# v3.2.37 — Agent-call timeout + finally-based typing-cleanup

## What changed

### 1. Agent call now has a hard 90s timeout

`sendChatMessage()` (both the typed-input path AND the
desktop's image-attach path inside `sendChat:img`)
wraps the openclaw IPC in a `Promise.race` with a
90-second timeout. The IPC's own timeout is 120s, but
the user-facing cleanup needs to fire on a tighter
window than that — 90s gives the typical IPC error
("openclaw -m ... timed out") a chance to land first,
but if anything goes silently wrong server-side, the
race rejects and we surface the error.

Tobe's 2026-07-29 feedback: "And the clawsuu is
working seems to disappear from time to time. Perhaps
when i minimize and open the app again a little
later. And its still only saying thinking."

The old code had `try { result = await ... } catch
{ removeChatMsg(typingId) }`. The catch only catches
THROWS. A truly hung openclaw call (process exists but
never returns) would block the `await` indefinitely,
and `removeChatMsg` would never run. The result was
exactly what Tobe described: the "thinking..." bubble
stuck, then on top of that, `chatBusy=true` block the
NEXT message for 15s before the queue force-reset.

### 2. `finally` block for typing-cleanup

Both paths now wrap everything in `try { ... } finally
{ removeChatMsg(typingId); ipcRenderer.invoke('sync-
broadcast-typing', { active: false }); chatBusy = false;
}`. The cleanup runs no matter what path is taken —
success, error, timeout, or even an `await` rejection.

`chatBusy = false` was previously OUTSIDE the try
block (line ~2634 in app.js), which meant a hung
`await` would skip it entirely. Moving it into the
finally block means the next user message always
goes through immediately — no more 15s queue wait
after a hang.

### 3. 110s typing-failsafe

A `setTimeout(..., 110000)` runs as a belt-and-
suspenders failsafe. If the main thread is wedged
enough that even the `finally` block doesn't run, this
fires after 110s and force-clears the typing bubble
plus sets typing-off on the mobile sync. The user
sees the desktop log warn "AI still thinking after
110s — clearing indicator" but at least the bubble
goes away and the app remains responsive.

This is what Tobe saw: long stretches with no reply,
no typing indicator update, no chance to send another
message. With these three layers stacked, the worst
case is a 90-110s pause where the chat logs explain
what's happening, and then the bubble clears
automatically.

## Where

- `src/js/app.js` — `sendChatMessage` (the IPC caller
  from `mobile-chat` and voice_transcript handlers) and
  the local image-attach path (`window.sendChat =
  async function() { ... }` patch around line 5630+).

versionCode: n/a (desktop)
