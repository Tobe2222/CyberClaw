# 3.1.30 — Mobile agents_list broadcast separates user emoji from sprite icon

## What it fixes

After installing the mobile v3.1.71 chat-label fix, Tobe reported that
the chat message labels now show 🤖 (the desktop's default emoji)
instead of the sprite catalog icon (🦊 for fox, 🐇 for hare, etc.).
The chat tabs at the bottom of the screen also had no icon at all,
because both the per-agent emoji and the sprite icon had collapsed to
the same default value in the broadcast.

The expected behavior: if the user hasn't set a per-agent emoji, the
mobile should fall back to the sprite's catalog icon (the emoji that
shipped with the sprite in the catalog). The desktop's own UI does
this correctly — `agent.emoji || getSpriteIcon(agent._pixelCompanionId)
|| '🤖'` — but the broadcast wasn't sending those two fields
independently.

## Root cause: the broadcast conflated "user emoji" with "sprite icon"

The desktop's agents dict stores `a.emoji = a.emoji || '🤖'` (line
191 in `app.js`). Once stored, `a.emoji` is never null — the
desktop's UI uses this to render a robot when no sprite / no user
emoji is set.

The mobile broadcast (lines 423-424 and 3544-3545) was:

```js
emoji: a.emoji || null,
icon: a.emoji || getSpriteIcon(a._pixelCompanionId) || null,
```

Because `a.emoji` is always truthy (either the user-set emoji or the
'🤖' default), both fields ended up as either the user-set emoji or
'🤖'. The mobile never received the sprite catalog icon, so its
`a.icon` lookup always returned '🤖' (or null) and its `a.emoji` field
showed '🤖' too.

The mobile's own logic (`a.emoji || a.icon || '🐾'`) was correct — the
problem was the data it was working with.

## The fix

Two changes in the broadcast (both sites, `app.js:423-424` and
`app.js:3544-3545`):

1. **`emoji`** is the user's per-agent emoji only. The desktop's
   '🤖' default is treated as "not set" and sent as `null` instead:
   ```js
   emoji: a.emoji === '🤖' ? null : (a.emoji || null)
   ```

2. **`icon`** is the sprite catalog icon only — never the per-agent
   emoji, never the '🤖' default. The sprite icon is a separate
   concept (intrinsic to the sprite, like the sprite's name and
   folder), and the mobile composes it with the user's emoji in its
   own chain:
   ```js
   icon: getSpriteIcon(a._pixelCompanionId) || null
   ```

The desktop's own UI is unchanged — its rendering sites
(`app.js:581`, `1480`, `1524`) already do
`agent.emoji || getSpriteIcon(agent._pixelCompanionId) || '🤖'`,
which still works correctly.

## Resulting mobile behavior

| User-set emoji | Sprite has icon | Mobile emoji | Mobile icon |
|----------------|-----------------|--------------|-------------|
| ✓ (e.g. 😺)    | ✓ (e.g. 🦊)     | 😺 (user)    | 🦊 (sprite) |
| ✗ (default)    | ✓ (e.g. 🦊)     | null         | 🦊 (sprite) |
| ✗ (default)    | ✗               | null         | null        |

The mobile's chat label and tab use the same chain
(`emoji → icon → 🐾`), so a user-set emoji wins; otherwise the sprite
icon wins; otherwise the paw. The chat tab and the message label are
now consistent by construction.

## Mobile compatibility

The mobile v3.1.71 chat-label fix already does
`a.emoji || a.icon || '🐾'`. No mobile change is needed. Users on
v3.1.71 + this desktop v3.1.30 will see the correct sprite icon as
soon as the desktop restarts and the fresh agents_list broadcast
arrives.

Users on v3.1.71 with the older desktop v3.1.29 will keep seeing 🤖 —
the desktop's broadcast is what determines the data.

## Files

- `src/js/app.js` — both broadcast sites updated with the new
  emoji/icon resolution.
- `package.json` — 3.1.29 → 3.1.30.
