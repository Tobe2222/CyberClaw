# v3.3.13 — Renderer crash + chat-pipeline sessionKey lookup

Tobe (2026-09-23 17:55, Discord #cyber-dev):
> "actually. I see that the desktop is bugged. Its not
> loading anything, that is likely the reason"

Two compounding bugs surfaced once Tobe started testing the
v3.3.12 mobile action log:

## Bug 1: Renderer crashed at boot

The renderer (`src/js/app.js`) was throwing `Uncaught
SyntaxError: Identifier 'pairingTimerInterval' has already
been declared`. Introduced in v3.3.10 (the forge model panel
refactor) which added a second `let pairingTimerInterval =
null;` at line 6802 without removing the original at line
6508.

Effect: the entire renderer JS failed to parse. None of the
chat UI loaded. The desktop's main process and sync server
kept running (so the SyncServer log shows mobile messages
being received and broadcast), but the renderer couldn't
display anything — including the chat log. From Tobe's
perspective: "the desktop is bugged, it's not loading
anything". The mobile sends reached the desktop but Tobe
never saw them on the desktop, AND the desktop's chat
pipeline (which runs in the renderer process) couldn't
process the message — so no agent reply was generated and
nothing got broadcast back to mobile.

The mobile-side "message disappeared" symptom Tobe
reported was the renderer-side chat pipeline being dead.

Fix: removed the redundant declaration at line 6802. The
module-level `pairingTimerInterval` at line 6508 is the
canonical one and is correctly referenced by
`window.generatePairingCode`.

## Bug 2: chat-pipeline tool events still invisible (separate from v3.3.12)

Even after the v3.3.12 inverted-gate fix, the tailer was
logging:

```
[LOG] 📡 OpenClaw tail — SessionTail: read 1 new lines
  from 7633a997-a2de-41ac-8aeb-34fc9d05f027.jsonl
  (delta=11030b, sessionKey=unknown)
```

The chat-pipeline session's sessionKey wasn't being resolved.
Root cause: `refreshSessionKeys()` was building the
`fileToKey` map using `s.sessionId` as the JSONL filename
basename:

```js
const fp = path.join(this.sessionsDir, `${s.sessionId}.jsonl`);
```

But OpenClaw now stores the JSONL path under `sessionFile`
(an absolute path), and `sessionId` is a separate
identifier (used for the OpenClaw session object, not for
the on-disk file). The disk filename UUID and the
`s.sessionId` UUID don't match.

Example from the live sessions.json at
`~/.openclaw/agents/clawsuu/sessions/sessions.json`:

```
s.sessionId = "c3508d4a-30c1-4400-98df-c6abeddc0b7b"
s.sessionFile = ".../7633a997-a2de-41ac-8aeb-34fc9d05f027.jsonl"
```

Old code: `fileToKey.set(<c3508d4a...jsonl>, sessionKey)`
Actual file: `<7633a997...jsonl>` → lookup misses → log
shows `sessionKey=unknown` → gate `if (!isDiscord &&
sessionKey)` is FALSE → onToolCall never fires.

This is a separate bug from the v3.3.12 inverted gate; it
was hidden by the v3.3.12 log lines
("suppressing tool call from Discord session...") which
showed the suppression path firing for Discord sessions
only. The chat-pipeline path was failing silently with no
log line.

Fix: use `s.sessionFile` basename when available, fall
back to `s.sessionId` for older sessions.json entries that
predate the rename:

```js
const fname = s.sessionFile
  ? path.basename(s.sessionFile)
  : (s.sessionId ? `${s.sessionId}.jsonl` : null);
if (fname) {
  const fp = path.join(this.sessionsDir, fname);
  this.fileToKey.set(fp, s.key || '');
}
```

After this fix the tailer logs:

```
[LOG] 📡 OpenClaw tail — SessionTail: read 1 new lines
  from 7633a997-a2de-41ac-8aeb-34fc9d05f027.jsonl
  (delta=11030b, sessionKey=agent:clawsuu:openai-user:cyberclaw:clawsuu)
```

The chat-pipeline session is now correctly resolved. Tool
calls from this session will fire `onToolCall` →
`toolFriendlyName` → `syncServer.sendToMobile({type:
'agent_tool', friendly, ...})` → mobile action log.

## User-visible effect

After desktop v3.3.13 + mobile v3.11.1:

- Renderer boots cleanly (no SyntaxError).
- Chat log displays correctly.
- Mobile chat sends reach the renderer chat pipeline, get
  routed to the agent, and the agent's reply broadcasts back
  to mobile as a chat_message bubble (this was BROKEN
  before this release — Tobe's "message disappeared" was
  the renderer being dead).
- Agent tool calls from the chat pipeline now broadcast as
  `agent_tool` events to mobile, populating the v3.11.1
  action log under the pulsing dot.

## Files changed

- `src/js/app.js` — removed the duplicate `let
  pairingTimerInterval = null;` at line 6802.
- `src/openclaw-session-tail.js` — `refreshSessionKeys()`
  now uses `s.sessionFile` basename for the JSONL filename
  lookup, with `s.sessionId` fallback.

## Compatibility

- Same as v3.3.12.
- No protocol changes.
- The renderer fix is required to get v3.3.12's tool
  broadcasts to actually reach the mobile's action log —
  the renderer needs to be alive for the user to have
  anything to see on the desktop side, and for the chat
  pipeline to route messages from the sync server to the
  agent.

## Tested

- `node --check` on both files passes.
- Manual sessions.json inspection confirms `sessionFile` is
  the right field.
- Mock `refreshSessionKeys()` invocation against the live
  sessions.json: target file `7633a997-...jsonl` resolves to
  `agent:clawsuu:openai-user:cyberclaw:clawsuu`
  (non-Discord → emit). ✓
- Desktop restarted with new code; live tailer log
  confirms `sessionKey=agent:clawsuu:openai-user:cyberclaw:clawsuu`
  (was `sessionKey=unknown` before). ✓
- Renderer boots cleanly: `[RI] [Chat] chat-messages
  element: found` (was failing to parse before). ✓