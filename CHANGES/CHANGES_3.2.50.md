# v3.2.50 — clean mobile-attachment handler (no chat noise)

## 1. Two things to fix from the same screenshot

**the user's report (2026-08-02 21:36):**
> "He still says he cannot see them. Just make it such that
> it works like it does in discord. And it says that i sent
> attachment extra in the chat now, as you see. We dont want
> that extra message either."

Screenshot showed three user bubbles of `📎 [attached:
<fileName>.png]` — one per sent image. Those are the
user-attribution bubbles v3.2.49 added. The user already
sees their own send (the image preview + their text
bubble); the extra bubble was noise.

## 2. What v3.2.49 got right and wrong

**Right:** added the missing `ipcRenderer.on('mobile-
attachment', ...)` listener. main.js was saving the
attachment to disk and firing the IPC, but no one
received it — the file sat unseen. Now the renderer
forwards the path to the LLM.

**Wrong:** added a user-attribution bubble that shows up
IN ADDITION to the user's normal send bubble. The user
already sees the image they pasted; the extra bubble was
redundant.

## 3. Fix: remove the user bubble

The attachment metadata is now a private side-channel to
the LLM. The user sees only their original send (the
text they typed, plus the image preview). No extra
`📎 [attached: ...]` row.

## 4. Why the LLM still says "I can't see the image"

The user also asked: make it work like Discord. The
honest answer: **the current `openclaw agent -m <text>`
CLI invocation does NOT support image attachments.**
OpenClaw's gateway-side ACP layer supports
`opts.images` (see `agent-command-DimMXeog.js` line ~724)
but the CLI flag set we use (`-m`, `--agent`, `--json`)
doesn't expose any image-attachment flag.

The model only sees the path-based prompt we send. If
the model has vision tools enabled, it could `read
<path>` and the file content would be returned. By
default, OpenClaw gives an agent session-management
tools (sessions_list, sessions_history, etc.) — not file
tools. To enable file-read capability, the clawsuu agent
entry in `~/.openclaw/openclaw.json` needs
`tools: { allow: ["read"] }` (or a broader allowlist).

We don't make that change in v3.2.50 — that's a config
change in a different file owned by the user, not code
in this repo. The chat-side fix here is: stop showing the
noisy user bubble, and rephrase the prompt so the LLM
acknowledges the attachment gracefully even without
vision. It now says:

> [The user sent an image attachment: ...]
>
> Respond as if the user just sent this image in chat.
> If you have a way to view images (vision capability
> or a read tool that handles images), look at the file
> and tell the user what you see. Otherwise,
> acknowledge the attachment and ask what they'd like
> you to do with it.

So with no tools, the LLM responds "got the image, what
do you want me to do with it?" — which is correct
behavior. With tools enabled (out of band), the LLM
can read the file and describe it.

## Files changed

- `src/js/app.js` — `mobile-attachment` handler no longer
  adds the user-attribution bubble; prompt rephrased.
- `package.json` — version 3.2.49 → 3.2.50

**v3.2.50 (desktop).**
