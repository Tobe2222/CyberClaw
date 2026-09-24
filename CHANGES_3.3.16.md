# v3.3.16 — `_sendFullState` always re-broadcasts fresh, replays tagged

Companion to mobile v3.11.2. After shipping v3.11.2 (the
chat-flash / chat-stuck fix), Tobe clarified the bug was
NOT a flash — the chat **stayed** on the wrong quest
until he navigated Quests and back. That meant the mobile
listener permanently adopted the wrong active quest via
Case 1 (no anchor yet, adopt broadcast).

Under the original v3.11.2 design, the first broadcast
the listener sees could be a stale cached replay served
from `_lastQuestsList`. The cache can drift relative to
disk (e.g. the desktop restarted while the cache held a
transient value, or the mobile connected before any
saveQuests fired in this process boot). The mobile
seeded the anchor at that stale value, and every
subsequent legitimate broadcast got ignored under Case
3.

## What changed

### `broadcastQuestsList` (sync-server.js)

Tags every fresh broadcast with `source: 'broadcast'`:

```js
const payload = {
  type: 'quests_list',
  quests: Array.isArray(quests) ? quests : [],
  ts: Date.now(),
  source: 'broadcast',
};
this._lastQuestsList = { payload, ts: Date.now() };
```

### `_sendFullState` (sync-server.js)

Always calls `onRequestQuestsList()` first to re-broadcast
fresh, in addition to (or instead of) the cache replay.
The cache replay is also tagged `source: 'cache_replay'`:

```js
if (this.onRequestQuestsList) {
  try { this.onRequestQuestsList(); } catch (e) { … }
  // Also send cache immediately (tagged as such) so the
  // mobile doesn't have to wait for the fresh-broadcast
  // round-trip.
  if (this._lastQuestsList) {
    const replayPayload = {
      ...this._lastQuestsList.payload,
      source: 'cache_replay',
    };
    this._send(ws, replayPayload);
  }
} else if (this._lastQuestsList) {
  // Defensive cache-only fallback.
  this._send(ws, this._lastQuestsList.payload);
}
```

The mobile gets two messages in quick succession on
auth-time `_sendFullState`:
1. Cache replay (instant, tagged `source: 'cache_replay'`)
2. Fresh broadcast (a tick later, tagged `source: 'broadcast'`)

The mobile's listener treats the cache replay as data-only
(populates the quest list, doesn't seed the anchor) and
the fresh broadcast as authoritative (can seed the
anchor).

### `request_quests_list` cache fallback

Same tag, same data-only treatment on the mobile side.
The normal path (when `onRequestQuestsList` is registered)
already re-broadcasts fresh; the tag only matters in the
defensive fallback.

## Files changed

- `src/sync-server.js`
  - `broadcastQuestsList`: payload now includes
    `source: 'broadcast'`.
  - `_sendFullState`: calls `onRequestQuestsList()` first
    to re-broadcast fresh; cache replay tagged
    `source: 'cache_replay'`.
  - `request_quests_list` cache fallback: replay
    payload tagged `source: 'cache_replay'`.

## Compatibility

- Wire format: extended, not breaking. Old clients (pre-
  v3.11.2 mobile) ignore the `source` field; they fall
  back to the original v3.11.2 anchor logic (adopt every
  broadcast). New clients (v3.11.2 mobile) prefer fresh
  broadcasts.
- `request_quests_list`: the cache fallback now requires
  `onRequestQuestsList` to be registered (it always is in
  production). If unregistered (defensive), the behavior
  matches the previous release.

## Verified

- `node --check src/sync-server.js` passes.
- Hand-trace: mobile connects → `_sendFullState` sends
  cache replay (tagged) + triggers `onRequestQuestsList`
  which broadcasts fresh (tagged). Mobile listener:
  cache replay hits `if (!isFreshBroadcast)` early-return,
  populates data; fresh broadcast hits Case 1, seeds
  anchor correctly.
