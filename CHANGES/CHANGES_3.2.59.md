# v3.2.59 — Per-quest conversation log (cross-session memory)

> **Update 2026-08-04 12:37:** The user confirmed Discord should NOT
> feed the quest log. v3.2.60 (no version bump yet) unwinds
> the Discord-tail IPC write path. The chat-pipeline write
> (`addChatMsg` path) remains. See addendum below; the
> addendum applies to both the released code and the
> shipped CHANGES text in the next push.

## The bug

the user 2026-08-04 11:55 in #cyber-dev (screenshot attached):
> "Okey so i think we updated and started a new session mid
> conversation on the mobile cyberclaw. Did we not add a
> conversation log per quest? If not we need to make the
> companion create a log for each project with a appropriate
> max size for the companions which they should read for each
> reply? Such that it can always keep the conversation in mind
> for a specific project? Such that it does not forget like this.
> And to keep a project log also."

The screenshot showed the mobile chat (v3.10.133) had lost
track of the conversation about SeedSigner parts sourcing
from Welectron. The user had just upgraded the desktop and the
mid-conversation restart wiped the in-memory chat history
that was driving the LLM context — the companion "forgot"
the entire prior discussion.

## What existed (and what didn't)

Pre-v3.2.59 there was **per-quest project memory** via two
structured-output tags the LLM could emit:
- `QUEST_APPEND_CHANGE` → appends to `quest.latestChanges`
  (max 100 entries; last 5 surfaced in context as a single
  pipe-joined summary line)
- `QUEST_NOTE` → appends a "## Companion notes" section to
  `<quest.directory>/QUEST_QUEST_INSTRUCTIONS.md`, fully
  injected into context

Neither of these is **automatic**. Both require the LLM
to emit the right tag in its reply, which it does only when
its system prompt reminds it. Both are also **curated** —
the LLM decides what's worth logging. They DON'T cover the
literal "what did The user just ask me" / "what did I just answer"
stream. That's the gap the user wants filled.

There's also a `chatHistoryByAgent[agentId]` (capped at
200 messages, persisted to localStorage) that mirrors the
desktop chat panel. That **is** the conversation stream
that's broadcast to the mobile, but:
- it's per-agent, NOT per-quest — same-named "SeedSigner"
  quest and a totally different "SeedSigner" quest would
  share the same conversation stream
- it's NOT injected into the LLM prompt — only used for
  the desktop renderer / mobile UI display
- it gets wiped on localStorage clear / desktop reinstall /
  any path where localStorage is bypassed

So the LLM has zero in-prompt access to the prior
conversation when the desktop restarts mid-discussion.

## The fix

A new **`conversationLog` field on each quest** —
auto-populated, auto-injected.

### Storage shape

Per quest, persisted to the existing `quests.json`:
```
quest.conversationLog = [
  { ts: ISO timestamp,
    role: 'user' | 'agent' | 'system',
    text: '<=1000 chars',
    agentId: '<speaker's agent id, or null for user>',
    agentName: '<speaker's display name, or null>' },
  ...
]
```

Capped at **200 entries** per quest (FIFO; oldest dropped).
Each `text` capped at **1000 chars** (long agent replies
get the first 1000 chars + '…'). Why 1000: a long LLM
reply can be several kB; we trim because the JSON file
gets shipped to mobile on every quest-list broadcast, and
context window budget is a separate concern (we trim again
to 300 chars in the LLM injection block — see below).

The cap of 200 was chosen empirically: a typical user-asks-
question / agent-answers cycle is 2 entries; 200 covers ~100
exchanges which is far more than any human will scroll
through, while keeping the quest JSON file under ~200kB even
in pathological cases.

### Auto-population

Three write sites:

1. **`addChatMsg('user'|'agent', ...)`** on the desktop
   renderer. This is the main chat pipeline (typed chat,
   mobile-routed chat, voice-typed chat, image-attached
   chat). When `activeQuestId` is set AND the message is
   `user`/`agent`/`error`, fire-and-forget IPC
   `quests:append-conversation-log` is called with the
   message + active quest id. Fire-and-forget so the chat
   render doesn't block on disk.

2. **`openclaw-session-chat-message` IPC handler** on the
   desktop renderer. This is the Discord-routed tail —
   messages that arrived via Discord and were pushed into
   `chatHistoryByAgent` without going through `addChatMsg`.
   Same fire-and-forget log append, gated on `activeQuestId`.
   This means Discord chats while a quest is active also
   populate that quest's log.

3. **No tag required.** The whole point — this is automatic,
   not structured-output. The LLM doesn't have to remember
   to emit a tag; the system records every exchange.

