# 3.1.29 — Broadcast SVG icons as data URIs (works in React Native)

## What it adds
the user: "Updated mobile and that still has the old robot icons." After v3.1.28 the desktop was correctly showing Twemoji boar/hare SVGs in the chat channel tabs, but the mobile (v3.1.69) was still showing robot icons.

## Root cause: relative file paths don't work in React Native's `<Image>`
v3.1.26 added `iconFile` (relative path like `'assets/icons/boar.svg'`) to the catalog and the broadcast payload. The desktop chat tab uses `<img src="boar.svg">` which works (HTML resolves relative paths from the HTML's location).

But the mobile (React Native) does:
```js
<Image source={{ uri: a.iconFile }} />
```
React Native's `Image` component can't resolve relative file paths at runtime. It can load from `require('./local.png')` (bundled at build time) or `uri: 'https://...'` (HTTP/HTTPS) or `uri: 'data:image/svg+xml;base64,...'` (data URIs). A bare relative path like `'assets/icons/boar.svg'` is none of these, so the Image fails to load and falls back to whatever the system renders next — which for the user's agents is `agent.emoji = '🤖'`.

## Fix: send SVG content as base64 data URI
The broadcast payload now includes `iconDataUri` alongside `iconFile`. `iconDataUri` is the SVG file's content encoded as `data:image/svg+xml;base64,...`. React Native renders data URIs reliably. The SVG is <3KB so the base64 overhead (~4KB) is negligible.

The mobile prefers `iconDataUri` over `iconFile`. The desktop chat tab continues to use `iconFile` directly (HTML resolves it fine).

## Also fixed: `iconFile` missing from the FIRST broadcast site
v3.1.26 added `iconFile` to the second broadcast site (`mobile-request-agents-list` IPC handler) but missed the first one (`broadcastAgentsListToMobile`, called from `initArenaCompanions`). This meant the very first broadcast after boot didn't include the iconFile. v3.1.29 adds `iconFile` and `iconDataUri` to both sites.

## Files changed
- `src/js/app.js` — new `getSpriteIconDataUri(pixelId)` helper that reads the SVG file and base64-encodes it; both broadcast sites now include `iconFile` and `iconDataUri`
- `package.json` — 3.1.28 → 3.1.29

## Lesson: relative paths don't cross process boundaries
When shipping image references across process boundaries (renderer → React Native, server → client), a relative path is ambiguous — relative to WHAT? The recipient might be in a different filesystem context (Android assets folder vs Linux project root), a different runtime (HTML vs React Native vs Electron renderer), or a different OS (Windows vs Unix).

The portable formats are:
- **Absolute URLs** (`https://...`) — if you control the server
- **Data URIs** (`data:...`) — if the size is reasonable (<10KB per icon)
- **Bundled `require()`** — if you ship the file with the build

For the broadcast case here, data URIs win: small icons, no server, no build dependency, works everywhere.
