# v3.2.70 — make snack events always visible in the chat log

the user 2026-08-05 11:59:
> "I tried to give him some food but he does not
> seem to remember, perhaps we should make him
> comment it each time so he sees it in the log
> atleast, Instead of in memory and not needing to
> comment it like we tried."

## What v3.2.64 (silent snack log) actually did

Looking at the screenshot — the user dropped a snack,
then asked "Was that food satisfying?", and got back
"Tastes like dust and broken dreams... I need real
food". The companion had no idea food was just
delivered.

Tracing the v3.2.64 code path:

```js
function placeTreatOnArena(...) {
  // 1. Direct append to memory.md (deterministic)
  promptCompanionSilent(agentId, 'the user gave me hamburger (food)', 'happy');
  // 2. Visible reaction prompt to the LLM
  promptCompanionReaction('I just gave you a hamburger. What do you think?');
}
```

`promptCompanionSilent` writes to memory.md AND fires
a silent LLM round-trip with a `[REMEMBER]` directive.
`promptCompanionReaction` fires a visible LLM call.

The intended flow was: snack goes to memory.md (next
session reads it), AND a visible chat reaction
happens. Two paths, two effects.

What actually happened on 2026-08-05 11:59:

1. **The reaction got dropped silently.** `promptCompanionReaction`
   has a busy-guard: `if (chatBusy || reactionBusy) return;`.
   the user dropped the snack while a previous reaction /
   user message was in flight (clawsuu had been
   responding to "Afternoon already, the user..." 9
   minutes earlier; the reaction round-trip likely
   hadn't fully drained). Guard returned early —
   **no chat reaction was sent**.

2. **Memory.md updated, but the current session's LLM
   doesn't re-read it.** The silent append wrote
   `the user gave me hamburger (food)` to
   `~/.openclaw/cyberclaw/companions/clawsuu/memory.md`.
   But the OpenClaw session's assembled system prompt
   was already built and injected into the LLM's
   context window. When the LLM received the user's
   follow-up "Was that food satisfying?", it never
   re-read memory.md mid-turn — the file edit was
   invisible to it.

Net result: silent log + dropped reaction = nothing
in the chat, nothing in the running context, even
though the food was eaten.

## The fix

Two changes:

1. **Drop the busy-guard from `promptCompanionReaction`.**
   The OpenClaw lane already serializes concurrent
   calls for the same agent server-side — the
   renderer-side guard was redundant. Removing it
   means snack drops while the chat is busy will
   fire their reaction (after the in-flight call
   finishes server-side, in submission order).

2. **Skip the silent-prompt path for food events.**
   `placeTreatOnArena` now:
   - Directly appends `the user gave me <item> (<category>)`
     to memory.md (deterministic, no LLM round-trip)
   - Fires `promptCompanionReaction` (visible chat,
     goes through `addChatMsg` as 'agent' message,
     lands in `chatHistory`, broadcasts to mobile,
     shows arena bubble)

   `promptCompanionEat` (called when the companion
   walks over and eats) does the same shape.

## What this changes for the user

- Every snack drop produces a visible "got food!" chat
  reply ("yum", "thanks", whatever the persona
  delivers). It lands in the chat log so subsequent
  questions ("was it good?", "what was your favorite?")
  have context.
- The arena bubble also shows the reaction (already
  happened in the v3.2.64 path too).
- Memory.md continues to receive a deterministic
  append, so future sessions can reference snack
  history the same way.

## What stays the same

- Toys (`ball`, `yarn`, etc.) and scenery changes
  still go through `promptCompanionReaction` with
  the busy-guard removed for the same reason.
- The non-food silent logs (e.g.
  `promptCompanionSilent` for non-chat events) are
  unchanged.

## Files

- `src/js/app.js`:
  - `placeTreatOnArena` rewritten: deterministic
    memory append + visible reaction (drop silent
    path)
  - `promptCompanionEat` rewritten: same shape
  - `promptCompanionReaction`: dropped
    `chatBusy || reactionBusy` guard