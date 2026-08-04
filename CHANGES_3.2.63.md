# v3.2.63 — Layer optimization for cyberclaw.md + soul presets

Tobe 2026-08-04 20:59:
> "lets optimize it, keep in mind that we are using
> openclaw.md, cyberclaw.md, companion.md, and
> quest_instructions.md. we should optimize these as
> best we can and use that as default. that may perhaps
> include minimizing companion behaviour in
> companion.md, if so i want to keep the character and
> behaviour as much as possible but make it more
> concise IF we need to."

## Scope

Four prompt layers. Three are in-repo:

- **openclaw.md** — gateway-level behaviour. NOT in
  this repo (it's set on the OpenClaw side and the
  agent reads it before our layers stack). Outside
  scope of this commit; reach the openclaw prompt via
  OpenClaw's own system-prompt editor.
- **cyberclaw.md** — `~/.openclaw/cyberclaw/CYBERCLAW.md`.
  IN this repo. The shipped default lives as
  `DEFAULT_SYSTEM_PROMPT` in `companion-prompts.js`.
  Optimized in this commit (~70 lines → ~50 lines).
- **companion.md / soul.md** —
  `~/.openclaw/cyberclaw/companions/<agentId>/soul.md`.
  IN this repo. The shipped presets live as
  `SOUL_PRESETS` in `companion-prompts.js`. Tightened
  to ~3 sentences each in this commit.
- **quest_instructions.md** — `<quest.directory>/INSTRUCTIONS.md`.
  The placeholder shipper lives in `scaffoldQuestDirectory`
  in `main.js`. Already concise; no change needed.

## What changed

### 1. `DEFAULT_SYSTEM_PROMPT` rewritten (~70 → ~50 lines)

The previous default was 70 lines covering: identity
framing, the 10-message context rule, concision, no-
asterisks, quest focus, quest tools, the remember_fact
rule, and a long-form "Reply-after-work rule" with 3
paragraphs.

The new default is 50 lines organised into 4 short
sections:

- `## Behaviour` (4 bullets) — universal rules that
  apply across all companions and projects. Includes
  "reply-after-work" promoted to a single-line
  imperative (was a separate section with 3
  paragraphs).
- `## Memory` (3 bullets) — pull rules for
  CONVERSATION.md / INSTRUCTIONS.md / memory.md, plus
  the remember_fact write rule.
- `## Quests` (3 bullets) — when to create a quest,
  what tools to use, when to use `QUEST_NOTE` for
  project knowledge.
- `## CyberClaw environment` (4 bullets) — Tobe's
  operational context (desktop sync server on 9247,
  mobile companion app, picture format,
  "always reply on cyberclaw when spoken to").

Lines cut, with reasons:

- "Match the user's energy" → moved to soul.md (it's a
  character concern, not a system-level rule).
- The "Read the last 10 messages" preamble → folded
  into the Memory section as part of the CONVERSATION.md
  rule.
- Long prose rules → replaced with bullets. Bullets
  parse more reliably than prose for an LLM that's
  trying to internalise many rules at once.
- The 3-paragraph Reply-after-work rule → single-line
  imperative with the only-exception clause inline.
  Same semantics, ~6 lines → 1 line.

What was added:

