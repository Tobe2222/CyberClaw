# v3.2.44 — companion does work, then replies (no more status-update limbo)

## 1. The "reply-before-work" pattern is gone

**the user's report (2026-08-02 18:14):**
> "no the next reply of from it having done the task never
> comes. It never does. [...] It does not seem to be that
> way in discord either, even tho it should be that way."

**What's happening:** when the user asks Clawsuu to look for SSH
keys in the notes file, Clawsuu replies "On it — digging
through the notes file now, should have those keys any
second" — and then stops. No tool call. No follow-up reply.
The "I'm doing X → I do X → I report back" loop that should
happen in a single turn never does. The companion emits a
friendly status message and the turn ends.

**Root cause:** the system prompt's instructions for tool use
were too soft. The DEFAULT_SYSTEM_PROMPT said "Use the quest
tools to log your work" but didn't say "use your shell and
file tools in the same turn as your reply when the user asks
for action." LLMs default to social/friendly behavior when
instructed to be in-character; without an explicit
"do-then-reply" rule, the companion picks the cheaper path
(text-only reply, no tool call).

The OpenClaw chat pipeline already supports native tool calls
in a single turn (the LLM emits tool_use blocks, OpenClaw
executes them, the LLM gets the results, then emits the final
text reply). So the capability is there — the prompt just
wasn't pushing the model to use it.

**Fix:** Added a "Reply-after-work rule" section to
`DEFAULT_SYSTEM_PROMPT` in `companion-prompts.js`:

> A chat reply marks the END of a task, not the start of
> one. When the user asks you to do something — read a file,
> find a key, run a command, check a directory — do NOT send a
> status update first ("let me crack it open", "on it",
> "looking now"). Just do the work. Use your shell and file
> tools in the SAME turn. The user should see your reply when
> the work is done, not when you start it.
>
> If you can do the work in one tool call, do it and reply
> with the result. If it takes multiple tool calls, do them
> all in the same turn before you reply. Do NOT stop mid-task
> and wait for the user to prompt you again.
>
> The only time it's OK to reply before doing work is when
> you genuinely need more information from the user. In that
> case, ask one specific question — don't promise to do work
> you haven't started.

Also added `[QUEST_NOTE]` to the listed quest tools in the
same block so the new tag is in the prompt alongside the
others.

**Note on `CYBERCLAW.md` overrides:** if the user creates
`~/.openclaw/cyberclaw/CYBERCLAW.md`, that file fully
replaces the default prompt (the default is only loaded when
the file is missing). So this fix only applies to companions
that don't have a custom system prompt yet. the user doesn't
have CYBERCLAW.md on disk, so the default applies. If he
later creates one, this fix is bypassed — he'll need to
copy the new section into his custom prompt.

## Files changed

- `src/companion-prompts.js` — `DEFAULT_SYSTEM_PROMPT` adds
  the "Reply-after-work rule" section and the
  `[QUEST_NOTE]` tag.
- `package.json` — version 3.2.43 → 3.2.44

**v3.2.44 (desktop).**