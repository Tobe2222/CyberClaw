# v3.2.16 — Mobile food/play reaction cleanup + diagnostic info

The user asked on 2026-07-22:

> "The comments the companion makes when given food
> or played with does not need to appear in the chat
> if it does, not sure."

And from a follow-up:

> "And i tested the quest edit also. It still said
> the same and did not work to edit."

Two changes ship in this companion release.

## Change 1: Remove LLM roundtrip on mobile feed/play

The v3.10.72 `mobile-arena-treat-placed` and
`mobile-arena-treat-eaten` IPC handlers called
`window.promptCompanionReaction(prompt)`, which
triggers an LLM roundtrip and adds the reply to
chat. the user didn't want chat noise on every feed/play
action.

**Fix:** Both handlers now log to the desktop log
panel via `addDesktopLog` and that's it. No chat
messages, no LLM call, no companion reply bubble.
The mobile's 😋 + ❤️ emoji overlay is the only
user-visible feedback (handled by the mobile arena,
not the desktop).

The desktop's own tap-to-treat flow
(`placeTreatOnArena` in `src/js/app.js:4905`) still
calls `promptCompanionReaction` — that's a separate
path and not affected by this change. If the user later
wants the desktop's treats to also be quiet, that's
a separate change.

## Change 2: Quest diagnostic info in failed-update response

The v3.10.73 mobile-side gate on
`firstBroadcastReceived` was supposed to fix the
"Couldn't update quest: quest not found" error but
the user reports the error persists. Rather than guessing
at another fix, this release adds diagnostic info to
the failure response:

```js
this._send(ws, {
  type: 'quests_update_failed',
  action: 'update_quest',
  id,
  error: 'quest not found',
  available: [...list of quest ids on the desktop...],
});
```

Server-side log: `[SyncServer] update_quest: id not
found. requested: X available: [a, b, c]`

The mobile's failedHandler appends
` · wanted "X", desktop has [a, b, c]` to the toast
(truncated to 5 ids + "+N more").

Next time the user hits this error, the toast itself will
tell us whether the mobile is sending an id the desktop
genuinely doesn't have, or whether there's a deeper
encoding/mismatch bug.

## Files changed

- `src/sync-server.js` — `update_quest` failure
  response includes `available: [...]`
- `src/main.js` — new `onListQuests` callback that
  returns `loadQuests().map(q => q.id)`
- `src/js/app.js` — mobile-arena-treat-placed /
  mobile-arena-treat-eaten no longer call
  `promptCompanionReaction` (no LLM roundtrip,
  no chat noise); log only via `addDesktopLog`
- `package.json` — version 3.2.15→3.2.16

## Lessons

**Instrument-before-fix when your hypothesis was
wrong.** The v3.10.73 gate was a reasonable
hypothesis for the quest-not-found bug but didn't
fix it. Rather than guess at another fix, adding
diagnostic info to the failure response is cheaper
and more informative than a speculative second
attempt. The next test run will tell us exactly
what's happening.

**Different UX surfaces need different noise levels.**
The desktop's tap-to-treat triggers an AI reaction
because the user is actively looking at the chat and
expects the companion to reply. The mobile's tap is
often non-attentive (background-process kind of
thing) so a chat reply is noise. Same action, different
context, different feedback policy. The fix is to
separate the two paths at the IPC layer, not to try
to share code that needs to behave differently.