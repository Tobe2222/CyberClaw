# 3.1.21 — Per-sprite icons in the mobile companion list

## What it adds
the user: "When clicking wake word training i get this Prompt now. It really should be a meny after clicking wake training with the companions in a list and a related icon. This companion icon we could perhaps set as a property of each sprite we use for the companions. We can use that icon in the text channel also, with the icon beside the companion name for the text channels. A related emoji icon for each sprite which are applied to the companion."

The mobile wake-trainer companion picker was using the native Android `Alert.alert`, which is functional but looks like 2010-era system UI. the user wants a proper picker with the companions in a list, each with a related icon. The icon should be a property of the sprite (not a per-agent override), so adding a new sprite gives it a consistent icon across the mobile companion list, the chat tabs, and the wake trainer.

## Change 1: catalog gets an `icon` field per sprite
`src/assets/companions/catalog.json` now carries an `icon` (emoji) per sprite:
- fox 🦊
- boar 🐗
- deer 🦌
- hare 🐇
- black_grouse 🦚

These are the source of truth for the mobile. Per-agent `emoji` overrides still take precedence when set (e.g. a user can set their companion's emoji to something custom in the agent editor and it wins).

The mirror copy at `android/app/src/main/assets/companions/catalog.json` is updated identically.

## Change 2: desktop propagates the icon to the mobile
New `getSpriteIcon(pixelId)` helper in `app.js` looks up the catalog icon for a sprite. Both `agents_list` broadcast sites (`broadcastAgentsListToMobile` and the saveCompanion re-broadcast path) add an `icon` field to each agent entry:

```js
icon: a.emoji || getSpriteIcon(a._pixelCompanionId) || null
```

Resolution order: per-agent `emoji` (user override) → sprite `icon` (catalog default) → `null` (mobile falls back to 🐾).

The sync server (`sync-server.js`) passes the whole `agents` array through to the WebSocket, so the new field lands on the mobile without any server-side changes.

## What's NOT changing
- Desktop chat tab emoji (still falls back to 🤖 when no per-agent emoji). The change is a single new field in the mobile payload; the desktop UI is unchanged.
- Per-agent `emoji` overrides still work. If the user picks a custom emoji for their companion in the agent editor, that wins.
- Old training data (per-companion wake samples from v3.1.67) is unaffected.

## Files changed
- `src/assets/companions/catalog.json` — added `icon` per sprite
- `src/js/app.js` — new `getSpriteIcon` helper, `icon` field in both `agents_list` broadcast sites
- `package.json` — 3.1.20 → 3.1.21

## Mobile companion (v3.1.68, separate release)
- The wake-trainer companion picker is now a custom modal sheet (replacing the native `Alert.alert`). Each row shows the companion's sprite icon + name + a "train →" hint, with a dimmed backdrop and a Cancel button.
- `availableCompanions` in SettingsScreen now includes `emoji` and `icon` from the desktop's `agents_list` payload.
- Chat-tab emojis in HomeScreen fall back to the sprite `icon` when the agent has no custom `emoji`, so newly added companions show a meaningful icon next to the name without the user having to set one.
- Chat-message labels and the wake greeting hint use the same fallback.
