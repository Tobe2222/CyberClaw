# v3.1.50 — Active quest (persistent) + latestChanges journal + agent edit tools

The active quest finally has teeth. Before this release, the desktop
already had a click-to-select flow on each quest card (the in-memory
`activeQuestId` variable, the `quest-selected` CSS class, the
`[Active Quest: ...]` chat-context injection). What was missing:

1. **Persistence.** The selection was in-memory only. Restart the
   desktop and your active quest was gone. v3.1.50 moves the
   source of truth to a per-quest `active: true` flag, persisted
   to `~/.openclaw/cyberclaw/quests.json`. Survives restarts.

2. **Visibility.** The old `quest-selected` was a 1px border color
   change — easy to miss in a long list. v3.1.50 adds a thicker
   gold border + soft glow, a pulsing ⚡ ACTIVE badge, and a ⭐
   button on every card. Active quest is impossible to miss.

3. **Companion memory.** The chat-context injection used to include
   just the quest name + description + directory. v3.1.50 adds
   the **incomplete goals** (so the LLM knows what's left) and
   the **last 5 entries from latestChanges** (so the LLM has
   memory of what it did on this quest across turns). Plus a
   one-line tool list so the LLM knows it can log changes,
   mark goals done, or switch the active quest.

4. **Latest changes journal.** Each quest now has a
   `latestChanges: [{ timestamp, text }]` array — a running
   log of what the companion did on that quest. The companion
   appends to it via the new `[QUEST_APPEND_CHANGE: text="..."]`
   structured-output tag. Trimmed to the last 100 entries to
   keep the JSON file small.

5. **Agent edit tools.** The agent (running in OpenClaw) can now
   read + edit quests via three new structured-output tags:
   `[QUEST_SET_ACTIVE: id="..."]`, `[QUEST_APPEND_CHANGE: text="..."]`,
   `[QUEST_MARK_GOAL: index="N" done="true|false"]`. The renderer
   parses these from the LLM's reply and routes them to the IPC
   bridge. The LLM doesn't need function-calling — it just emits
   the tags inline in its reply, the same way the existing
   `[CREATE_QUEST: ...]` tag works.

---

## Model

```json
{
  "id": "abc123",
  "name": "Cyberhive v2",
  "description": "...",
  "status": "active" | "completed",
  "directory": "/path/to/project",
  "goals": [{ "text": "...", "completed": false }],
  "created": "2026-07-08T...",

  // v3.1.50 (new, persisted)
  "active": true,                          // exactly one quest is active
  "latestChanges": [
    { "timestamp": "2026-07-08T11:00:00Z", "text": "Set up DNS A record" },
    { "timestamp": "2026-07-08T11:30:00Z", "text": "Configured SSL" }
  ]
}
```

**Migration:** `loadQuests()` defaults `active: false` and
`latestChanges: []` on any quest that doesn't have them yet. The
migration is idempotent and runs on every load (cost: O(n) over
the quest list, where n is typically < 20). A defensive check
enforces "at most one quest is `active: true`" — if a migration
left multiple active, the first wins and the rest are cleared.

`active` is independent of `status`. A quest can be
`active: true, status: 'completed'` (you've finished but still
have it open for reference) or
`active: false, status: 'active'` (paused, not currently in focus).

---

## IPC (new handlers in `src/main.js`)

| Handler                          | Args                  | Returns                  |
|----------------------------------|-----------------------|--------------------------|
| `quests:set-active`              | `id \| null`          | the active quest or null |
| `quests:get-active`              | (none)                | the active quest or null |
| `quests:append-change`           | `id, text`            | the new entry, or null   |
| `quests:mark-goal-done`          | `id, goalIndex, done` | the updated quest, or null |

All four broadcast the full updated quest list via
`broadcastQuestsList(loadQuests())` so the mobile stays in sync
without polling.

`set-active` enforces the exactly-one-active invariant by flipping
the flag on every quest in the array, then saving. Idempotent —
calling it with the currently-active id is a no-op (no save, no
broadcast).

`append-change` trims the log to the last 100 entries after each
append. The LLM is expected to log meaningful steps ("set up
DNS A record"), not granular sub-actions ("pressed Enter in the
form"). The 100-entry cap is generous; if a quest's log hits
100 we trust that earlier entries are no longer the active
context.

`mark-goal-done` handles both goal shapes: legacy plain strings
(upgrade to `{text, completed: !!done}`) and object form (shallow
clone + flip the flag). Index validation: returns null if the
index is out of range or non-numeric.

---

## Preload bridge (`src/preload.js`)

Four new methods exposed on `cyberclaw.quests`:

- `setActive(id)` / `getActive()`
- `appendChange(id, text)`
- `markGoalDone(id, goalIndex, completed)`

The renderer's existing quest flows (`list`, `create`, `update`,
`delete`, `pickDirectory`, `detectVersion`) are unchanged.

---

## Renderer changes (`src/js/app.js`)

**`activeQuestId`** is now derived from the quest list, not stored
as a free variable. `renderQuests()` re-reads
`quests.find(q => q.active)?.id` on every render. The variable
itself is kept as a local cache so the chat-context builder
doesn't have to scan the list on every message.

**`selectQuest(el, questId)`** is now async and persists. The
optimistic local visual update (add/remove `quest-selected`) is
applied first for instant feedback, then the IPC call goes out.
On success the renderer re-renders to pull the canonical
`active: true` flag. On failure the optimistic update is rolled
back via the next render.

**`buildActiveQuestContext(quest)`** is a new helper that builds
the chat-context prefix. Used by both the regular chat path
(line ~1700) and the voice-mode chat path (line ~1848). Output
shape:

```
[Active Quest: "name" — desc | Project dir: /path
 | Incomplete goals: goal1; goal2; ...
 | Recent changes: text (2h ago); text (1d ago); ...
 | Tools: [QUEST_APPEND_CHANGE: text="..."] [QUEST_MARK_GOAL: index="N" done="true|false"] [QUEST_SET_ACTIVE: id="<id-or-name>"]]
```

The Tools line is one short clause — the LLM picks up the tag
shape from prior uses in the conversation; the hint here just
reminds it that the tools are available. No additional system
prompt is needed.

**Quest card visual** (in `renderQuests()`):

- ⭐ button on every card. Filled (⭐) when active, empty (☆)
  when not. Click toggles active via the existing `selectQuest`
  flow. Inline `event.stopPropagation()` so clicking the star
  doesn't also trigger the card's onclick (which would re-toggle
  and cancel the change).
- ⚡ ACTIVE badge in the top-right of the card when
  `q.active === true`. Subtle 2.4s pulse so the eye lands on it.
- The card itself gets a 2px gold border + soft gold glow when
  active. If a quest is active AND completed, the border is
  muted gold (60% alpha) — the pulse is still on the badge.
- A new `.quest-is-active` class drives these styles. The
  existing `.quest-selected` class is still applied (for the
  cyan border + orange tint), but the gold treatment is the
  loud signal.

**New structured-output parsers** in the chat-reply handler
(after the existing `questMatch` parser for `[CREATE_QUEST: ...]`):

- `[QUEST_SET_ACTIVE: id="..."]` — switch the active quest.
  Falls back to name match if the id isn't found (LLMs sometimes
  emit the name when the id isn't in their context).
- `[QUEST_APPEND_CHANGE: text="..."]` — append to the active
  quest's journal. No-op if there's no active quest; the
  renderer echoes "📝 Logged: <text>" in chat.
- `[QUEST_MARK_GOAL: index="N" done="true|false"]` — toggle a
  goal's completed flag. Echoes "✅ Goal N marked done" or
  "↩ Goal N reopened". 0-based index, so the LLM sees
  "index=0" for the first goal.

All three use the case-insensitive `i` flag so the LLM has
flexibility in how it emits the tags. The parsers run
independently — an LLM reply can have multiple tags (e.g.
"marked goal done and logged the change") and all of them get
parsed.

---

## CSS (`src/css/components.css`)

Three new style blocks:

- `.quest-star-btn` — the ⭐ button. Low opacity (0.4) until
  hover; `.is-active` variant is full opacity + gold color +
  text-shadow glow.
- `.quest-active-badge` — the ⚡ ACTIVE badge. Gold background
  tint + gold border + uppercase + letter-spacing + 2.4s pulse
  animation. Defined as a keyframe `questActivePulse` for the
  box-shadow breathing effect.
- `.quest-item.quest-is-active` — the gold border + soft glow
  for the active card. Overrides the default `border: 1px solid
  var(--border-mid)` with `border: 2px solid var(--gold)` and
  adds a `box-shadow: 0 0 12px rgba(247, 147, 26, 0.25)`.

The existing `.quest-selected` styles are kept (cyan border +
orange tint) but the gold treatment is the loud signal. The two
classes co-exist: the active quest gets BOTH `.quest-selected`
(for the subtle cyan treatment) AND `.quest-is-active` (for
the loud gold treatment).

---

## Wire protocol

**No new broadcast channels.** The new fields (`active`,
`latestChanges`) ride the existing `quests_list` event from
v3.1.49. The mobile (v3.7.8) just reads `q.active` and
`q.latestChanges` from the same payload it already parses.

The four new IPC handlers are desktop-internal (renderer ↔
main process). They don't add anything to the
desktop↔mobile WebSocket.

---

## Companion behavior

The companion now has memory of the active quest across turns.
When the user says "deploy this to staging", the LLM sees:

```
[Active Quest: "Cyberhive v2" — Rebuild the Cyberhive
marketing site for v2 | Project dir: /home/tobe/projects/cyberhive
| Incomplete goals: Set up DNS A record; Configure SSL
| Recent changes: Set up DNS A record (2h ago)
| Tools: [QUEST_APPEND_CHANGE: text="..."] ...]
deploy this to staging
```

So the LLM knows "staging" means "the Cyberhive v2 site"
without the user having to repeat it. And it knows the DNS
record is set up but SSL isn't. It can then deploy with
context, and log the deployment step via
`[QUEST_APPEND_CHANGE: text="Deployed v2 to staging at https://staging.cyberhive.dev"]`.

The companion is now a real collaborator on a project, not
a chatbot in a void.

---

## Files touched

- `src/main.js` — model migration in `loadQuests()`, defaults
  in `quests:create`, four new IPC handlers
- `src/preload.js` — four new methods on `cyberclaw.quests`
- `src/js/app.js` — new helper `buildActiveQuestContext`, new
  `selectQuest` that persists, new structured-output parsers,
  ⭐ button + ACTIVE badge in `renderQuests`
- `src/css/components.css` — new styles for star button,
  active badge (with pulse), gold border + glow
- `package.json` — 3.1.49 → 3.1.50

## Not touched

- `src/sync-server.js` — no new wire protocol; the existing
  `broadcastQuestsList()` carries the new fields
- The chat system prompt (the proactive `promptCompanionReaction`
  case) — those are idle reactions, not user-chat; the active
  quest context is not relevant there
- The Quests editor UI — `saveQuestEdit` and `openQuestEditor`
  work as before; the new fields are populated by IPC handlers
  and visible via the existing list/detail rendering

## Companion release: v3.7.8

The mobile side is a viewer of the new fields. v3.7.8 (next
release) adds the ACTIVE badge on the quest card + the
latestChanges timeline in the detail modal. No new IPC needed
on the mobile side either — it just reads the new fields from
the existing `quests_list` event.
