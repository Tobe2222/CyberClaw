# Changelog — v3.1.1 + v3.1.2 + v3.1.3 (session 2026-06-14)

All changes from Tobe's four turns in this session. Branch:
`feature/companion-improvements`. To test: `npm start` from the
project root.

---

## v3.1.3 (fourth turn)

### 1. Removed arena background button (bottom-right)

The bottom-right background button (`#arena-bg-btn`) and its
label are gone. Background picker still lives in the **Arena
Settings** modal (top-left gear button).

### 2. Removed the leader concept

- `isMain` is no longer derived during agent sort; the field is
  kept on agents (always `false`) for back-compat only.
- `assignRarity` no longer grants a "legendary" tier to the first
  agent. Every agent is now rare/epic/uncommon like the others.
- The "Companion · Leader" badge is now just "Companion". The
  chat header no longer says "★ leader · online".
- The arena now shows the **active chat companion** (or the first
  non-hidden one as a fallback) — there's no fixed leader slot.
- **Arena Settings**: every companion can be hidden, no leader
  exemption.
- A new helper `pickCurrentCompanionId()` replaces all the old
  "find the leader" lookups. Preference: active chat channel >
  first non-hidden agent > first agent.
- Boot messages: "Companion: X" / "N spirits detected" became
  "Chatting with: X" / "N other companion(s) available".

### 3. Redesigned Skills in the inspect panel

- The section that shows the categories (Coding / Writing / Game
  / etc. with XP bars) is now called **Abilities** to avoid the
  duplicate "Skills" name.
- The "Skills" section itself is now just two buttons:
  - **📚 Learn New Skill** — opens a chat-driven LLM guide that
    walks the user through creating a custom skill.
  - **📋 Learned Skills** — new modal that lists the companion's
    equipped skills with descriptions and a "✕ Forget" button
    per row. Built-in skills get a cyan accent border.
- The old gear grid + 🔍 search bar + "No equipment yet" text
  are gone.
- New CSS: `.learned-skills-panel`, `.learned-skill-row`, etc.
- New JS: `openLearnedSkillsModal`, `closeLearnedSkillsModal`,
  `forgetLearnedSkill`.

### 4. Arena + idle chatter routing

- The arena previously only showed one companion (the leader)
  because `pixelArena.setCompanion` overwrites itself. Now it
  shows the active chat companion, so when you switch channels
  via the top tabs, the arena updates too (sprite config and
  sprite reloads — minor).
- `promptCompanionReaction` no longer routes to a leader. It
  routes to `pickCurrentCompanionId()`, so idle chatter now
  lands in the chat channel of the companion the user is
  currently looking at.
- **Idle chatter frequency bumped from 19-31 min to 60-90 min.**
  The "playful comment about being bored" prompt was removed
  (a primary source of the "play with me" spam).
- `togglePlayMenu` is debounced — the LLM reaction fires at
  most once per 30 seconds, so rapidly opening/closing the toy
  menu no longer spams LLM calls.

### 5. Sleep/wake toggle (per-companion)

- Each agent has a new `sleepState` field: `'awake'` (default)
  or `'sleeping'`.
- **Inspect panel** now has a row with the status indicator
  ("Online" / "Sleeping") plus a button:
  - `💤 Sleep` when awake (sets the companion to sleeping,
    plays the "death" sprite as a sleeping pose)
  - `☀️ Wake` when sleeping (wakes the companion, returns the
    sprite to "idle")
  - Manual toggle posts a system message in chat so the user
    gets feedback.
- **Auto-wake on chat**: `sendChat()` and `sendChatMessage()`
  now wake the target companion if they're sleeping, so
  messages always get a response.
- **Sleeping companions** are skipped by:
  - `promptCompanionReaction` (no idle chatter / reactions)
  - `scheduleIdleChatter` (no periodic comments)
- The chat header shows the active companion's state:
  - green dot + "online" when awake
  - cyan dot + "💤 sleeping" when sleeping

### Verification (v3.1.3)

- `node --check` passes on main.js, preload.js, app.js
- Headless electron boots clean (SyncServer listening, no JS
  errors)
- All v3.1.0/v3.1.1/v3.1.2 features preserved untouched

---

## v3.1.2 (third turn)

### Per-companion chat channels (one per agent)

- `chatHistory` is now `chatHistoryByAgent = { agentId: [...] }`.
  Each companion has their own chat thread.
