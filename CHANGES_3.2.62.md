# v3.2.62 — Quest directory update support + CYBERCLAW.md WS round-trip

## What shipped

### 1. Quest directory update + re-scaffold

When the mobile's quest editor changes a quest's
`directory` field (or types one into a previously
empty directory), the desktop's `quests:update` IPC
now:

- Detects the change (compares trimmed new vs old).
- No-ops if the new value matches the old one.
- Re-scaffolds the new directory: mkdir + writes
  INSTRUCTIONS.md placeholder + writes CONVERSATION.md
  placeholder. Idempotent (writes only if missing,
  never overwrites user content).
- Empty string clears the directory. The quest falls
  back to the v3.2.30 id-based path on the next read
  (`~/.openclaw/cyberclaw/quests/<id>/`). The id-based
  dir also gets re-scaffolded so the next write
  succeeds.
- Best-effort — a failed scaffold logs a warning and
  doesn't fail the update.

Files do NOT migrate. The desktop's choice of "re-
scaffold, don't copy files" is deliberate: the
quest's files (INSTRUCTIONS.md, CONVERSATION.md) are
tied to the project they describe, not the storage
path. Moving the directory is the right user signal
that the quest is now about a different folder.

The accompanying mobile change is v3.10.136's
"directory field always editable in the editor" —
they're a pair.

### 2. CYBERCLAW.md round-trip from mobile

Three new SyncServer callbacks + three new WS cases
so the mobile can read / write / reset the overarching
system prompt at `~/.openclaw/cyberclaw/CYBERCLAW.md`.

| WS message                  | SyncServer callback                | Reply event                   |
|----------------------------|------------------------------------|-------------------------------|
| `request_cyberclaw_system`  | `onGetCyberclawSystem`             | `cyberclaw_system`             |
| `save_cyberclaw_system`     | `onSaveCyberclawSystem(content)`   | `cyberclaw_system_saved`       |
| `reset_cyberclaw_system`    | `onResetCyberclawSystem`           | `cyberclaw_system_reset` + a fresh `cyberclaw_system` event |

The get / save / reset callbacks wrap the
pre-existing `system:*` IPC handlers from v3.2.32, so
the renderer-side System Prompt editor and the
mobile-side Settings editor hit the same
`companionPrompts.readSystemPrompt / writeSystemPrompt
/ resetSystemPrompt` functions. Single source of
truth.

Get returns `content + defaultContent + path`. The
`defaultContent` is the same constant the desktop
embeds (`companionPrompts.DEFAULT_SYSTEM_PROMPT`) so
the mobile can render a "Reset to default" button
without an extra fetch.

Save is async; the WS ack is `cyberclaw_system_saved
{ ok: true }` or `{ ok: false, error: ... }`.

Reset is a dual ack: `cyberclaw_system_reset { ok: true }`
followed by a fresh `cyberclaw_system` event carrying
the now-default content. The mobile updates its
textbox without an extra round-trip.

the user 2026-08-04 17:31: "did we have a cyberclaw md
also, outside of companions? If not we should have it
in the settings (editable with a warning that this
might break the companions behaviour)."

## Files

- `src/main.js`:
  - `quests:update` IPC: detects directory change,
    re-scaffolds via `scaffoldQuestDirectory`. Three
    cases (changed, equal, cleared).
  - Three new SyncServer callbacks inside the
    constructor args object:
    `onGetCyberclawSystem` (sync read with
    DEFAULT + path),
    `onSaveCyberclawSystem(content)` (writes via
    `companionPrompts.writeSystemPrompt`),
    `onResetCyberclawSystem` (delegates to
    `companionPrompts.resetSystemPrompt`).
- `src/sync-server.js`:
  - Three new SyncServer-instance callbacks wired
    in the constructor (`onGet/Save/Reset
    CyberclawSystem`).
  - Three new WS cases routed to those callbacks.
    Reset case has the dual-ack behaviour described
    above.
- `package.json`: 3.2.61 → 3.2.62.
- `CHANGES_3.2.62.md`.

## Verification

- `node -c` on all edited JS files: clean.
- Manual flow (post-restart):
  1. Mobile → quest editor → change the 📁 Project
     directory field to a new path → Save.
  2. Desktop log: `[quests:update] re-scaffolded
     /new/path with INSTRUCTIONS.md +
     CONVERSATION.md`.
  3. `ls /new/path/` shows the two new files.
  4. Settings → CYBERCLAW.md → edit text → Save.
  5. Desktop log: read+write via the existing
     companionPrompts helpers.
  6. Settings → CYBERCLAW.md → Reset → desktop
     unlinks the file; mobile textbox fills with the
     shipped default.
  7. Send a chat → companion uses the new prompt on
     the next message.

## What didn't change

- The CYBERCLAW.md file path is unchanged
  (`~/.openclaw/cyberclaw/CYBERCLAW.md`).
- The `companionPrompts.{read,write,reset}SystemPrompt`
  functions are unchanged. The new callbacks are
  thin wrappers.
- The per-quest files (INSTRUCTIONS.md /
  CONVERSATION.md) still live at
  `<quest.directory>/` (or id-based fallback). No
  physical file-migration on directory change —
  explicit per design (the user's mental model: file
  co-locates with the project it describes; moving
  the directory is the user's signal that the
  quest is now about a different project).
- Quest `directory` field stays optional on the quest
  model.

## See also

- `CHANGES_3.2.30.md` — original `QUEST_QUEST_INSTRUCTIONS.md`
  filename + id-based fallback.
- `CHANGES_3.2.32.md` — `system:*` IPC handlers for the
  desktop's own CYBERCLAW.md editor.
- `CHANGES_3.2.41.md` — `QUEST_NOTE` structured-output.
- `CHANGES_3.2.59.md` — first version of the per-quest
  conversation log (JSON array).
- `CHANGES_3.2.61.md` — file-based conversation log +
  directory scaffolding on create.
- `CHANGES_3.10.134.md` — mobile-side defaultQuestDir
  setting in Settings.
- `CHANGES_3.10.136.md` — mobile-side pair: editor
  always shows + is editable, plus the CYBERCLAW.md
  Settings section.
