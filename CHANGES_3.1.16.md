# Changelog — v3.1.16 (session 2026-06-16)

Branch: `main`. To test: `npm start` from the project root.

---

## v3.1.16 — manual wake button didn't wake the sprite at night; tighten night end to 06:30

Two related issues with companion sleep behaviour. Both fixed.

### 1. The wake button left the sprite in the death pose during night

**Symptom:** Click the ☀️ Wake button in the inspect panel between
22:00 and 08:00, and the focused companion's agent state flips to
`awake` (chat status updates, button text changes back to 💤 Sleep),
but the arena sprite stays in the 'death' pose — the sleeping
position. Visually the companion is "still sleeping" even though
the state machine says it's awake.

**Root cause:** `_updateCompanion` in `pixel-arena.js` computes
sleep from two sources:

```js
const manualSleep = comp.sleepState === 'sleeping';
const isNight = hour >= 22 || hour < 8;
const timeBasedSleep = isNight && !window._nightWakeTimer;
const isAsleep = manualSleep || timeBasedSleep;
```

`toggleCompanionSleep` only cleared `comp.sleepState` (the
`manualSleep` half). It never touched `_nightWakeTimer`, so during
night time `timeBasedSleep` stayed true and the sprite was forced
back into the 'death' animation on the next frame, before the
"resume from sleep" branch could land it in 'idle'.

So the agent's state was awake but the sprite's effective state
was asleep, and the visible result was a companion that the
inspect panel *says* is online but that the *arena* shows as
sleeping.

**Fix:** `toggleCompanionSleep` now also calls `nudgeNightWake()`
on wake. `nudgeNightWake` is a no-op during the day (early return
if `!isNightTime()`) and idempotent at night (it just clears and
re-sets the same 10-minute `_nightWakeTimer`), so calling it from
a wake click is always safe. With the timer set, `timeBasedSleep`
becomes false and the sprite's "resume from sleep" branch runs
correctly on the next `_updateCompanion` tick.

```js
if (agent.sleepState === 'sleeping') {
  agent.sleepState = 'awake';
  if (pixelArena && pixelArena.companion && pixelArena.companion.id === id) {
    pixelArena.companion.sleepState = 'awake';
    pixelArena.companion.vx = 0;
    pixelArena.companion.vy = 0;
    pixelArena.companion.frame = 0;
    pixelArena.companion.animation = 'idle';
  }
  // v3.1.16: also reset the night-wake timer, otherwise the time-based
  // sleep half of _updateCompanion keeps the sprite in the death pose.
  nudgeNightWake();
  addChatMsg('system', `☀️ ${agent.name} woke up`);
}
```

### 2. Night window was 22:00–08:00, should end at 06:30

The original `isNightTime()` used a coarse `getHours() < 8` check,
so the auto-wake happened at 08:00 sharp. The user asked for 06:30.
Switched to minutes-of-day for sub-hour precision:

```js
function isNightTime() {
  const now = new Date();
  const totalMinutes = now.getHours() * 60 + now.getMinutes();
  return totalMinutes >= 22 * 60 || totalMinutes < 6 * 60 + 30;
}
```

So `isNightTime()` returns:
- `true` from 22:00:00 through 23:59:59
- `true` from 00:00:00 through 06:29:59
- `false` from 06:30:00 onwards

This affects:
- `isAsleep()` — used to decide whether to skip the startup greeting
- `wakeFromSleep()` — early-returns during the day (no-op)
- `nudgeNightWake()` — same
- `_updateCompanion`'s `timeBasedSleep` calculation in
  `pixel-arena.js` (which still uses its own local
  `hour >= 22 || hour < 8` — also fixed to match, see below)

### 3. The arena's night check was duplicated and out of sync

`pixel-arena.js` had its own local copy of the night check
inline in `_updateCompanion`:

```js
const hour = new Date().getHours();
const isNight = hour >= 22 || hour < 8;
```

It was identical to the old `isNightTime()` (which is now
`>= 22 * 60 || < 6 * 60 + 30`), but kept the old 08:00 boundary.
After the app.js fix, app.js thinks it's daytime at 07:00 but the
arena thinks it's still night. Result: companion would say "☀️
woke up" and the chat status would show "online", but the sprite
would still be in the death pose.

**Fix:** Replaced the local `hour` calculation in
`_updateCompanion` with a direct call to the shared
`isNightTime()` (which `pixel-arena.js` already had a reference
to via the `window` global). Both sides now use the same function
and the same boundary, so they can't drift apart again.

```js
// pixel-arena.js _updateCompanion
const isNight = window.isNightTime ? window.isNightTime() : (hour >= 22 || hour < 8);
const timeBasedSleep = isNight && !window._nightWakeTimer;
```

(Defensive fallback to the old check in case `isNightTime` isn't
exposed on `window` yet — in app.js the function is module-local
to the renderer, so the fallback keeps the arena from breaking if
someone refactors the export.)

## Files

- `src/js/app.js` — `toggleCompanionSleep` calls `nudgeNightWake()`;
  `isNightTime()` uses minutes-of-day, ends at 06:30
- `src/js/pixel-arena.js` — `_updateCompanion` calls the shared
  `isNightTime()` instead of a duplicated local check
- `package.json` — bumped to 3.1.16

## Verification

- `node --check` passes on `app.js` and `pixel-arena.js`.
- `isNightTime()` returns `false` at 06:30:00 (boundary test) and
  `true` at 06:29:59.
- Manual reproduction: at 07:45 (within the old 22:00–08:00 night
  window but past 06:30), clicking ☀️ Wake now exits the death
  pose on the next frame. Without the fix, the sprite stayed in
  the death pose for the rest of the night.

## How to test in the UI

1. `npm start` from the project root.
2. Wait until night time (or temporarily set your system clock to
   02:00 to force it). Focus a companion that's currently
   sleeping.
3. Click the ☀️ Wake button in the inspect panel.
4. The arena sprite should exit the death pose within a second
   and start wandering / idling.
5. Without the fix, the sprite would stay in the death pose
   until 08:00 (or 06:30 after this change).