- `addChatMsg` buckets the message into the right agent's history
  (via name → agentId lookup) and only renders it in the active
  view. Non-active channels get an unread badge.
- `switchActiveChat(agentId)` re-renders the chat-messages
  container from the per-agent history, updates the channel tabs,
  and updates the chat header.
- `updateCarousel()` now also calls `switchActiveChat` when the
  focused agent changes, so carousel selection = chat target.
- The boot flow picks the leader (or first agent) as the initial
  active chat.
- The `createNewCompanion` flow sets `pendingNewCompanionId` so
  `saveCompanion` switches the chat to the new companion's
  channel after a successful create.

### Channel tabs on the sides

- **Left column** (`#companion-channel-tabs`): companion chat
  channels, one tab per agent, with avatar/emoji and the agent's
  name. Clicking a tab switches the chat.
- **Right column** (`#system-tabs`): system tabs (Events,
  OpenClaw, Logs) plus the existing collapse/expand toggle.
- The chat-messages / chat-input area is now in the center.
- The chat view got a `#chat-header` that shows the active
  companion's avatar, name, and "online" status.
- Old top-mounted `.term-tab` / `.terminal-tabs` design is gone.

### Arena Settings (top-left button on the arena)

- New `#arena-settings-btn` (gear icon) in the top-left of the
  arena. Sits next to the existing logo.
- New `#arena-settings-overlay` modal with two sections:
  - **Background picker** (moved here from the bottom-right
    gear button which is still there as a legacy shortcut).
  - **Companion show/hide list.** Each row: avatar, name, class,
    toggle switch. The leader is always shown (toggle disabled).
  - Hidden state persists to localStorage as
    `cyberclaw-hidden-companions` (a Set of agent ids).
- `applyCompanionVisibility()` hook ready for the future
  multi-companion arena (currently the pixelArena renders only
  one companion, so the hidden flag is mostly cosmetic until
  that refactor lands).

### Verification (v3.1.2)

- `node --check` passes on main.js, preload.js, app.js
- Headless electron boots clean (SyncServer listening, no JS
  errors)
- Previous v3.1.1 features preserved untouched

---

## v3.1.1 (second turn)

## 1. Chat resizer direction was inverted ✅

The resizer sits at the **top** of the input area in the flex column.
When you drag **down** by +delta, the resizer should appear to follow
your mouse (move down on screen), which means the input area must get
**taller**. In a flex column with `flex: 1` on the messages area, a
taller input forces the messages area to shrink and the resizer to
move down. The math: `newH = startH - delta` (sign was previously
`+delta`, which shrunk the input instead of growing it).

**Verified behavior now:** drag up = input shrinks; drag down =
input grows. The resizer visually tracks the mouse.

## 2. Swords button removed from chat input ✅

`<button id="chat-send">⚔️</button>` was the only obvious "send"
button, but Tobe flagged it as not working (it was the send button
— Enter also sends). Cleaner: just remove it. Attach (📎) and
voice (🎤) remain. The placeholder now reads "Type a message...
(Enter to send, Shift+Enter for newline)" so the keyboard shortcut
is obvious.

## 3. Companion forge size scale ✅

Added a 📐 Size section to the forge with a 1–8 slider and a live
"4×" label. The slider:

- Sets `currentForgeScale` (default 4).
- Recreates the preview sprite at the new scale.
- Persists to the sprite config under `scale` so it survives reload.

Refactored the three duplicate `new PixelSprite(viewer, { scale: 4, ... })`
sites into a single `showForgeCompanion(id)` helper that honors the
current scale.

## 4. Spirits all removed — every agent is a companion ✅

- **`initArenaCompanions` rewritten.** Every agent now gets a
  companion sprite (no more `addSpirit` / spirit catalog loading).
  Each agent rotates through the default companion list when no
  `pixelCompanionId` is set. The leader keeps the central arena
  position; non-leaders are flagged as sidekicks.
- **`openCompanionEditor`** always opens the companion forge (no
  more spirit-vs-companion split). Selecting Lamasuu and clicking
  "Edit Companion" now opens the regular forge, not the spirit one.
- **Inspect panel:**
  - Type badge: "Companion" for all agents (with "· Leader" suffix
    for the main one).
  - Equipment section: visible for all agents.
  - Skills: full set shown (no more focus-only for non-leaders).
- **Dead code removed:** `openSpiritForge`, `saveSpirit`, the spirit
  catalog loading, the focus-skills gating in the skill grid.

