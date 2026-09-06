# v3.2.64 — Strip-on-output for chat history + silent snack logging

the user 2026-08-04 21:16:
> "We should log snacks by the way, and type of snack
> so he can talk about them. Perhaps we send a
> message to him each time we give food, 'user gave
> you hamburger, lighten up a little, no need to
> respond, just add to memory.' would that work?
>
> And main thing: He does not need to say in text, the
> quest append, it can be silent in the background,
> it should just respond normaly mostly in the chat."

Three changes:

1. **Strip quest tags on chat history output paths** so
   pre-v3.2.36 historical messages (with raw tag text
   persisted) don't show in the mobile chat bubble.
2. **Update `buildQuestToolsHint`** to remind the LLM
   to pair tool tags with a chat-visible reply (or a
   short "logged." ack). Tags alone are stripped from
   the bubble; without a real reply, the user sees an
   empty bubble after the LLM does work.
3. **Add silent snack-logging** — when the user gives
   the companion a treat, log the snack + category to
   memory.md AND fire a quiet LLM round-trip that can
   optionally enrich the entry. No chat-visible reply
   from the snack event itself; the companion's chat
   reaction is unchanged.

## 1. Strip-on-output for chat history

the user's screenshot showed a chat bubble with raw
`[QUEST_APPEND_CHANGE: text="..."]` text. The
stripper (`stripQuestTags`) was added in v3.2.36 and
called from `addChatMsg` in the chat pipeline. So why
was the unstripped text showing in the bubble?

Cause: the desktop's `chatHistoryByAgent` (persisted
in localStorage as `cyberclaw-chat-byagent`) had
entries from before v3.2.36 was installed. Those
entries were persisted WITHOUT stripper-cleaning. On
reconnect, the mobile requests `chat_history` (or
`agent_history`), the renderer ships the unstripped
text, the mobile shows it as-is.

Fix: strip on the OUT path. Updated both IPC
listeners:

- `ipcRenderer.on('mobile-request-chat-history')` —
  maps `chatHistory.slice(-50)` through `stripQuestTags`
  before forwarding to `sync-send-chat-history`.
- `ipcRenderer.on('mobile-request-agent-history')` —
  same strip on the per-agent history map.

Stripping is idempotent (already-clean text stays
clean), so we don't need a one-shot localStorage
migration. As old messages re-load they're cleaned
in-flight; new messages get cleaned at write time (the
existing stripQuestTags call in the chat pipeline).

### Behaviour notes

- Desktop's chat panel also gets the cleaned text
  (the renderer's `addChatMsg('agent', ...)` call
  already stripped before render). No regression.
- TTS path also gets cleaned text (the renderer's
  `mobile-tts-response` event uses the already-
  stripped `result.reply`). No regression.

## 2. `buildQuestToolsHint` reply reminder

The LLM was sometimes emitting ONLY a tool tag and no
chat-visible text. After stripping, the chat bubble
was empty, which made it look like the companion
"responded" but said nothing. the user's report (paraphrased):
"It should just respond normally mostly in the chat."

Fix: extend the `buildQuestToolsHint` to remind the
LLM that bare tags are silent. New tail added to the
hint:

```
| IMPORTANT: tags alone are silent in the user's
chat — always pair a tag with a normal chat-visible
reply (or a short "logged." ack).
```

The directive sits in the same context the LLM
already sees (right next to the available tag shapes),
so it shouldn't require a new model adaptation cycle.

### Behaviour notes

- The reminder is wrapped in the same `| Tools: [...]`
  block as the existing tag list, so it counts toward
  the same context budget.
- "logged." is offered as the canonical short ack
  the LLM can use when the action IS the main point
  of the message — e.g. "ok I'll change the directory"
  → `[QUEST_NOTE: ...] logged.` (tag + 1 word).
- The reminder does NOT change the stripper's
  behaviour — the stripper still strips tags from the
  chat bubble regardless of whether the LLM emits a
  reply or not.

## 3. Silent snack logging

the user: "We should log snacks by the way, and type of
snack so he can talk about them." Each snack event
now writes to `memory.md`:

