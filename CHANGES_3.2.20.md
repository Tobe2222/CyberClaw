# 3.2.20 — chat: always inject quest-tools hint (incl. CREATE_QUEST)

## Reported by Tobe (via mobile chat, screenshot)

Tobe's chat with Clawsuu (mobile, 2026-07-23):

> "@Clawsuu any idea why the companion could not
> create a new quest?"

Screenshot showed the chat with two failed attempts at
creating a quest called "Cyber_School":

1. First attempt: "Quest creation tool rejected my
   system-event routing — let me know if Cyber_School
   already exists in your active quest list and I'll
   roll from there." (hallucinated a tool that doesn't
   exist)
2. After Tobe said "create one i said": "Cron scheduled
   an isolated agentTurn to run the quest creation —
   it'll execute in about 15 minutes since 'at'
   schedules a future run, but the request is
   registered." (deferred the action 15 minutes via
   cron instead of doing it now)

Both responses are wrong. The right answer is to emit
`[CREATE_QUEST: name="Cyber_School" desc="..."]` in
the agent's reply, which the desktop parses
immediately and creates the quest. The tag has been
supported by the desktop's parser since v3.1.50 (see
`src/js/app.js:1919` and `src/js/app.js:4619`).

## Root cause

The desktop's prompt hint for quest tools lived
inside `buildActiveQuestContext()`, which only runs
when there's an **active quest**. The hint listed:

```
| Tools: [QUEST_APPEND_CHANGE: text="..."]
         [QUEST_MARK_GOAL: index="N" done="true|false"]
         [QUEST_SET_ACTIVE: id="<id-or-name>"]
```

Notice what's missing: `CREATE_QUEST`. Two related
failures:

1. **The hint was conditional on having an active
   quest.** A fresh workspace with no active quest
   would never inject the hint, so the agent had no
   idea quest tools even existed from chat.

2. **Even when the hint DID fire, CREATE_QUEST was
   missing from it.** A user asking "create a new
   quest" while working on another quest would still
   not see CREATE_QUEST in the in-context hint, because
   the parser was supported but the hint was incomplete.

So the agent had two wrong priors:
- "I can't create quests from chat" (no hint)
- "If I can't do it, schedule a cron" (wrong fallback)

Both priors are wrong. The desktop DOES support
CREATE_QUEST. The agent just didn't know.

## Fix

Two-part change to `src/js/app.js`:

**1. Extract the hint into `buildQuestToolsHint()` and
inject it UNCONDITIONALLY in every chat message.**

```js
function buildQuestToolsHint() {
  return '[Quest tools available — emit these tags in your reply when applicable: ' +
         '[CREATE_QUEST: name="..." desc="..." dir="optional/path"] to create a new quest, ' +
         '[QUEST_APPEND_CHANGE: text="..."] to log a change to the active quest, ' +
         '[QUEST_MARK_GOAL: index="N" done="true|false"] to toggle a goal on the active quest, ' +
         '[QUEST_SET_ACTIVE: id="<id-or-name>"] to switch the active quest. ' +
         'Tags are parsed by the desktop on every reply and the action is performed immediately.] ';
}
```

Injection points:
- `sendChat()` — typed desktop chat (line 1842)
- `sendChatMessage()` — programmatic (mobile, voice,
  IPC) (line 2095)
- image-attach chat path (line 4647)

**2. Add CREATE_QUEST to the existing
`buildActiveQuestContext()` hint** as defense in depth
— if the unconditional injection ever regresses (a
future refactor that puts it back behind a guard),
the in-context hint will still mention CREATE_QUEST
when there's an active quest.

## Why "schedule a cron" was the wrong fallback

Documented in clawsuu's AGENTS.md as a guard rail
against future regressions:

> If I can't do something via tag, I might think to
> schedule a cron job to do it later. **Don't.** The
> desktop's chat pipeline runs me specifically to
> handle user requests in real time. Scheduling a
> cron:
> - Defers the action by minutes/hours (cron `at`
>   schedules future runs)
> - Runs in an isolated session that doesn't have
>   the desktop's tag parser
> - Surprises the user with "I'll execute in 15
>   minutes" when they wanted it now
> - Bypasses the desktop's UI feedback (chat system
>   message, broadcast)

The two wrong fallbacks the agent tried on 2026-07-23
are both forms of "give up on doing it now":

1. "Tool rejected → I can't do it" (false negative —
   the tool exists, the parser supports it, I just
   didn't know)
2. "Schedule a cron to do it later" (wrong answer —
   defers a synchronous user request by minutes)

Both should have been:
- "Oh, I can emit `[CREATE_QUEST: ...]` and the
  desktop handles it"
- (When the tag isn't supported) "I can't do that
  from chat, but I can edit the quest file directly
  if you want me to"

## Files changed

- `src/js/app.js`:
  - New `buildQuestToolsHint()` function (line 1142)
  - Injected in `sendChat()` (line 1842)
  - Injected in `sendChatMessage()` (line 2095)
  - Injected in image-attach chat path (line 4647)
  - Added `CREATE_QUEST` to existing
    `buildActiveQuestContext()` hint (line 1115)
- `package.json` — version 3.2.19→3.2.20

## Lessons

**Hiding capabilities behind "if there's an active
quest" is a footgun.** Tools that the user might
need on a fresh workspace shouldn't be gated on
prior state. The unconditional injection fixes this
and is the only safe default.

**A parser that exists in code but isn't advertised
in the prompt is invisible to the agent.** LLMs pick
up tag shapes from in-context examples, not from
"the desktop supports this". If a tag is supported,
it must be in the prompt hint. Treat the parser and
the hint as a single unit — whenever you add a new
tag parser, add it to the hint at the same time.

**"Schedule a cron" is almost never the right answer
to a real-time user request.** It's a fallback for
recurring work or for "do this in 5 minutes" type
deliberate deferrals. For "I want this done now", it
degrades the UX silently — the user waits and
nothing happens for minutes, then maybe something
happens. Document the bad fallback in AGENTS.md so
the agent's reasoning includes "don't do this."

## Manual fallback (until v3.2.20 lands)

Tobe's quest was created via direct file write as a
fallback (`~/.openclaw/cyberclaw/quests.json`,
appended to the array with a fresh id). The mobile
sees the new quest on the next refresh of the Quests
page. The desktop's `request_quests_list` handler
calls `loadQuests()` from disk on every request, so
the file-write fallback is picked up without
restarting the desktop app.