# 3.1.28 — Set `_pixelCompanionId` at agent load time

## What it fixes
Tobe's DevTools diagnostic on v3.1.27:
```
lookup test: iconFile=assets/icons/boar.svg icon=🐗 agents_clawsuu_id=undefined agents_lamasuu_id=undefined
```

`getSpriteIconFile()` and `getSpriteIcon()` work — both correctly return their values from the catalog. The catalog data is right. But `agent._pixelCompanionId` is **undefined** on both agents, so the chat tab falls through to the text-emoji branch and shows `agent.emoji || '🤖'`.

The user previously set `agent.emoji = '🤖'` (back when that was the default fallback). So the chat tab is correctly displaying the user's chosen emoji — the robot. That's actually correct behavior given the data; the bug is that `_pixelCompanionId` isn't being set, so we never get to the iconFile (Twemoji SVG) branch.

## Root cause: `_pixelCompanionId` set only in `initArenaCompanions`
`initArenaCompanions()` is the only place that sets `agent._pixelCompanionId`. It runs once on boot, but if anything replaces `agents[id]` afterwards (a saveCompanion, a settings change, a config reload), the new agent object doesn't have `_pixelCompanionId`. The chat tab rendering code reads from `agents[id]._pixelCompanionId` directly, so it falls back to `agent.emoji`.

## Fix: set `_pixelCompanionId` in `loadAgents`
The `loadAgents()` loop already reads each agent's sprite config via `cyberclaw.agents.getSpriteConfig(id)` and copies various fields (`customName`, `focusSkills`, `traits`, `primaryModel`, etc.) onto the agent object. This commit adds `pixelCompanionId` to that copy list:

```js
if (cfg.pixelCompanionId) {
  agents[id]._pixelCompanionId = cfg.pixelCompanionId;
}
```

Now `_pixelCompanionId` is set at load time and persists across agent object replacements.

## Files changed
- `src/js/app.js` — `loadAgents` loop now copies `pixelCompanionId` from the sprite config
- `package.json` — 3.1.27 → 3.1.28

## Lesson: don't rely on a side-effect-only field set
`_pixelCompanionId` was set as a side effect of `initArenaCompanions` running. The agent object identity was assumed to persist forever, but it doesn't. The fix is to set the field at the canonical "create this agent" point (in `loadAgents`) so any code that reads it later sees the correct value regardless of which other paths have run.

This is the same lesson as v3.1.21-v3.1.27: the chat tab icon code path needs to read the right data to make the right icon. v3.1.21 added the icon concept. v3.1.23 wired up the chat tab. v3.1.24 made the catalog loadable. v3.1.26 made the chat tab use the icon. v3.1.27 made the catalog re-readable. v3.1.28 makes sure the field is actually populated.

Each step closes one source of "no icon" failure. After v3.1.28, every possible reason for the chat tab to show `🤖` instead of the sprite icon should be eliminated.
