# v3.3.0 — Skills library: per-companion process skills you can write

## What

A new **Skills Library** lives in the left sidebar (under the Quest Log).
Skills are markdown documents that describe a specific process — not
generic tasks. The companion's prompt picks up the content of every
enabled skill on chat-send, so the LLM has the procedure in front of it
when it applies the skill.

The big idea: instead of hoping the LLM happens to know a workflow, you
write the workflow once as a skill, equip it on the companions that
should use it, and forget about it.

## How it's laid out on disk

```
~/.openclaw/cyberclaw/
├── skills/<skill-id>/SKILL.md          ← one skill per directory
│   └── SKILL.md                        ← YAML frontmatter + markdown body
└── companions/<agentId>/
    └── enabled-skills.json             ← ["send-screenshots", ...]
```

The `enabled-skills.json` file lists which skills are active for that
companion. `assembleContext()` reads it on every chat send and
appends the enabled skill bodies to the system context block.

## Storage layer (`src/skill-store.js`)

New module that owns:

- `parseSkillFile(content)` / `serializeSkillFile(fm, body)` — minimal
  YAML-frontmatter parser, no external dep. Tolerates unterminated
  frontmatter by returning `{ ok: false, raw }` so the UI can show the
  user a fix-it view instead of crashing.
- `validateSkill({ frontmatter, body })` — returns errors and
  warnings. Skills must have name, description, and a body with at
  least one heading + one step list. Warnings nudge toward process
  content (no warnings = "good skill"). Errors block save.
- `listSkills() / readSkill(id) / createSkill / updateSkill / deleteSkill`
  — CRUD. `createSkill` auto-generates a unique slug id (e.g.
  "send-screenshots" → "send-screenshots-2" on collision).
- `getEnabledSkills(agentId) / setEnabledSkills(agentId, ids)` —
  per-companion toggle state, persisted to JSON.
- `buildSkillsPromptBlock(agentId)` — returns the markdown block the
  prompt expects, or "" if no skills enabled. Called from
  `companion-prompts.assembleContext()`.
- `seedStarterSkills()` — drops in three starter skills on first run:
  - **Send Screenshots to User** — the workspace-path + MEDIA:
    workflow that fixes Tobe's image-not-rendering bug from
    earlier tonight.
  - **Deploy Website via pm2** — VPS scp + pm2 restart 1 workflow.
  - **Manage Cybercomputer Services** — service catalogue + port
    table for the three background services running on this host.

## UI

### Left sidebar — new "SKILLS LIBRARY" section

Below the Quest Log. Each skill is a row with icon, name, one-line
description, and a trigger count. Click a row → opens the detail modal.

Empty state shows a "Seed Starter Skills" button so a fresh install
gets something useful immediately instead of an empty list.

The `+` button next to the header opens the create form:
- Name
- Icon (emoji)
- Description (one line)
- Triggers (one per line — "when to use this skill")
- Body (markdown — process steps)

On submit, the validation result is shown inline. Warnings don't block
save (the "Seed Starter Skills" starter skills all warn about missing
content but they're still useful); errors do.

### Right panel (companion detail) — new "Enabled Skills" section

Each skill in the library is shown as a one-line row with a checkbox.
Click the row → toggles the skill for the current companion. The
companion's prompt picks up the change on the very next chat send.

The previously-existing "Abilities" / "Learn New Skill" UI was
removed — that flow was generic "search and equip openclaw skills" and
didn't match the user-managed library concept. OpenClaw skills
(weather, browser-automation, etc.) are still available via the
`openclaw:list-skills` IPC for any future re-integration.

The "Skill Categories" section above (Building / Writing / Design /
etc.) is unchanged — those are auto-classified task XP, not user
skills.

### Detail modal

Click any skill (in either sidebar or detail panel) → modal with
the full SKILL.md rendered as markdown (headings, lists, code,
bold/italic via a tiny renderer — no external markdown lib). Edit
button switches to an inline form with the same fields as create.

Delete button (with confirm) removes the skill directory. The skill is
removed from every companion's enabled list implicitly (the prompt
builder skips missing skills silently).

## IPC surface

```
skills:list                 → { ok, skills: [{id, name, description, icon, triggers, mtime}] }
skills:read <id>            → { ok, skill: {..., frontmatter, body, path, raw} }
skills:create <payload>     → { ok, skill, validation }
skills:update <id> <payload>→ { ok, skill, validation }
skills:delete <id>          → { ok }
skills:seed-starters        → { ok, seeded: [...ids that were created] }

companion:get-enabled-skills <id>      → { ok, enabled: [...] }
companion:set-enabled-skills <id, ids> → { ok, enabled: [...] }
```

`assembleContext(agentId)` calls `skillStore.buildSkillsPromptBlock()`
after the existing soul + memory blocks, so the chat pipeline picks
up enabled skills with no other code changes.

## Process-specific, not generic

Per Tobe's direction, the validation requires:

- A name and a one-line description.
- A body with at least one heading AND one step list (numbered or
  bulleted). Skills-as-prose-paragraphs are warned against.
- At least one trigger phrase (warning, not error — sometimes you
  don't know how to articulate when a skill applies, that's OK).

The starter skills are all process-focused:

- **Send Screenshots to User** doesn't say "communicate with the
  user" — it says "save the file to a workspace path the chat
  transport can resolve, then attach via MEDIA: on its own line".
- **Deploy Website via pm2** doesn't say "ship code" — it says "scp
  each changed file, then `pm2 restart 1`, then curl the affected
  endpoint".

That makes them usable as actual procedure docs, not vibes.

## Out of scope (deliberately)

- **Mobile UI** — mobile stays at v3.10.172 for now. The IPCs in
  this change are desktop-side; syncing the library to mobile is a
  follow-up. The renderer's `cyberclaw.skills.*` preload bindings
  are the integration point.
- **Skill versioning / git history** — skills live as plain
  markdown in `~/.openclaw/cyberclaw/skills/`. If the user wants
  history, they can put the directory in git themselves.
- **Skill sharing between workspaces** — skills are per-user
  (`~/.openclaw/...`), not per-project. Cross-workspace sharing is a
  future feature; nothing in this change blocks it.
- **Drag-and-drop reordering of triggers** — they're an unordered
  set in the frontmatter for now.
