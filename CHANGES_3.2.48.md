# v3.2.48 — work-first reminder appended to every user message

## 1. The system prompt wasn't enough

**Tobe's report (2026-08-02 21:10):**
> "but why did he/you not do the changes? Only talk?"

**Screenshot:** Tobe asked for several CSS and agent-path
changes. Clawsuu replied asking clarifying questions ("Where
exactly do you want these? Main CSS in arena?") instead of
making any edits. No tool calls fired.

v3.2.44 added a "Reply-after-work rule" to the
DEFAULT_SYSTEM_PROMPT. It said:
> "When the user asks you to do something — read a file,
> find a key, run a command — do NOT send a status update
> first. Just do the work. Use your shell and file tools
> in the SAME turn."

The rule was being ignored. The LLM kept over-applying
the exception clause ("The only time it's OK to reply
before doing work is when you genuinely need more
information...") and treating clarifying questions as
"doing the work."

## 2. Fix: put the rule at the END of every user message

System prompts set general behavior, but the LAST thing
the LLM sees in a prompt window is the most actionable
for that specific turn. Long system prompts get pushed
out of attention as the user message grows; the
bottom of the user message is always fresh.

So in addition to the system prompt rule, we now append
a short work-first reminder at the END of every chat
message:

> [Action rule: do the work in this turn, then reply
> with the result. If you genuinely cannot proceed
> without more information, ask ONE specific question —
> do not promise work you have not started. The user
> should see your reply when the work is done, not when
> you start.]

Implementation:
- New `buildWorkFirstSuffix()` helper alongside
  `buildQuestToolsHint()`.
- Appended in both chat send paths: `sendChat()`
  (desktop DOM input) and `__sendChatMessageImpl()`
  (mobile / voice / programmatic).
- Same suffix for both paths so the user gets a
  consistent nudge regardless of who initiated the
  message.

The suffix is short — it's the freshest signal in the
prompt window, so every word counts. No examples, no
narrative. Just the rule.

## Files changed

- `src/js/app.js`:
  - New `buildWorkFirstSuffix()` helper.
  - Both chat send paths append it to `fullMessage` after
    the quest-tools hint and quest context.
- `package.json` — version 3.2.47 → 3.2.48

**v3.2.48 (desktop).**
