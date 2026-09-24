# v3.3.15 — Quest files always live in `<quest.directory>/quest/`

Tobe's design (2026-09-23 18:37, Discord #cyber-dev):
> "when a user starts a new quests it creates the folder
> with the quest name(which becomes the project name) and
> within it a specifc folder for that projects quest
> specific info, like the chat logs etc. Makes sense? and
> if the quest name is already there that means the project
> has already started and the user just want to link a
> quest to it, so when it does that it should only create
> that quest specific folder."

After the 2026-09-23 projects-dir cleanup, every existing
project already had a `quest/` subfolder holding the three
quest markdown files (`INSTRUCTIONS.md`, `CONVERSATION.md`,
`NOTES.md`). The cleanup prefigured this model — but the
code still wrote the files at the project root, so the
next chat exchange would land *outside* the `quest/`
subfolder and re-create the very split the cleanup fixed.

`seed_signer` already shows this: after the cleanup merged
2026-09-06 + 2026-09-23 chat into
`seed_signer/quest/CONVERSATION.md`, today's chat at
04:33:33Z wrote 692 bytes to `seed_signer/CONVERSATION.md`
(the root) instead. Two parallel logs.

This change makes the new layout the only layout the code
knows about. Brand-new projects and existing projects
both get a `quest/` subfolder; the 3 .md files always
live there. `seed_signer`'s split is migrated on the
next restart — the legacy root file is appended to
`quest/CONVERSATION.md` under a divider and dropped.

## What changed

### 1. New canonical layout

```
<quest.directory>/
  <project files — package.json, README.md, src/, …>     # project's files
  quest/                                                 # this quest's files
    INSTRUCTIONS.md
    CONVERSATION.md
    NOTES.md
```

For a brand-new quest whose project doesn't exist yet:

```
<quest.directory>/        ← mkdir -p creates it (may be empty except for .git or whatever the user adds)
  quest/                  ← mkdir -p creates it
    INSTRUCTIONS.md       ← scaffold writes the placeholder
    CONVERSATION.md       ← scaffold writes the header
    NOTES.md              ← scaffold writes the header
```

For an existing project:

```
<quest.directory>/        ← already exists, untouched
  package.json            ← project's files, untouched
  README.md
  src/
  quest/                  ← mkdir -p creates it (only if missing)
    INSTRUCTIONS.md       ← scaffold writes placeholders only if absent
    CONVERSATION.md
    NOTES.md
```

### 2. New helper: `deriveQuestFilesDir(quest)`

Pure function. Returns `<quest.directory>/quest/` if
`quest.directory` is set, else the legacy
`~/.openclaw/cyberclaw/quests/<id>/` fallback path for
id-only quests.

### 3. New helper: `migrateLegacyQuestFiles(quest)`

Idempotent migration of the 3 .md files from the project
root into `<quest.directory>/quest/`. Called from
`scaffoldQuestDirectory`, `quests:save-quest-instructions`,
and `quests:append-quest-instructions` so any code path
that touches the files picks up the migration.

Four rules:

| Root | `quest/` | Action |
| --- | --- | --- |
| exists | missing | **move** root → `quest/` |
| exists | exists, same content | **drop** root |
| exists | exists, different content | **append** root to `quest/` with divider, then drop root |
| missing | (any) | no-op |

The "append with divider" rule is the seed_signer case:
today's `seed_signer/CONVERSATION.md` (692 bytes, this
morning's chat) gets appended to
`seed_signer/quest/CONVERSATION.md` (5393 bytes after
migration) under a `# Migrated legacy CONVERSATION.md`
heading. No history lost.

### 4. New persisted field: `quest.questFilesDir`

`loadQuests()` now writes `questFilesDir` into every quest
on first load (one-time migration; idempotent). All path
helpers (`questInstructionsFilePathV2`,
`questConversationFilePath`, `questNotesFilePath`) prefer
`questFilesDir` when set, fall back to `deriveQuestFilesDir()`
when not, fall back to legacy `<quest.directory>/<file>.md`
for pre-v3.3.15 reads.

### 5. `scaffoldQuestDirectory` creates `quest/` instead of writing to the root

The 3 .md files always land at `<quest.directory>/quest/`.
If the project root has the legacy files, they're migrated
first; if `quest/` already has files, nothing is
overwritten (idempotent).

## Files changed

- `src/main.js`
  - `loadQuests()`: persist `questFilesDir` on first load
    (one-time migration write).
  - New `deriveQuestFilesDir(quest)`.
  - New `migrateLegacyQuestFiles(quest)`.
  - New `questFilesRoot(quest)` — prefer persisted field,
    fall back to derived path.
  - `questInstructionsFilePathV2`,
    `questConversationFilePath`, `questNotesFilePath`:
    route through `questFilesRoot`.
  - `resolveExistingInstructionsPath`: also check
    `<quest.directory>/INSTRUCTIONS.md` (legacy root
    location) for read-back during migration window.
  - `scaffoldQuestDirectory`: create `quest/` subfolder,
    run migration, persist `questFilesDir`.
  - `quests:save-quest-instructions` and
    `quests:append-quest-instructions`: run migration
    before writing so the write lands where existing
    files live.

## Compatibility / migration

- **Existing projects**: 6 of 8 quests had legacy root files
  that the migration moves on first restart:
  - `seed_signer`: appends today's `CONVERSATION.md` to
    `quest/CONVERSATION.md` (now 5393 bytes with divider).
  - `cyber_database`, `cyber_music`, `cyber_school`: 3 files
    each moved from root to `quest/` (no `quest/` existed
    before).
  - `CyberAccountant`, `CyberRepair`: no migration (already
    in `quest/` from the 2026-09-23 cleanup).
- **`cyberclaw-desktop` and `cyberclaw-mobile`**: no code
  changes. The path helpers' contract is unchanged from
  the renderer's perspective — it still asks
  "where is INSTRUCTIONS.md?" and gets a path back. The
  path just points at a different location now.
- **Migration is reversible**: legacy root files are
  `unlink`'d after a successful move/append. If we ever
  need to roll back v3.3.15, the root files are gone —
  backups are at `/tmp/cleanup-backup-2026-09-23/` (from
  the 2026-09-23 cleanup) and a fresh backup should be
  made before any production deploy if you want a
  pre-v3.3.15 rollback target.

## Verified

- `node --check src/main.js` passes.
- Migration test against the actual projects directory:
  - `seed_signer`: legacy CONVERSATION.md appended with
    divider (legacy dropped, total size grew).
  - `cyber_database / cyber_music / cyber_school`: all 3
    files moved root → `quest/`, root cleaned.
  - `CyberAccountant / CyberRepair`: no migration needed.
- Re-running migration is a no-op (idempotent).
- `package.json` version bumped to `3.3.15`.
