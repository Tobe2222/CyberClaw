# v3.1.47

## Fix: stray 🤖 next to agent messages in chat

**Bug:** Agent messages in the desktop chat showed a robot
emoji (🤖) as the prefix, even when the agent had a custom
emoji (😺, 🦊, etc.) configured. The robot appeared next to
the message text, not just in the tab icon.

**Root cause:** Three places in `src/js/app.js` were
inserting `m.emoji || '🤖'` (or the equivalent
`leader.emoji || getSpriteIcon(leader?._pixelCompanionId)`)
as the message prefix. The `|| '🤖'` is the desktop's
*internal storage default* (line 191) — it gets written
to the agents dict at load time so the desktop's own UI
has something to fall back to. But the *chat prefix* is
a different concept: it should be "the agent's user-set
emoji" (which can be empty), not "the desktop's default".

When an agent has no explicit emoji, the desktop stores
`'🤖'` in the agents dict. The chat prefix logic read that
`a.emoji || '🤖'` and showed the robot. The user saw a
stray robot next to messages from every agent that
didn't have a custom emoji configured.

**Bonus effect (the original suspicion):** because the
desktop was sending `emoji: '🤖'` over the WebSocket to
the mobile, the mobile's `request_agent_history` was
caching the chat history with the bad emoji. Even after
the desktop fix, old cached history on the mobile still
had the robot — the render-side fix covers that case.

**Fix:** five call sites updated.

*Render sites (don't show the bad emoji):*
- `app.js:1469` (chat render): strip `'🤖'` from the
  prefix, fall back to `[name]` only.
- `app.js:2044` (events render): same fix.

*Send sites (don't broadcast the bad emoji to mobile):*
- `app.js:1684` (chat send, leader agent).
- `app.js:1826` (chat send, fallback path).
- `app.js:2327` (chat send, arena bubble reaction).
- `app.js:4126` (chat send, image-attached message).
- `app.js:4554` (chat send, custom reaction).

All use the same pattern as the existing v3.1.28/v3.1.30
broadcast fix:
```js
a.emoji === '🤖' ? null : (a.emoji || null)
```

**Verification:**
- `node --check src/js/app.js` clean.
- Brace/paren/bracket balance: 0/0/0.
- Searched for `m.emoji || '🤖'` and `emoji || '🤖'` —
  one remaining match at line 191, which is the intentional
  internal-storage default (kept so the desktop's own UI
  has a fallback when rendering agent icons in places that
  aren't the chat prefix).
