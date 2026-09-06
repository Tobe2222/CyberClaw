# Changelog — v3.1.6 (session 2026-06-14)

Branch: `feature/companion-improvements`. All changes are in
`src/js/app.js` and `src/js/pixel-arena.js`. To test: `npm start`
from the project root.

---

## v3.1.6 (seventh turn) — companion forge size actually sticks

### The bug

When editing a companion in the Companion Forge and dragging the
📐 Size slider, the new size was **not persisted**. Reloading the
forge (or restarting the app) reverted the slider to the old value
and the arena sprite stayed at the old size.

### Root cause

The slider's `oninput` handler (`updateForgeSize`) was writing the
new scale to the sprite config **on every tick**:

```js
if (editorAgentId) {
  cyberclaw.agents.getSpriteConfig(editorAgentId).then(cfg => {
    cfg = cfg || {};
    cfg.scale = currentForgeScale;
    return cyberclaw.agents.saveSpriteConfig(editorAgentId, cfg);
  });
}
```

That looked fine in isolation, but it raced with the final
`saveCompanion` click. `saveCompanion` reads the current sprite
config, mutates a few fields, and writes the whole object back. If
the slider's debounced write hadn't landed before `saveCompanion`
ran, the final write would clobber the new scale back to whatever
the last full save had stored (the previous value, or undefined
for fresh companions).

The arena init also didn't pass the scale to `_buildCompanion`,
so even when the scale was correctly saved, the arena sprite
ignored it and used the hard-coded default of 5.

### The fix

**1. Stop writing the scale from `updateForgeSize`.**
The slider now only updates the in-memory `currentForgeScale`
global and re-renders the preview. No more debounced async
write, no more race.

```js
function updateForgeSize(value) {
  currentForgeScale = parseInt(value, 10) || 4;
  const lbl = document.getElementById('forge-size-value');
  if (lbl) lbl.textContent = currentForgeScale + '×';
  if (selectedPixelCompanion) showForgeCompanion(selectedPixelCompanion);
  // v3.1.6: don't write to the sprite config here. The value is
  // captured in currentForgeScale and saved by saveCompanion
  // together with the rest of the form.
}
```

**2. `saveCompanion` writes the scale in the same object as
everything else.** It now reads `currentForgeScale` and stamps it
into the new sprite config object, so the final write always
includes the latest slider value:

```js
await cyberclaw.agents.saveSpriteConfig(editorAgentId, {
  pixelCompanionId: selectedPixelCompanion,
  // ...
  scale: currentForgeScale, // v3.1.6
});
```

**3. The arena honors the saved scale.** `initArenaCompanions`
and `applyCompanionVisibility` now read `config.scale` and pass
it to `pixelArena.addCompanion(id, pixelId, name, scale)`.
`_buildCompanion` uses the provided scale (1–8) instead of the
hard-coded 5, and the mobile-set-companion IPC also passes the
saved scale into `swapCompanionSprite`.

`_buildCompanion` / `setCompanion` / `addCompanion` /
`swapCompanionSprite` all gained an optional `scale` parameter
(back-compat — old call sites still work; default 5 if omitted).

### Verification

- `node --check` passes on `app.js` and `pixel-arena.js`.
- Headless electron boots clean (SyncServer listening, no JS
  errors).
- Simulated save → reload round-trip: setting scale=7, saving,
  then reopening the forge restores `currentForgeScale = 7` ✅.

### How to test in the UI

1. `npm start` from the project root.
2. Click 🎨 Edit Companion on any companion.
3. Drag the 📐 Size slider (e.g. to 7). The preview sprite
   should grow immediately.
4. Click **Save**.
5. Close and reopen the editor — the slider should still be at 7.
6. Restart the app — the arena sprite should be at the same
   size as the preview.

### Files changed

```
src/js/app.js          +16/-10   (slider no longer writes; save
                                  includes scale; arena reads it)
src/js/pixel-arena.js  +9/-5     (_buildCompanion / setCompanion /
                                  addCompanion / swapCompanionSprite
                                  accept an optional scale)
```
