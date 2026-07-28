# v3.2.35 — Companion soul + memory + CYBERCLAW.md system prompt

## Overview

Every chat message now carries a `[SYSTEM CONTEXT]` block that
stacks four pieces of identity: a hardcoded safety preamble, the
overarching `CYBERCLAW.md` (user-editable, shared by all
companions), the per-companion `soul.md` (character definition),
and the per-companion `memory.md` (auto-written facts). The
desktop's Settings and Companion Forge get new editor surfaces
for all three files. The mobile gets a read-only mirror of
soul/memory on the Personalize screen with a clear-memory
button that round-trips through the desktop.

## What's new

### 1. `src/companion-prompts.js` (new module)

Single source of truth for the companion prompt pipeline.

- **File layout** under `~/.openclaw/cyberclaw/`:
  - `CYBERCLAW.md` — overarching system prompt (shared by every companion)
  - `companions/<agentId>/soul.md` — character definition
  - `companions/<agentId>/memory.md` — auto-written facts
- **9 exports**: `readSoul`, `writeSoul`, `readMemory`, `appendMemory`, `clearMemory`, `readSystemPrompt`, `writeSystemPrompt`, `resetSystemPrompt`, `migrateAllSouls`, `assembleContext`, plus `SAFETY_PREAMBLE`, `DEFAULT_SYSTEM_PROMPT`, `SOUL_PRESETS`, `SYSTEM_PROMPT_FILE`
- **`assembleContext(agentId)`** — stacks safety preamble + CYBERCLAW.md + soul.md + memory.md, wrapped in `[SYSTEM CONTEXT]…[/SYSTEM CONTEXT]` so the LLM can tell where the user message begins
- **`migrateAllSouls(spriteConfigs)`** — runs at boot; if a companion has `traits` in sprites.json but no soul.md yet, generates one from the traits (existing user edits are never overwritten)
- **Soul presets**: `sassy`, `curious`, `lazy`, `cheerful`, `foodobsessed`, `dramatic`, `stoic`, `adventurous`, `goblin` — desktop-only, mobile shows the active soul but doesn't write

### 2. `src/main.js` — chat pipeline uses the assembled context

`chat:send-message` now prepends `[SYSTEM CONTEXT]…[/SYSTEM CONTEXT]` to the user message before invoking the openclaw CLI:

```js
let ctx;
try { ctx = companionPrompts.assembleContext(agentId); }
catch (e) { console.error('[chat:send] context assembly failed:', e.message); ctx = ''; }
const finalMessage = ctx ? ctx + message : message;
```

Failure to assemble context is non-fatal — the chat still sends with an empty context block rather than blocking the user.

