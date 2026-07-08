# v3.1.52 — Quests: always re-read from disk on explicit refresh

Tobe's v3.8.0 testing found that the SyncServer's
`_lastQuestsList` cache could serve stale data to the
mobile. The cache is supposed to be invalidated on every
save (via `broadcastQuestsList`), but the broadcast path
was failing silently in some scenario — the file got
updated but the cache didn't. Replays kept serving the
stale 2-quest list, so the mobile never saw the 4 new
quests that were actually on disk.

**Root cause:** investigation pending. The fix is
defensive: don't trust the cache for explicit refreshes
from the mobile.

## What changed

`src/sync-server.js`: in the `request_quests_list` case
(explicit refresh from the mobile), prefer
`onRequestQuestsList` (which re-reads from disk) over
the cache. The cache is still used for the initial
replay when the mobile first connects.

```js
case 'request_quests_list': {
  if (this.onRequestQuestsList) {
    try { this.onRequestQuestsList(); } catch (e) { ... }
  } else if (this._lastQuestsList) {
    this._send(ws, this._lastQuestsList.payload);
  }
  break;
}
```

The cost is negligible: `loadQuests` is O(n) over
typically <20 quests, and explicit refreshes are
sporadic (only when the user opens the Quests screen or
the auto-fire fires on auth).

## Files touched

- `src/sync-server.js` (reorder the `request_quests_list`
  case to prefer disk over cache)
- `package.json` (3.1.51 → 3.1.52)

## Investigation note

The broadcast path looks correct: `saveQuests` calls
`broadcastQuestsList` which updates `_lastQuestsList`
and broadcasts. But the log shows no subsequent
"Broadcasting quests_list" line after the initial
startup, even though the file was updated 4 times. So
either:

1. `saveQuests` isn't being called when quests are
   created (the file is being updated by something
   else?)
2. The `console.log` in `broadcastQuestsList` is being
   buffered by Electron's stdout and not making it to
   the nohup capture
3. There's a silent error in the broadcast path

The defensive fix in v3.1.52 (always read from disk on
explicit refresh) avoids the bug regardless of which
of these is the actual cause. Investigation will
continue in a future release.

## Companion release

- **Mobile v3.8.1** (already shipped) — the + New
  Quest button + hidden ⭐ on active card. No
  additional mobile change needed; the desktop fix
  makes the new quests appear.
