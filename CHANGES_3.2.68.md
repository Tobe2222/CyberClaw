# v3.2.68 — relax HTTP timeout to 600s and stop falling through to CLI on timeout

Tobe 2026-08-05 11:00:
> "now it timed out again. Cant it just run longer
> if hes working?"

## What changed

v3.2.65 added a 60s HTTP fetch timeout on
`chat:send-message` to fix the "wedged gateway lane →
5 minute hang" bug. The fix was too aggressive:

1. **60s is too short for legitimate work.** Complex
   tasks (multi-tool code refactors, BOS+ protobuf
   reasoning, anything that triggers several tool
   calls) routinely exceed 60s. Tobe's 10:44 AM
   message about "heaters are basically miners, just
   call them all devices" needed real model work and
   got aborted at 60s with `Error: agent call timed
   out (current cap is AGENT_TIMEOUT_MS=600000ms=600s)`.

2. **Falling through to `sendChatMessageViaCli` on
   abort created duplicate replies.** The CLI
   fallback spawns a NEW isolated `openclaw agent`
   session. So the user got:
   - The CLI session's reply (immediate, ~10s)
   - The late HTTP session's reply (delayed, when
     the original model call finally finished)
   Both went to the mobile chat bubble. Worse than
   no fix at all.

## The fix

- **Bumped `httpTimeoutMs` from 60s to 600s** to
  match the renderer-side UI cap (Promise.race
  `AGENT_TIMEOUT_MS = 600000` in `app.js`). Legitimate
  long calls now have headroom.
- **On abort, return a clean timeout error directly.**
  Don't fall through to CLI on `AbortError`. Non-abort
  failures (network unreachable, malformed token,
  gateway crash) still fall through to CLI because
  for those, a duplicate reply is better than no
  reply.

The "wedged lane forever" scenario from earlier
today is still handled — the renderer-side 600s cap
in `app.js` fires `Promise.race` reject and shows
the user the timeout error. The original IPC
promise rejects, the renderer's `Promise.race`
catches it, the user sees the message and can
retry.

## Files

- `src/main.js` — `sendChatMessageViaHttp`:
  - `httpTimeoutMs: 60000 → 600000`
  - On `AbortError`: return `{ ok: false, error:
    "HTTP request timed out after Xs...", timedOut:
    true }` instead of falling through to CLI
  - Non-abort failures (network unreachable, etc.)
    still fall through to CLI

## Lesson

When adding a fallback path to handle "the primary
might fail", be very careful about the failure mode
that triggers the fallback:

- **Primary genuinely unreachable / crashed**: fallback
  is a win — better duplicate reply than no reply.
- **Primary is slow / wedged**: fallback is a LOSS —
  the primary will eventually succeed, the fallback
  adds noise. Better to let the user retry or wait.

The distinguishing signal here is `AbortError` (our
own timeout, primary might still be working) vs
network errors (primary is down, fallback is the
only chance). Route them differently.

A 60s cap on a "the model is thinking" call is
also just wrong. Long LLM calls are normal,
especially with tool use. Match the cap to the
caller's expectations, not the worst-case "hung
forever" scenario.