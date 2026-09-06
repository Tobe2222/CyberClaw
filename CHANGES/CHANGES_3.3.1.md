# v3.3.1 — Bump AGENT_TIMEOUT_MS from 10 min to 15 min

Tobe (2026-08-30 11:48, Discord #cyber-dev): "let's try a and b
first, but let's make it 15 min."

## Background

The desktop's chat send path wraps the LLM call in a
`Promise.race` against a hard-coded `AGENT_TIMEOUT_MS` constant.
When the race loses (timeout fires first), the chat bubble shows
an "agent call timed out" error card (rendered as a `taskSummary`
footer on mobile via v3.10.177), but the underlying LLM call
keeps running on the gateway — the timeout is purely a
UI-side affordance.

The cap was 600s (10 min), set in v3.2.58 to fix a 180s cap that
was firing too aggressively on multi-tool refactors. 10 min was
an improvement, but Tobe hit it on 2026-08-30 11:08 on a request
that actually completed at 11:09 — the work was legitimate but
slow because it spanned multiple sub-tasks (kpow save flow +
brand colors + cache buster + git tag/push/verify). Bumping to
15 min (900s) gives those multi-step jobs headroom without
leaving the user staring at a wedged bubble forever.

The OpenClaw gateway's default `agents.defaults.timeoutSeconds`
is `2880 * 60` (172800s = 48 hours). 900s stays well below that.

## What changed

### 1. `src/js/app.js` — `AGENT_TIMEOUT_MS`

Bumped from `600000` (10 min) to `900000` (15 min) at both call
sites:

- Main `sendChatMessage` path (line ~3144)
- Image-path `sendChatImage` (line ~6850)

The error string built inside the race loser preserves the
dynamic `AGENT_TIMEOUT_MS` value, so the chat bubble will now
read "current cap is AGENT_TIMEOUT_MS=900000ms=900s" instead of
the old 600000/600s.

### 2. `typingFailsafe` — 300000 to 600000

The failsafe is a separate `setTimeout` that clears the typing
bubble if the LLM is still "thinking" past a fixed deadline.
Previously 300s (5 min); bumped to 600s (10 min) so it stays
below the new 900s timeout. If the failsafe fires after the
race loser fires, the user sees two error events (the failsafe
log + the timeout card); with the proportional bump, the
failsafe always fires well before the timeout, so only one
event surfaces.

### 3. What was NOT changed

- The Promise.race itself (still UI-side, not abort signal)
- The underlying LLM call behavior on the gateway
- The error card structure (managed on the mobile side via
  v3.10.177)
- The sync protocol — desktop + mobile wire-compatible

## Files

`src/js/app.js`:
- Line ~3144: `AGENT_TIMEOUT_MS = 600000` → `900000`
- Line ~3148: `typingFailsafe` timeout 300000 → 600000 + log
  string update
- Line ~6850: same AGENT_TIMEOUT_MS bump
- Line ~6853: same typingFailsafe bump + log string update

`package.json` 3.3.0 → 3.3.1.

## Verification

- `npm start` in dev mode, send a long-running request, confirm
  the chat bubble stays in "thinking" state for the full 15 min
  before the error card appears (instead of 10 min).
- The log entry should read "AI still thinking after 600s —
  clearing indicator" instead of "after 300s".

## Lesson

**Two timeouts sharing a UI affordance need to be
proportional.** The Promise.race timeout is "the LLM call has
given up on this user, surface an error" — that's a soft cap on
the user experience. The typingFailsafe is "the typing bubble
has been here too long without activity, hide it" — that's a
hard cap on visible UI noise. Bumping one without the other
leaves a window where the failsafe fires AFTER the timeout, and
the user sees the typing bubble vanish followed by the error
card — confusing. The failsafe must always be < the race
timeout.
