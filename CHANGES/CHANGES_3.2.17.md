# v3.2.17 — Quest edit: name-based fallback + richer diagnostics

The user reported on 2026-07-22 20:01 (with screenshot
showing the editor open for CYBERHIVE_WEBSITE V2
with 4 steps, after tapping Save):

> "@Clawsuu Okey updated and tested. Food is ok now.
> Tried to edit quest again but still getting the
> same error. Quest not found, could not update. For
> some reason"

The screenshot also showed the toast as just
"Couldn't update quest: quest not found" — without
the diagnostic info v3.10.74 added. That's a clue:
the user's desktop is on v3.2.15 or earlier (the
diagnostic info was added in v3.2.16). He needs to
restart the desktop to pick up v3.2.16+.

v3.2.17 ships two more improvements:

1. **Name-based fallback in `onUpdateQuest`.** If the
   exact id doesn't match, try to find by name. If a
   single match, recover (log a warning, proceed with
   the update). If multiple matches, refuse to guess
   (return null as before). This trades a little
   safety for usability — a stale id from a
   desktop-restart can now be silently corrected when
   the name matches.

2. **Richer diagnostic info.** The failure response
   now includes the full list of quests with both id
   AND name (was just ids in v3.10.74), plus
   `wantedName` extracted from the update payload. So
   the mobile can show "wanted id X for name Y,
   desktop has: A (id1), B (id2), C (id3)". This
   distinguishes "stale id for the right quest" from
   "id doesn't match any quest".

The mobile (v3.10.77) updates the toast to render
the rich diagnostic. the user can now read the toast and
see exactly what's mismatched.

## Files changed

- `src/main.js`:
  - `onUpdateQuest` adds name-based fallback (single
    match → recover, multiple → refuse)
  - `onListQuests` returns `[{id, name}]` instead of
    just `[id]`
- `src/sync-server.js` — failure response includes
  full quest list + `wantedName`
- `package.json` — version 3.2.16→3.2.17

**Companion mobile:** v3.10.77 — updates
`failedHandler` to render id+name pairs in the toast.

## Lessons

**When diagnostic info didn't show up, that itself is
diagnostic.** the user's screenshot showed the toast
WITHOUT the v3.10.74 diagnostic info. That tells us
his desktop is on v3.2.15 or earlier — the
diagnostic-info code wasn't deployed. Always note
"the diagnostic info is missing" as a clue, not as a
bug in the diagnostic code.

**Name-based fallback is a pragmatic UX compromise.**
The "correct" fix for a stale id is to never have a
stale id (which is what the broadcast-acked gate
tried to do). But if stale ids CAN exist (and they
do — desktop reinstalls, manual file edits, etc.),
a name-based fallback gets the user unstuck without
silently corrupting data. The "refuse if multiple
matches" guard prevents the worst case (two quests
with the same name). The desktop log captures the
recovery so we can see how often it happens and
fix the underlying bug.

**Diagnostic info should distinguish "wrong target"
from "no target".** "wanted id X, desktop has [a, b,
c]" tells you nothing if you don't know what each
id maps to. "wanted id X for name V2, desktop has:
HIVE_CONTROL (a), CYBERHIVE_WEBSITE V2 (b),
Domain Redirects (c)" makes it obvious: "the id
'b' IS for V2, the user just has the wrong id for
V2" → confirms stale-id diagnosis. Richer diagnostics
cheaper than guessing.

**the user's toast text was truncated to one line.**
v3.10.74 set `numberOfLines={2}` on the error toast,
so 2 lines of room. The basic error took 1 line.
The diagnostic info would have been on the same
line (or the second). If we'd shipped without
that, the diagnostic could be invisible in the
toast. Lesson: when shipping diagnostic info,
make sure it fits in the existing UI budget — or
extend the toast height to accommodate.