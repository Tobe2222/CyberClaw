## v3.3.3 — 2026-09-06 — Arena drag-and-drop + collision + variation

Five small arena tweaks Tobe asked for at once.

### 1. Drag-and-drop companions
Mirror the existing toy-drag pattern for companions. Click and
drag any companion to reposition it for picture-taking. Cursor
turns to `grab` when hovering one and `grabbing` while held.
Release drops the companion in place; a small throw velocity
applies for a flick. State timer pushed far into the future
while dragged so the autonomous AI doesn't fight the user, then
released back to `idle` with a 1.2–2s grace before re-engaging.
Click-to-select still works (separate listener).

### 2. Toys disappear faster
Toys idle >15s are removed. Was 60s. Tobe: *"make the toys
disappear faster."*

### 3. Companion↔companion hitbox collision
After the bounds clamp in `_updateCompanion`, every companion
checks against every other companion. If their cylindrical
bodies overlap, both get pushed apart along the contact normal
(positional separation) and a soft impulse reflects their
velocity component along the normal (velocity separation with
restitution=0.35). Cylindrical body radius scales with sprite
width. Tobe: *"They need a hitbox or something which the others
crash in."*

### 4. Per-companion chase variation
Each companion now gets a randomized `chasePersonality`:
- `speedMult` (0.75–1.30): scales chase speed
- `reactRadius` (60–180 px): some only chase close toys, others
  spot them from far away
- `reactionDelay` (0–800 ms): some react instantly, some have a
  small lag before committing
Tobe: *"And some variation when chasing the ball."*

### 5. Companions stay lower in the arena
`horizonLine` 0.5 → 0.7. Companions stay in the lower 30% of
the canvas instead of roaming the upper half. Tobe: *"the
background allows them to go a bit too high up."*

### Files
- `src/js/pixel-arena.js` — all five tweaks in this file.
- `package.json` — version 3.3.2 → 3.3.3.

### Verified
- `node -c`-style parse check on pixel-arena.js passes.
- Desktop restarted with `DISPLAY=:0 XAUTHORITY=... npm start`.
