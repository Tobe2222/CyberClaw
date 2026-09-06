# 3.2.25 — Discord conversations no longer appear in the mobile chat app

The user reported on v3.2.24 (2026-07-24 00:13):

> "@Clawsuu and if we have conversation here on discord
> it should not appear on the app."

## Root cause

The OpenClaw session tailer (added in v3.2.21) was
broadcasting Discord-routed agent replies to the mobile
chat via `syncServer.broadcastChatMessage(...)`. The
intent was to bridge Discord-routed replies to mobile
(because at the time, those replies were getting lost
— they went back to Discord via OpenClaw's `message`
tool without ever touching the desktop).

But this had an unintended side effect: every agent
reply in a Discord conversation showed up as a message
in the mobile chat. If the user and I had a long
conversation in Discord, the mobile chat would fill
up with all the agent's replies, even though the user
wasn't engaging with the agent via mobile.

The mobile chat panel should reflect conversations
the user had IN THE APP (mobile chat / voice mode),
not conversations the agent had in parallel channels
(Discord / webchat / cron / etc.).

## Fix

In `main.js`, the OpenClaw session tailer's three
callbacks (`onChatMessage`, `onTyping`, `onToolCall`)
no longer broadcast to mobile. They still send IPCs to
the renderer (so the renderer's `chatHistoryByAgent`
stays in sync — useful if the user later switches to
the desktop), but the mobile no longer receives the
broadcasts.

```js
onChatMessage: ({ agentId, agentName, text, isUser }) => {
  // v3.2.25: NO mobile broadcast for Discord-routed
  // agent replies. the user: 'discord conversation should
  // not appear on the app.' We still send the IPC to
  // the renderer so chatHistoryByAgent stays in sync.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('openclaw-session-chat-message', {
      agentId, agentName, text, isUser, ts: Date.now(),
    });
  }
},

onTyping: (active) => {
  // v3.2.25: no-op — Discord typing shouldn't show
  // on mobile.
},

onToolCall: ({ tool }) => {
  // v3.2.25: no-op — Discord tool calls shouldn't
  // show on mobile.
  console.log(`[openclaw-tail] ignoring tool call tool=${tool} for Discord session (no mobile broadcast)`);
},
```

## Channel separation, post-fix

```
User → mobile chat → desktop pipeline →
  addChatMsg → sync-broadcast-chat → mobile ✓

User → voice mode → desktop pipeline →
  addChatMsg → sync-broadcast-chat → mobile ✓

User → Discord → OpenClaw → agent reply →
  OpenClaw message tool → Discord ✓ (NOT mobile)

User → webchat → OpenClaw → agent reply →
  OpenClaw message tool → webchat ✓ (NOT mobile)

Cron / scheduled agent run →
  OpenClaw message tool → Discord / wherever ✓ (NOT mobile)
```

The cyberclaw chat pipeline path (mobile + voice) is
the ONLY path that broadcasts to mobile. Other
channels stay isolated.

## What this breaks

Nothing — the chat pipeline path already handles
mobile + voice broadcasts. The tailer was redundant
for that case (it was added because the original
"missing message" bug was actually a different
problem, fixed in v3.10.x dedupe work).

The renderer-side IPC (`openclaw-session-chat-message`)
still fires so the desktop's chat panel sees Discord
messages if the user views the chat there. That's the
right behavior — the desktop shows all conversations,
the mobile only shows in-app conversations.

## Files changed

- `src/main.js`:
  - `openclawSessionTail.onChatMessage`: removed
    `syncServer.broadcastChatMessage` call, kept
    renderer IPC
  - `openclawSessionTail.onTyping`: no-op (was
    `syncServer.broadcastTyping`)
  - `openclawSessionTail.onToolCall`: no-op (was
    `syncServer._broadcast({type: 'agent_tool', ...})`)
- `package.json` — version 3.2.24 → 3.2.25

## Companion mobile note

No mobile change needed. The mobile's listeners
(`syncClient.on('typing', ...)`, `syncClient.on('agent_tool', ...)`,
`onChat`) still exist — they just stop receiving events
for Discord-routed runs.

## Lessons

**Channel bridging should be opt-in per channel.**
The original v3.2.21 tailer was "bridge ALL assistant
messages from Discord sessions to mobile" — too broad.
The correct framing is "broadcast messages the user
initiated via the mobile." Each channel decides
independently whether to broadcast to mobile. Discord
routing doesn't have user-initiated-via-mobile, so
it doesn't broadcast.

**Side-channel bridges are easy to over-broadcast.**
This is the third time (after v3.10.89 dedupe
swallowing re-sends, and v3.2.22 tailer spamming
mid-run messages) the bridge between channels has
caused user-visible bugs. The pattern: side channel
broadcasts should be EXPLICIT (only when there's a
specific user intent), not implicit (broadcast
everything that matches a heuristic).

**Renderer-side state ≠ mobile-side state.**
The renderer's `chatHistoryByAgent` is the desktop
chat panel's truth. The mobile's `messagesByAgent` is
its own truth. They share via broadcasts but are not
the same thing. Updates to one don't need to propagate
to the other — each side decides what to display.
Treating them as identical was the bug.