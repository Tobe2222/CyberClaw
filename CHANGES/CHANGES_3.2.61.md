# v3.2.61 — Per-quest directory scaffolding + file-based conversation log

## the user's three-layer behavior model (2026-08-04 16:45)

> "Openclaw has one set of behaviour with its md,
> cyberclaws companion md has its own behaviour, and
> then lastly quests adds behaviour or info to the agent.
> So all these impacts the agents behaviour and what it
> does before answering. Openclaw sets standard
> behaviour, cyberclaw gives it more of a character
> through companion behaviour, and the quest
> instructions tells it info about the current task, and
> its history through its md and quest conversation log."

Three layers, currently wired as:
1. **OpenClaw gateway** system prompt — base behavior
2. **`~/.openclaw/cyberclaw/CYBERCLAW.md`** — overarching
   user-editable system prompt (overrides openclaw defaults)
3. **`~/.openclaw/cyberclaw/companions/<agentId>/soul.md`** —
   per-companion character
4. **`~/.openclaw/cyberclaw/companions/<agentId>/memory.md`** —
   per-companion memory
5. **`<quest.directory>/QUEST_QUEST_INSTRUCTIONS.md`** (or
   v3.2.61's `INSTRUCTIONS.md`) — task-specific behavior
6. **`<quest.directory>/CONVERSATION.md`** (new in 3.2.61) —
   conversation transcript

Layers 1-4 are unchanged. Layers 5-6 are co-located
in the quest directory so users can `cat`, `git add`,
share, and reason about them in one place. The
previous arrangement had the conversation log in the
JSON array inside `~/.openclaw/cyberclaw/quests.json`,
which was buried inside admin metadata — not what
The user wanted.

## What shipped

### 1. Quest directory auto-scaffold on create

When a quest is created with a non-empty `directory`,
`mkdir -p` the directory and write two placeholder
files (only if absent — never overwrites user content):

```
<quest.directory>/
  INSTRUCTIONS.md       <- placeholder header explaining the file's purpose
  CONVERSATION.md       <- placeholder header for the auto-appended transcript
```

Idempotent: re-running on an already-scaffolded dir
is a no-op. Triggered from BOTH paths into the desktop
that create quests:
- The renderer-side `quests:create` IPC handler
- The WS-side `onCreateQuest` callback (mobile's
  `create_quest` WS message)

A failed scaffold does NOT fail the create. The
quest still exists; only the file co-location is
missing. The quest.conversationLog JSON array
(v3.2.59) still works as a fallback.

### 2. File-based conversation log

Every chat exchange (via `quests:append-conversation-log`)
now writes to BOTH:
- **`q.conversationLog` JSON array** in `quests.json`
  (load-bearing for `buildActiveQuestContext`'s LLM
  context injection — the file is NOT re-parsed for
  context because that would double-write and
  double-parse)
- **`<quest.directory>/CONVERSATION.md`**, as a
  per-line markdown file with the format:
  ```
  [2026-08-04T12:00:00Z] user: Where is Welectron?
  [2026-08-04T12:00:30Z] agent(Clawsuu): Welectron (DE) ships from €15
  [2026-08-04T12:01:00Z] user: And Adafruit for headers?
  ```
  Appended via `fs.appendFileSync` — the OS keeps the
  file consistent at rest for `tail -f`, and the
  per-turn IO is constant (no rewriting of the whole
  file every chat turn).

Best-effort file appends: a failed file append doesn't
fail the JSON-array append. The JSON is the load-bearing
store; the file is the human-readable mirror.

File path auto-created if missing (handles the
pre-v3.2.61 case where a quest was created before the
scaffold ran — every append now creates the file on
demand).

### 3. Filename migration: `QUEST_QUEST_INSTRUCTIONS.md` → `INSTRUCTIONS.md`

The old filename had a redundant `QUEST_QUEST_` prefix;
v3.2.61 shortens it to `INSTRUCTIONS.md`. The old
filename still works as a fallback (read first, fall
back to the new one for newer content). On save:
- If only the OLD file exists → its content is ported to
  the NEW file first, then the new write lands.
- If BOTH files exist with the same content → silently
  delete the legacy file.
- If BOTH files exist with DIFFERENT content → leave
  both in place so the user can manually reconcile.

The legacy file is left in place (even if same
content as the new file) for the first save after
migration; after that, repeated saves converge on
the new filename automatically.

### 4. New IPCs for mobile-side conversation log access

Three new IPCs on the desktop, mirrored as WS messages
through `sync-server.js`:

| IPC name                              | WS message                          |
|---------------------------------------|-------------------------------------|
| `quests:get-conversation-log`         | `request_quest_conversation_log`    |
| `quests:get-conversation-file` (new)  | `request_quest_conversation_file`   |
| `quests:clear-conversation-log`       | `clear_quest_conversation_log`      |

The new `get-conversation-file` returns the raw markdown
content (vs the JSON-shaped entries from `get-conversation-log`)
so a future mobile "View past conversations" panel can render
the file directly.

The mobile's `SyncClient` now has matching methods:
- `getConversationLog(questId)` — returns JSON entries +
  file path
- `getConversationFile(questId)` — returns raw markdown
  content + path
- `clearConversationLog(questId)` — wipes both stores

### 5. Default quest directory from Settings

The mobile Settings → "Default quest directory" field
(shipped in v3.10.134) is the suggested path that the
editor pre-fills when the user taps + New. On create,
the desktop receives that path in the WS payload,
scaffolds the directory, and stores the path on the
quest. Future turns find `<quest.directory>/CONVERSATION.md`
ready to be appended to.

This is the "default to that unless specified" path
the user requested: the Settings field is the default;
the user can override per-quest by typing a different
path in the editor. Empty Settings field → no
suggestion → user types a path manually (or leaves
the quest without a directory, falling back to
`~/.openclaw/cyberclaw/quests/<id>/` which gets
the same scaffold treatment).

## Why file-based instead of just keeping JSON

Three reasons the user's model is right:
1. **Co-location with project files.** A quest
   about `/projects/seed-signer` should have its
   memory, instructions, and conversation IN the same
   folder. Then `find /projects/seed-signer -type f`
   shows everything, and `tar czf seed-signer.tgz .`
   bundles the entire project (code + memory + history)
   in one command.
2. **Human readability.** `tail -f CONVERSATION.md`,
   `grep "Welectron" CONVERSATION.md`. The JSON array
   in `quests.json` is opaque — `cat quests.json | jq`
   works but it's not what the user wants for a per-quest
   workflow.
3. **Version-controllable.** The quest directory is
   the natural git repo (or sub-repo) for that
   project. The conversation log lives alongside the
   code, so commits have meaningful context.

JSON array stays as the fast-read mirror for the
LLM context injector (no parsing on every chat send,
no double-IO on append). The LLM gets the JSON
entries; the user sees the markdown file.

## Files

- `src/main.js`:
  - `scaffoldQuestDirectory(quest)` helper (mkdir +
    write INSTRUCTIONS.md placeholder + write
    CONVERSATION.md placeholder, idempotent).
  - `questInstructionsFilePathV2(quest)` returning the
    new `INSTRUCTIONS.md` filename.
  - `questConversationFilePath(quest)` returning the
    new `CONVERSATION.md` filename.
  - `resolveExistingInstructionsPath(quest)` for the
    read-side filename fallback (prefers v2, falls
    back to v3.2.30's `QUEST_QUEST_INSTRUCTIONS.md`).
  - `quests:read-quest-instructions` updated to prefer
    the v2 file with v1 fallback.
  - `quests:save-quest-instructions` updated to write
    to the v2 file + port-and-migrate the v1 file.
  - `quests:append-quest-instructions` updated to write
    to the v2 file + port legacy content if needed.
  - `appendConversationLog()` now ALSO calls
    `fs.appendFileSync` to the conversation file
    (best-effort; failure doesn't fail the JSON append).
  - `quests:get-conversation-log` now also returns the
    file path.
  - `quests:clear-conversation-log` now also
    `fs.unlinkSync`s the file (best-effort).
  - NEW: `quests:get-conversation-file` IPC for the raw
    markdown content.
  - `quests:create` IPC + `onCreateQuest` callback both
    call `scaffoldQuestDirectory` if `quest.directory`
    is set (best-effort).
  - SyncServer constructor wired with three new
    callbacks:
    `onGetQuestConversationLog`,
    `onGetQuestConversationFile`,
    `onClearQuestConversationLog`.
- `src/sync-server.js`:
  - `_handleMessage` made `async` to allow `await` in
    the new quest-conversation-log cases (no other case
    used `await` previously, so this is additive).
  - Three new WS cases: `request_quest_conversation_log`,
    `request_quest_conversation_file`,
    `clear_quest_conversation_log`. Each forwards to
    the corresponding SyncServer callback and replies
    over the same WS.
- `src/preload.js`: bridge unchanged (the existing
  `getConversationLog` / `clearConversationLog` from
  v3.2.59 already work for the renderer; the new
  `getConversationFile` IPC isn't on the renderer
  side yet — the user can add it later if needed for a
  desktop panel).
- `package.json`: 3.2.60 → 3.2.61.
- `CHANGES_3.2.61.md`.

## Mobile side (v3.10.135+ to ship separately)

The SyncClient now has three new methods on
`CyberClawMobile/src/services/SyncClient.ts`:
- `getConversationLog(questId)` — JSON entries
- `getConversationFile(questId)` — raw markdown
- `clearConversationLog(questId)`

These are wire-up only. The mobile UI doesn't
actually call them yet — that's the next release
when a "💬 N conversations on this quest" badge
+ "View past chats" panel lands on the QuestsScreen.
The infrastructure is ready so v3.10.135 can be UI-only.

## Verification

- `node -c` on all 3 edited JS files: clean.
- 9/9 unit smoke tests pass (`/tmp/test-v3.2.61.js`):
  scaffold creates both files with correct headers
  (+ quest name in heading), append-to-file is
  idempotent + preserves order + tags agent entries
  with name, re-scaffolding does NOT overwrite user
  content, no-directory quests return ok:false.
- Manual flow (post-restart):
  1. Settings → Quests → set default dir to `/tmp/test`
  2. Quests → + New → name `Test`, description optional
  3. Save → `mkdir -p /tmp/test` + write INSTRUCTIONS.md
     + write CONVERSATION.md
  4. `cat /tmp/test/INSTRUCTIONS.md` → shows placeholder
  5. Mobile: chat panel → "Hi" with the quest starred
  6. `cat /tmp/test/CONVERSATION.md` → first entry
     appended
  7. Quit and restart the desktop
  8. Mobile: chat again
  9. `cat CONVERSATION.md` → second entry appended,
     JSON array still has both
- Migration: existing quests with `quest.directory`
  get scaffolded on their NEXT IPC call (the
  append-to-file helper lazy-creates the file if
  missing). Existing quests WITHOUT a directory fall
  back to `~/.openclaw/cyberclaw/quests/<id>/`.

## What didn't change

- **buildActiveQuestContext** still reads from the
  JSON array (NOT from the file). The file is
  user-facing; the JSON is LLM-facing. Re-parsing
  the file on every chat send would be wasted IO +
  double-write risks. The two stores are kept in
  sync via the write side; readers pick the right
  one for their purpose.
- **Soul / memory / CYBERCLAW.md** paths unchanged.
  Layers 1-4 are stable.
- **QUEST_APPEND_CHANGE / QUEST_NOTE** structured
  output tags unchanged. They're complementary to
  the new auto-log (curated vs raw), same as
  v3.2.59's design.

## See also

- `CHANGES_3.2.30.md` — original quest instructions
  file path (`QUEST_QUEST_INSTRUCTIONS.md`).
- `CHANGES_3.2.41.md` — `QUEST_NOTE` structured-output
  tag (notes go to the instructions file).
- `CHANGES_3.2.50.md` — `QUEST_APPEND_CHANGE`
  structured-output tag (curated journal).
- `CHANGES_3.2.59.md` — first version of the
  in-memory conversation log (JSON array).
- `CHANGES_3.2.60.md` — drop the Discord auto-write.
