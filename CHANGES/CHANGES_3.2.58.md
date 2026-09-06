# v3.2.58 — bump desktop agent-call timeout 180s → 600s

## The bug

the user 2026-08-03 11:18 in #cyber-dev:
> "Often get this error timeout message. I don't get this on
> Discord, why do we get this on CyberClaw? It should have the
> same timeout etc."

Screenshot showed the chat bubble:
> "Error: agent call timed out (90s+ legacy string; actual
> cap is AGENT_TIMEOUT_MS=180000ms)"

## Root cause

The desktop's `sendChatMessage` wraps the LLM call in a
`Promise.race(...)` with a hardcoded 180s timeout
(`AGENT_TIMEOUT_MS = 180000`). When the LLM call takes longer
than 180s (multi-tool code refactor, long file write, etc.),
the desktop rejects the local promise and surfaces the error
in the chat bubble.

The underlying LLM call keeps running on the openclaw gateway
in the background — the gateway's default `timeoutSeconds`
is 172800 (48 hours; see `timeout-Drw0_zOv.js` in the
openclaw dist). So the reply eventually arrives via the
OpenClaw session-tail watcher and lands in chat history.
The user just sees a confusing error message in the interim
and might think the task failed.

**Why Discord doesn't see this:** the Discord channel adapter
in openclaw doesn't have a per-message UI-side cap. It just
spawns the agent and waits. The 180s was a desktop-only
choice (predates v3.2.51) and was tuned for short turn-taking
chats, not multi-tool refactors.

The "90s+" legacy string in the error message is because the
original 90s cap was bumped to 180s in v3.2.46 but the error
message wasn't updated. Confusing.

## The fix

`AGENT_TIMEOUT_MS` 180s → 600s (10 minutes) in both the main
`sendChatMessage` path and the image-attach path. Typing-
failsafe 110s → 300s. Error message updated to:
- drop the misleading "90s+" legacy string
- include the actual cap in seconds
- note that the LLM call may still complete in the background

Future plan: add a "still working" status line that updates
the chat bubble every 30s past the 5-min mark, so the user
isn't staring at "thinking..." forever and isn't seeing an
error when the LLM is actually working.

## Files

- `src/js/app.js` — bumped `AGENT_TIMEOUT_MS` in both
  `sendChatMessage` (line 2917) and `sendChatMessageWithImage`
  (line 6272). Updated typing-failsafe timer. Updated error
  message.
- `package.json` — 3.2.57 → 3.2.58

**v3.2.58 (desktop).**

## Why 600s not 6000s

Could go higher, but 10 minutes is enough for any realistic
multi-tool task and the user shouldn't wait longer than 10
minutes for a chat reply without seeing some indication of
progress. The OpenClaw gateway will keep the LLM running
longer if needed; the error at 600s just surfaces that the
chat reply is taking unusually long.