# 3.1.22 — Desktop UI uses sprite icons too

## What it adds
v3.1.21 added the `icon` field to the catalog and propagated it to the mobile, but the desktop chat tabs, agent rows, and inspect header were still falling back to `🤖` for agents without a custom `emoji`. the user: "I dont see the new icons on the chat channels on either of them" — even after restarting desktop and updating mobile to v3.1.68.

The mobile correctly showed `🐾` fallback (because the cache wasn't refreshed yet), but the desktop needed the same fallback chain the mobile has: per-agent `emoji` → sprite catalog `icon` → `🤖`.

## Change 1: Desktop chat tab emoji uses sprite icon
`renderCompanionChannelTabs` in `app.js` now uses `agent.emoji || getSpriteIcon(agent._pixelCompanionId) || '🤖'` instead of `agent.emoji || '🤖'`. The chat tab will now show 🦊 for a fox-sprite companion even without a custom emoji.

## Change 2: Agent row avatar and inspect header avatar
Same fallback chain applied to the side-panel agent row (`avatar.textContent`) and the inspect panel header avatar (`headerAvatar.innerHTML`). Anywhere the desktop displays an agent icon now uses the sprite icon as a fallback.

## Change 3: Chat message prefix uses resolved icon
All `addChatMsg('agent', ..., agent.emoji)` call sites now pass `agent.emoji || getSpriteIcon(agent._pixelCompanionId)`. So new agent messages in the chat channel show the sprite icon in the message prefix (`🦊 [Clawsuu]: hello`). Old messages persisted before this version will still fall back to `🤖` — that's intentional, the user can scroll past old messages.

## Files changed
- `src/js/app.js` — `getSpriteIcon` fallback in chat tabs, agent rows, inspect header, and all `addChatMsg` agent call sites (4 sites)
- `package.json` — 3.1.21 → 3.1.22

## Lesson: a "mobile-only" change is rarely mobile-only
the user's original ask was about the mobile wake trainer picker, but the same icon-source-of-truth principle applies to the desktop chat tabs. The catalog now has the icon; the desktop UI should use it too. The fallback chain (`emoji || icon || '🤖'`) is the same on both platforms — the only difference is the "default" emoji (🤖 on desktop, 🐾 on mobile), and even that could be unified later.
