# Changelog — v3.1.19 (session 2026-06-16)

## v3.1.19 — cap desktop arena at 6 visible companions

The desktop's pixel arena was unbounded — every non-hidden
companion was rendered, with the pixelArena spreading them
horizontally. With many companions this gave a long
horizontal scroll bar and a crowded scene. The mobile
already caps at 6 (v3.1.27); the desktop should match.

### The cap

- `MAX_ARENA_COMPANIONS = 6` in `initArenaCompanions()` —
  the initial render takes the active chat companion
  (if visible) first, then fills from `agentOrder` in
  order, until 6 are placed.
- The same cap applies to `applyCompanionVisibility()`,
  the runtime add/remove handler. If a user un-hides a
  7th companion, the add is skipped (logged to the
  console) — the companion is still fully usable
  (chat, settings, etc.), just not rendered in the
  pixel arena.
- The active chat companion is ALWAYS included in the
  arena, even over the cap, so the user can always see
  the companion they're currently chatting with.

### What didn't change

- The mobile cap of 6 (added in v3.1.27) is independent;
  the mobile already cuts the list at the consumer side.
  The desktop now also caps at the source, so the mobile
  won't see a list of 20 and then cut it down.
- The agent list, channel tabs, chat history, and
  everything outside the pixel arena are unaffected.
  The user can still have more than 6 companions; only
  the on-screen sprite count is limited.
- The `cyberclaw-hidden-companions` set is still
  respected. Hidden companions don't render in the
  arena, and don't count toward the cap.

## Files

- `src/js/app.js`
  - `initArenaCompanions()`: `visibleOrder` now sliced
    to `MAX_ARENA_COMPANIONS` (6).
  - `applyCompanionVisibility()`: cap-aware add loop.
    The active chat companion is always added; the
    rest are added in `agentOrder` order until 6 are
    placed. Excess adds are logged and skipped.
- `package.json` — bumped to 3.1.19

## Verification

- `node --check` passes on the modified JS.
- With 6 or fewer non-hidden companions, behaviour is
  unchanged from v3.1.18.
- With 7+ non-hidden companions, the arena renders the
  first 6 (in arena order, active chat companion first).
  The 7th+ are still in the agent list and chat-
  able, but not visible in the pixel arena.
