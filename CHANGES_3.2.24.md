# 3.2.24 — mobile activity heartbeat (companions sleep correctly on mobile too)

Tobe reported on v3.2.23 (2026-07-23 23:28):

> "@Clawsuu also. The companions should sleep on the
> mobile also like they do on desktop. And wake up
> when engaded with"

## Root cause

The desktop has `scheduleAutoSleep()` (v3.1.4) that
runs every minute and checks `now - lastInteractionTs >
AUTO_SLEEP_AFTER_MS` (12 min default). It flips
`sleepState` to 'sleeping' if the user hasn't
interacted recently.

`lastInteractionTs` is bumped via `bumpCompanionInteraction(agentId)`
which is called from:
- Desktop chat submit (`sendChatMessage`)
- Desktop voice mode entry
- Desktop focus changes / agent toggles
- Mobile chat submit (via `sendChatMessage` IPC)
- Mobile voice mode entry (via `sendWakeAgent`)
- Mobile arena treat dropped

But NOT from:
- Mobile passive chat viewing (just looking at messages,
  no submit / no voice / no treat)
- Mobile companion-tab switching without sending

So a user who ONLY uses the mobile to read chat (no
sending, no voice, no treats) has `lastInteractionTs`
stuck at the last desktop-side interaction. After
12 min the desktop auto-sleeps the companion, but the
mobile-side lastInteractionTs doesn't reset, so the
mobile's perception of activity is decoupled from
the desktop's auto-sleep timer.

Mobile-side rendering: the desktop's
`broadcastAgentsListToMobile()` includes `sleepState`,
so the mobile DOES render the sleeping visual (v3.10.43
added the "💤 sleeping" overlay + opacity dim). The
visual is correct — the gap is that the user feels the
companion shouldn't be sleeping while they're actively
engaged with chat on mobile.

## Fix

Mobile-side activity heartbeat. Every 30s while the
chat tab is open + app is foregrounded + connected,
the mobile sends `mobile_activity_ping` to the
desktop. The desktop bumps `lastInteractionTs` on
the targeted agent via the existing
`bumpCompanionInteraction()` function.

### Why 30s

12 min budget × 60s/min ÷ 30s/ping = 24 pings per
window. Even if half are dropped (background,
network), 12 pings still arrive in 12 min, more than
enough to keep the timer reset.

Pinging more often (e.g. every 5s) wastes battery.
Pinging less often (e.g. every 2 min) risks missing
the 12-min window.

### Why only when chat tab open + app foregrounded

Three conditions must hold:
1. **activeTab === 'chat'** — user is viewing the chat
   tab. If they're on Events or Log, they're not
   engaging with the companion.
2. **appState === 'active'** — app is in foreground.
   When backgrounded, the user might not be
   interacting at all (or might be using a different
   app). No point bumping the desktop's timer.
3. **isConnected** — WS is open. If disconnected, the
   ping won't reach the desktop anyway.

If all three hold, ping. Otherwise skip. The desktop
already receives bumps via sendChat / sendWakeAgent
when the user actually engages, so the ping is only
a fallback for the "actively reading but not
interacting" case.

### Why ping doesn't wake a sleeping companion

The ping is for "I'm still here, don't auto-sleep me."
It only resets the timer; it doesn't flip sleepState.
Waking a sleeping companion requires actual engagement
(chat / voice / treat / explicit wake button). Passive
viewing shouldn't wake a sleeping companion — only
prevent it from falling asleep in the first place.

If the companion is ALREADY sleeping when the user
opens the chat on mobile, the ping won't wake it. The
user has to send a message (or use the wake button)
to wake it. This is intentional: passive viewing
shouldn't have side effects.

## Files changed

### Desktop

- `src/sync-server.js`:
  - Added `case 'mobile_activity_ping':` handler that
    calls `this.onMobileActivityPing(agentId, meta)`
- `src/main.js`:
  - Added `onMobileActivityPing: (agentId, meta) => ...`
    that forwards to the renderer via
    `mainWindow.webContents.send('mobile-activity-ping', { agentId })`
- `src/js/app.js`:
  - Added `ipcRenderer.on('mobile-activity-ping', ...)`
    handler that calls `bumpCompanionInteraction(id)`
    on the targeted agent. Reuses the same function
    that desktop chat/voice/treat calls.
- `package.json` — version 3.2.23 → 3.2.24

### Mobile

- `src/services/SyncClient.ts`:
  - Added `sendActivityPing(agentId = 'companion')` that
    sends `{ type: 'mobile_activity_ping', agentId }`
- `src/screens/HomeScreen.tsx`:
  - New useEffect that starts a 30s interval timer when
    `[isConnected, activeTab]` changes. Timer calls
    `syncClient.sendActivityPing(...)` only if
    `activeTab === 'chat'` AND `appState === 'active'`
    AND `isConnected`. Fires one immediate ping on tab
    change / connect so the desktop sees activity
    within seconds, not after a 30s wait.
- `package.json` — version 3.10.90 → 3.10.91
- `android/app/build.gradle` — versionCode 314→315

## Lessons

**Asymmetric platforms need symmetric state.** The
desktop tracks activity via its own events. The
mobile has its own events. The companion's
lastInteractionTs is a SHARED state on the desktop,
but only updated by desktop-side + chat-submit events.
A mobile-only engagement pattern (read chat, don't
send) didn't fit the desktop's event model. Adding
the heartbeat closes the gap.

**Ping intervals are budgets.** 30s × 24 = 12 min
budget. This is the edge — the auto-sleep check
runs every minute, so as long as 1 ping arrives per
check window, the timer is reset. Don't ping less
than ~1/12 of the auto-sleep window.

**Reset timers don't wake things.** Tempting to have
the ping also flip sleepState to 'awake' (so opening
the chat wakes a sleeping companion). But that's a
side effect — passive viewing shouldn't have side
effects. Active engagement (chat / voice / treat)
should be required to wake. The ping only delays
auto-sleep; it doesn't override it.

**Three-condition gates reduce false positives.**
Gating on `activeTab === 'chat' && appState === 'active'
&& isConnected` means the ping fires only when the
user is actually looking at chat on a foregrounded
mobile with a live WS connection. False positives
(wasting battery pinging when user is on the Events
tab or in another app) are eliminated.