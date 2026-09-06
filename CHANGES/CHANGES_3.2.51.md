# v3.2.51 — Discord-style image attachments via gateway HTTP API

## 1. The fix

**the user's report (2026-08-02 21:45):**
> "Okey we need this ability so go with the option you
> think is most appropriate for this app."

The user wanted attachments to work like Discord: image bytes
reach the model inline, not as a path the model can't read.
The CLI path (`openclaw agent -m <text>`) is text-only by
design — OpenClaw's gateway-side ACP layer supports
multimodal content but the CLI doesn't expose it.

The right path: **the gateway's OpenAI-compatible
`/v1/chat/completions` HTTP endpoint**, which accepts the
standard multimodal content shape:

```json
{
  "model": "openclaw/<agentId>",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "..."},
      {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
    ]
  }]
}
```

## 2. What changed

### Gateway config

`~/.openclaw/openclaw.json`:

```diff
   "gateway": {
     "port": 18789,
     "mode": "local",
     "bind": "loopback",
     "auth": { "mode": "token", "token": "..." },
+    "http": {
+      "endpoints": {
+        "chatCompletions": { "enabled": true }
+      }
+    },
```

I added this. The gateway needs a restart to pick up the
change (it was killed and re-spawned by the user session).

### main.js — `chat:send-message` IPC

Replaced the single CLI path with two paths:

- **`sendChatMessageViaHttp`** (preferred when gateway's
  HTTP endpoint is enabled). POSTs to `/v1/chat/completions`
  with multimodal content. Tested: a 1×1 PNG sent to
  clawsuu got back "Low-resolution solid black image."
- **`sendChatMessageViaCli`** (fallback). The legacy
  `openclaw agent -m ...` invocation. If the HTTP path
  errors out (network blip, gateway restart, etc), the
  handler falls back transparently so chat never breaks.

A new `readGatewayConfig()` helper reads the gateway's
base URL + token from `~/.openclaw/openclaw.json` on every
call (config changes take effect without restart).

### preload.js

`cyberclaw.chat.sendMessage` now accepts an optional
`attachments` array as a third argument.

### app.js (renderer)

`__sendChatMessageImpl(message, attachments)` accepts the
attachments and passes them through to the IPC. Empty
message + non-empty attachments is now valid (lets image-
only sends go through).

The `mobile-attachment` IPC handler (when a desktop-side
attachment is saved from the mobile's `attachment` WS
message) now:
1. Reads the saved file's base64 (already done in main.js)
2. Builds a `data:` URI
3. Calls `window.sendChatMessage('', [attachments])`
   instead of generating a path-based prompt

### CLI fallback path

When the CLI path runs with attachments, it can't embed
the image data. The CLI fallback now appends a note to the
message:

```
[Attachments received but not embedded inline (CLI path
doesn't support image content):
  1. foo.png (image/png, 12345 bytes) — saved at /path/foo.png
Please acknowledge the attachments and ask the user to
describe them if you cannot view them.]
```

So even on the fallback path, the LLM knows the
attachments arrived and can ask the user for context.

## 3. End-to-end behavior

1. User pastes an image in the mobile chat (v3.10.129
   auto-attach on TextInput focus).
2. User taps send.
3. Mobile WS sends the `attachment` message to the desktop.
4. Desktop's `onAttachment` saves the file, fires
   `mobile-attachment` IPC with the file's base64 data.
5. Renderer forwards the attachment as a multimodal
   `image_url` content block to the chat IPC.
6. Desktop's chat:send-message handler POSTs to the gateway.
7. The model sees the image bytes and responds.

## 4. Why this works

Verified at 21:50 GMT+2:
- Gateway `chatCompletions` endpoint enabled.
- A 1×1 base64 PNG sent to `openclaw/clawsuu` returned
  "Low-resolution solid black image." (proves the image
  bytes reached the model).
- Plain text messages still work as before.

## Files changed

- `src/main.js`:
  - New `readGatewayConfig()` helper.
  - `chat:send-message` handler splits into
    `sendChatMessageViaHttp` (preferred) and
    `sendChatMessageViaCli` (fallback).
  - `mobile-attachment` IPC now includes the file's
    base64 in the payload.
- `src/preload.js` — `chat.sendMessage(agentId, message,
  attachments)`.
- `src/js/app.js`:
  - `__sendChatMessageImpl(message, attachments)`.
  - Empty-message-with-attachments is now valid.
  - Both IPC call sites pass attachments.
  - `mobile-attachment` handler builds attachments array
    and passes to sendChatMessage.
- `~/.openclaw/openclaw.json` — `chatCompletions` endpoint
  enabled (gateway restarted by user session).
- `package.json` — version 3.2.50 → 3.2.51

**v3.2.51 (desktop).**
