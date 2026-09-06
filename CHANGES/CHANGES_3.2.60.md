# v3.2.60 — Unwind the Discord tail → quest.conversationLog path

## The change

the user 2026-08-04 12:37:
> "No need for discord to update quest logs, it does not
> necessarily know which quest we are working with."

In `src/js/app.js` the v3.2.59 Discord-tail IPC handler
(`openclaw-session-chat-message`) had a block that
auto-stamped every Discord-routed message onto the active
quest's `conversationLog` — same as the chat-pipeline write.

That was wrong. Discord is a separate channel: if the user has
a "SeedSigner" quest active on the desktop at the moment
he happens to be chatting about something completely
unrelated in #cyber-dev with the agent, every line of that
unrelated chat would silently land in the SeedSigner
project's conversation log and corrupt future cross-session
context. The user's `activeQuestId` is just whatever they
starred most recently on the desktop; it's not a statement
about which channel's conversation they want logged.

The chat pipeline (`addChatMsg` path) is a different case:
when the user types into the mobile chat panel while the
SeedSigner quest is active, that IS an explicit signal of
project focus — he's talking to the companion in the app
about the project. That's the only path that auto-logs.

## What stays

- `addChatMsg('user' | 'agent', ...)` still fires
  `quests:append-conversation-log` (the original v3.2.59
  path).
- The IPCs, the helper, the migration, the context
  injection — all unchanged from v3.2.59.
- The chat panel still mirrors Discord messages via
  `chatHistoryByAgent` and the mobile broadcast path —
  Discord traffic just stops being auto-stamped to a quest.

## Lesson

"Auto-log everything while a flag is set" is a seductive
default but only works when the flag is genuinely
authoritative. `activeQuestId` is authoritative for "the
user is working on this project **inside the app**" but
NOT for "any conversation anywhere in the world right now
should count toward this project".

The right discriminator for "should this message update
project memory" is **which channel** the message came
through, gated by an explicit user signal. For the chat
panel, the signal is "the user typed/tapped here, with
this quest starred" — that's enough. For Discord, there's
no equivalent signal short of the user explicitly
attaching a `[QUEST_APPEND_CHANGE: ...]` tag, which the
v3.2.50 structured-output flow already supports.

## Files

- `src/js/app.js`: removed the
  `cyberclaw.quests.appendConversationLog(...)` block
  inside the `openclaw-session-chat-message` handler.
  Replaced with a comment explaining the scope rule.
- `package.json`: 3.2.59 → 3.2.60.
- `CHANGES_3.2.59.md`: added a header addendum pointing
  to this file.
