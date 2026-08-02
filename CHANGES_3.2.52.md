# v3.2.52 — batch mobile attachments into one chat send

## 1. The bug

**Tobe's report (2026-08-02 22:13):**
> "Okey tested. Something else has broken now."

Screenshot showed the chat with "No response from OpenClaw."
The user pasted 9 images + typed "Lets test again. Can you
see these now" + tapped send. The mobile sent 1 text
message + 9 attachment WS messages. The desktop processed
them in order:

1. Text → `chat:send-message` HTTP call (fast, 1-2s).
2. 9 attachments → each one fires a separate
   `mobile-attachment` IPC → each one fires a separate
   `sendChatMessage` → each one makes a separate HTTP
   call to the gateway.

The renderer's per-agent `chatSendChain` (v3.2.45) serialized
the calls. 9 calls × 10-30s each = 90-270s of total
work. The chain's wait cap is 95s. By the time the 9th
call ran, the queue had either timed out or the LLM had
given up and replied "No response from OpenClaw" as a
deflection.

## 2. The fix

Batch attachments in main.js. The desktop buffers all
attachments for **700ms** after the LAST one arrives,
then fires ONE `mobile-attachment-batch` IPC with all
of them. The renderer's handler builds ONE multimodal
content array and fires ONE `chat:send-message` call.

### main.js

```js
let pendingAttachments = [];
let attachmentFlushTimer = null;
const ATTACHMENT_FLUSH_MS = 700;

function flushAttachmentBatch() {
  if (pendingAttachments.length === 0) return;
  const batch = pendingAttachments;
  pendingAttachments = [];
  attachmentFlushTimer = null;
  mainWindow.webContents.send('mobile-attachment-batch', { attachments: batch });
}
```

Each `onAttachment` push resets the timer. The flush
happens 700ms after the LAST image arrives, so a
9-image paste results in 1 IPC instead of 9.

### app.js (renderer)

The `mobile-attachment` listener is replaced with
`mobile-attachment-batch`. The handler loops over the
batch and builds a single attachments array. ONE
`sendChatMessage('', attachments)` call.

## 3. Why 700ms

- Too short (e.g. 100ms): images that arrive 200ms apart
  would flush separately, defeating the point.
- Too long (e.g. 3000ms): the user waits 3s before the
  LLM starts processing their paste.
- 700ms comfortably covers the network round-trip between
  attachment WS messages (typically <50ms apart) without
  feeling laggy.

## 4. What still works

- Single attachment: timer fires once → batch of 1 → one
  chat send. Identical to v3.2.51 behavior.
- Mixed text + attachments: text goes via `chat:send-message`
  separately (the existing flow); attachments batch via
  this new path. Both are independent. The user sees
  their text bubble + the LLM gets the images. (Merging
  text+attachments into a single send is a bigger
  refactor — the mobile doesn't currently bundle them.
  Out of scope for this fix.)

## Files changed

- `src/main.js`:
  - Module-level attachment buffer + flush timer.
  - `onAttachment` pushes to buffer + resets timer (was:
    fired per-image IPC).
- `src/js/app.js`:
  - `ipcRenderer.on('mobile-attachment', ...)` replaced
    with `ipcRenderer.on('mobile-attachment-batch', ...)`.
  - Handler builds ONE attachments array from the batch
    and calls `sendChatMessage` once.
- `package.json` — version 3.2.51 → 3.2.52

**v3.2.52 (desktop).**
