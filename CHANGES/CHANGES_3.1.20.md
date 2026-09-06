# Changelog — v3.1.20 (session 2026-06-16)

## v3.1.20 — re-broadcast agents_list to mobile after saveCompanion

The desktop's `saveCompanion` (called from the forge
when the user changes a companion's sprite, size, name,
or traits) was NOT re-broadcasting the updated agent
list to the mobile. The mobile would only see the new
size on the next 60s periodic sync or on reconnect.
That's why Lamasuu stayed at the old size on the mobile
even after the user resized it on the desktop.

### The fix

Factor the `agents_list` broadcast out of
`initArenaCompanions` into a reusable
`broadcastAgentsListToMobile()` function. Call it from
`saveCompanion` after a successful save. The function
uses the same `visibleOrder` construction (active chat
companion first, then the rest, minus hidden ones) so
the mobile's view of the agent list stays consistent
with the desktop's.

### Files

- `src/js/app.js`
  - Factored `broadcastAgentsListToMobile()` out of
    `initArenaCompanions`.
  - `saveCompanion` now calls
    `broadcastAgentsListToMobile()` after a successful
    save, so mobile sees sprite / scale / name changes
    immediately instead of waiting up to 60s.
- `package.json` — bumped to 3.1.20

### Verification

- `node --check` passes.
- After install, change a companion's size in the
  desktop forge → save → the mobile's companion
  resizes within ~500ms (the time for the IPC
  round-trip), not 60s.
- Change a companion's sprite in the desktop forge →
  save → the mobile's companion swaps sprites
  immediately.