The Spirit Forge modal in the HTML is still present but no longer
wired to anything. Leaving it in place for now (it's hidden by
default and harmless); can be deleted in a follow-up.

## 5. Companions linked to openclaw agents ✅

The big architectural change. CyberClaw companions are now truly
backed by openclaw agent entries — there's a single source of
truth (`~/.openclaw/openclaw.json → agents.list`).

**New IPC handlers (`main.js`):**
- `openclaw:read-config` — full config
- `openclaw:list-providers` — `models.providers` entries, normalized
  to the `{id, name, baseUrl, apiKey, defaultModel, api}` shape
- `openclaw:upsert-provider`
- `openclaw:delete-provider`
- `openclaw:list-agents` — `agents.list` entries
- `openclaw:create-agent` ← used by "Create New Companion"
- `openclaw:update-agent`
- `openclaw:delete-agent`

**Preload bridge (`preload.js`):** `cyberclaw.openclaw.*` exposes
all of the above.

**`fetchProviders()` in app.js:** reads from openclaw config first,
falls back to the local `providers.json` if openclaw config is
unavailable. Both the Settings "Default model" dropdown and the
forge Primary/Secondary model dropdowns are populated from this
list.

**`addProvider` / `deleteProvider`:** write through to openclaw
config first; fall back to the local CyberClaw list only if
openclaw config can't be read. So adding a new LLM provider in
CyberClaw makes it available to the openclaw CLI immediately
(since openclaw reads its own config on launch).

**`createNewCompanion()` is now a true create flow:**
1. Patches `saveCompanion` with a guard requiring a sprite + name.
2. On a valid save it:
   - Generates a unique id from the name (kebab-case,
     disambiguated with `-2`, `-3`, …).
   - Calls `cyberclaw.openclaw.createAgent({id, name, workspace,
     model, tools})` — this writes a new entry to openclaw's
     `agents.list`.
   - Reloads the agent list and inserts the new agent into the
     in-memory `agents` map and `agentOrder` so it shows up in
     the carousel.
   - Restores the original `saveCompanion` and calls it to
     persist the sprite/avatar/secondary model — same path as
     editing an existing companion.
3. Result: a new companion is also a new openclaw agent,
   visible to the openclaw CLI, Discord bindings, etc.

## Files changed

```
src/css/components.css    +27/-0   (settings-slider + size section styles)
src/index.html           +10/-2    (size slider, removed swords send button)
src/js/app.js           +200/-166  (resizer fix, size scale, no-spirits,
                                     openclaw-linked create flow)
src/main.js              +122/-0   (openclaw config read/write IPC)
src/preload.js            +10/-0   (openclaw bridge)
```

5 files changed, 352 insertions(+), 185 deletions(-).

## Not changed (preserved v3.1.0 features)

- Sleep mode (`nudgeNightWake`, `isAsleep`, `_nightWakeTimer`)
- Agent Reach (remote tool bridge)
- WebSocket serialization
- Mobile IPC (`mobile-set-companion`)
- Theme system (`--accent` defined, `body.theme-light`)

## How to test

```bash
cd /media/humpsuu/CYBERDRIVE/2B/work/projects/cyberclaw
git checkout feature/companion-improvements
npm start
```

Things to verify:
1. **Resizer:** drag the small bar above the chat input up/down.
   It should follow the mouse.
2. **No swords button:** the chat input row is now just
   [📎] [textarea] [🎤]. Enter sends, Shift+Enter for newline.
3. **Size scale:** Edit Companion → drag the Size slider. Reload
   the editor and the size sticks.
4. **Lamasuu is a companion:** click on Lamasuu in the carousel.
   The inspect panel shows "Companion" badge and the equipment
   section. Click "Edit Companion" → opens the regular forge.
5. **Provider list reads from openclaw config:** Settings →
   the saved providers come from `~/.openclaw/openclaw.json →
   models.providers`. Add one in CyberClaw and verify
   `openclaw.json` was updated.
6. **Create New Companion = create new openclaw agent:** click
   "✨ Create New Companion", pick a sprite, name it, save. Check
   `~/.openclaw/openclaw.json` for the new entry under
   `agents.list`. The new agent should appear in the carousel.

## Rollback

```bash
cd /media/humpsuu/CYBERDRIVE/2B/work/projects/cyberclaw
git checkout main
# or:
git revert 3639987
```
