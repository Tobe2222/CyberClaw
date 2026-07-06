# v3.1.50

Per-companion silence (mobile-pushed in v3.7.2+) is now persisted
on the desktop and replayed to other connected phones. This
delivers the "consistent companion" goal for the voice-loop
setting: a phone reinstall recovers the silence value from the
desktop on auth, and the desktop's own voice-mode loop uses
the same per-companion value (interpreted as a max-recording
floor — see the "Semantic mapping" note below).

## Wire-protocol additions

| Direction | Message | Shape |
|---|---|---|
| Phone → Desktop | `set_companion_silence` | `{ type, agentId, silenceMs }` |
| Desktop → Phone | `set_companion_silence_result` | `{ type, ok, agentId, silenceMs?, error? }` (origin only) |
| Desktop → Phone (broadcast) | `companion_settings_sync` | `{ type, settings: { [agentId]: { silenceMs } }, ts }` |

`companion_settings_sync` is broadcast in three situations:
1. When a phone pushes a new silence value (so other connected
   phones see the change immediately).
2. On any `set_companion_silence` write (same broadcast).
3. On every `auth` (replay path in `_sendFullState`) so a
   freshly-paired or reconnected phone gets the full snapshot
   without having to wait for a fresh push.

## Storage

New file: `~/.openclaw/cyberclaw/companion-settings.json`

Shape:
```json
{
  "<agentId>": { "silenceMs": 3000, "updatedAt": 1749999999000 }
}
```

Why a separate file (not agents/<id>/settings.json or
openclaw.json): these are mobile-pushed values. Keeping them
out of the agent's primary config avoids clobbering the
openclaw agents/<id>/ schema with a field the desktop never
writes on its own. The desktop's only writes here are
re-broadcasts of what the phone pushed.

## Desktop voice-mode loop (main.js:2328)

The `voice:start-recording` IPC handler now accepts an
optional `agentId` arg. When present, it looks up the
per-companion `silenceMs` and applies it as a FLOOR on the
renderer's `durationMs` (default 15000). The floor prevents
a short phone-side silenceMs (e.g. 2s for a chatty
companion) from chopping off long utterances on the desktop.

### Semantic mapping (important)

The phone's `silenceMs` means "end the turn after N ms of
silence". The desktop's `durationMs` means "record for at
most N seconds, then transcribe". These are conceptually
different. v3.1.50 keeps the *value* shared (single source
of truth: the phone), but lets the desktop interpret it
as a *floor* on its own duration cap. The result: a phone
set to 2s silence still records at least 15s on the desktop
for that companion; a phone set to 20s silence causes the
desktop to record 20s for that companion.

The right longer-term fix is to make the desktop's voice
loop silence-detected instead of duration-capped (same
`arecord` streaming + RMS monitoring the mobile uses), so
the same `silenceMs` means the same thing on both sides.
That's a v3.2.0 desktop voice-loop rewrite, separate scope.

## Renderer change (src/js/app.js)

The `voice:start-recording` IPC call now passes
`activeChatAgentId` alongside `durationMs` so main.js can
look up the per-companion value.

## Files changed

- `src/main.js`:
  - `COMPANION_SETTINGS_FILE` constant + `loadCompanionSettings`
    / `saveCompanionSettings` / `getCompanionSetting` /
    `setCompanionSetting` helpers.
  - Exposed `_setCompanionSetting` / `_getCompanionSetting` /
    `_getAllCompanionSettings` on the sync-server so the
    `set_companion_silence` case can write to and read from
    the same companion-settings.json.
  - `voice:start-recording` handler now resolves a per-companion
    floor when `agentId` is provided.
- `src/sync-server.js`:
  - `case 'set_companion_silence':` — validates, delegates to
    `_setCompanionSetting`, replies with `set_companion_silence_result`
    to the origin, broadcasts `companion_settings_sync` to all
    clients.
  - `_sendFullState` now replays the full companion-settings
    snapshot on every auth.
- `src/js/app.js`:
  - `voice:start-recording` IPC call passes `activeChatAgentId`.

## Companion mobile change (Cyber_Claw_Mobile v3.7.3)

The mobile's `saveSilence` callback now also calls
`syncClient.setCompanionSilence(agentId, ms)` after the local
AsyncStorage write. The mobile's `CompanionSettingsScreen`
also subscribes to `companion_settings_sync` so a phone
reinstall that has no per-companion local value adopts the
desktop's value on auth.

See `Cyber_Claw_Mobile/CHANGES_3.7.3.md` for the mobile side.
