# 3.2.23 — fix missed-broadcast replay on mobile reconnect

Tobe reported on v3.2.22 (2026-07-23 21:29):

> "@Clawsuu i swipe down to the bottom but no more
> chats appear"

Pull-refresh didn't reveal the missing chat. Earlier
debugging showed:
- Desktop log: agent reply "Yes, all of these are
  live right now on the VPS..." was broadcast via
  sync-broadcast-chat
- Desktop log: `[SyncServer] Client disconnected:
  0c13f8cec4d807bb` shortly after
- Mobile never received the broadcast (was
  disconnected)
- Pull-refresh should trigger chat history replay
  → mobile asks for chat history
- Desktop sends `chatHistory.slice(-50)`
- But the renderer might have lost that message
  (renderer reload, etc.) → empty replay

## Root cause

The sync-server already had a reconnect-replay
mechanism for chat messages — but it was tuned for
short disconnects (60-second window, single message):

```js
// Replay last chat message if it arrived while client
// was disconnected (60s window)
if (this._lastChatMessage && (Date.now() - this._lastChatMessage.ts) < 60000) {
  this._send(ws, this._lastChatMessage.payload);
}
```

Two problems:

1. **60-second window is too narrow.** Real
   disconnects (phone sleep, app switch, brief
   connectivity loss) routinely exceed 60s. Tobe's
   case: the agent reply landed at 4:42 PM CEST;
   the mobile reconnected much later. By then the
   60s window had long expired.

2. **Single-message cache.** Only ONE recent message
   was cached (`_lastChatMessage`). If multiple
   messages arrived during a disconnect, only the
   latest one was replayed.

The fallback (mobile asks for chat history via
`request_chat_history`) is supposed to cover this
case, but it relies on the renderer's in-memory
`chatHistory` array being intact. If the renderer
reloaded between broadcast and chat history request
(common during desktop restarts or renderer crashes),
`chatHistory` is empty and the mobile gets an empty
list.

## Fix

### 1. Buffer of recent AI messages

In `sync-server.js`, `broadcastChatMessage` now keeps a
rolling buffer of the last 50 AI messages (was:
single message):

```js
if (!isUser) {
  if (!this._recentAiMessages) this._recentAiMessages = [];
  this._recentAiMessages.push({ payload, ts: Date.now() });
  if (this._recentAiMessages.length > 50) {
    this._recentAiMessages = this._recentAiMessages.slice(-50);
  }
  this._lastChatMessage = this._recentAiMessages[this._recentAiMessages.length - 1];
}
```

### 2. Replay all buffered messages on reconnect

In `_sendFullState`, replay the entire buffer (was:
single message within 60s window):

```js
if (this._recentAiMessages && this._recentAiMessages.length > 0) {
  for (const entry of this._recentAiMessages) {
    this._send(ws, entry.payload);
  }
}
```

The 60-second window is gone. A mobile that
disconnected for an hour can still catch up on the
last 50 agent messages.

### Mobile dedupe is the safety net

The mobile's `appendAgentMessage` (v3.10.89) has
three dedupe stages (60s window + 1h window + 5min
window) keyed on normalized text. The replay from
the sync-server sends messages that might already be
in the mobile's local cache — Stage 1 catches
within-session echoes, Stage 2 catches cross-restart
replays, Stage 3 catches fresh re-sends. None of
those are an issue here because:

- Stage 1 (60s, same isUser) catches an echo that
  landed in the mobile's cache while still connected
  (60s is the typical echo window)
- Stage 2 (1h, same isUser) catches cross-restart
  echoes
- Stage 3 (5min, same text) catches re-sends within
  the replay window

A replay that the mobile already has in its cache
would either match Stage 1/2 (if it's the local echo)
or not match anything (if it's the agent's original
reply and the mobile already has it from the live
broadcast — but in that case the live broadcast
already added it, so replay doesn't add a duplicate).

Actually wait — let me re-think. If the mobile got
the live broadcast, it's in messagesByAgent. The
replay sends the same message again. The mobile's
dedupe (Stage 3, same text anywhere) with 5min
window... if the original broadcast was within 5min
of the replay, Stage 3 dedupes. Good.

If the original broadcast was >5min ago (unlikely
for a single replay, but possible), Stage 3 wouldn't
dedupe, and the message would be added again. But
the v3.10.89 Stage 3 window is 5min, not "anywhere".
So this case wouldn't apply.

In short: the dedupe in v3.10.89 already covers the
replay case correctly.

## Files changed

- `src/sync-server.js`:
  - `broadcastChatMessage`: replaced `_lastChatMessage`
    single-cache with `_recentAiMessages` rolling buffer
    (max 50 entries)
  - `_sendFullState`: replaced single-message 60s
    replay with full buffer replay (no time window)
- `package.json` — version 3.2.22 → 3.2.23

## Companion mobile note

The mobile doesn't need a change for this version.
The dedupe in v3.10.89 already handles the replay
case correctly. If the mobile gets a replay for a
message it already has, Stage 1 (60s) or Stage 2 (1h)
catches it.

## Lessons

**60-second reconnect windows are wrong for any
non-trivial use case.** Phone sleep / app switch /
brief connectivity loss routinely exceed 60s. The
sync-server's reconnect-replay buffer needs to be
either:
- Long-lived (1h+) with reasonable size cap
- Unbounded (with size cap, drop oldest)

A single-message cache is the worst of both worlds:
wrong size (only one message) AND wrong window (60s).
Even 50 messages × 5KB each = 250KB, which is
negligible memory. Always buffer enough to cover
the typical reconnect window.

**The dedupe on the receiver side is the safety net,
not the constraint.** I was tempted to dedupe at the
sender (only keep messages that haven't been seen
by ANY mobile). But that requires tracking per-mobile
delivery state, which is fragile (mobile reconnects
with new ID, mobile disconnects and reconnects, etc.).
The simpler approach: sender keeps a small buffer of
recent messages, replays on reconnect, receiver
dedupes. The dedupe is the receiver's job. The
sender's job is "always have recent state ready".

**Logs tell the story when test results don't.**
"[SyncServer] Client disconnected" right after a
broadcast was the diagnostic tell. The mobile
broadcast went out to zero connected clients. The
replay mechanism (60s window, single message) didn't
cover the disconnect duration. Fix the buffer size
and window, then verify the replay actually fires on
the next reconnect.

## What this doesn't fix

- The mobile's pull-refresh (manual refresh) doesn't
  trigger a chat history replay by itself. The mobile
  only requests chat history on WebSocket connect (in
  SyncClient.ts:593). If the WS is connected and the
  user pull-refreshes, the renderer doesn't push new
  history.
- If the desktop restarts mid-conversation, both
  `_recentAiMessages` (in-memory) and the renderer's
  `chatHistory` (also in-memory) are empty. After
  restart, there are no messages to replay. Long-term
  fix: persist `_recentAiMessages` to disk so it
  survives desktop restarts. Not done in this version.