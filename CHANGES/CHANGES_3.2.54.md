# v3.2.54 — debug-log the attachment data path

## 1. The mystery

**the user's report (2026-08-03 00:05):**
> "Still nothing. Why is this so complicated? Just do it
> the same way discord does it?"

Screenshot shows Clawsuu still saying "The chat pipe is
dead for attachments on your end. I've told you twice now
— stop trying to push them through here."

But the desktop log for this round showed:
```
[chat:send/http] POST ... (body=4483b, attachments=1)
```

A 4483-byte body with 1 attachment is **impossible**. The
system context alone is ~4500 bytes. A 264KB image encoded
as base64 is ~352KB. So the request body would need to be
~360KB to contain the image. **The base64 data is being
dropped somewhere between the file save and the HTTP body.**

## 2. Where it could drop

Two IPC boundaries:
1. **main.js → renderer** via `webContents.send('mobile-attachment-batch', {attachments: [batch]})`. Electron serializes the payload as JSON. Large strings (a 352KB base64) should serialize fine — they're just strings.
2. **renderer → main.js** via `ipcRenderer.invoke('chat:send-message', {agentId, message, attachments})`. Same — JSON serialization.

The most likely culprit: the renderer's batch handler
builds `dataUri` from `a.data`, but `a.data` was missing
or empty in the IPC payload. So dataUri was never built
and the multimodal content was sent as empty text.

## 3. Fix: log every step

Three new log points:

- **main.js `flushAttachmentBatch`:** logs each pending
  attachment with `data` length in chars. If main.js
  read the file successfully, this is non-zero. If
  zero, the file read failed.
- **renderer `mobile-attachment-batch` handler:** logs
  each batch entry's `data` length as it arrives via IPC.
  If main.js sent it but renderer got null, the IPC
  dropped it.
- **renderer attachment builder:** logs the total
  `dataUri` length across all attachments after
  building them. If the dataUri length is ~10, the
  data was missing; if it's ~352000, the data made it
  through.

The next test paste will reveal exactly which step
loses the data. Then we fix that one step.

## Files changed

- `src/main.js` — log `data` length in
  `flushAttachmentBatch`.
- `src/js/app.js` — log `data` length on batch arrival
  + `dataUri` total length after building.
- `package.json` — version 3.2.53 → 3.2.54

**v3.2.54 (desktop, debug-only).**