# v3.3.35 — Per-bubble quest pill on renderer reload + remove legacy chat-quest-indicator

**Tobe 2026-10-04 11:25 (Discord #cyber-dev):**

> "Okey, on the desktop, dont have the toggles for
> current quest and casual switch places when clicked.
> And we can now remove the quest indicator right above
> the attach file and user text input field.
>
> Still dont see the chat watermark on the bottom right
> of the text bubbles on desktop, they might be applied
> forward tho."

Two bugs + one cleanup, all in v3.3.35.

## Fix 1 — Per-bubble quest pill is missing on renderer reload (THE BIG ONE)

Tobe: 'Still dont see the chat watermark on the bottom
right of the text bubbles on desktop, they might be
applied forward tho.'

The "might be applied forward" instinct is exactly
right. The pill IS rendered on every NEW bubble that
arrives during a session — `addChatMsg` (line 5156)
prepends `questHeaderHtml` to the bubble's innerHTML.
But on every renderer reload (CSS hot-reload, page
navigation, devtools open/close, etc.), the entire chat
panel is re-rendered from localStorage by
`_renderStoredChatMsg` (line 2737), which had a copy
of the bubble-render code that **omitted the
`questHeaderHtml` prepend**. Result: the bubbles the
user saw five minutes ago had the pill; the same
bubbles after a page reload don't.

This was hidden by the fact that the desktop renderer
hot-reloads on every file change, and v3.3.32 / v3.3.34
touched app.js + components.css several times today. So
every v3.3.3x release re-rendered the chat history from
storage WITHOUT the pill. The user saw "the pill is
gone" but couldn't pin it on a specific reload.

### Fix

Mirror the `questHeaderHtml` logic from `addChatMsg` in
`_renderStoredChatMsg`. Use the stored message's
`activeQuestId` (which was stamped by `addChatMsg` at
the time the message was sent) as the source of truth
— NOT the live `activeQuestId`, which may have
changed since the message was sent. Look up the quest
name from `cachedQuestsList` for the displayed text;
fall back to the stored `m.activeQuestName` if the
quest isn't in the current list (deleted quest, etc.).

Also extended the same pill to `error` and `typing`
bubbles in BOTH the live (`addChatMsg`) and reload
(`_renderStoredChatMsg`) paths. Pre-v3.3.35 these
bubble types rendered no quest attribution at all,
which made error bubbles (e.g. "Error: agent call
timed out") look like they belonged to no quest when
they were actually fired under one.

### The v3.3.34 pill shape (still in effect)

- Position: `position: absolute; top: 3px; right: 6px;`
  on a `.chat-msg` parent that has `position: relative;
  padding: 24px 12px 4px 12px;`.
- Style: 10px bold, opaque accent background
  (`var(--accent, #ff8c1a)`) with `#1a1a1a` text,
  rounded corners, 1px accent-light border. Reads as a
  bright postage stamp on every bubble.

## Fix 2 — Remove the legacy chat-quest-indicator badge

Tobe: 'we can now remove the quest indicator right
above the attach file and user text input field.'

The pre-v3.3.34 chat-quest-indicator was a small 9px
gold pill (`📜 <name>` or hidden) sitting just above
the chat input row. v3.3.34 added the new centered
toggle pill and kept the legacy badge as a hidden
placeholder. But `updateChatQuestIndicator()` still
set `display: ''` on it on every quest change, which
un-hid the inline `display:none` and showed the
legacy badge alongside the new toggle.

### Fix

- `index.html` — remove the
  `<span id="chat-quest-indicator">` element entirely.
- `components.css` — remove the `.chat-quest-badge`
  CSS rule.
- `app.js` — `updateChatQuestIndicator()` now early-
  returns after forcing `display: none` on the (now
  nonexistent) element. The function still fires
  `updateQuestIndicator()` for directory / metadata
  refresh and `updateChatQuestToggle()` to keep the
  new toggle in sync. The `if (!el) return;` guard
  makes the function safe to call when the element
  is gone.

## Fix 3 — Toggle click logging

Tobe: 'dont have the toggles for current quest and
casual switch places when clicked.'

This was ambiguous in the report. Possible
interpretations:
- The toggle doesn't appear at all → FALSE, the
  vision model confirmed it's visible above the chat
  input.
- The toggle appears but doesn't switch state when
  clicked → UNKNOWN, the report doesn't say if the
  pill text or chat panel changed.
- The toggle works but the user didn't see the change
  because the bucket they switched to was empty →
  UNKNOWN.

To make the next report unambiguous, added a
`console.log` in `window.toggleChatQuestContext`
that records the click with `{ prev, target, ts }`.
The next time Tobe clicks the toggle and the chat
panel doesn't change, we can ask him to check the
DevTools console (View → Toggle Developer Tools) and
read the log to confirm:
- Did the click fire at all?
- Did `setActiveQuestId` get the right target?
- Did the IPC fail?

If the click doesn't even fire, the issue is the
button being covered by an overlay or the
`onclick="toggleChatQuestContext()"` not being
evaluated (would point to a JS error earlier in
app.js that breaks the renderer).

## Files changed (v3.3.35)

- `src/js/app.js` — extend `_renderStoredChatMsg`
  with `questHeaderHtml` from stored `m.activeQuestId`
  + name lookup. Apply to user / agent / error cases.
  Extend `addChatMsg` error and typing cases to
  include `questHeaderHtml`. Force
  `updateChatQuestIndicator` to never re-show the
  legacy element. Add click log to
  `toggleChatQuestContext`.
- `src/index.html` — remove
  `<span id="chat-quest-indicator">` element.
- `src/css/components.css` — remove `.chat-quest-badge`
  rule.
- `package.json` — version bump to 3.3.35.

## Deploy

Renderer hot-reload. No restart needed (all changes
are inside the renderer bundle). Tobe's running
desktop will pick up the new code on the next page
reload. Recommend Ctrl+R / Cmd+R to force a hard
reload in case the renderer cached the old CSS.

## Verification plan

For Tobe to verify in one pass:

1. **Force a hard reload of the desktop renderer.**
   `View → Toggle Developer Tools` (or Ctrl+Shift+I)
   to open DevTools, then Ctrl+R to reload. The chat
   panel re-renders from localStorage.
2. **Per-bubble quest pill.** Every bubble in the
   active quest's chat should have a bright orange
   "stamp" in the top-right corner showing the quest
   name. Bubbles in the casual chat (after toggling)
   should have a gray "— Casual" stamp in the same
   position. This includes the bubble visible right
   now in the chat (the [You] bubble with the Android
   Phone [From: ...] prefix) — after the reload, that
   bubble should have the stamp.
3. **No legacy chat-quest-indicator.** Above the
   chat input row, the only quest UI is the centered
   toggle pill (`📜 HIVE_CONTROL  [↔ Casual]`). The
   small 9px gold pill that used to sit just above
   the input is gone.
4. **Toggle click.** Click `↔ Casual`. The pill should
   update to `💬 Casual  [↔ HIVE_CONTROL]` and the
   chat panel should re-render from the casual chat
   bucket. Click `↔ HIVE_CONTROL` to go back.

## Cross-cutting note (2026-10-04)

The bug in `_renderStoredChatMsg` is a classic
"two render paths, one of them missed the feature"
pattern. The fix in `addChatMsg` shipped in v3.3.30
(the per-bubble quest pill). The same change was
needed in `_renderStoredChatMsg` for the pill to
survive renderer reloads. Same shape as the v3.3.20
agent-image persistence fix — a feature was added to
the live-render path but the reload-from-storage
path was missed.

**Strong rule (added 2026-10-04):** Every new
visual feature on a chat bubble must be applied to
BOTH render paths — `addChatMsg` (live, in-session)
and `_renderStoredChatMsg` (reload-from-storage).
If only one is updated, the feature will appear
correctly during the session and disappear on every
renderer reload. The reload path is easy to miss
because it's only exercised when the user reloads
the page, which is rare in normal use but common
during a release train (when the user is reloading
to pick up new code anyway).

Same generalizes to: any "X renders in both the
in-memory and the persisted path" scenario. Always
audit both. The asymmetric update is the bug.