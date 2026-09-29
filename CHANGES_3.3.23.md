# v3.3.23 — Desktop: skills-library panel move, XP panel auto-refresh

## The bug (panel layout + stat display)

Tobe (2026-09-29 22:29, Discord #cyber-dev):

> "@Clawsuu Yeah move that library position. The level
> stagnation might be my lack of obsetvation but take a
> quick look, it also seemed like he should have had some
> xp on more categories also, it had so few but it might
> be correct."

Plus a follow-up:

> "Yeah we need this chat to sync properly between the
> quest changes on both ends."

## What's fixed

### Skills library moved to the right panel

The per-companion skills library UI (browse / create /
edit / delete process-specific skills) lived in the LEFT
panel under the QUEST LOG. Tobe wanted it on the right
panel above the Enabled Skills toggles — the library is
the source of which toggles below are enabled, so the
grouping makes more sense on the right.

Fix: in `index.html`, cut the `SKILLS LIBRARY` panel
header, the `skill-form` block, and the `skill-list`
container from the left panel and paste them into the
right panel as a new `.inspect-section` between
"Skill Categories" (the auto-classified task XP) and
"Enabled Skills" (the per-companion toggles).

No JS changes needed — `refreshSkillsList()` looks up the
container by ID (`#skill-list`), which still resolves
correctly because the IDs are unchanged. The skill form's
`+` button still wires to `showSkillForm()` and the
seed-starters button still calls `seedStarterSkills()`.

### Skills panel auto-refresh on XP gain

Root cause of the apparent "stagnation": `awardXpForReply`
calls `cyberclaw.agents.addXP(...)` then broadcasts
`agents_list` to the mobile, but does NOT refresh the
desktop's own `#inspect-skills` panel. The panel only
re-rendered when the user clicked away from a companion
tab and back — so on a long chat session, XP would
accumulate on disk but the panel showed stale data.

Investigated the stats file directly
(`~/.openclaw/cyberclaw/companion-stats.json`): clawsuu
actually has Building at level 4 with 240 XP, plus
Design / General / Communication at level 1. Stats are
accumulating correctly. The render code at line 1166 of
`app.js` reads `stats.skills[s.name]` correctly. The
problem was purely UI staleness.

Fix: in `awardXpForReply`, after broadcasting agents_list
to the mobile, also call `updateInspect(xpTarget)` if the
gaining agent is the currently-focused companion. Now
the Skill Categories panel updates live as XP is awarded,
no manual tab-switch needed.

## Quest-sync status (no code fix shipped, just confirming)

Tobe asked about chat sync across quest changes on both
ends. Investigated the flow:

1. User clicks star on desktop quest → `selectQuest` →
   `cyberclaw.quests.setActive(id)` →
   `quests:set-active` IPC (main.js:3146) → mutates
   `q.active` in the in-memory list →
   `saveQuests(quests)` (main.js:466) →
   `syncServer.broadcastQuestsList(loadQuests())` to
   mobile + `mainWindow.webContents.send('quests-updated',
   loadQuests())` to own renderer.
2. Mobile's `onQuestsList` listener (HomeScreen.tsx:4984)
   updates `activeChatQuestId` / `activeQuestRef` (with
   the v3.11.x source-tag guard so cache replays don't
   corrupt fresh state).
3. Desktop's `quests-updated` handler (app.js:7685)
   updates `cachedQuestsList` + `setActiveQuestId(...)` +
   `renderQuests()`.

This should work end-to-end. The v3.3.22 quest pill on
each bubble now makes the active-quest state visible to
the desktop user (matching the mobile), so any sync
mismatch is observable. If Tobe hits a case where the
two ends disagree after a quest switch, we'll have a
concrete repro.

## Lessons

1. **Auto-refresh on data mutation.** Any time the
   renderer mutates state that drives a UI panel, the
   mutation site should also re-render that panel.
   `broadcastAgentsListToMobile` was correct for the
   mobile side, but the desktop's `inspect-skills`
   panel is fed from the same data and needed the same
   re-render. Two consumers, one mutation site —
   broadcast handles one, but the local consumer needs
   its own hook. Same architectural class as the
   "every reader/writer consulting the source-of-truth"
   MEMORY.md lesson.

2. **Panel placement matches data hierarchy.** The
   skills library was under the quest log on the left
   panel — a leftover from when skills were added in
   v3.3.0 without much thought to layout. Moving it
   above the per-companion enabled-skills toggles
   reflects the actual data flow: library is the source,
   toggles are the per-agent view onto it.

3. **Stat accumulation vs. stat display are separate
   concerns.** The "stagnation" symptom could have
   been either a write-side bug (XP not being saved)
   or a read-side bug (XP saved but not displayed).
   Always check the source data file before patching
   the renderer.