# v3.2.69 — strip tool-warning lines from agent chat bubbles

Tobe 2026-08-05 11:38:
> "this edit fail warning shows up sometimes, even
> here in discord, and we have talked about it
> earlier but it was no issue, if it really is no
> issue, lets hide it."

## What it looks like

Inside otherwise-good agent replies, a line like:
```
⚠️ 📝 Edit: '/path/to/file.html' failed
```
sometimes shows up at the end of the bubble. Same
shape for read failures, exec failures, etc. OpenClaw
emits these as structured tool-call output, but when
the model echoes them verbatim in its user-visible
reply, they bubble up to the mobile chat.

## The fix

Two strippers, applied at every render + persist
point in the desktop:

1. **`stripToolWarnings(reply)`** — removes individual
   lines that match the OpenClaw `sanitize-user-facing-text`
   patterns:
   - `^[📊🛠️📖📝🔍🔎⚙️] (Session Status|Exec|Read|Edit|Write|Patch|Search|...)\s*:`
   - `^[⚠️ 🛠️📝📖🔍🔎⚙️] ...(agent) failed`
   Applies line-by-line so multi-line replies with an
   artifact in the middle clean up cleanly (the line
   is removed, surrounding blank lines collapsed).

2. **`stripAgentReplyDecorations(reply)`** — wraps the
   existing `stripQuestTags` plus the new
   `stripToolWarnings`. Most call sites want both, so
   the combined function avoids forgetting either
   stripper in the future.

## Applied at

- `addChatMsg` entry: agent-only, before persisting
  to `chatHistory` / `chatHistoryByAgent` and before
  broadcasting to mobile. User replies and errors
  pass through unchanged.
- Existing chat pipeline call sites (lines that were
  using `stripQuestTags(result.reply)`): now use
  `stripAgentReplyDecorations`.
- Mobile chat history serialization (the
  `cyberclaw-chat-byagent` localStorage payload):
  stripped on `restoreChatHistory` so old persisted
  entries get cleaned up on next restart.
- TTS text sent to mobile.

## Trade-off

This is purely cosmetic — the underlying edit/read/
exec still happens, and the LLM is still chatting
around the failure normally. Hiding the warning just
makes the chat cleaner. If someone needs to debug a
tool failure, the desktop log panel
(`window.addDesktopLog`) still gets a separate entry
with the full stderr output.

The system LLM would also benefit from being told
"don't echo tool warnings verbatim in your reply" —
but that's a system-prompt tweak, out of scope for
this fix. The stripper approach works regardless of
prompt content.

## Files

- `src/js/app.js`:
  - new: `stripToolWarnings`, `stripAgentReplyDecorations`
  - `addChatMsg` entry: strip agent text before persist
  - `restoreChatHistory`: one-shot migration strips
    tool-warning lines from old persisted entries
  - all `stripQuestTags(result.reply)` call sites
    switched to `stripAgentReplyDecorations`