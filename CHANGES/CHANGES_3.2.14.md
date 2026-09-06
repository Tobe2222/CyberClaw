# v3.2.14 — Chat channel shows companion sprite, not robot, for agents without explicit emoji

**User report:** "the desktop chat channel has a robot emoji
Instead of the companion emoji in its texts. It should have
the companions icon."

**Root cause:** the desktop stores `agents[id].emoji === '🤖'`
as the default emoji when no explicit emoji is set for the
agent. Three sites in `src/js/app.js` rendered this default
straight through to the user-visible UI:

1. **Chat header avatar** (line 1637) — `updateChatHeader`
   showed 🤖 next to the active companion's name in the chat
   panel header.
2. **Channel tab icons** (line 1681) — the row of buttons
   above the chat that switch between companions showed 🤖
   for any agent without an explicit emoji.
3. **Carousel avatar** (line 607) — the rotating 3D companion
   carousel also rendered 🤖 for those agents.

The chat message *prefix* (the `[emoji] [name]` part of each
message) was already fixed in v3.1.96 — it strips 🤖 and falls
back to the sprite icon at render time. But the three surfaces
above used the pattern `agent.emoji || getSpriteIcon(...) || '🤖'`,
which only falls through to the sprite icon when `agent.emoji`
is falsy. Since `agents[id].emoji === '🤖'` is a truthy string,
the 🤖 won and the sprite icon was never reached.

**Why v3.1.96 missed these three sites:** that fix targeted the
*chat history* path (where `addChatMsg` receives an `emoji`
parameter and persists it to localStorage). The three
avatar/tab/header sites read `agent.emoji` directly off the
agents dict — they never go through `addChatMsg`'s resolution.

**Fix:** applied the same `(agent.emoji && agent.emoji !== '🤖')`
strip pattern at all three sites:

```js
(agent.emoji && agent.emoji !== '🤖')
  ? agent.emoji
  : (getSpriteIcon(agent._pixelCompanionId) || '🤖')
```

So: explicit non-robot emoji → keep it. Otherwise → fall back
to the catalog sprite icon (boar.svg, hare.svg, etc.). If
both are unavailable, keep 🤖 as the last-resort fallback.

**Bonus: legacy chat history migration.** Persisted chat
histories from before v3.1.96 contain messages with
`emoji: '🤖'` baked in. The render site at line 1606 already
strips 🤖 from the prefix display, so those old messages
showed *no* prefix emoji at all (just `[name]`). The migration
in `restoreChatHistory()` walks the loaded history, rewrites
each legacy 🤖 entry to the resolved sprite icon (or null if
no agent/fallback exists), and logs the count. New messages
already pass the resolved emoji via `addChatMsg`, so they
don't need migration.

**Files:**

- `src/js/app.js` — three render sites + restore migration
- `package.json` — 3.2.13 → 3.2.14

**Audit rule for this bug class:** anywhere that renders an
agent's emoji directly from the agents dict needs the
`!== '🤖'` strip. The full set is now:
- Carousel avatar (line 607)
- Chat header avatar (line 1637)
- Channel tab icon (line 1681)

The broadcast path to mobile (`icon: getSpriteIcon(...)`) and
the chat message prefix rendering (`m.emoji !== '🤖'`) were
already correct. Future sites should follow the same pattern
or use the helper if added later.

**Lesson (general):** when fixing a class of bug, audit all
parallel sites that read the same source field. The v3.1.96
fix touched the message prefix path; the avatar/tab/header
paths were parallel readers of `agents[id].emoji` and slipped
through because they don't share state with the message prefix.
A grep for `agent.emoji || getSpriteIcon` would have caught
all three at once.