- **Direct append first** (deterministic, doesn't
  depend on LLM compliance):
  ```js
  cyberclaw.companions.rememberMemory(agentId, fact);
  ```
  where `fact` is e.g. "the user gave me a hamburger (food)"
  or "I ate some berries (food)". This lands in
  `~/.openclaw/cyberclaw/companions/<agentId>/memory.md`
  immediately, so future sessions remember the
  snack category.
- **Silent LLM round-trip second** (optional context):
  the LLM is asked to emit a `[REMEMBER: text="..."]`
  tag with any context it wants to add (e.g. "the user
  gave me a hamburger for the third time tonight —
  clearly an apology for something I did"). The
  silent prompt is built with the `[SILENT LOG MODE]`
  prefix so the LLM knows it should NOT write a
  chat-style reply, just the tag (or nothing).
- **Chat reaction unchanged**: the existing
  `promptCompanionReaction` call still fires after
  the silent log, so the companion gets to chat-react
  to the food if it wants (goblin: "an apple? what
  am I, a toddler?", stoic: "thanks.", etc.). The
  chat reaction is short and personality-flavoured,
  the silent log is for long-term memory.

### Why two writes?

- Direct append guarantees the fact lands. The LLM
  round-trip is for context. If the LLM doesn't emit
  a `[REMEMBER]` tag, the fact is still in memory.md
  from the direct append. If the LLM DOES emit one,
  we have two entries (the deterministic one + the
  LLM-enriched one) — slight redundancy, but the
  companion's memory.md is short and dated; duplicate
  entries are fine and the user can clear them.
- Same pattern as v3.2.59's conversation-log: JSON
  array is the load-bearing store for context
  injection, the file is the canonical long-term
  store for `cat`/`grep`/git. Here memory.md is
  always the canonical store (the JSON/memory split
  is per-companion, not per-quest), so direct append
  + LLM enrichment both write to memory.md.

### `promptCompanionSilent` mechanics

The function is a sibling to `promptCompanionReaction`
(same pattern: build prompt → call LLM → handle
reply). Key differences:

- Builds a `[SILENT LOG MODE]` system prompt. The
  LLM is told: "Use the [REMEMBER: text="..."]
  structured-output tag. Do NOT write a chat-style
  reply. Do NOT address the user. The tag is the
  entire output."
- Calls `cyberclaw.chat.sendSilentMessage(agentId,
  systemPrompt)` (new IPC variant — see below) — this
  fires the `chat:send-message` IPC with `silent:true`
  and gets the LLM reply. **No broadcast, no chat
  history push, no arena bubble, no typing indicator,
  no TTS** — the renderer's chat pipeline wrapper
  (`__sendChatMessageImpl`) is bypassed entirely.
- After the LLM reply comes back, parses out
  `[REMEMBER: text="..."]` tags via `extractRememberTags`,
  calls `cyberclaw.companions.rememberMemory(agentId,
  text)` for each. The text outside the tags is
  silently discarded.
- **Direct memory append before the LLM call** (not
  after) — see the "two writes" rationale above.

### `extractRememberTags` + `[REMEMBER]` strip

- `extractRememberTags(reply)` — regex
  `/\[REMEMBER:\s*text="([^"]*)"\]/gi`, returns an
  array of strings. Matches the same bracket-close
  logic as `stripQuestTags`.
- `stripQuestTags` was extended to strip `[REMEMBER]`
  tags from the visible chat bubble (defensive: if
  a non-silent path ever returns a reply containing
  the tag, it doesn't leak into the chat).
- The `[REMEMBER]` structured-output tag is
  documented in `DEFAULT_SYSTEM_PROMPT`'s
  `## CyberClaw environment` section so the LLM
  knows about it from the base layer (rather than
  relying on the silent prompt to teach it each time).

### `cyberclaw.chat.sendSilentMessage` IPC variant

Added to `preload.js`:

```js
sendSilentMessage: (agentId, message) =>
  ipcRenderer.invoke('chat:send-message', {
    agentId, message, attachments: null, silent: true,
  }),
```

The `chat:send-message` IPC handler in main.js
already accepted the same payload shape; added the
`silent` flag to the destructure and a console-log
of the flag for debugging. **No behaviour change** —
the handler already just called the LLM and returned.
The renderer's `addChatMsg` + TTS side-effects are
in `__sendChatMessageImpl`, which the silent path
bypasses.

### `TREAT_CATEGORIES` mapping

A new map `treatType → 'food' | 'toy'` (and the
implicit future keys for sub-types like 'sweet',
'savory', 'fruit', etc.). Each treat now has a
category string that flows into the memory.md
entry, so the companion can talk about snack
types later ("I had some food today", "we played
with toys earlier").

## Files

- `src/js/app.js`:
  - `stripQuestTags` extended to handle `[REMEMBER]`.
  - `extractRememberTags(reply)` helper added.
  - `buildQuestToolsHint` extended with the
    "tags alone are silent" reminder.
  - `TREAT_CATEGORIES` map added next to
    `TREAT_NAMES`.
  - `placeTreatOnArena` now fires
    `promptCompanionSilent` before the existing
    `promptCompanionReaction`.
  - `promptCompanionEat` similarly fires the
    silent log on the eat event.
  - `promptCompanionSilent(agentId, fact, mood)`
    function added below `promptCompanionReaction`.

- `src/main.js`:
  - `chat:send-message` IPC handler's payload
    destructure now includes `silent` (defaulted to
    falsy — old behaviour unchanged). Console log
    adds the silent flag.

- `src/preload.js`:
  - `cyberclaw.chat.sendSilentMessage(agentId, message)`
    added — fires `chat:send-message` with
    `silent: true`.

- `src/companion-prompts.js`:
  - `DEFAULT_SYSTEM_PROMPT` `## CyberClaw environment`
    section now mentions the `[REMEMBER: text="..."]`
    structured-output tag.

- `package.json`: 3.2.63 → 3.2.64.
- `CHANGES_3.2.64.md`.

## Verification

- `node -c` on all 4 edited files: clean.
- ESLint: 0 new errors introduced.
- 3/3 smoke tests pass on the new helpers
  (`extractRememberTags`, `stripQuestTags` strips
  REMEMBER, `TREAT_CATEGORIES` all map to food/toy).
- Manual flow (post-restart):
  1. Open Settings → CYBERCLAW.md → confirm new
     bullet mentions `[REMEMBER]` tag.
  2. Reconnect mobile, chat_history replay — any old
     unstripped messages get cleaned in flight.
  3. Arena: drag a hamburger to the companion →
     `memory.md` should now have a line like
     `- the user gave me a hamburger (food)`.
  4. Same for other foods (apple, cake, etc.) and
     toys (ball, frisbee) — categories in memory.md
     match `TREAT_CATEGORIES`.
  5. Send a chat → companion can mention the food
     ("oh, did you give me an apple earlier? I'm
     still full").

## What didn't change

- `chatHistory` persistence shape (still the local
  renderer's `cyberclaw-chat-byagent` localStorage
  key). New writes get stripped at the chat pipeline
  boundary; old writes get stripped on read in the
  IPC listeners.
- `promptCompanionReaction` is unchanged. Food events
  still trigger a chat reaction; the silent log is
  additive.
- `placeTreatOnArena`'s visual drop + `adjustHappiness`
  side-effect is unchanged.
- The `cyberclaw.chat.sendMessage` IPC's
  `attachments` parameter shape is unchanged. The
  third arg is still treated as attachments for
  backwards compat; `silent` is a separate field on
  the IPC payload object.

## See also

- `CHANGES_3.2.36.md` — original `stripQuestTags`
  shipping (the v3.2.64 strip-on-output fix is the
  defensive counterpart).
- `CHANGES_3.2.59.md` — first version of the
  per-quest conversation log; same JSON/memory split
  pattern as v3.2.64's direct-append + LLM-enrich.
- `CHANGES_3.2.63.md` — DEFAULT_SYSTEM_PROMPT
  rewrote with the `## CyberClaw environment`
  section that this commit extends with the
  `[REMEMBER]` tag mention.