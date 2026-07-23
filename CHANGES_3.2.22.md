# 3.2.22 — fix mobile chat spam (filter mid-run tool-use messages + dedupe renderer IPC)

## Reported by Tobe (via Discord)

Tobe on Discord after v3.2.21 + v3.10.88 deployed:

> "@Clawsuu and for some reason it replied for this
> message in the app now. Its spamming the app for
> this issue i posted here"

Screenshot showed the mobile chat with 90+ agent
message bubbles for every internal agent run I did
during the v3.10.80/v3.10.81/v3.10.86/v3.10.87
debugging session. Each `exec` tool call from my
OpenClaw session ended with a final assistant text
reply, all of which got broadcast to the mobile.

## Root cause (two bugs that combined)

### Bug A: tailer fired for every assistant message

The session tailer (added in v3.2.21) emits
`onChatMessage` for every assistant text entry in
Discord-routed sessions. But OpenClaw writes one
assistant entry per model response — including the
mid-run "I'll run a tool next" messages (where
`stopReason: "toolUse"`) AND the final user-facing
reply (where `stopReason: "stop"` / `"end_turn"`).

During my debug session I made ~10 exec calls, each
producing 2-3 mid-run "tool call" assistant messages
+ 1 final "stop" message. Result: ~30 broadcasts from
ONE debug session.

The original intent was to broadcast Discord-routed
final replies (the ones the user would actually see in
Discord). The tailer didn't distinguish "final reply"
from "mid-run continuation".

### Bug B: renderer IPC handler double-broadcasts

The IPC handler `ipcRenderer.on('openclaw-session-chat-message', ...)`
calls `addChatMsg(isUser ? 'user' : 'agent', text, name)`.
`addChatMsg` updates `chatHistory` AND fires
`ipcRenderer.invoke('sync-broadcast-chat', ...)` to
broadcast to the mobile.

But `main.js`'s `onChatMessage` callback ALREADY
called `syncServer.broadcastChatMessage(...)` (the
sync-server broadcast). So each tailer-detected
message got broadcast TWICE:

1. `syncServer.broadcastChatMessage` (from main.js)
2. `addChatMsg → ipcRenderer.invoke('sync-broadcast-chat')`
   (from the renderer's IPC handler)

The second one was the renderer mirroring what the
first one already did, except the second one was
triggered via IPC instead of via the sync-server
directly. Net effect: every assistant message hit
the mobile twice.

## Fix

Two changes in this version:

### 1. Tailer filters by `stopReason`

In `src/openclaw-session-tail.js`, added a check:

```js
const stopReason = msg.stopReason;
const isFinalReply =
  !stopReason || stopReason === 'stop' || stopReason === 'end_turn' || stopReason === 'max_tokens';
if (!isFinalReply) {
  this.fileLastBroadcastId.set(filePath, msgId);
  return;
}
```

Skips messages with `stopReason: "toolUse"` (the agent
wants to call another tool, more messages coming).
Only broadcasts `"stop"` / `"end_turn"` / `"max_tokens"`
(terminal stop reasons — these are the user-facing
replies).

We still emit `onToolCall` for ALL messages (including
toolUse ones) — the better thinking indicator wants
to see every tool the agent runs, even mid-run. We
just don't broadcast the mid-run TEXT to chat.

### 2. Renderer IPC handler stops calling `addChatMsg`

In `src/js/app.js`, the `openclaw-session-chat-message`
handler now pushes directly to `chatHistory` and
`chatHistoryByAgent` arrays (bypassing `addChatMsg`'s
broadcast side effect). The sync-server broadcast
already went out from `main.js`'s `onChatMessage`
callback. No double-broadcast.

## Files changed

- `src/openclaw-session-tail.js`:
  - Added `stopReason` check in `processLine` before
    calling `onChatMessage`
  - Mid-run tool-use messages: mark as seen, return
    without broadcast
  - Final-stop messages: broadcast as before
- `src/js/app.js`:
  - IPC handler for `openclaw-session-chat-message`
    no longer calls `addChatMsg`. Pushes directly to
    `chatHistory.push(...)` and `chatHistoryByAgent[aid].push(...)`
    + `schedulePersistChatHistory()` to persist.
- `package.json` — version 3.2.21 → 3.2.22

## Companion mobile note

The mobile doesn't need a change for this version.
The bug was on the desktop side (broadcasting too many
messages). The mobile just displays what the desktop
sends, and now it sends only the final replies.

## Lessons

**Side-channel bridges are easier to over-broadcast
than under-broadcast.** The v3.2.21 tailer fixed a
"not reaching mobile" bug. The fix was correct in
intent (broadcast assistant messages from Discord
sessions). But it didn't distinguish "user-facing
final reply" from "mid-run continuation". Every
internal agent run fires the same kind of JSONL
entry. Without filtering, you spam.

**Always distinguish "what the user sees" from "what
the agent does internally."** OpenClaw's JSONL has
both — final replies AND tool-use continuations. They
look identical at the type level (`role: assistant`)
but differ in `stopReason`. Filtering by stopReason
is the right discriminator.

**Two broadcasts from two different code paths
silently compound.** Both `syncServer.broadcastChatMessage`
in main.js AND `addChatMsg → sync-broadcast-chat` in
the renderer's IPC handler were firing. They looked
like separate concerns (one for "tail to mobile
now", the other for "update renderer history") but
they both ended in the same destination. The fix:
pick ONE path for the broadcast, leave the other to
update history only.

**Diagnostic trick:** count broadcasts per session.
"91 addChatMsg broadcasts" was the tell that something
was wrong — there should be ~1 broadcast per actual
user-facing message, not ~90.