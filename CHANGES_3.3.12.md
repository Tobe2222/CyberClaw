# v3.3.12 — Tool-call events reach mobile chat pipeline

Tobe (2026-09-23 16:24, Discord #cyber-dev), 2026-09-23:
> "it would be cool to have it like claude has its web
> interface where you see the actions more or less also."

This is the desktop-side follow-up to the mobile v3.11.1
change. The mobile already wires up the action log
(`chatActions` rolling list, pulsing dot, fade in/out) and
the `onAgentTool` listener — but the desktop was suppressing
`agent_tool` events for every session, so the mobile never
received any.

## What changed

### Tool-call gate inverted in `openclaw-session-tail.js`

The tailer detects tool calls in the OpenClaw session JSONL
files. v3.2.21's original code gated detection on `if
(isDiscord)` — the comment said "we only emit for Discord-
routed sessions to match the chat pipeline scope (the
desktop's own pipeline already shows progress via the
renderer's typing bubble)". This was an inversion bug: the
chat pipeline shows progress on the DESKTOP renderer, not on
the MOBILE. The mobile had no way to see tool calls.

The v3.2.25 fix touched the message broadcast (correctly
suppressed Discord chat messages from polluting the mobile
chat) but extended the suppression to tool events too,
making every tool event from every session invisible to the
mobile.

v3.3.12 inverts the tool-call gate to match the original
intent:

```js
if (!isDiscord && sessionKey) {
  // Chat-pipeline session → emit tool events to mobile
  for (const part of msg.content) {
    if (part && part.type === 'toolCall' && part.name) {
      this.onLog('debug', `SessionTail: tool call detected: ${part.name} ...`);
      this.onToolCall({ tool: part.name, sessionKey });
    }
  }
} else if (isDiscord) {
  // v3.2.25: suppress Discord — mobile shouldn't react to
  // activity from conversations the user isn't having
  // in the app.
  this.onLog('debug', `SessionTail: suppressing tool call from Discord session ...`);
} else if (!sessionKey) {
  // No sessionKey mapping yet — refresh sessions.json and retry
}
```

Session classification (unchanged):
- `agent:clawsuu:main` (desktop typed chat) → emit
- `agent:clawsuu:web:discord:...` (Discord-routed) → suppress
- `agent:clawsuu:cron:...` (cron) → emit
- `agent:clawsuu:web:...` (non-Discord web) → emit
- empty/unknown sessionKey → defer until sessions.json updates

### `main.js` `onToolCall` callback now broadcasts

Was a no-op (just a console.log saying "ignoring tool call").
Now maps the raw tool name to a friendly text via the
existing `toolFriendlyName()` mapping (which has been in
main.js since v3.2.21 — see line ~380) and broadcasts:

```js
onToolCall: ({ tool, sessionKey }) => {
  const friendly = toolFriendlyName(tool);
  try {
    if (syncServer) {
      syncServer.sendToMobile({
        type: 'agent_tool',
        tool,
        friendly,
        sessionKey: sessionKey || '',
        ts: Date.now(),
      });
    }
  } catch (e) {
    console.warn(`[openclaw-tail] agent_tool broadcast failed: ${e?.message ?? e}`);
  }
},
```

The mobile (v3.11.1 HomeScreen `onAgentTool` listener)
already handles the `agent_tool` event:

```js
const onAgentTool = (msg: any) => {
  if (!msg || typeof msg.friendly !== 'string') return;
  setChatVoiceStatus(msg.friendly);
  setChatActions(prev => {
    const next = [...prev, friendly];
    return next.length > 3 ? next.slice(next.length - 3) : next;
  });
  appendTaskStep({ label: `tool: ${friendly.substring(0, 40)}` });
};
```

No mobile change needed beyond v3.11.1 — the wiring was
already there, just no events were ever being sent.

## User-visible effect

After updating to desktop v3.3.12 + mobile v3.11.1 (already
shipped), Tobe's mobile chat will show:

```
● Clawsuu is thinking...
  • Running command...
  • Reading file notes.md
  • Searching memory...
  • Writing file output.txt
```

The pulsing dot at the top is the persistent "is thinking..."
indicator (always shows while the agent is running). The
indented action list under it is the last 3 tool calls in
chronological order, with the most recent at full opacity and
older ones dimmed to 0.55. The list resets when each new
turn starts.

## Files changed

- `src/openclaw-session-tail.js`
  - Inverted the tool-call gate from `if (isDiscord)` to
    `if (!isDiscord && sessionKey)`.
  - Added a `v3.2.25`-style suppress log for Discord
    sessions.
  - Updated the comment block with the v3.3.12 design
    rationale and Tobe's 2026-09-23 quote.
- `src/main.js`
  - `onToolCall` callback (line ~4763): was a no-op; now
    maps the tool name to a friendly text and broadcasts
    via `syncServer.sendToMobile({ type: 'agent_tool', ... })`.
- `CHANGES_3.3.12.md` — this file.

## Compatibility

- Mobile version: requires v3.11.1 (already shipped) for the
  action-log + pulsing-dot UI.
- Sync protocol: `agent_tool` event shape is new but
  backward-compatible — older mobile versions that don't
  listen for it will simply ignore it (SyncClient's default
  case logs it but doesn't error).
- OpenClaw session JSONL: unchanged. We just changed which
  detections get acted on.
- Cron + non-Discord web sessions: now also get tool
  events. This was probably wanted all along (cron jobs run
  unattended, so no mobile noise; web sessions follow the
  same per-agent-not-per-channel rule as Discord but
  without the spam concern).

## Tested

- Manual: `isDiscordSessionKey` classification matrix
  (see verification script in commit message).
- Mock integration test: ran the new `onToolCall` callback
  with `syncServer.sendToMobile` mocked to capture
  payloads. Verified `exec` → "Running command...", `read`
  → "Reading file...", unknown tool → "Thinking..."
  fallthrough.
- Existing `node --check` passes on both files.