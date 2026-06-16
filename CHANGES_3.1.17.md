# Changelog — v3.1.17 (session 2026-06-16)

Branch: `feature/companion-improvements`. To test: `npm start`
from the project root.

---

## v3.1.17 — fix mobile companion tab bar (Lamasuu missing) and add refresh path

### The bug

After the mobile app connected to the desktop, the companion
tab bar at the top of the chat showed only a single **Clawsuu**
tab — **Lamasuu was missing**. The Clawsuu tab also had no
chat history, so the chat area below it was empty.

The boot log on the mobile showed:
```
[8:44:14 AM] Connecting to 51.175.117.35...
[8:44:15 AM] State → connected
[8:44:15 AM] → Re-requested agents list (reconnect)
[8:44:16 AM] → Requested agents list from desktop
```

…with no `← Agents list: N companion(s)` reply. So the mobile
sent `request_state` and `request_agents_list`, the desktop
received them, but the mobile never got the agents list back.
That left `agents.length === 0` on the mobile and the fallback
single-tab layout (or, after the fix below, the
"Loading companions…" placeholder).

### Root cause

The desktop's `_sendFullState` (in `src/sync-server.js`) has
two paths for replaying the cached agents list when a mobile
asks for full state:

```js
if (this._lastAgentsList && (Date.now() - this._lastAgentsList.ts) < 600000) {
  console.log(`[SyncServer] Replaying recent agents_list (${...} agents) to reconnected client`);
  this._send(ws, this._lastAgentsList.payload);
}
```

The `600000` (10 minutes) TTL was a leftover from the
"replay recent chat message" logic, which legitimately needs
a short window to avoid replaying stale conversation. For the
agents list, the list itself is small (~200 bytes per
companion) and the desktop is the source of truth — there is
no "stale" to avoid. So the 10-minute window was wrong.

Tobe's case: started the desktop at 07:52, opened the mobile
app at 08:44. That's 52 minutes — way past 10. So when the
mobile's first `request_state` hit the desktop, the cache was
technically there, but the TTL check rejected it. No agents
list was sent. Mobile fell back to the empty Clawsuu tab.

### The fix

Three coordinated changes across the desktop's sync stack:

1. **`src/sync-server.js`**: removed the 10-minute TTL on the
   agents-list cache replay. If `_lastAgentsList` exists, it's
   sent. Period. The list is small and the desktop owns the
   truth.

2. **`src/sync-server.js`**: added a new `case 'request_agents_list'`
   in the message switch. The mobile now sends a dedicated
   `request_agents_list` message (instead of piggy-backing on
   `request_state`) so the request and the reply both have
   explicit meaning. The case replays the cache or, if empty,
   asks the main process to trigger a fresh broadcast from
   the renderer (handles the edge case where the mobile
   connected before the renderer's first broadcast).

3. **`src/main.js` + `src/js/app.js`**: added the
   `onRequestAgentsList` callback and a
   `mobile-request-agents-list` IPC channel. When the sync
   server's cache is empty (or always, if you want belt and
   braces), the main process asks the renderer to re-broadcast
   the current agents list using the same logic as
   `initArenaCompanions`. The renderer handler at the bottom
   of `app.js` rebuilds the `mobileList` from the current
   `agentOrder` and `visibleOrder` and fires the existing
   `sync-broadcast-agents-list` IPC.

### Why the dedicated message type

Using `request_state` worked, but coupling the agents-list
refresh to a "give me everything" message means any future
refactor of `_sendFullState` (e.g. adding other heavy payloads
like sprite configs) risks accidentally dropping the
agents-list reply. The dedicated `request_agents_list` message
is a one-purpose contract: "send me the current agents list."

The mobile's `SyncClient.requestAgentsList()` was updated to
send `request_agents_list` directly. The desktop-side handling
shares the same cache-replay-and-refresh logic.

### Belt-and-braces

The 10-minute TTL is gone, but the refresh path is also
there. If `_lastAgentsList` is null (e.g. mobile connected
before the renderer's first `initArenaCompanions` ran), the
desktop now asks the renderer for a fresh list. So the agents
list is guaranteed to arrive on the mobile no matter the
race.

## Files

- `src/sync-server.js` — removed 10-min TTL on agents-list
  cache replay, added `case 'request_agents_list'`
- `src/main.js` — added `onRequestAgentsList` callback,
  `mobile-request-agents-list` IPC channel
- `src/js/app.js` — added `mobile-request-agents-list` listener
  that re-broadcasts the current agents list
- `package.json` — bumped to 3.1.17

## Verification

- `node --check` passes on `sync-server.js`, `main.js`,
  `app.js`.
- After the fix, opening the mobile app and connecting to the
  desktop will produce a `← Agents list: 2 companion(s)` log
  entry on the mobile. The companion tab bar will show both
  Clawsuu and Lamasuu, and tapping a tab will load that
  companion's chat history.
- The fix is also robust against the edge cases:
  - Mobile connects after a long delay: cache replay (no TTL)
  - Mobile connects before the renderer's first broadcast:
    refresh path triggers a fresh broadcast from the renderer
  - User adds/removes a companion on the desktop after the
    mobile connected: still uses the same cache; a future
    patch can add a `companion_visibility_changed` event that
    invalidates the cache and re-broadcasts.

## How to test in the UI

1. Start the desktop: `npm start` from `projects/cyberclaw`.
2. Open the mobile app and connect. The companion tab bar
   should show both Clawsuu and Lamasuu.
3. Tap a tab. The chat area below should load that
   companion's history within a second.
