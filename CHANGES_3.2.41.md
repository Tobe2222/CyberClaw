# v3.2.41 — quest context: preheat + companion notes

## 1. First chat send after a quest switch now sees the instructions file

**Tobe's report (2026-08-02 15:45):**
> "for some reason i cannot scroll all the way down now when i
> have the keyboard up. ... hmm, clawsuu on the cyberclaw still
> seem a bit confused. [...] the messages show it missed the
> instructions file."

The chat screenshot tells the story:
- Tobe set CYBERHIVE_WEBSITE V3 as the active quest.
- Tobe sent "do it".
- Clawsuu replied "What the fuck, Tobe. I'm sitting here
  starving waiting for you to actually let me into the project
  — you said 'do it' but didn't unlock shit. You wanna hand me
  the keys or what?"
- Tobe: "The keys? Its in the quest instructions. Or do you not
  see that?"
- Clawsuu: "I'm a dumbass, missed it."

The instructions file was there. The quest editor showed it to
Tobe. But the companion's chat context didn't have it on the
**first** send after the quest switch.

**Root cause:** `buildActiveQuestContext` is (was) sync and the
quest instructions file is read async. The original code fired
a "fire-and-forget" read on the first call and used the cache
from the SECOND call onwards. The comment in the code even
called this out:

> "The first chat send after opening a quest will NOT have the
> instructions file in context; the second one will. Tobe's UX
> is 'open quest, type, send' so the second-send delay is
> acceptable."

Tobe's UX is exactly "open quest, type, send" — and the
companion's "I'm a dumbass, missed it" reply is the visible
failure of that tradeoff. The two-send delay isn't acceptable
when the user only sends one.

**The fix (two parts):**

### 1a. Pre-warm the cache on quest selection

`selectQuest()` now seeds a module-level preheat map
(`questInstructionsPreheat`) immediately after `setActive`
succeeds. The preheat reads the instructions file and writes it
into the quest's cache. `renderQuests()` also preheats the
active quest so the desktop restart path is warm too.

### 1b. `buildActiveQuestContext` is now async

Used to be sync because the chat send path was sync. The chat
send path is async (`await cyberclaw.quests.list()` etc.).
Making `buildActiveQuestContext` async lets it:

- Await the preheat promise if it's still pending. The await
  is a no-op if the preheat already resolved. Either way the
  cache is filled before the context block is built.
- If the preheat is missing (legacy code path, race), fall back
  to a direct `readQuestInstructions` IPC + cache write.

Both call sites (sendChatMessage and the voice-mode chat path)
await the now-async helper.

**Result:** the first chat send after a quest switch has the
instructions file in context.

---

## 2. Companion can leave notes for itself in the quest instructions

**Tobe's report (2026-08-02 15:45):**
> "as it works within the quests it should leave notes for itself,
> and update key info in the quest instructions for itself, how
> to do things etc."

The companion already had a quest instructions file (the editor
on the desktop shows it under "Quest instructions"). The
companion was reading it on every chat send. But there was no
tool for the companion to **write to it** — it could only read.
So the user's "quest instructions" stayed frozen: the human
wrote them once, and the companion never learned anything
project-specific (SSH paths, deploy commands, "don't touch this
file", "use British English", etc.) that future turns could
benefit from.

**New tag:** `[QUEST_NOTE: text="..."]`

The companion emits this in its reply when it learns something
project-specific. The desktop's reply parser:

1. Reads `text` from the tag.
2. Calls `cyberclaw.quests.appendQuestInstructions(activeQuestId, text)`.
3. The IPC handler appends a timestamped block to the
   `QUEST_QUEST_INSTRUCTIONS.md` file under a `## Companion notes`
   section (creating the section if it doesn't exist). The
   user's hand-written instructions stay untouched at the top —
   the agent's notes accumulate at the bottom.
4. Invalidates the in-memory cache so the next chat send sees
   the new note in the context block.
5. Shows a small system message in the chat: `📓 Note saved:
   <preview>`.

The new IPC is `quests:append-quest-instructions`. Exposed via
preload as `cyberclaw.quests.appendQuestInstructions(id, text)`.
Mobile is read-only on this — the desktop renderer is the only
thing that emits the tag.

**In-context hint:** added to the quest-tools hint string so the
agent sees `[QUEST_NOTE: text="..."]` alongside the existing
tags. The hint is renamed-by-comment to mention the new tag.

**Strip from chat:** `[QUEST_NOTE:...]` is added to
`stripQuestTags()` so the user doesn't see the tag in the
visible chat bubble.

---

## 3. Why I didn't add a separate `QUEST_MEMORY.md` file

Worth a note: Tobe's "leave notes for itself" could have been
implemented as a separate `QUEST_MEMORY.md` file inside the
quest directory. I chose to put the notes in the same
`QUEST_QUEST_INSTRUCTIONS.md` file under a `## Companion notes`
section because:

1. **One source of truth per quest.** The user already has an
   editor for that file. The companion's notes show up in the
   same editor (top-of-file instructions + bottom-of-file
   notes) so the user can see what the companion has learned.
2. **No extra context merging.** If the notes were a separate
   file, `buildActiveQuestContext` would have to read two
   files and inject both — easy to get wrong, easy to forget
   to update one of them.
3. **The user can edit the notes too.** If the companion
   writes something wrong, the user can fix it in the same
   editor. The next chat send sees the corrected version.

The section heading `## Companion notes` separates the
agent-written notes from the human-written instructions so the
two don't get confused when re-reading.

---

## Files changed

- `src/main.js` — new `quests:append-quest-instructions` IPC
  handler. Appends a timestamped `## Companion note (ISO)`
  block under the existing `## Companion notes` section (or
  creates the section if missing).
- `src/preload.js` — expose `appendQuestInstructions(id, text)`
  on `cyberclaw.quests`.
- `src/js/app.js`:
  - Add `questInstructionsPreheat` module-level map.
  - `selectQuest()` preheats the cache on quest selection.
  - `renderQuests()` preheats on every render (covers
    desktop restart, mobile sync, save events).
  - `buildActiveQuestContext` is now async; awaits the
    preheat before reading.
  - New tag parser for `[QUEST_NOTE: text="..."]`.
  - `stripQuestTags` strips the new tag.
  - Quest-tools hint strings updated to mention
    `[QUEST_NOTE: text="..."]`.
- `package.json` — version 3.2.40 → 3.2.41

**v3.2.41 (desktop).**
