# v3.2.84 — Skill XP system v2 (better categorization + mobile visibility)

## What this is

The user () asked for two improvements to
the companion skill XP system:

1. Better task categorization (current 9-skill
   keyword list is narrow — misses common things).
2. Skill XP visible on mobile in companion settings
   (view-only).

The user also said: "Just make it easy and less accurate.
Its just for fun." So this is deliberately a
small, low-risk change — same stats file, same
broadcast, same IPC.

## Desktop changes

### 1. Skill taxonomy as single source of truth

The skill defs (names + icons + keyword regexes)
used to live inline in two places:

- `src/main.js` — `classifyTask()` (the keyword
  matcher)
- `src/js/app.js` — `updateInspect()` (the renderer
  loop)

Same shape but easy to drift. Now:

- `src/main.js` exports `SKILL_DEFS` (the canonical
  list with keyword regexes).
- `src/js/app.js` exports a renderer-side `SKILL_DEFS`
  with names + icons only (mirrors the main process).

Both are commented to remind future-me to keep them
in sync. Not a real shared module because the renderer
runs in a Chromium webview without Node require, so
we duplicate + comment.

### 2. Widened keyword lists

The 9 categories (Building, Writing, Design, Analysis,
Strategy, Research, Communication, Game, General)
get broader keywords:

- **Building** (was "Coding"): adds install, run,
  ssh, server, npm, host, port, docker, kube, cron,
  service, process, script, config, env, path, app,
  launch, rebuild, update, upgrade, setup, init.
