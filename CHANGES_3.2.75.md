# v3.2.75 — remove diagnostic logs from v3.2.72/v3.2.73/v3.2.74

The root cause was found: the mobile side
(`HomeScreen.tsx` lines 1385 + 1396) was calling
`syncClient.send(JSON.stringify({...}))` — a
double-stringify. `SyncClient.send` already calls
`JSON.stringify` internally, so the actual WS
frame was a JSON-encoded string, not a JSON
object. The desktop's `JSON.parse` decoded the
outer JSON back to the inner string, `msg.type`
was undefined, and the case dispatch silently
fell through.

The fix lives in the mobile repo as v3.10.137
(commit `51fc5b1`). Once Tobe rebuilds and
installs the APK, the chat reaction will fire.

This commit removes the diagnostic logs added in
v3.2.72/73/74 from the desktop side since they
served their purpose (confirmed the message
never reached the sync-server) and are no
longer needed.

## Files

- `src/sync-server.js`:
  - remove `[SyncServer] msg type=...` per-message log
  - remove `[SyncServer] arena_treat_placed from ...`
  - remove `[SyncServer] arena_treat_eaten from ...`
- `src/main.js`:
  - remove `[Main] arena_treat_placed dispatched...`
  - remove `[Main] arena_treat_eaten dispatched...`

## The fix on the mobile side

```ts
// Before (v3.10.136 and earlier):
syncClient.send(JSON.stringify({
  type: 'arena_treat_placed',
  treat: msg.treat,
}));

// After (v3.10.137):
syncClient.send({
  type: 'arena_treat_placed',
  treat: msg.treat,
});
```

Tobe needs to `./build-android.sh` to produce a
new APK and install on his phone for the fix to
take effect. The JS bundle is baked into the APK
— no hot-reload possible.