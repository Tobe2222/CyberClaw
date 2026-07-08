# v3.1.51 — Phone-side quest edit: wire protocol + desktop handlers

Tobe: "yes we need edit ability on Phone" — greenlit the
v3.8.x series. This release is the **wire protocol + desktop
back-end** half of the v3.8.0 feature. The mobile half
(v3.8.0 mobile) ships the editor UI on top of this protocol.

## What changed

### 1. New wire protocol messages (5 inbound + 1 ack)

The mobile can now mutate quests over WebSocket. Each
inbound message routes to a callback in `main.js` that
performs the mutation using the same `loadQuests → modify →
saveQuests` flow the desktop's IPC handlers use. The
save triggers a `quests_list` broadcast (existing path)
so the mobile's optimistic update gets replaced with the
canonical data within ~100ms.

| Inbound from mobile          | What it does                          |
|------------------------------|---------------------------------------|
| `set_quest_active`           | Toggle `active: true` on a quest      |
| `update_quest`               | Update name / description / status    |
| `delete_quest`               | Remove a quest                        |
| `mark_quest_goal_done`       | Toggle a goal's completed flag        |
| `create_quest`               | Create a new quest                    |

| Outbound to mobile           | When                                  |
|------------------------------|---------------------------------------|
| `quests_update_failed`       | Mutation rejected (id not found etc.) |

The mobile uses the existing `quests_list` broadcast as
the implicit ack for successful mutations. No separate
success ack is sent — the broadcast IS the confirmation.

### 2. Desktop SyncServer: 5 new message cases

`src/sync-server.js` adds 5 new `case`s in the message
switch. Each one:
- Validates the client is authenticated
- Calls the appropriate callback (`onSetQuestActive`,
  `onUpdateQuest`, etc.)
- On failure, sends a `quests_update_failed` ack with
  the action name and id so the mobile can roll back

### 3. Desktop wiring: 5 new SyncServer callbacks

`src/main.js` adds the callbacks to the SyncServer
constructor options. Each callback does the same logic
as the corresponding IPC handler:

- `onSetQuestActive(id)` — sets `active: true` on the
  matching quest, `false` on the others, saves.
- `onUpdateQuest(id, updates)` — mutates fields on the
  quest, saves. Block-list for unsafe fields: `id`,
  `created`, `active`, `latestChanges`, `skills` (the
  user can change `active` via `set_quest_active`
  instead; `latestChanges` is desktop-only).
- `onDeleteQuest(id)` — filters the quest out, saves.
- `onMarkQuestGoalDone(id, goalIndex, completed)` —
  toggles a goal's flag, normalizes legacy string
  goals to object form, saves.
- `onCreateQuest(quest)` — assigns id + created + defaults
  (`status: 'active'`, `active: false`, `latestChanges:
  []`), unshifts to the top of the list, saves.

All five use the existing `saveQuests()` path which
broadcasts the updated list to all connected clients.

## Why a separate wire protocol layer (not reusing IPC)

The mobile can't use the Electron `ipcMain` IPC handlers
directly — those run in the renderer↔main-process context,
not over WebSocket. The SyncServer is the layer that
translates WebSocket messages into main-process actions.
By adding callbacks to the SyncServer wiring, the new
edit messages get the same validation + persistence
guarantees as the existing IPC handlers, with minimal
code duplication (the IPC handler bodies and the
SyncServer callbacks share the exact same logic).

The block-list on `onUpdateQuest` is a defensive
measure: the mobile COULD send any field, but we
explicitly reject writes to `id`, `created`, `active`,
`latestChanges`, and `skills`. The user has dedicated
messages for `set_quest_active`; the rest are
desktop-managed invariants.

## Files touched

- `src/sync-server.js` (5 new message cases, 1 ack)
- `src/main.js` (5 new SyncServer callbacks, ~80 lines)
- `package.json` (3.1.50 → 3.1.51)

## Companion release

- **Mobile v3.8.0** — ships the editor UI on top of this
  protocol. Edit / set-active / delete / mark-goal-done
  from the phone. Detail modal goal checkboxes are now
  tappable. Editor modal slides up from the bottom with
  name / description / status / active fields.

## Deferred to v3.8.1

- "+ New Quest" button on the Quests screen
- Android directory picker (Storage Access Framework)
- Goal text editor (add / remove / rename goals)
- Quest status auto-archive (auto-mark completed after
  all goals done)