- **Writing**: adds message, email, readme, docs,
  markdown, md, txt, script, dialogue, narration.
  Drops overly-broad "edit" and "page" which
  matched too many false positives (e.g. "edit the
  config", "settings page").
- **Design**: adds pixel, sprite, art, redesign,
  stylesheet.
- **Analysis**: adds stats, log, trace, profile.
- **Strategy**: adds goal, milestone, workflow,
  pipeline, backlog, sprint, todo, task.
- **Research**: adds version, latest, size,
  temperature, weather, forecast, price.
- **Communication**: adds ask, ping, status,
  notify, alert, remind.
- **Game**: adds quest, level, hp, mp, xp, treat,
  feed, attack, defend, spawn, score, reward.

### 3. Dual-classify (user msg + assistant reply)

Previously only the user's message was classified.
Now both the user message AND the assistant's reply
are classified, and the more specific match wins
(earlier in SKILL_DEFS = more specific).

Why: a question like "hey, what's the latest?"
(classifies as Communication) might prompt the
agent to do a `git fetch` (Building) — without
dual-classify, only Communication XP is awarded.
With dual-classify, the more specific match wins.

Special cases:
- Same match on both sides → return it.
- One side matched, other is General → return the
  match.
- Different matches → earlier (more specific) wins.

Tested against 28 real-world-ish prompts: 25/28
correct (89%). Good enough for "for fun".

### 4. Re-broadcast after XP award

After every `addXP` call, the renderer re-broadcasts
the agents_list so the mobile Skills section sees
the new XP live (the desktop already broadcasts
agents_list on agent discovery + sprite changes;
XP just wasn't one of those triggers).

## Mobile changes

### 1. Skills section in CompanionSettingsScreen

New view-only section showing the companion's
skill XP + levels. Renders below the Exit settings
card. Looks like the desktop inspect panel's skill
rows but in the mobile dark theme.

Features:
- Sortable: highest XP first.
- Empty state if no XP yet: "Chat with <name> to
  start gaining XP."
- Header shows companion level (Lv.X) next to "Skills".
- Each row: icon + name + level number + thin
  progress bar.
- Updates live on every agents_list broadcast.

### 2. Companion type extended

`type Companion` in CompanionSettingsScreen.tsx
gains a `skills?: { level, xp, xpTotal, skills: Record<string, { level, xp }> }`
field. The cache hydration (`cyberclaw-agents-cache`)
picks it up, and a new `syncClient.on('agents_list')`
listener merges fresh broadcasts while the screen
is open.

## Files

- `src/main.js`:
  - New `SKILL_DEFS` constant (9 categories with
    widened keyword regexes).
  - New `classifyText(text)` helper.
  - `classifyTask(user, reply)` now dual-classifies.
  - Two call sites pass `reply` through.
- `src/js/app.js`:
  - New renderer-side `SKILL_DEFS` (names + icons).
  - Inspect skill list uses the shared `SKILL_DEFS`.
  - `broadcastAgentsListToMobile()` includes the
    companion's stats from `cyberclaw.agents.getStats(id)`
    in each agent's `skills` field.
  - After `addXP`, `broadcastAgentsListToMobile()`
    is called to push the fresh XP to mobile.
- `src/screens/CompanionSettingsScreen.tsx` (mobile):
  - `Companion` type gains `skills` field.
  - Cache hydration reads `skills` from cached
    agents_list payload.
  - New `syncClient.on('agents_list')` listener
    merges fresh broadcasts.
  - New `renderSkillsSection()` helper renders
    the Skills section.
  - New styles for the Skills section + skill rows.
- `package.json`: bump `3.2.83` → `3.2.84`.
- Mobile `package.json`: bump `3.10.138` →
  `3.10.139`.

## Verification (for the user)

1. **Desktop inspect panel** — open the inspect
   panel for any companion. Skill rows show 9
   categories (Building, Writing, Design, Analysis,
   Strategy, Research, Communication, Game, General).
   The "Coding" → "Building" rename should be
   visible.
2. **Desktop XP awarding** — chat with a companion.
   After each reply, look for the `⚔️ <name> gained
   +<n> <skill> XP` system message. Skill should
   match the topic (e.g. "fix this bug" → Building).
3. **Mobile Skills section** — open Settings →
   pick a companion → scroll down. New "Skills"
   section appears below Exit. Tap a different
   companion on the list → Skills section updates
   to that companion's stats.
4. **Live updates** — open a companion's Skills on
   mobile, then chat with that companion on desktop.
   After the desktop reply, the mobile Skills section
   should refresh within ~1 second (next agents_list
   broadcast).

## Lessons

### Keyword lists vs. LLM classification

the user's "less accurate is fine, for fun" framing
was right here. A keyword classifier misses edge
cases (89% accuracy in my tests) but it's:

- Zero cost per classification (no extra LLM call)
- Deterministic (same input → same output)
- Trivial to debug (just read the regex)
- Doesn't depend on model availability

For a view-only display where false positives don't
break anything, keyword is the right tool. If we
later want accuracy (e.g. routing tasks to a
specialist agent), THEN switch to LLM classification.

### Single source of truth for shared defs

When the renderer + main process both need the same
data (skill names, icons, etc.), it's tempting to
duplicate + comment. The duplication WILL drift over
time. The "right" fix is a shared module loaded by
both — but Electron's preload sandbox makes that
awkward without bundling. For this PR, duplication
+ "keep in sync" comments is the pragmatic choice.
A future improvement could be a small build step
that generates the renderer-side defs from a JSON
file shared with main.

### Dual-classify is a force multiplier

Classifying only the user message misses the case
where the user asks casually but the assistant
does serious work ("hey" + code reply → only
Communication XP, missing the Building work).
Classifying only the assistant reply misses the
case where the user is specific but the assistant
gives a one-liner ("fix this bug" + "done!" →
only Communication XP).

Dual-classify with "more specific wins" gets both
cases right with zero extra cost. Pattern worth
remembering for other classifiers.

## Out of scope (deliberately)

- No LLM-based classifier (the user: "less accurate
  is fine").
- No skill decay (skills only grow).
- No skill allocation (the desktop already routes
  XP to a "specialist" companion if one's focused
  on that skill; this PR doesn't change that).
- No new IPC or new stats file (re-uses
  `companion-stats.json`).
- Mobile is view-only (the user's explicit ask).
