# v3.3.11 — Per-quest chat separation + auto-jump + scroll preservation

Tobe (2026-09-22 08:05, Discord #cyber-dev):
"I was thinking about separating the chats in cyberclaw.
Such that there is a chat for each quest. The chat should
just automatically jump to the current quest chat, no
need for tabs etc. That might make the logging easier also."

Follow-up (08:13): "And the chat still don't behave as
discord chat. When i Click quests for example, the chat
does not stay at the position it was last, it started
further up and force scrolls back down towards the
current."

## What changed

### Per-quest chat buckets

Each (companion, quest) pair now has its own chat history.
Switching quests automatically re-renders the chat panel
to that quest's bucket (no tabs, per Tobe's spec). The
"no quest / default chat" bucket exists as a special
`__default__` sentinel — when no quest is active, new
messages go there.

Storage shape changed:
- **Before**: `cyberclaw-chat-byagent` = `Record<agentId, ChatMessage[]>`
- **After**: `cyberclaw-chat-byagent-byquest` = `Record<agentId, Record<questKey, ChatMessage[]>>`

Where `questKey` is the quest's id, or the sentinel
`__default__` for the default bucket. The migration is
idempotent — on first launch with v3.3.11+, the old key is
read once, upgraded to the new shape (everything into the
default bucket, since pre-v3.3.11 messages had no quest
attribution), written under the new key, and the old key is
deleted. Subsequent launches skip the migration path
entirely.

### Auto-jump on quest change

A new `setActiveQuestId(newId)` function is the single
writer for the active quest id. It updates the in-memory
cache AND auto-switches the chat panel to the new quest's
bucket. Every previous assignment to `activeQuestId` was
routed through this setter, so quest changes from any
source (desktop quest click, mobile sync, IPC, list reload)
all trigger the same chat-panel swap.

The chat header now also shows a quest pill (`📜 Quest
Name`) when a quest is active, sourced from the existing
`chat-quest-indicator` element in `index.html`.

### Per-quest scroll preservation

The chat-messages div now has a scroll listener that saves
`scrollTop` per (agent, quest) pair on every scroll event.
On agent or quest switch, `switchActiveChat` reads the
saved offset for the new (agent, quest) pair and restores
it (instead of the previous behavior of always scrolling
to the bottom, which was the "force scrolls back down
towards the current" bug Tobe reported).

Storage shape for scroll offsets:
- **Before**: `cyberclaw-chat-scroll-byagent` = `Record<agentId, number>`
- **After**: `cyberclaw-chat-scroll-byagent-byquest` = `Record<agentId::questKey, number>`

Same migration pattern as the chat history.

### Unread badge per-quest

The unread badge on companion tabs now reflects the active
quest's bucket only. Previously, the badge could persist
after a quest switch because old messages in other quest
buckets were still "unread-by-the-user-but-not-currently-
being-viewed".

## Compatibility

- Mobile app: must be running v3.11.0+ for the per-quest
  sync messages to round-trip cleanly. Older mobiles still
  work for the desktop's local-only chat, but quest-stamped
  messages on the mobile side won't be filtered by quest
  until the mobile is upgraded.
- Sync protocol: unchanged. The desktop stamps each message
  with `activeQuestId` (a new field on the in-memory chat
  entry; doesn't affect IPC payload shape), and the mobile
  reads its own `activeQuestRef` to stamp incoming echoes.
  No protocol-level change needed.

## Files changed

- `src/js/app.js` — storage shape, `setActiveQuestId`
  setter, `switchActiveChatQuest`, scroll listener +
  per-quest restore, unread badge fix, addChatMsg
  per-quest bucketing, Discord-tail handler per-quest
  bucketing.
- `CHANGES_3.3.11.md` — this file.
