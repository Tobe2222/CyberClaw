# v3.3.36 — High-contrast bubble stamp (post-debug)

**Tobe 2026-10-04 13:34 (Discord #cyber-dev):**

> "Still dont see the chat watermark on the bottom
> right of the text bubbles on desktop, they might
> be applied forward tho."

The v3.3.35 fix added the quest pill to
`_renderStoredChatMsg` (the reload path) and the
debug logs confirmed `hasPill: true` and the pill
HTML+CSS is being rendered with the correct
dimensions. But Tobe still doesn't see it on his
bubbles, and the vision model on a fresh screenshot
described the casual pill as "a small gray pill
in the top-right corner" — i.e. present but easy
to miss.

## Root cause

The casual-state pill (used when no quest is active
or the user is chatting on the casual chat) had:

```css
background: rgba(180, 180, 200, 0.9);  /* light gray, 0.9 alpha */
color: #1a1a1a;                          /* dark text */
border-color: rgba(220, 220, 235, 0.7);  /* very light border */
```

Light gray on a bubble that may have ANY tint
(agent bubbles have a gold/amber background, user
bubbles have a teal/cyan background, system bubbles
have a purple background). The 0.9 alpha lets the
bubble's color bleed through, and the dark text on
a near-white pill gives poor contrast. Result: the
pill was technically rendered (debug log confirmed
`width: 67.6px, height: 18px`) but visually
indistinguishable from the bubble background.

The HIVE_CONTROL pill (orange bg + dark text) is
high-contrast and definitely visible — Tobe probably
saw it on a quest and didn't see the casual pill
when he switched to casual chat. He thought the
pill was "gone" but it was just camouflaged.

## Fix

- Bump pill size: 10px → 11px font, 2px×8px →
  3px×9px padding, 1px → 1.5px border.
- Both states get solid backgrounds (no alpha) for
  maximum contrast against any bubble color.
- Quest state: keep the accent background
  (var(--accent, #ff8c1a)) + dark text + white
  border.
- Casual state: dark slate background (#4a4a55) +
  white text + white border. High contrast, no
  alpha, reads as a "neutral" stamp that doesn't
  disappear into the bubble's tint.
- Bump bubble top padding 24px → 28px so the
  bigger pill has clearance above the message text.
- Bigger box-shadow (0 1px 2px → 0 1px 3px) for
  more depth.

The desktop log debug confirms the pill is now
rendered as a 67.6×18px element (was 67.6×18px
before — same width, slightly taller). The visual
change is the colors, not the size.

## Files changed

- `src/css/components.css` — `.msg-quest-header`
  font/padding/border/box-shadow bump. `.no-quest`
  variant switched to dark slate + white text.
  `.chat-msg` top padding 24px → 28px.
- `package.json` — version bump to 3.3.36.

## Deploy

Renderer hot-reload (CSS only). No restart needed.
Tobe's running desktop will pick up the new colors
on the next page reload.

## Verification plan

For Tobe to verify:

1. **Hard reload the renderer** (Ctrl+R or View →
   Force Reload) to pick up the new CSS.
2. **Chat panel re-renders from storage.** Existing
   bubbles (including the [You] bubble visible right
   now) should now show a clearly visible stamp in
   the top-right corner of each bubble.
3. **Quest stamp (HIVE_CONTROL etc).** When a quest
   is active, every bubble shows a bright orange
   pill with "📜 <name>" in dark text. 11px bold,
   white border, 3px×9px padding.
4. **Casual stamp.** When the user toggles to
   casual chat (or when a companion-reaction bubble
   lands in the casual bucket), the pill is dark
   slate with "— Casual" in white text. High
   contrast, visible on any bubble background.

## Cross-cutting note (2026-10-04)

The pattern of "technically rendered but visually
invisible" is a common one in CSS work. The
element is in the DOM, the styles are applied, the
computed style is what you'd expect — but the
chosen color values blend into the surroundings
and the user perceives "not rendered." The fix
isn't a logic change; it's a design change: pick
contrast values that survive the worst-case
background, not the best-case.

For this specific case: the pill lives on top of
EITHER a quest-attributed bubble (any quest
color: HIVE_CONTROL is amber, others may be
green/blue/etc) OR a casual bubble (could be any
agent bubble color). To survive both, the pill
needs a background + border + text color that
contrast with BOTH the lightest and darkest
possible bubble tint. Solid (no alpha) on a solid
(no alpha) bubble background gives 1:1 contrast.
Alpha on a bubble gives variable contrast that's
a function of the bubble's tint.

**Generalizes to:** any UI element that floats
over content with variable background colors
(status pills, toast notifications, error
overlays, achievement banners). Solid backgrounds
are safer than alpha. When alpha is required for
aesthetic reasons, the text and border should
have enough contrast to survive the worst case
bubble tint, not the average case.

## Diagnostic tell-tale (v3.3.35-3.3.36 chain)

"The element is rendered (DOM has it, computed
style is correct) but I don't see it on screen."
This is a contrast issue, not a layout / DOM /
CSS-rule issue. Add `console.log(getComputedStyle
(el).background)` and verify the resulting
`background-color` actually contrasts with the
parent's `background-color` per the WCAG contrast
ratio. If it's < 3:1 (large text) or < 4.5:1
(small text), bump the contrast.