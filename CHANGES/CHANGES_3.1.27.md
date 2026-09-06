# 3.1.27 — loadPixelCatalog always re-reads (fixes stale iconFile)

## What it fixes
the user: "still says the same" after v3.1.26 (Twemoji SVG). DevTools diagnostic showed the chat tab text is literally `🤖` — meaning `getSpriteIconFile()` returned null. The catalog file on disk has `iconFile` for all 5 sprites, but the renderer's cached copy of the catalog (loaded at module init time) was from the OLD code (before iconFile existed) and never got refreshed.

## Root cause: module-level cache + no re-read
`loadPixelCatalog()` in `src/js/companion-renderer.js` cached the parsed catalog at module scope (`let pixelCatalog = null`). On first call it reads the file and caches. On subsequent calls it returns the cached version. If the renderer process started before v3.1.26 was deployed, the cached catalog never had the `iconFile` field, and the renderer's `getSpriteIconFile()` always returned null even after pulling new code.

## Fix: always re-read the catalog
`loadPixelCatalog()` now reads the catalog file on every call (no cache). The catalog is tiny (<4KB) so the I/O cost is negligible. The cache fallback is preserved for the empty/failed case: if all candidates fail to read AND we have a previously-loaded catalog, return that one. Otherwise return `{ companions: [] }`.

This means:
- After `git pull` + restart, the renderer immediately sees the new catalog with `iconFile` field
- No stale cache can pin the old version
- Even if a `git pull` happens mid-session (without restart), the next `getSpriteIconFile()` call will see the new field

## Files changed
- `src/js/companion-renderer.js` — `loadPixelCatalog` always re-reads
- `package.json` — 3.1.26 → 3.1.27

## Lesson: don't cache files you can re-read cheaply
The catalog is ~4KB and the read+parse takes <1ms. Caching it at module level saved nothing and introduced a stale-cache bug that's hard to diagnose. For small, rarely-changing data files read frequently during a session, just re-read every time. The "optimization" of caching is not worth the bug surface.

This is the same lesson as v3.1.24 (catalog loading failing silently) — the catalog file was the source of truth, and my code was hiding that fact behind a cache or a silent error. When the source of truth is a file on disk, every read should go to disk unless there's a real performance reason not to.
