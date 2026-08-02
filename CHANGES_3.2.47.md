# v3.2.47 — chat messages are selectable + right-click Copy

## 1. Chat messages now selectable (drag-to-select)

**Tobe's report (2026-08-02 20:27):**
> "I noticed that i cannot Click the messages, as in mark
> and copy etc, fix so i can do that."

**Root cause:** the body had `user-select: none` (intentional
— disables accidental selection on the desktop terminal /
arena). The chat-messages div, chat-msg divs, and msg-text
spans all had `user-select: text` overrides. The cascade
*should* have made them selectable, but on Electron 33
(Chromium 130+) the override wasn't actually taking effect —
drag-to-select drew the marquee but no text got highlighted.
Possibly a CSS specificity quirk in Electron's frame=false
window where the body's user-select: none was being
re-inherited through some path we couldn't see in DevTools.

**Fix:** Add `!important` to all three selectors, plus
`-webkit-` / `-moz-` / `-ms-` prefixes. Electron has used
WebKit prefixes in user-select for backward compat even in
recent versions; adding the prefixed forms covers the path
the unprefixed form was missing. Also add `cursor: text` so
the user sees a text cursor over messages (visual signal
that the area is selectable).

## 2. Right-click context menu with Copy

Even with the CSS fix, drag-to-select can be fiddly on small
text. Added a right-click context menu on every chat message
with two items:

- **Copy** — copies just the message text (no [Name]
  prefix).
- **Copy with prefix** — copies `[Name] message text` for
  pasting into a chat log or quoting.

The menu uses Electron's `Menu.buildFromTemplate().popup()`
(native menu, not a DOM-styled one) so it integrates with
the OS right-click feel.

The message text is extracted from the `.msg-text` span and
cached on the div via a `data-msg-text` attribute, so the
context menu handler doesn't re-parse the DOM each time.

Implementation lives in `addChatMsg` (after the innerHTML is
set, before `msgs.appendChild(div)`) and a small
`getChatMessageText(div)` helper. Clipboard writes use
`require('electron').clipboard.writeText(...)` — same as
the rest of the app.

## Files changed

- `src/css/components.css` — `.msg-text`, `#chat-messages`,
  `.chat-msg` get `!important` + `-webkit-` / `-moz-` /
  `-ms-` prefixes.
- `src/js/app.js` — `addChatMsg` adds a contextmenu
  handler; new `getChatMessageText(div)` helper.
- `package.json` — version 3.2.46 → 3.2.47

**v3.2.47 (desktop).**