### Auto-injection (read site)

In `buildActiveQuestContext(quest)` on the desktop renderer,
after the existing `[Quest instructions ...]` block:

```
[Recent conversation on this quest]
  You: Where do I source the Pi Zero in Norway?
  Clawsuu: Welectron (DE) — ~€15, fast EU shipping.
  You: And headers?
  ...
[/Recent conversation on this quest]
```

Limits enforced in the injection:
- **8 exchanges** (16 messages — last 8 user + agent pairs
  matched up best-effort). Cap to keep prompt bounded.
- **300 chars per line** (drop with '…').

The empty case (fresh quest, no log) is silent — we don't
emit "no prior conversation on this quest" because that's
a meta-comment that doesn't help the model and just burns
context budget.

### Migration

`loadQuests()` adds `conversationLog: []` to any quest
missing the field. Idempotent — runs on every file read,
mutates only when needed.

### New IPCs

```
quests:append-conversation-log
  args: (questId, role, text, agentId, agentName)
  returns: { ok, entry } | { ok: false, error }

quests:get-conversation-log
  args: (questId)
  returns: { ok, log: [...], questName: string } | { ok: false, error }

quests:clear-conversation-log
  args: (questId)
  returns: { ok } | { ok: false, error }
```

Exposed on the renderer bridge via:
- `cyberclaw.quests.appendConversationLog(id, role, text, agentId, agentName)`
- `cyberclaw.quests.getConversationLog(id)`
- `cyberclaw.quests.clearConversationLog(id)`

The mobile can read the log via `getConversationLog` to
power a future "view past chats on this quest" panel — not
wired in this release, but the IPC is ready for the
QuestsScreen UI to add per-quest conversation history.

## What didn't change

- `chatHistoryByAgent[agentId]` (per-companion, NOT per-quest)
  is unchanged. That's the stream that powers the chat panel
  UI; the new `conversationLog` is a separate per-quest slice
  used only for LLM context.
- The existing `QUEST_APPEND_CHANGE` / `QUEST_NOTE` tags still
  work. They remain useful for "curated" knowledge (the LLM
  decides what's important enough to log); the new automatic
  log captures the raw stream. They're complementary.
- The cap-200 / 1000-chars-per-entry settings are baked
  constants in `main.js`. Easy to expose via settings UI
  later if the user wants different limits per quest type.

## Files

- `src/main.js`: loadQuests migration; quests:create default;
  three new ipcMain.handle blocks; new `appendConversationLog`
  helper + size constants.
- `src/preload.js`: three new bridge methods on
  `cyberclaw.quests`.
- `src/js/app.js`: addChatMsg + openclaw-session-chat-message
  both fire the appendConversationLog IPC. `buildActiveQuestContext`
  injects the most-recent 8 exchanges as a separate context block.
- `package.json`: 3.2.58 → 3.2.59.

## Verification plan

- TypeScript/N/A (this is the desktop, JS only).
- `node -c` on all three edited files: clean.
- Manual flow:
  1. Open quests panel, ensure "SeedSigner" quest is active.
  2. Mobile → chat "Where does Welectron ship from?"
  3. Wait for the LLM reply.
  4. Quit the desktop (Cmd+Q) WHILE the chat is open.
  5. Re-launch the desktop.
  6. Mobile → chat "What about Adafruit for headers?"
  7. The companion should remember that The user was asking about
     Pi Zero sourcing and reference Welectron/Adafruit in
     the context, not re-ask what the project is about.

## Known limitations

- **No mobile UI for the conversation log yet.** The IPC
  exists but the mobile's QuestsScreen doesn't show a
  "past conversations" panel. Add as a follow-up.
- **Discord tail migration is automatic** (covered above)
  but only if `activeQuestId` is set on the desktop at
  the time the Discord message arrives. If the user uses
  Discord without an active quest (the more typical case),
  the log simply doesn't fire — that's by design; the
  quest is project-scoped, the conversation log is
  per-project.
- **Tag-driven `QUEST_APPEND_CHANGE` already exists** and
  is unchanged; if the LLM emits it the change still
  lands in `latestChanges`. This release doesn't unify
  the two — they live side by side with different
  semantics (curated vs raw).

## See also

- `CHANGES_3.2.30.md` — original quest instructions file
  (`QUEST_INSTRUCTIONS.md` — project-specific behavior
  rules).
- `CHANGES_3.2.41.md` — `QUEST_NOTE` structured-output tag.
- `CHANGES_3.2.50.md` — `QUEST_APPEND_CHANGE` structured-output
  tag.
- `CHANGES_3.1.50.md` — original quest system + the
  `latestChanges` log introduced alongside.
