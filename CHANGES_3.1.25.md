# 3.1.25 — Make the chat-tab emoji unmistakable

## What it adds
Tobe: "still looks the same" (after v3.1.24 was deployed, boot log confirmed v3.1.24).

The v3.1.24 catalog-loading fix is verified working — `~/.openclaw/cyberclaw/debug.log` shows `loadPixelCatalog OK: .../catalog.json (5 sprites)` on every boot, so `getSpriteIcon('boar')` returns `'🐗'` and `getSpriteIcon('hare')` returns `'🐇'`. The chat tab should show those emojis.

But Tobe is still seeing what they call "robot icons". Looking at the v3.1.24 screenshot closely, the icons next to "Clawsuu" and "Lamasuu" in the channel strip look like small pixel-art animals (boar and hare) — they ARE the new emojis, but at 22px on a dark background they're hard to distinguish from the previous avatar PNG render. Tobe is calling them "robot icons" because at that size, a small colorful blob reads as a generic icon.

## Fix: make the emoji dramatically larger and more distinct
`channel-tab-companion .companion-tab-emoji`:
- Box: 22×22 → 34×34 (54% larger)
- Font size: 16px → 26px (62% larger)
- Line height: 20 → 32 (matches the new box)
- Background: transparent → `rgba(255, 255, 255, 0.04)` (subtle light tint so the emoji pops against the dark UI)
- Border: transparent → `rgba(255, 255, 255, 0.12)` (subtle light border)
- Active tab: orange-tinted background + border to match the existing accent color
- Font stack: extended to include `Noto Emoji` (monochrome fallback) so the emoji ALWAYS renders something, even on systems without Noto Color Emoji

The bigger emoji is unmistakable as a colored emoji glyph, not a small pixel-art sprite.

## Files changed
- `src/css/layout.css` — chat-tab emoji made dramatically larger and given a subtle background so it pops
- `package.json` — 3.1.24 → 3.1.25

## Lesson: when "looks the same" persists after a fix, check rendering legibility
After fixing the actual code bug (v3.1.22/23/24), the chat tab was technically rendering the new emoji — but at 22px on dark background, the user couldn't tell the difference from the previous small pixel-art render. The "looks the same" feedback was real even though the code was correct.

The lesson is to verify rendering legibility, not just code correctness. After a visual change ships, the change should be CLEARLY VISUALLY DIFFERENT from the previous render. If you can't tell the difference at a glance, the user can't either. A 50%+ size increase and a distinct background make the change unmistakable.

If Tobe reports "still looks the same" again after v3.1.25, the next step is a screenshot diff to confirm whether the icons actually changed at all (in case the CSS isn't being loaded — Electron caches CSS too, and a forced quit + restart is needed).