New IPC handlers:
- `companion:get-soul` → `{ ok, content, presets }`
- `companion:save-soul` → `{ ok, bytes }`
- `companion:apply-soul-preset` → applies a preset to the companion's soul.md
- `companion:get-memory` → `{ ok, content }`
- `companion:remember-memory` → appends a line (the companion's chat pipeline uses this)
- `companion:clear-memory` → `{ ok, content }` (content is the new empty string)
- `system:get-cyberclaw` → `{ ok, content, defaultContent, path }`
- `system:save-cyberclaw` → `{ ok, bytes }`
- `system:reset-cyberclaw` → deletes the file so next read returns `DEFAULT_SYSTEM_PROMPT`

`sync-server.js` callbacks (for the mobile wire): `onReadCompanionSoul`, `onReadCompanionMemory`, `onClearCompanionMemory`.

### 3. `src/index.html` — Settings + Forge UI

- **Settings → 🛡️ CyberClaw System Prompt** (new section): 16KB-capped textarea with byte counter, Save, and Restore default. Red warning banner explains that edits affect every companion.
- **Companion Forge → 📜 Soul** (new section): preset dropdown (sassy/curious/lazy/cheerful/foodobsessed/dramatic/stoic/adventurous/goblin), Apply preset button, 8KB-capped textarea.
- **Companion Forge → 🧠 Memory** (new section): read-only viewer with Clear button.

### 4. `src/preload.js` — IPC bridge

```js
window.cyberclaw = {
  ...
  agents: {
    ...
    getSoul: (agentId) => ipcRenderer.invoke('companion:get-soul', agentId),
    saveSoul: (agentId, content) => ipcRenderer.invoke('companion:save-soul', agentId, content),
    applySoulPreset: (agentId, presetKey) => ipcRenderer.invoke('companion:apply-soul-preset', agentId, presetKey),
    getMemory: (agentId) => ipcRenderer.invoke('companion:get-memory', agentId),
    rememberMemory: (agentId, line) => ipcRenderer.invoke('companion:remember-memory', agentId, line),
    clearMemory: (agentId) => ipcRenderer.invoke('companion:clear-memory', agentId),
  },
  system: {
    getCyberclaw: () => ipcRenderer.invoke('system:get-cyberclaw'),
    saveCyberclaw: (content) => ipcRenderer.invoke('system:save-cyberclaw', content),
    resetCyberclaw: () => ipcRenderer.invoke('system:reset-cyberclaw'),
  },
  ...
};
```

### 5. `src/js/app.js` — renderer wiring

- `loadCyberclawEditor()` — called from `openSettings()`; reads the file, populates the textarea, hooks the byte-counter `oninput`
- `updateCyberclawStatus()` — live byte counter (turns red over 16KB, orange over 8KB)
- `saveCyberclawPrompt()`, `resetCyberclawPrompt()` — wired to the IPC handlers
- `loadCompanionSoulEditor(agentId)` — runs when the forge opens; populates soul textarea, applies preset dropdown, hooks save
- `loadCompanionMemoryViewer(agentId)` — runs when the forge opens; populates the read-only viewer
- `applySoulPreset()`, `clearCompanionMemory()` — wired to IPC handlers

### 6. `src/sync-server.js` — mobile wire protocol

Three new WebSocket cases mirroring the v3.2.30 quest-instructions pattern:
- `read_companion_soul` → `companion_soul` (response carries `content` + `presets`)
- `read_companion_memory` → `companion_memory` (response carries `content`)
- `clear_companion_memory` → `companion_memory_cleared` (response carries `content`)

Each uses the same callback → Promise → response envelope as the existing quest handlers, so the mobile sees consistent error shapes (`{ ok: false, error: 'Desktop does not support … yet' }` when running against an older desktop).

## Patterns and lessons

- **Hardcoded safety preamble is never user-editable.** Only the `CYBERCLAW.md` user-editable layer lives behind the editor. The safety block is a constant in `companion-prompts.js`.
- **Read-only-by-default for cross-surface files.** Mobile can READ soul/memory and CLEAR memory, but cannot WRITE soul. The desktop forge is the single editor. Same pattern as the quest instructions file in v3.2.33.
- **Promises vs sync callbacks in sync-server.js.** The quest instructions pattern (result is a Promise → await → send response) was copied verbatim. Three copies in one PR is the right time to extract a helper; not yet, but keep an eye on it.
- **Migration is best-effort, not blocking.** `migrateAllSouls` runs at boot but catches its own errors so a bad sprites.json can't block boot. The user's existing soul.md files are never overwritten — the migration only fills in MISSING files from `traits`.
- **Edit-then-restore with a confirm dialog.** Restore default for CYBERCLAW.md and Clear for memory both use `confirm()` before destructive action. The 16KB/8KB caps give a clear "you're hitting the limit" signal before the user tries to save.

## Files changed

- `src/companion-prompts.js` (new, 226 lines)
- `src/main.js` (+89 lines: chat-pipeline context prepend, 9 new IPC handlers, 3 new sync-server callbacks)
- `src/index.html` (+67 lines: 3 new settings sections)
- `src/js/app.js` (+196 lines: loaders, savers, status counter)
- `src/preload.js` (+18 lines: 9 new IPC bridge methods)
- `src/sync-server.js` (+~150 lines: 3 new cases + constructor callback wiring)
- `package.json` 3.2.34 → 3.2.35

## Deployment

Requires desktop v3.2.35. Mobile v3.10.104 ships the read-only viewer + clear button. If the mobile connects to an older desktop, the desktop responds with `{ ok: false, error: 'Desktop does not support companion soul yet' }` and the mobile falls back to a graceful error message.