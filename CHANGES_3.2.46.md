# v3.2.46 — broadcast error messages to mobile, longer timeouts

## 1. Error messages now reach the mobile

**Tobe's report (2026-08-02 20:18):**
> "Something is wrong with the clawsuu is thinking now.
> It appeared for a few seconds then its gone. He cant
> possibly have done the task so fast so my guess is that
> he either replied and i cant see it or the message is
> buggy so it disappears when it should not."

**What was happening:** the IPC's 90s timeout fired because
the LLM was doing a multi-step task (editing 7 files —
Tobe's "windows taskbar icon, logo bigger, version control"
report). The openclaw process was clearly making progress
(20+ tool calls visible in `SessionTail`) but hadn't
finished. The IPC killed the process and returned
`{ok: false, error: '...timed out...'}`.

The renderer's `sendChatMessageImpl` called `addChatMsg('error',
'Error: ...timed out...')`. **But `addChatMsg` only
broadcasts `agent` and `user` messages to the mobile.**
Error messages stayed on the desktop renderer only.

The mobile's typing bubble then cleared (because the
renderer's finally ran `sync-broadcast-typing active: false`),
and the user saw the typing indicator vanish with no
follow-up. No agent reply, no error message — just
silence.

**Fix:** `addChatMsg` now also broadcasts `'error'` type
messages to the mobile. The mobile gets an error bubble
in the chat when the IPC fails (timeout, parse error,
exec error, etc.).

## 2. Bumped timeouts 90s → 180s

Both the IPC `exec` timeout in `main.js` and the
renderer's `Promise.race` timeout in `app.js` were 90s.
A 7-file edit task can easily take 30-90s of tool calls;
the 90s cap killed it mid-edit. 180s gives complex
multi-step tasks a fair shot at completing.

The two timeouts stay aligned (renderer Promise.race
fires first at 180s, IPC's exec timeout also at 180s)
so the user sees one coherent error message in either
case.

## 3. Side fix: chain wrapper now also broadcasts error messages

The v3.2.45 chain wrapper wraps the original impl in
try/finally to resolve the chain promise. With the
error broadcast fix in #1, errors now reach the mobile
even when they fire during a queued call. Tobe's chain
serialization isn't broken — same one-message-at-a-time
behavior, just with proper error visibility.

## Files changed

- `src/js/app.js`:
  - `addChatMsg`: broadcasts `'error'` messages to mobile
    (was agent/user only).
  - `AGENT_TIMEOUT_MS`: 90s → 180s.
- `src/main.js`:
  - `exec` IPC timeout: 90s → 180s.
- `package.json` — version 3.2.45 → 3.2.46

**v3.2.46 (desktop).**
