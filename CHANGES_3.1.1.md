# Changelog — v3.1.1 (session 2026-06-14)

Six follow-up changes from Tobe's second turn. Branch:
`feature/companion-improvements`. To test: `npm start` from the
project root.

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
