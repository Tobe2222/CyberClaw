# v3.2.19 — Quest callbacks wired into SyncServer (14-day-old bug fix)

Tobe reported on 2026-07-22 that quest edit still
failed after v3.2.17's name-based fallback + richer
diagnostic info. The toast said
"Couldn't update quest: quest not found · wanted id
\"mlwysbptbii7\", desktop has no quests" — which is
the fingerprint of a non-trivial bug.

## The actual bug (latent since 2026-07-08)

**Root cause:** sync-server.js called the quest-edit
callbacks via `this.onUpdateQuest`, but the
constructor never copied the option onto `this`. So
`this.onUpdateQuest` was always `undefined`, the
function in main.js was never called, and every quest
edit over WebSocket silently no-op'd with the failure
branch returning `available: []`.

The original v3.1.51 commit on 2026-07-08 added 5 new
inbound quest-edit message types
(`update_quest`, `delete_quest`, `create_quest`,
`set_quest_active`, `mark_quest_goal_done`) and 2
diagnostic callbacks (`onListQuests`,
`onRequestQuestsList`). The constructor only stored 4
of the ~10 options on `this`:
- `onChatMessage`
- `onVoiceTranscript`
- `onAudioInput`
- `onAttachment`

The other 7 were left as constructor arguments that
nobody references. The runtime check
`this.onUpdateQuest ? this.onUpdateQuest(...) : null`
always evaluated falsy.

**Tobe's quest edits have NEVER actually worked since
2026-07-08** — 14 days of silent failure that the
v3.10.74 broadcast-acked gate + v3.10.77 diagnostic
info + v3.2.17 name-based fallback all failed to
catch, because none of those layers fixed the
underlying wiring.

## How Tobe's diagnostic info caught it

Tobe tested V2 edit after my v3.2.17 restart. The toast
showed:
> "Couldn't update quest: quest not found · wanted
> id \"mlwysbptbii7\", desktop has no quests"

I shipped extra logging in `onListQuests` and
`onUpdateQuest` (v3.2.17) to log `loadQuests.length`.
Rebooted. Tobe retried. The new console.logs did NOT
fire — but the sync-server's
`update_quest: id not found` log DID. That told me
the function in main.js was never being CALLED, only
RETURNED AS UNDEFINED.

## Fix

Wired up the 7 missing callbacks in sync-server's
constructor:

```js
this.onSetQuestActive = options.onSetQuestActive || null;
this.onUpdateQuest = options.onUpdateQuest || null;
this.onDeleteQuest = options.onDeleteQuest || null;
this.onMarkQuestGoalDone = options.onMarkQuestGoalDone || null;
this.onCreateQuest = options.onCreateQuest || null;
this.onListQuests = options.onListQuests || null;
this.onRequestQuestsList = options.onRequestQuestsList || null;
```

Also removed the diagnostic logging from v3.2.17
(served its purpose).

## Files changed

- `src/sync-server.js` — added 7 missing
  `this.X = options.X || null` assignments in the
  constructor
- `package.json` — version 3.2.17→3.2.19

## Lessons

**Always test the option-passing contract.** The
constructor accepts 10 options but only stores 4 — a
hidden bug because the runtime `this.X ? ...` check
silently skips work when `this.X` is undefined. The
"easy" pattern of "if the option exists, call it"
hides bugs that should be loud failures. Pattern: in
constructor, ALWAYS `this.X = options.X || null` for
every option, and loudly throw at construction time if
the option is missing for a callback that's going to be
required later.

**Diagnostic info that itself doesn't work is itself
diagnostic.** My v3.2.17 added console.log inside
`onListQuests` and `onUpdateQuest`. The toast at
Tobe's end showed `available: []` with no `console.log`
preamble. That told me the functions were NEVER BEING
CALLED — only the outer `if (this.onListQuests) ...
(this.onListQuests() || [])` evaluates and finds
`this.onListQuests` undefined. The diagnostic code
existed but never executed → tells me the wiring is
broken, not the function body.

**A 14-day-old bug is worse than a 14-minute-old bug.**
Tobe probably thought quest editing was always broken
and just worked around it on the desktop. The
broadcast-acked gate + diagnostic info layers kept
"fixing" symptoms without addressing the underlying
wiring. When a feature has been failing for a while,
the fix has to reach into the foundational layer, not
just the symptom layer.

**The lesson in turn becomes:** when adding new
callbacks to a class that uses the
"options-object-then-this.X" pattern, do an audit and
verify ALL callbacks are wired. Not just the new ones.