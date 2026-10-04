# v3.3.32 — Chat bubble quest pill overlap + all-tabs online dot

**Tobe 2026-10-02 07:53 (Discord #cyber-dev):**

> "@Clawsuu the desktop chat bubble still looks bad.
> What if we put the quest name at the bottom right in a
> way which it overlaps with the lowest text line. Such
> that it does not has its own which incresses the text
> bubble Height?
>
> And the live/active indicator for the companion chat
> tab is gray while the companions are online."

Two visual bugs from the v3.3.30 / v3.3.22 work, both
caught on a fresh look at the rendered UI. The fixes are
renderer-side CSS/JS only; no main-process or sync-server
changes. Renderer hot-reloads on next page load (no
restart needed, per TOOLS.md).

## Fix 1 — Quest pill overlaps the last line of bubble text

The v3.3.30 pill was absolutely-positioned at
`bottom: 4px; right: 8px` inside the bubble, but the
bubble itself kept its `padding: 8px 12px` (8px bottom).
For short messages, the pill sat in 8px of empty padding
**below** the text instead of overlapping it. The bubble
still looked like it had a "tail" of empty space the
pill was sitting in, and the pill visually read as a
separate row of footer text.

Tobe's exact request: "put the quest name at the bottom
right in a way which it overlaps with the lowest text
line. Such that it does not has its own which incresses
the text bubble Height."

**Change in `src/css/components.css`:**

- `.chat-msg` `padding` bottom shrunk from `8px` to `2px`.
  Top, left, right padding unchanged so the bubble's
  body and side margins stay identical.
- `.msg-quest-header` shrunk:
  - `font-size: 9px → 8px`
  - `padding: 1px 6px → 0px 5px 1px 5px`
  - `right: 8px → 4px`, `bottom: 4px → 0px`
  - opacity `0.55 → 0.85` (needed because the pill now
    sits ON TOP of text, not in empty padding — needs
    enough contrast to read against arbitrary message
    text)
  - added `border: 1px solid rgba(255, 140, 26, 0.45)`
    and `box-shadow: 0 0 2px rgba(0, 0, 0, 0.6)` so the
    pill reads as a tag floating over the text rather
    than as part of the message
  - added `line-height: 1.2` so the pill's text doesn't
    push its bounding box taller than needed
  - `border-radius: 8px → 6px` to match the smaller size

- `.msg-quest-header.no-quest` (the "— No quest" label
  for messages stamped with no active quest) also gets
  a subtle border + background to match the new visual
  style. Was previously almost invisible at 0.4
  opacity; bumped to 0.65.

`pointer-events: none` was already there in v3.3.30 and
is unchanged — text selection under the pill still works
because the pill doesn't intercept mouse events. Verified
by reading the existing v3.3.30 comment block above the
rules and confirming the property is intact.

**Result:** the pill now sits in the bubble's
bottom-right corner overlapping the last line of text,
not in dead padding space below it. The bubble's height
is driven by the message text alone (plus the 2px
bottom padding, which is a hairline). Long single-line
texts still do clip behind the pill where they reach the
right edge, but that's the explicit "overlap with the
last text line" behaviour Tobe asked for.

## Fix 2 — Green-dot online indicator on ALL channel tabs

The v3.3.22 green-dot indicator was only updated inside
`updateChatHeader()`, which is only called when the chat
for a companion is opened (line 2465 / 965 / 10109). For
companions whose chat has never been opened, the tab
was rendered fresh by `renderCompanionChannelTabs()`
without the `.online` class — and the CSS default
`.companion-tab-status` is grey when the parent tab
lacks `.online` (`.channel-tab-companion:not(.online)
.companion-tab-status`). So every tab the user hadn't
clicked into was grey, regardless of whether the
companion was actually awake.

Tobe's report: "the live/active indicator for the
companion chat tab is gray while the companions are
online."

**Change in `src/js/app.js`:**

- New function `refreshChannelTabsOnlineState()` that
  iterates `agentOrder`, looks up each agent's
  `sleepState`, and toggles `.online` on its tab via
  `classList.toggle('online', !sleeping)`. Wrapped in a
  try/catch like the rest of the tab helpers — same
  fail-soft behaviour.
- Wired up at three call sites:
  1. `updateChatHeader()` — replaces the v3.3.22
     one-line `tab.classList.toggle` for the active
     agent. Now refreshes every tab.
  2. `renderCompanionChannelTabs()` — called at the
     end, after all tabs are appended. Covers first
     load, agent add, agent remove, and the
     `renderCompanionChannelTabs` re-render path.
  3. `toggleCompanionSleep()` — the manual sleep/wake
     toggle. The just-toggled companion is not
     necessarily the active chat companion, so the
     v3.3.22 path didn't reach its tab. Now every tab
     re-syncs against current `sleepState`.

The function deliberately iterates `agentOrder` rather
than reading `.channel-tab-companion` from the DOM —
agentOrder is the authoritative list, and tabs for
removed agents won't exist anyway (renderCompanionChannelTabs
rebuilds the tab list on each call).

## Files

- `src/css/components.css` — `.chat-msg` bottom padding
  `8px → 2px`; `.msg-quest-header` made smaller, tighter,
  bordered, overlapping; `.msg-quest-header.no-quest`
  styled to match.
- `src/js/app.js` — new
  `refreshChannelTabsOnlineState()` function; called
  from `updateChatHeader`, `renderCompanionChannelTabs`,
  and `toggleCompanionSleep`.
- `package.json` — 3.3.31 → 3.3.32

## Deploy

Renderer hot-reloads on next page load. No restart
needed. The sync-server and main process are not touched.

## Verification plan

For Tobe to verify both fixes in one pass:

1. **Bubble:** open chat with any companion, send a few
   short messages on a quest (so the pill says the quest
   name, not "— No quest"). The pill should now sit on
   top of the right end of the last text line in each
   bubble, with a small dark background panel and accent
   border. For short single-line messages, the bubble
   should be only as tall as the text + 2px of padding
   below; no empty footer area.
2. **Online dot:** open the chat for one companion (so
   that companion's tab is "active" with the cyan
   highlight). The OTHER tabs in the channel bar should
   show a green dot, not grey. Click the inspect-panel
   💤 Sleep button on one of them — that tab's dot
   should switch to grey (sleeping) without you having
   to open its chat.

## Lesson (added to MEMORY.md)

**Tab-toggle UI updates must iterate all instances, not just
the one being interacted with.** v3.3.22 attached the
green-dot update to `updateChatHeader`, which only fires
for the active chat companion. Toggling the sleep state
of a non-active agent, or simply rendering the tabs at
first load, left the relevant tab's dot in its default
grey state. The fix pattern (and the general one for any
"status dot per item" UI):

- A separate function `refreshItemState(item)` that
  iterates all items.
- Called from every interaction that could change an
  item's state (toggle, add, remove, render, refresh).
- Idempotent — safe to call repeatedly without side
  effects.

Same lesson applies to per-companion pills, per-quest
badges, per-channel status indicators, etc.