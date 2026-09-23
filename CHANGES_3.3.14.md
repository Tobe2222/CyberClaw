# v3.3.14 — Renderer ReferenceError: quests is not defined

Tobe (2026-09-23 18:09, Discord #cyber-dev), after installing
desktop v3.3.13 + mobile v3.11.1:
> "Now the chat was empty when i started the app, and stayed
> empty. And I sent the message but no clawsuu thinking etc
> and no response. I dont see the message in the desktop
> either actually."

## What happened

The renderer crashed with `Uncaught ReferenceError: quests
is not defined` the moment Tobe's chat message reached
`addChatMsg`. The crash killed the chat pipeline mid-flight:

```
[RI] [mobile-chat] received: [From: Android Phone] Hey little goblin...
[RE] Uncaught ReferenceError: quests is not defined
```

The mobile bubble DID appear locally (the mobile appends
its own copy before sending). The desktop's renderer never
showed it (crashed before reaching `addChatMsg`'s render).
The agent never received the message (the chat pipeline
threw BEFORE the LLM call). The mobile never got an agent
reply. Net result: Tobe saw his message on the mobile,
nothing else happened.

## Root cause

v3.3.11's per-quest bucketing patch added an `activeQuestName`
enrichment to `addChatMsg`'s push call:

```js
chatHistoryByAgentAndQuest[agentId][qk].push({
  type, text, name, emoji, ts: Date.now(),
  activeQuestId: activeQuestId || null,
  activeQuestName: (quests.find(q => q.id === activeQuestId) || {}).name || null
});
```

The bare `quests` reference was never declared in the
function's scope. `addChatMsg` is sync — it doesn't
`await cyberclaw.quests.list()` like the other call sites
that use `const quests = await cyberclaw.quests.list()` do
(those are all in async contexts: quest editor, mobile-chat
handler, etc.).

The function is called from many sync paths (mobile chat
echo, agent reply insert, system messages, typing bubble
insert). Every single one hit the bare `quests` reference
and threw.

Why didn't v3.3.11 testing catch this? Most likely Tobe's
v3.3.11 test sessions were on the mobile, and:
- Some sessions had no quest active (so `agentId` was
  sometimes falsy via `agentIdForName(null) === null`
  → `if (agentId)` block skipped → no throw).
- Some sessions had `activeChatAgentId` null at the
  moment the message arrived (so the same guard skipped).
- Or the throw fired but was caught somewhere and the
  user reloaded before noticing.

The desktop-renderer crash is silent from the user's
perspective when the message is on the mobile but the
desktop chat panel is dead.

## Fix

Drop the `activeQuestName` enrichment. The `activeQuestId`
is still stamped (so per-quest bucket routing continues to
work, which was the actual purpose of v3.3.11). The quest
name can be looked up at render time via
`cyberclaw.quests.list()` if a future UI feature needs to
display it.

I considered making `addChatMsg` async and resolving the
name with `Promise.race([cyberclaw.quests.list(),
timeout])` to keep the enrichment, but `addChatMsg` is
called from many sync fire-and-forget call sites (agent
reply handlers, typing bubble, system messages, mobile
echoes, post-screenshot decorators, etc.) and making it
async would require touching all of those for ordering
guarantees they don't currently need. The enrichment is a
nice-to-have, not a load-bearing feature.

## Files changed

- `src/js/app.js` — `addChatMsg` (line ~4144): removed the
  `(quests.find(...))` enrichment. The push still records
  `activeQuestId` so per-quest bucketing works.

## Compatibility

- Mobile sync: unchanged. The `activeQuestId` field is
  still stamped; only the human-readable name is dropped.
- Per-quest bucket routing: unchanged.
- All other call sites of `addChatMsg`: unchanged.

## Verified

- `node --check` on `src/js/app.js` passes.
- Desktop restarted with new code. Renderer boots cleanly:
  `[RI] [Chat] chat-messages element: found` ✓
- No `ReferenceError: quests is not defined` in the log.
- Bare-`quests` scan: only the already-safe
  `(typeof quests !== 'undefined' ? ...)` guard at L2439
  remains in the codebase.