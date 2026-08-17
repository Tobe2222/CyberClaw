# 3.1.26 — Twemoji SVG icons in chat tabs (smooth, consistent)

## What it adds
the user: "i just get a warning when i try to paste. but you can obviously see that its still the wrong emojis, no matter their size. change the size back also."

After v3.1.25 the chat tabs were technically rendering the Unicode emoji glyph (`🐗`, `🐇`), but on Linux the system emoji font (Noto Color Emoji) renders these as **low-resolution bitmaps** that look pixelated at small chat-tab sizes. The user was seeing pixel-art boar/hare icons — which is actually the correct emoji glyph, just rendered badly by the system font.

The fix: bundle the Twemoji SVG files (vector graphics, smooth at any size, consistent across all platforms) and render those instead of the Unicode emoji. The 5 SVGs are tiny (~8KB total) and live at `src/assets/icons/{sprite}.svg`.

## Changes
- **Catalog gets `iconFile` field** pointing to the SVG path (e.g. `assets/icons/boar.svg`).
- **`getSpriteIconFile(pixelId)` helper** in `app.js` looks up the iconFile for a sprite.
- **Chat tabs render `<img src="assets/icons/boar.svg">`** when an iconFile is available — Twemoji smooth boar. Falls back to text emoji + per-agent emoji + 🤖 if no iconFile.
- **CSS reverts to original chat-tab sizing** (20×20, 14px font). The Twemoji SVG renders crisp at any size so we don't need the larger box.
- **Mobile broadcast payload now includes `iconFile`** so the mobile can render the same SVG. The mobile side will pick this up in a follow-up release.

## Why Twemoji SVG beats Unicode emoji on Linux
- **Noto Color Emoji** (Linux default): bitmap, low resolution, looks pixelated at small sizes.
- **Apple Color Emoji** (macOS): vector, smooth, but only available on Apple devices.
- **Segoe UI Emoji** (Windows): vector, smooth, only available on Windows.
- **Twemoji SVG**: vector, smooth, identical across all platforms. Used by Twitter, GitHub, Discord.

By bundling Twemoji, the desktop and mobile show the SAME boar/hare icons regardless of which OS the user is on.

## Files changed
- `src/assets/companions/catalog.json` — added `iconFile` per sprite
- `src/assets/icons/{boar,hare,fox,deer,grouse}.svg` (new) — Twemoji SVGs
- `src/js/app.js` — `getSpriteIconFile()` helper, chat tab renders `<img>` from iconFile, mobile payload includes iconFile
- `src/css/layout.css` — reverted v3.1.25 size bump, added `.companion-tab-icon-img` selector
- `package.json` — 3.1.25 → 3.1.26

## Lesson: don't rely on the system emoji font for app iconography
For app-level icons (chat tabs, picker rows, anywhere you show an identifier for a thing), use a bundled SVG/PNG icon. The Unicode emoji works for typed text (chat messages) because the user knows what they typed. For app UI, the system emoji font varies wildly across platforms and renders poorly on Linux. A small bundle of Twemoji SVGs (~8KB for 5 sprites) gives consistent, smooth, recognizable icons everywhere.

the user's feedback chain on this was instructive: v3.1.22 (code fix), v3.1.23 (avatar removed), v3.1.24 (catalog loading), v3.1.25 (size bump), v3.1.26 (Twemoji SVG). Each step was technically correct but didn't fix the actual problem — system emoji rendering on Linux. Bundling Twemoji SVG sidesteps the system emoji font entirely.
