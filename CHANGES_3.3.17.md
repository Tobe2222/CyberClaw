# v3.3.17 — Surface verbose stderr / output in agent-failure error bubbles

Tobe (2026-09-24 ~12:15, Discord #cyber-dev), retest feedback
on v3.3.16 + mobile v3.11.2 (revised):

> "this error dont say much and i remember we had a fancier
> error earlier at some point which just had a problem with
> not showing until i send a new message. I tried that now
> but it did give a better explanation of the error."

## Root cause

The renderer's `sendChatMessage` (and the mobile-initiated
send path) only surfaced `result.error` (the friendly
summary like `"agent CLI exited with code 1"`) and dropped
`result.cliStderr` / `result.output` on the floor. The
verbose output was already populated by main.js (line
1422) and available on the IPC response, but the
renderer's `addChatMsg` call only used the friendly text.

The "fancier error" Tobe remembered was likely an earlier
version that surfaced stderr. The projection-effect bug
from v3.11.0 caused the error to not render until the next
send triggered a re-projection; v3.11.1 fixed the projection
effect so errors now render immediately, but the verbose
content was never restored.

## Fix

In both the desktop `sendChatMessage` path (app.js ~line
3287) and the mobile-initiated send path (~line 3645), build
the error message with both the friendly summary AND the
verbose output (truncated to 600 chars with a "truncated;
full output in desktop log" tail).

Both call sites now produce e.g.:
```
Error: agent CLI exited with code 1

```
<first 600 chars of stderr>
```
```

The full stderr is still available in the desktop log via
the `[chat:send/cli] child failed:` log line (main.js:1421)
for debugging.

## Files changed

- `src/js/app.js`
  - `sendChatMessage` error path (~line 3287): build
    error message with friendly summary + verbose stderr
    block, truncated.
  - `__sendChatMessageImpl` (mobile-initiated) error path
    (~line 3645): same fix.

## Compatibility

- Wire format: unchanged. `result.cliStderr` and
  `result.output` are existing fields on the IPC response
  that the renderer just wasn't using.
- Mobile display: the broadcast payload is the rendered
  error text. Mobile users see the friendly summary + the
  verbose block, exactly like the desktop renderer.
- Pre-existing errors without `cliStderr` / `output` (e.g.
  HTTP fetch failures) still show just the friendly text —
  the fix is a graceful add, not a regression.

## Verified

- `node --check src/js/app.js` passes.
- Hand-trace: Tobe's screenshot shows
  `"Error: agent CLI exited with code 1"` with no
  stderr. After this change, the next agent CLI failure
  on the same path will show the friendly summary plus
  the first 600 chars of stderr (e.g. the actual
  python/CLI traceback).
