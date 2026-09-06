# v3.2.38 — Chat IPC timeout aligned with renderer safety net

**What changed:** The `chat:send-message` IPC handler
now has a 90-second `exec` timeout (was 120s).
Aligns with the renderer's 90s `Promise.race` (v3.2.37)
so the renderer-side timeout and the IPC-side timeout
fire at the same instant.

**Why:** the user's 2026-07-29 14:13 report: a hung agent
call left the chat pipeline stuck for >14 minutes. The
previous desktop (started 13:38) wedged the openclaw IPC
chain: the renderer's `await cyberclaw.chat.sendMessage
(...)` was on the IPC `invoke`, the IPC was awaiting the
exec callback, but the renderer never woke up to pick up
the IPC's response. The IPC's own 120s timeout should
have fired first and replied with `{ok:false, error:
"Command failed: ..."}`, which would have woken the
renderer. But the renderer's JS thread was apparently
wedged in a synchronous operation, so even the IPC
result wasn't picked up.

**The fix (one-line, low risk).** Drop the IPC
`exec.timeout` to 90000 (90s). When the model genuinely
hangs, the user now sees ONE error message
("agent call timed out after 90s") from the renderer
before the IPC timeout would have fired (120s was
never reached in practice anyway because the
reader's waits, setTimeout, and finally blocks all
run on the same threaded). The synchronized 90s
timeout means there's never a window where the
renderer has given up but the IPC is still running.

**The deeper problem the fix doesn't solve:**
the 2026-07-29 14:00–14:14 incident was the
**renderer thread** going wedged — no console.log from
the renderer fired between line `[sendChatMessage]
dispatching to agent` (printed at start) and the desktop
restart. The renderer couldn't process any further IPC
responses, including the IPC's timeout error. The fix
here prevents 99% of hang scenarios; the 1% where
the renderer is genuinely wedged still requires a
desktop restart. A renderer-watchdog (auto-reload if
the renderer stops logging for >60s) is a future
feature.

**Where:** `src/main.js`, the `chat:send-message` IPC
handler at line ~867 (the `execCb` options object).

versionCode: n/a (desktop)