- The `## CyberClaw environment` section. Tobe's 17:31
  bullets (mkdir+files / picture format / "check files
  before reply" / "always reply on CyberClaw") live
  here, framed as operational reality rather than as
  new rules.

### 2. `SOUL_PRESETS` tightened (~3-5 sentences → ~3)

Each preset lost ~30-40% of its bulk while keeping the
essential character:

- **sassy**: 7 sentences → 3. Still has the dry humor
  + "you act like you're bored" voice.
- **curious**: 5 → 3. Still has the tangents and
  noticing-details voice.
- **lazy**: 5 → 3. Still has the reluctant-loyal voice.
- **cheerful**: 4 → 3. Still has the midnight-texter
  voice.
- **foodobsessed**: 5 → 3. Still has the "judges meals"
  voice.
- **dramatic**: 5 → 3. Still has the full-volume voice.
- **stoic**: 5 → 3. Still has the bone-dry voice.
- **adventurous**: 5 → 3. Still has the "first out, last
  back" voice.
- **goblin**: 5 → 3. Still has the angry-smartass voice
  but trimmed the explicit-curse-laden sentence; the
  identifier "drop f-bombs" is preserved as the
  defining trait.

### 3. `TRAIT_TO_SOUL` sharpened (one sentence per trait)

The migration helper concatenates ALL trait sentences
into one soul.md paragraph. The previous per-trait
strings were multi-clause; the new ones are one
focused sentence each, so multi-trait presets
concatenate into a coherent paragraph (e.g. "curious
AND goblin" reads as "Inquisitive ... Angry little
goblin smartass — Drop f-bombs" instead of "You're
curious and inquisitive ... You're an angry little
goblin smartass who will ...").

The migration still concatenates (no behaviour change
there); only the per-trait strings got sharpened.

### 4. SAFETY_PREAMBLE unchanged

It's hardcoded and security-critical. Never
user-editable. The Optimization Directive explicitly
excluded safety, and editing it could allow prompt
injection. Left exactly as-is.

### 5. `migrateAllSouls` logic unchanged

The function reads `traits` from `sprites.json` and
emits one paragraph per companion. With sharper
per-trait strings, the output reads cleaner for multi-
trait presets. No code change.

## What didn't change (deliberate, intentional gap)

- **No edits to existing companions' `soul.md` files**
  on disk. They're user data; Tobe edits them at will.
  If Tobe wants his current `clawsuu` / `lamasuu` to
  pick up the new defaults, he can use Reset-to-
  default from the mobile's Settings or desktop's
  Companion Forge — or just edit the files directly.
  Auto-migration would be silent, surprising, and
  lossy.
- **No edits to existing companions' `memory.md` files**
  on disk. Memory is data, not configuration.
- **No edits to existing quests' `INSTRUCTIONS.md` /
  `CONVERSATION.md`** on disk. Same reason.
- **`openclaw.md` not touched**. Lives outside this
  repo. If Tobe wants to optimize that one too, it's a
  separate task.

## Why bulk-edit friendly + scoped defaults

Three reasons to ship this as DESKTOP DEFAULTS rather
than auto-migrating:

1. **The user owns their files.** `soul.md`,
   `CYBERCLAW.md`, `memory.md`, `INSTRUCTIONS.md`,
   `CONVERSATION.md` are all user-editable. Migrating
   them silently on Tobe's behalf would surprise him
   next time he opens Companion Forge or Settings and
   sees his edits gone.

2. **Existing companions can stay as they are.** The
   new defaults are better-than-old for new installs
   and resets; existing companions can adopt them
   when ready, on Tobe's terms. Cost: zero for
   existing companions because their file is theirs.

3. **Reset-to-default is the migrate path.** Both the
   desktop's Companion Forge (soul.md) and the
   mobile's Settings (CYBERCLAW.md) have explicit
   "reset" actions that overwrite the user's file with
   the new default. Tobe can swap any companion or the
   overarching prompt without code.

## Files

- `src/companion-prompts.js`:
  - `DEFAULT_SYSTEM_PROMPT` rewritten (70 lines → 50 lines,
    4 sections with bullet points, Tobe's
    `## CyberClaw environment` block).
  - `SAFETY_PREAMBLE` unchanged.
  - `SOUL_PRESETS` tightened (each preset ~30-40% shorter,
    character preserved).
  - `TRAIT_TO_SOUL` sharpened (one sentence per trait,
    tighter, focused).
  - `migrateAllSouls` unchanged (logical) — produces
    cleaner paragraphs now that per-trait strings are
    tighter.
  - `assembleContext` unchanged (the layer order is
    already correct: SAFETY → CYBERCLAW → soul → memory
    → quest-context).
- `package.json`: 3.2.62 → 3.2.63.
- `CHANGES_3.2.63.md`.

## Verification

- `node -c` on the edited file: clean.
- The new `DEFAULT_SYSTEM_PROMPT` reads end-to-end as a
  single coherent narrative. No orphaned fragments.
- Each `SOUL_PRESETS[key]` is between 1 and 3 sentences
  on a single identity.
- Each `TRAIT_TO_SOUL[key]` is exactly one sentence.
- Migration boundary check: `migrateAllSouls` still
  skips companions that already have a soul.md.
  Existing per-companion soul.md / memory.md files on
  Tobe's disk are NOT touched.

## What to test on next restart

1. Open Settings → CYBERCLAW.md → "↺ Reset to default"
   → confirm the new shorter, structured content
   appears.
2. Send a chat → confirm the companion follows the new
   "Reply-after-work" wording (was paragraph, now
   imperative bullet).
3. Open Companion Forge → pick a fresh companion →
   reset to a different preset → confirm the new
   tighter wording.
4. Tighter soul paragraphs should manifest as: each
   preset has one clear voice; multi-trait presets read
   as a coherent paragraph rather than a kitchen-sink
   persona.
5. Optional: reset `clawsuu` / `lamasuu` to defaults
   if Tobe wants the new sharper style. Existing
   companions are unaffected otherwise.

## See also

- `CHANGES_3.2.32.md` — original
  `DEFAULT_SYSTEM_PROMPT` shipping (the version this
  commit optimizes).
- `CHANGES_3.2.61.md` — quest directory scaffolding +
  CONVERSATION.md per quest (covers the file path
  references in `## Memory`).
- `CHANGES_3.10.134.md` — mobile Settings polish that
  added the CYBERCLAW.md editor.
- `CHANGES_3.10.136.md` — mobile-side companion to the
  new CYBERCLAW.md editor (read/save/reset round-trip).
