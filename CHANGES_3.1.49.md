# v3.1.49

Quest sync to mobile + remove dead `skills` field from quest editor.

This release is the desktop-side counterpart to the upcoming
mobile v3.7.4. It pushes the desktop's quest list to the
mobile over the existing WebSocket sync channel so each
companion tab on the phone can show the desktop's quests
(read-only for now).

## What changed

### `src/sync-server.js`

Two new methods + one new handler case, mirroring the
agents-list pattern from v3.1.15 / v3.1.17:

1. **`broadcastQuestsList(quests)`** — pushes
   `{ type: 'quests_list', quests: [...] }` to every
   connected mobile. Cache `_lastQuestsList` (same
   shape as `_lastAgentsList`) so reconnecting phones
   see the list without needing a renderer roundtrip.

2. **`case 'request_quests_list':`** in the inbound
   message handler. Mobile can ask for the list
   explicitly; replay cache if warm, otherwise ask the
   main process via `onRequestQuestsList`.

3. **`_sendFullState(ws)`** now also replays the last
   quests_list payload alongside agents_list, so a
   reconnect that triggers a full-state pull gets
   both lists in one round-trip.

### `src/main.js`

1. **`saveQuests()`** now broadcasts the fresh quest
   list after every write. Re-reads from disk before
   sending, so a malformed write doesn't propagate.

2. **Initial broadcast on sync-server boot** after
   `syncServer.start()`. Pre-warms the cache so a
   phone that connects right after desktop boot gets
   the list without waiting for the first user
   action.

3. **New `onRequestQuestsList` callback** wired in
   the `new SyncServer({...})` options. Reads
   `loadQuests()` and broadcasts directly — no
   renderer roundtrip needed (quests live in
   main.js's domain, agents list lives in the
   renderer's). One less IPC hop than agents.

4. **New IPC handler `sync-broadcast-quests-list`**
   so the renderer can push a fresh list
   explicitly if it ever needs to override the
   main.js auto-broadcast (currently unused — left
   in place for the future renderer-side hook,
   mirrors `sync-broadcast-agents-list`).

### `src/js/app.js`

**Removed `skills` field from quest editor.**
Three call-sites cleaned:

- `openQuestEditor` — no longer reads
  `quest.skills`, no longer renders the
  "Work Categories" checkbox grid.
- `saveQuestEdit` — no longer gathers the
  checkbox state, no longer passes `skills` in
  the IPC payload.

Existing quests with `skills` data in their
JSON keep the field for backward-compat but
the editor never surfaces it and the IPC
payload never sets it. Quest creation
(`cyberclaw.quests.create({...})`) already
didn't pass skills, so no change there.

**Why:** the `skills` field was redundant — the
companion already has its own per-skill XP dict
in `companion-stats.json`, and goal completion
already routes XP to the right skill on the
desktop side. The quest-level `skills` was a
ghost of an old "quest = project" model that
never got wired up. Tobe's calls for this in
the 2026-07-07 feedback thread.

## Wire protocol additions

**New inbound (mobile → desktop):**
```
{ type: 'request_quests_list' }
```

**New outbound (desktop → mobile):**
```
{ type: 'quests_list', quests: Quest[], ts: number }
```

Where `Quest` is the same object stored in
`~/.openclaw/cyberclaw/quests.json`:

```ts
type Quest = {
  id: string;             // short base36 id
  name: string;
  description?: string;
  status: 'active' | 'completed';
  directory?: string;     // project path (NOT ~./openclaw)
  goals?: Array<{ text: string; completed: boolean }>;
  created?: string;       // ISO timestamp
  // `skills` is now ignored everywhere on the desktop side
  [k: string]: any;       // forward-compat: new fields pass through
};
```

## Behavior

- Quest list updates push within ~1 RTT of any
  quest CRUD on the desktop (create/update/delete).
- Reconnects always replay the latest list as part
  of `_sendFullState`.
- If the phone opens the Quests tab before
  connecting, the SyncClient's auto-`request_quests_list`
  (sent 500ms after auth) populates the cache.
- `quest.directory` is sent over the wire and
  shown on the phone as a project path reference,
  but no data is copied into the phone-side
  filesystem. Per Tobe's "project stays clean,
  support data lives in ~/.openclaw/cyberclaw/"
  rule.

## Future work (not in this release)

- **Per-companion quest mapping.** Currently
  quests are global; the desktop tracks one
  `activeQuestId`. The arena highlight-by-active-quest
  idea from the feedback requires a per-companion
  "what quest is this companion currently on"
  mapping that doesn't exist yet. Defer until the
  desktop models it.

- **Mobile-side quest edits.** The phone renders
  read-only. Create / edit / delete flows stay on
  the desktop because they need filesystem access
  (directory picker, goal text editing, version
  detection from package.json). A future v2 could
  proxy directory-pick via the existing remote-tool
  bridge but the simplest plan is "edit on desktop,
  view on phone" for now.

- **Per-project support data** (`.cyberclaw-mobile/`
  inside `quest.directory`). Out of scope until the
  mobile actually persists anything beyond the
  mirror cache.

## Files modified

- `src/sync-server.js` — 3 additions (handler case, broadcast method, replay in _sendFullState)
- `src/main.js` — 4 additions (saveQuests broadcast, initial broadcast, onRequestQuestsList, sync-broadcast-quests-list IPC)
- `src/js/app.js` — 2 removals (skills from openQuestEditor, skills from saveQuestEdit)
- `CHANGES_3.1.49.md` (new)
- `package.json` — 3.1.48 → 3.1.49
