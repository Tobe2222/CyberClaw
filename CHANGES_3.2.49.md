# v3.2.49 — companion now sees images sent from mobile

## 1. The bug

**Tobe's report (2026-08-02 21:27):**
> "the companion could not see them after they were sent,
> or looks to be sent from the user perspective."

Image attachments from the mobile were silently dropped
between the disk save and the LLM. The desktop's
`onAttachment` handler in `main.js` correctly saved the
base64 payload to `~/.openclaw/cyberclaw/attachments/`
and acked the mobile — but the IPC `mobile-attachment`
that was supposed to notify the renderer never had a
listener. The file sat on disk; the LLM never knew.

## 2. What was broken

`src/main.js` line 3017:
```js
mainWindow.webContents.send('mobile-attachment', {
  path: savedPath, mimeType, fileName, size, meta,
});
```

But `src/js/app.js` had **zero `ipcRenderer.on('mobile-attachment', ...)`
listeners**. The IPC fired into the void. The chat pipeline
never saw the file path, so when the LLM got the user's
follow-up message ("check out that screenshot"), it had
nothing to look at.

## 3. Fix

Added the listener. When the desktop finishes saving the
attachment, the renderer:

1. Builds a structured prompt including the on-disk path:
   ```
   [Image from mobile — <fileName> (<mimeType>, <size>
    bytes). Saved at: <path>

   Please look at this image with your read tool and
   tell me what you see.]
   ```
2. Adds a user-attribution bubble: `📎 [attached:
   <fileName>]` (visible on the chat).
3. Calls `sendChatMessage(prompt)` to dispatch to the
   active companion.

The path-based approach is intentional: OpenClaw's
`agent -m <text>` flag is text-only — we can't embed the
base64 in the prompt directly. Telling the LLM "the file
is at this path, use your read tool" is the standard
pattern for vision-capable models that have file tools
enabled.

## 4. This works WITH the v3.2.49 agent tools fix

Both must land together. Without `tools` on the agent
(see the parallel conversation), the LLM gets the path
but can't actually read the file. With tools, the LLM
calls `read <path>` and the file content is returned as
text (for PDFs, code, etc.) or piped to the model's
vision capability (for images, on vision-capable models).

## Files changed

- `src/js/app.js` — new `ipcRenderer.on('mobile-attachment',
  ...)` handler that builds the prompt and calls
  `sendChatMessage`.
- `package.json` — version 3.2.48 → 3.2.49

**v3.2.49 (desktop).**
