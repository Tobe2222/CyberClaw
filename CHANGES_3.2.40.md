# v3.2.40 — Tag replayed messages + strip `[From: ...]` prefix before the LLM

Two small fixes for mobile-routing confusion that
the user flagged 2026-08-01 in the Discord screenshot:

1. "clawsuu seems a bit confused still of where to
   respond"
2. "for some reason i get notification from earlier
   messages"

## Fix 1: strip `[From: ...]` prefix before the LLM

**The bug.** The sync-server prepends
`[From: <deviceName>] ` to every chat it forwards to
the renderer (sync-server.js line ~388). This is fine
for the chat-history bubble (the user wants to see
which device sent it) but the LLM doesn't need it.
When the message then flows through `sendChatMessage`
to the agent, the agent sees:
> [From: Android Phone] You texted me in DM on
> discord earlier...

…and confuses itself about which channel the user is
on. the user's screenshot showed Clawsuu's response:
> "I keep losing the thread because the discord-vs-
> Android routing is jacked."

The LLM is the right layer to fix this — the
desktop's chat history keeps the prefixed text (for
display), but the LLM call gets the clean message.

**The change.** Two sites:
- `src/js/app.js`, the `mobile-chat` IPC handler
  (~line 5193): strip the prefix from the text
  before forwarding to `sendChatMessage`.
- `src/js/app.js`, the `mobile-voice` IPC handler
  (~line 5345): same strip on the voice transcript
  path. The voice wrapper already includes
  `[Voice from mobile]` so the inner prefix is
  redundant + confusing.

```js
const llmText = (text || '').replace(/^\[From:\s*[^\]]*\]\s*/, '');
window.sendChatMessage(llmText);
```

Both regexes are the same shape
(`/^\[From:\s*[^\]]*\]\s*/`) and the same regex
already lives in the mobile's
`appendAgentMessage.normalize()` (HomeScreen.tsx
~line 411). One canonical shape across the two
sides — easy to keep in sync.

## Fix 2: tag reconnect-replay messages so the mobile can suppress notifications

**The bug.** The sync-server's `_sendFullState`
(sync-server.js ~line 1505) replays the rolling
buffer of recent AI messages on every reconnect:

```js
for (const entry of this._recentAiMessages) {
  this._send(ws, entry.payload);
}
```

The payload is `{ type: 'chat_message', agentId,
agentName, text, isUser, ts }`. On the mobile,
this lands in `onChat`, which fires a system
notification for every `isOwnReply` that's NOT
chat-focused (per the v3.10.70 logic). So if 5
agent replies landed while the user was
disconnected, on reconnect the user gets 5
notifications stacked in the tray. The user saw this
on the screenshot ("for some reason i get
notification from earlier messages").

**The fix.** Tag replayed messages with
`replay: true` on the server, and check the flag
on the mobile.

Server (sync-server.js `_sendFullState`):
```js
for (const entry of this._recentAiMessages) {
  this._send(ws, { ...entry.payload, replay: true });
}
```

Mobile (HomeScreen.tsx `onChat`):
```js
const isOwnReply = !msg.isUser;
if (isOwnReply && !msg.replay) {
  // ... fire notification
}
```

The chat-history append still happens (so the
replayed bubbles fill in correctly), only the
notification is suppressed. Reconnect-replay was
never about the chat — it was about catching the
user up on what they missed; the notification
tray already lost those moments.

## Files

- `src/sync-server.js`: `_sendFullState` tags
  replayed payloads with `replay: true` (~line 1546).
- `src/js/app.js`: `mobile-chat` IPC strips `[From:...]`
  before LLM (~line 5226); `mobile-voice` IPC
  strips on voice transcript path (~line 5350).
- `package.json`: 3.2.39 → 3.2.40.

## Lessons

1. **Cross-system metadata that's purely cosmetic
   should not leak into LLM prompts.** The `[From:
   <deviceName>]` tag was added so the chat bubble
   shows the source device — useful when a user has
   multiple phones / a tablet / etc. — but it's
   meaningless to the LLM, which only cares about
   the message content. The right architecture is
   "display-only metadata lives at the presentation
   layer; LLM-facing copies strip it." A regex on
   the renderer-side forwarding was the minimal
   fix. The longer-term fix would be to make
   `sendChatMessage` accept a `{display, prompt}`
   tuple, but that's bigger surgery than this
   bug deserves.

2. **Reconnect-replay is for chat history, not
   notifications.** The rolling-buffer replay exists
   so the user catches up on what was said while
   they were disconnected. It's NOT meant to be a
   notification ("hey, 7 things happened, look at
   them all RIGHT NOW"). The 50-message cap with
   notification spam = terrible UX. Tag replays
   with `replay: true` so the mobile can apply
   different UI semantics (silent fill-in vs.
   notification-worthy new arrival). Same pattern
   applies to any "catch-up" replay: web push,
   email sync, etc. — replays are silent, fresh
   events are noisy.

3. **Single canonical regex for shared strings.**
   The `[From: ...]` strip pattern now lives in
   THREE places: this release's renderer-side
   strips (x2), and the existing mobile-side
   `normalize()` for chat dedupe. The shapes are
   intentionally identical so a future rename
   ("[From X]" → "(from X)") only needs three
   grep-replace. If we ever introduce a 4th place,
   hoist to a shared util.

## What I didn't do

### Per-agent routing rules

the user's underlying frustration is "messages from
different platforms get routed wrong." The
v3.2.25 design says "mobile-chat goes to mobile
chat, Discord goes to Discord, never the twain
shall meet." That works for the LLM-side routing.
But on the mobile, the chat history shows the
last N messages regardless of source — including
the prefix that hints at the source. The right
fix would be: per-source chat history tabs on the
mobile, with the active tab determined by which
device sent the most recent message. Big change,
out of scope for v3.2.40. The two surgical fixes
above make the existing setup noticeably less
confusing without rewriting the routing layer.

### System-prompt awareness of channel

The agent's system prompt could include "you are
running on CyberClaw; messages may arrive from
Discord, the mobile app, or webchat — same
person, same thread, no need to switch context."
That would help the LLM interpret messages like
the screenshot's user message ("you texted me in
DM on discord earlier") without confusing itself
about channel routing. Could be done as a single
paragraph in `companion-prompts.js`. Skipped for
v3.2.40 because the prefix-strip makes the
practical issue go away — without the prefix,
Clawsuu no longer has a tag to confuse itself
with.