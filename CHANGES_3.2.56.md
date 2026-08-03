# v3.2.56 — combine mobile text + attachments into one LLM turn

## The bug Tobe hit

Tobe 2026-08-03 07:50 in #cyber-dev:
> "clawsuu still says he cannot see the pictures"

The desktop log for that test run:

```
[chat:send/http] POST /v1/chat/completions (body=4495b, attachments=0)
[Attachment] Saved 1000014577.png (264023 bytes)
[mobile-attachment-batch] flushing 1000014577.png (... hasData=true)
[RI] [mobile-attachment-batch] received 1000014577.png
[RI] [mobile-attachment-batch] built 1 attachment(s)
[RI] [mobile-attachment-batch] forwarding to chat: ... attachments: 1
[chat:send/http] response status=200   ← reply to the text-only call
[IPC] sync-broadcast-chat received: text="I can see the workspace,
     but I don't see any image attached to your message, Tobe..."
[RI] [sendChatMessage] dispatching to agent ... attachments=1
[chat:send/http] POST (body=356581b, attachments=1)   ← second call
[TTS] Synthesized 1132604 chars, sending to mobile...   ← the image description
```

Two LLM calls. The first got text only → "I can't see image".
The second got the image only → 1.1M chars describing it
(later TTS'd, but never surfaced as a chat bubble that the
user could read).

The session log shows the user message arrived as text-only.
The model replied "no image attached". Tobe saw that reply
in the chat and reported it. The image-describing reply from
the second call ended up in the TTS pipeline but not in the
chat bubble.

## Root cause

Two separate WS messages on the mobile side:
1. `syncClient.sendChat(text, aid)` → `chat` WS message →
   `onChatMessage` → `mobile-chat` IPC → `sendChatMessage(text)`
   → fires LLM call **immediately**
2. `syncClient.sendAttachment(b64, type, name)` (one per
   attachment) → `attachment` WS message → `onAttachment` →
   saves to disk → 700ms `flushAttachmentBatch` timer →
   `mobile-attachment-batch` IPC → `sendChatMessage('', [att])`
   → fires a **second** LLM call

The text arrives first (1-3ms after WS send). The image
arrives 50-200ms later (file read + base64 encode + WS round-
trip). The 700ms flush timer fires after the LAST attachment.

So the LLM always sees the user's text in a separate turn
from the user's image. v3.2.55 fixed the "dropped attachment"
bug at the chain wrapper, but the split-turn architecture
remained. The user's text-only turn produces a "I don't see
an image" reply that gets surfaced in the chat bubble — which
looks like the attachment silently failed, even though the
attachment did reach the model on the next turn.

## The fix

Hold the mobile text for `PENDING_CHAT_HOLD_MS = 600` ms
before firing the LLM call. If an attachment batch arrives
in that window, merge them into ONE multimodal send:

- `mobile-chat` IPC handler: store text in `pendingMobileChat`
  and start a 600ms timer. If the timer fires first, send
  text-only (existing behavior). If an attachment batch
  arrives first, consume the text and merge.
- `mobile-attachment-batch` IPC handler: if
  `pendingMobileChat.text` exists, cancel the timer and
  call `sendChatMessage(text, attachments)` instead of
  `sendChatMessage('', attachments)`. Otherwise unchanged.

600ms is shorter than the desktop's 700ms attachment-flush
timer (which fires AFTER the last attachment), so:
- text-only sends: still fire after 600ms — same speed as
  before for the no-attachment case
- text+1 image: attachment flushes 50-300ms after the text
  on average, so it lands inside the 600ms window
- text+multi images: total flush is up to 700ms after the
  last image, but the FIRST image typically arrives within
  ~200ms of the text → first image batch lands in the 600ms
  window, subsequent images arrive in a follow-up batch

The multi-image case still produces one extra LLM turn per
batch boundary, but that's a separate issue (and the
existing 700ms batch flush already optimizes the common
case of typing text + picking a single image).

## Why this is the right fix

Three other approaches considered and rejected:

1. **Send text + attachments in ONE WS message from the
   mobile.** Cleaner, but requires changes to SyncClient,
   sync-server, main.js, and renderer. Big surface.
2. **Desktop: hold the text only if attachments are pending
   on disk.** Same idea, but harder to detect from the
   renderer side. Renderer has no view of pendingAttachments.
3. **Mobile: send attachments FIRST, then text.** Doesn't
   help — the desktop fires the LLM call on the text
   immediately regardless of order.

Buffering in the renderer is the smallest change with the
fewest cross-cutting effects. Two IPC handlers, one timer.

## Files changed

- `src/js/app.js` — added `pendingMobileChat` state and
  `PENDING_CHAT_HOLD_MS = 600` constant. Updated `mobile-chat`
  IPC handler to buffer. Updated `mobile-attachment-batch`
  IPC handler to consume the buffer if present.
- `package.json` — version 3.2.55 → 3.2.56

**v3.2.56 (desktop).**

## What Tobe should see next

The next image+text he sends from the mobile should land as
ONE chat turn. The LLM should describe the image in its
single reply, not produce a "I can't see image" follow-up.
The log will show:
```
[mobile-chat] received: We try again ...
[mobile-chat] hold started (600ms)
[mobile-attachment-batch] merging with pending mobile chat: We try again ...
[mobile-attachment-batch] forwarding to chat: ... attachments: 1
```
instead of:
```
[mobile-chat] received: We try again ...
[chat:send/http] POST ... (body=4495b, attachments=0)
...later...
[mobile-attachment-batch] forwarding to chat: ... attachments: 1
[chat:send/http] POST ... (body=356581b, attachments=1)
```