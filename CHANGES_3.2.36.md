# v3.2.36 — Strip quest tags from chat + chat pipeline diagnostics

## What changed

Two unrelated fixes bundled under one release:

### 1. Strip LLM-facing quest tags from the chat bubble

The model's reply was being pushed verbatim into the
chat bubble via `addChatMsg('agent', result.reply, ...)`
BEFORE the tag parsers ran. The parser happy-path
worked (the action fired, the system log showed
"📝 Logged: …"), but the **literal tag text** was still
visible in the user's bubble.

So the user saw two things in the same reply:
- The bracketed tag (`[QUEST_APPEND_CHANGE: text="…"]`)
- The LLM's actual human reply

The tag was supposed to be LLM-only scaffolding — a
private side-channel — but it leaked into the public
chat every time the model emitted a quest mutation.

**Fix.** Added a `stripQuestTags(reply)` helper that
removes the four quest tags (`[CREATE_QUEST: …]`,
`[QUEST_APPEND_CHANGE: …]`, `[QUEST_MARK_GOAL: …]`,
`[QUEST_SET_ACTIVE: …]`) plus the occasional
`[Quest tools available — …]` echo. Applied at all
three `addChatMsg('agent', …)` call sites, the
desktop-log prefix, and the mobile TTS broadcast so
TTS doesn't read the tag aloud.

**Parsers still run on the unmodified reply.**
`addChatMsg` receives the stripped text, but the four
`match(…)` blocks for the actions run on the original
`result.reply` and still execute the side effect.

**Tobe's 2026-07-29 feedback:** "why does it say the
quest append thing? i dont want that."

### 2. Chat pipeline diagnostics + quest-list timeout

Three log lines added inside `sendChatMessage` so the
next "why wont you answer" incident can pinpoint the
stage that's stuck:

- `⏳ Waiting for previous AI reply` (when `chatBusy=true`)
- `⚠️ AI reply stuck > 15s, force-resetting` (when the
  15s wait elapsed without `chatBusy` clearing)
- `🧠 dispatching to agent, mainAgentId:` (right before
  the openclaw call)

Plus a `console.warn` if the quest context fetch fails.

**The 3s `quests.list()` timeout.** Tobe's
"Why wont you answer?" message on 2026-07-29 11:41
went through the mobile-chat IPC, hit `sendChatMessage`,
hit the chatBusy queue, was force-reset, but then
**silently disappeared** — no `AI thinking` log
appeared, no `AI responded` log, the message just
vanished. The most likely culprit was the `await
cyberclaw.quests.list()` call at line 2538: if the
renderer was wedged, the `await` blocks indefinitely
and the existing `try/catch` only catches throws, not
hangs. With a 3s `Promise.race` timeout, the chat
either gets the quest context or proceeds without it
— and the message always reaches the agent.

The win is twofold: (1) the next user can SEE the
failure mode in the desktop log, and (2) the hard
timeout means one slow quest-file read can never
silently sink a chat reply.

versionCode: n/a (desktop)
