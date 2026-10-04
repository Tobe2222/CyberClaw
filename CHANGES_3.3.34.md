# v3.3.34 — Centered quest toggle above chat input + visible bubble stamp

**Tobe 2026-10-04 11:05 (Discord #cyber-dev):**

> "I see there was an issue when the casual chat appeared
> on the desktop, i had to go out and in to the current quest
> to get the quest chat.
>
> I also see we have the current quest text/indicator right
> above the user input field there. Lets put that in the
> middle above that field and add a button for switch to
> casual chat. Such that the user can always toggle between
> current quest or casual chat with those two, makes sense?
>
> And i notice that the right bottom text bubble quest text
> is gone on the desktop, we should attach the quest name
> text into all chat bubbles, almost like a stamp, makes
> sense? We have this on the mobile already.
>
> Also lets update the mobile end so it says casual Instead
> of 'no quest'."

Four asks. Three are desktop v3.3.34; the mobile rename
was already done in v3.11.29 (Tobe's APK likely needs
an update — the v3.11.29 build is on origin but he
might still be on v3.11.28 from the last install).

## Fix 1 — Centered quest toggle pill above chat input

The pre-v3.3.34 chat input area had a small `chat-quest-
indicator` badge (9px font, dim gold) that was easy to
miss. It showed the active quest name but had no action
button — switching between quest / casual required
opening the quest panel and tapping the quest.

After Tobe's v3.3.31 toy-routing fix, companion reactions
(toy dropped, snack eaten, etc.) land in the no-quest /
casual chat bucket instead of the active quest's chat.
The chat panel stays on the active quest's view by
default, so the user sees the reaction bubble land in
the casual bucket but the visible chat panel doesn't
update — the user has to navigate to the casual chat
to see it. Tobe: 'had to go out and in to the current
quest to get the quest chat.' That's the v3.3.31
behavior working as designed; the missing piece is a
1-tap way to flip the visible chat between the active
quest and casual.

### What the new toggle does

A centered pill + button row above the chat input:

- On a quest:   `[ 📜 <quest-name> ]   [ ↔ Casual ]`
- On casual:    `[ 💬 Casual        ]   [ ↔ <quest-name> ]`
- No quests:    hidden entirely (nothing to toggle to)

Clicking the button calls the existing
`cyberclaw.quests.setActive(...)` IPC, which is the
same path the quest panel's ⚡ button uses. The
desktop's `activeQuestId` updates optimistically for
instant UI feedback, and the chat panel auto-jumps to
the new bucket via `setActiveQuestId` →
`switchActiveChatQuest` → `switchActiveChat`. No new
IPC plumbing, no new state field — the existing
per-quest bucket infrastructure (v3.3.11) handles
everything.

The toggle target on casual is the best available
quest: prefers `q.active === true` (the user's pin),
then `q.status === 'active'`, then the first quest in
the list. Same priority as the v3.3.11 chat-panel
auto-jump on quest-list reload.

### Files / functions changed

- `src/index.html` — added `<div id="chat-quest-toggle">`
  with `chat-quest-toggle-pill` and `chat-quest-toggle-btn`
  children. Wired to `toggleChatQuestContext()` via
  inline onclick. The legacy `chat-quest-indicator` is
  kept (hidden) for backwards compat.
- `src/css/components.css` — new `.chat-quest-toggle`,
  `.chat-quest-toggle-pill`, `.chat-quest-toggle-btn`
  classes. Centered flex row, accent-colored pill
  (orange) on quest, neutral-colored pill (gray) on
  casual. Hover state on the button highlights the
  accent color so the user can see it's tappable.
- `src/js/app.js` — new `updateChatQuestToggle()`
  function. Wired from:
  - `setActiveQuestId()` — fires after every quest
    change (so quest-panel ⭐ clicks refresh the
    toggle)
  - `updateChatQuestIndicator()` — fires after the
    small badge updates (so chat-panel auto-jumps
    also refresh the toggle)
  - the initial quest-list load IIFE — fires after
    `renderQuests()` so the toggle is visible from
    the first paint
  - new `window.toggleChatQuestContext()` click
    handler — calls `cyberclaw.quests.setActive(...)`
    with the toggle's target, optimistic local update
    via `setActiveQuestId`

## Fix 2 — Per-bubble quest stamp (more visible)

Tobe: 'the right bottom text bubble quest text is gone
on the desktop, we should attach the quest name text
into all chat bubbles, almost like a stamp, makes sense?
We have this on the mobile already.'

The v3.3.32 pill (8px font, opacity 0.85, dark
background, bottom-right corner) was too subtle. It
overlapped the bubble's text but at a size that was
easy to miss on short messages where the pill sat in
2px of bottom padding.

### New stamp style

- **Position:** top-right (was bottom-right). Top-right
  reads as a "stamp" / "metadata tag" and doesn't
  collide with the message text below it.
- **Size:** 10px (was 8px). Still small but
  unmistakable.
- **Background:** solid accent color (orange) with
  dark text. The pre-v3.3.32 design had a dark
  translucent background that disappeared against
  the bubble's dark background. Now the pill is a
  bright orange panel — it stands out on every bubble,
  agent or user, regardless of bubble color.
- **Weight:** 700 (was 600). Bolder for the small
  size.
- **Border:** accent-light border for definition.
- **No box-shadow.** The pre-v3.3.32 box-shadow was
  masked by the bubble's own shadow in some themes.
- **Bubble top padding:** 8px → 24px so the stamp
  has clearance above the message text without
  overlapping it. The bubble's bottom padding stays
  at the v3.3.32 2px (the text sits at the natural
  bottom of the bubble).

### Mobile parity

The mobile has had the inline quest pill on every
bubble since v3.11.5 (per-bubble 🎯 <name> in the
bubble header row, top-right). v3.11.18 made the
pill conditional on `item.activeQuestId !== null`
(so no-quest / casual bubbles render no pill — by
design, to avoid visual noise). The desktop's new
stamp follows the same "always show on stamped
bubbles" intent but uses an absolute-positioned
overlay instead of an inline row.

The two pieces of UI are NOT identical (mobile is
inline in the bubble header, desktop is absolute-
positioned overlay), but they serve the same purpose:
make the quest attribution visible on every bubble.

### Files changed

- `src/css/components.css` — `.chat-msg` top padding
  `8px → 24px`; `.msg-quest-header` reworked to
  top-right stamp with full-opacity accent
  background. Comments updated.
- `package.json` — version bump to 3.3.34.

## Fix 3 — Mobile "No quest" → "Casual" (already shipped in v3.11.29)

Tobe: 'Also lets update the mobile end so it says
casual Instead of "no quest".'

This was already done in v3.11.29 (shipped earlier
today). The mobile's QuestsScreen 'no active quest'
card now reads `●  Casual chat`, and the chat-message
quest-change separator reads `— Casual chat`. If
Tobe is still seeing 'No quest' on his phone, his
APK is the pre-v3.11.29 build (probably v3.11.28) —
he needs to install the v3.11.29 APK.

**No code changes for v3.3.34 on the mobile side.**
The mobile v3.11.29 is the canonical 'Casual chat'
label, and the tag is on origin. Build the APK with
`./build-android.sh` (or wait for the existing build
to complete if it's already running).

## Files changed (v3.3.34)

- `src/index.html` — added `<div id="chat-quest-toggle">`
  with pill + button, wired to `toggleChatQuestContext`.
  Legacy `chat-quest-indicator` kept hidden.
- `src/css/components.css` — new `.chat-quest-toggle*`
  classes. Per-bubble quest stamp reworked to top-
  right, 10px, opaque accent background.
- `src/js/app.js` — new `updateChatQuestToggle()`
  function (~70 lines) and `window.toggleChatQuestContext()`
  click handler. Wired from `setActiveQuestId`,
  `updateChatQuestIndicator`, and the initial quest-
  list load IIFE.
- `package.json` — version bump to 3.3.34.

## Deploy

Renderer hot-reload. No restart needed (no main-process
or sync-server changes; all changes are inside the
renderer bundle). Tobe's running desktop will pick
up the new code on the next page reload.

## Verification plan

For Tobe to verify in one pass:

1. **Toggle visibility.** Open the desktop chat. The
   centered quest pill should be visible above the
   chat input. If a quest is active, it should say
   `📜 <quest-name>` with a `↔ Casual` button. If no
   quest is active, `💬 Casual` with a `↔ <quest-name>`
   button.
2. **Toggle to casual.** Click `↔ Casual`. The chat
   panel should switch to the casual chat content
   (companion-reaction bubbles that landed there per
   v3.3.31 should be visible). The pill should update
   to `💬 Casual` and the button to `↔ <quest-name>`.
3. **Toggle back.** Click `↔ <quest-name>`. The chat
   panel should switch back to the active quest's chat.
   The pill should update to `📜 <quest-name>`.
4. **Bubble stamp.** Send a chat message on a quest
   (or have an agent reply). Every bubble in the
   active quest's chat should have a small bright
   orange stamp in the top-right corner showing the
   quest name. Bubbles in the casual chat (after
   toggling) should have a gray `— Casual` stamp in
   the same position.
5. **Mobile APK.** Install the v3.11.29 APK on the
   phone to pick up the `Casual chat` label change.
   The desktop v3.3.34 doesn't require a mobile
   update — the toggle pill is desktop-only.

## Cross-cutting note (2026-10-04)

The v3.3.32 / v3.3.33 / v3.3.34 releases in one
session illustrate the renderer-only fix pattern:
every change is inside `src/js/app.js`,
`src/css/components.css`, or `src/index.html`. The
main process, sync-server, preload, and electron
config are all untouched. The user picks up the new
code on the next page reload — no restart, no APK
rebuild, no app reinstall. This is what makes
shipping "one more polish" cheap, and is the reason
the v3.3.x release train has been so frequent this
week.

The trade-off: a v3.3.32 + v3.3.33 + v3.3.34 series
ships in three separate tags instead of one. The user
sees a slightly cluttered version history, but the
code is more reviewable (each tag is one focused fix)
and the renderer hot-reload makes per-tag shipping
free. If the user-facing changes were entangled
(main-process or sync-server changes), a single
release would be mandatory to avoid a window where
the renderer is talking to an old main process.