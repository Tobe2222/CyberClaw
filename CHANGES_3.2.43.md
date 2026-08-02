# v3.2.43 — desktop renderer picks up mobile-driven quest changes

## 1. Clawsuu now sees the correct active quest

**Tobe's report (2026-08-02 17:27):**
> "clawsuu tells me that he sees another quest. Something is
> of with the quests it seems."

The chat screenshot showed:
- Tobe: "I have cyberhive website as my current quest on the
  phone here."
- Clawsuu: "Yeah it says Cyber_Music is active, you absolute
  gremlin — your phone is showing me the wrong shit."

But the phone was right. The disk had CYBERHIVE_WEBSITE V3 as
active. The mobile UI said CYBERHIVE_WEBSITE V3 active. Clawsuu
was reading the **stale renderer's `activeQuestId`** — still
pointing at Cyber_Music from an earlier session.

**Root cause:** `saveQuests()` in main.js broadcasts the
updated list to WS clients (mobile, plus a reconnect-replay
cache). It does NOT push to the desktop's own renderer. The
renderer's module-level `activeQuestId` only re-syncs from
disk when something the *renderer* does triggers
`renderQuests()` (selecting a quest, creating one, deleting
one). The mobile's set-active writes to disk + broadcasts to
mobile clients but the renderer's in-memory state stays stale.

Verified with a v3.2.42 debug log: the WS handler did receive
all 3 `set_quest_active` calls from the mobile, the disk
updated each time, but the next chat send built its context
with the renderer's stale `activeQuestId` (Cyber_Music).

**Fix:** `saveQuests()` now also `webContents.send`s
`quests-updated` to the renderer with the canonical list from
disk. The renderer subscribes via `ipcRenderer.on('quests-updated',
...)`, updates its module-level `activeQuestId` from
`list.find(q => q.active)?.id || null`, and calls
`renderQuests()` so the UI reflects the change too.

Now both the chat context AND the desktop's Quests panel stay
in sync with mobile-driven changes.

**Why this wasn't caught earlier:** until v3.2.41, the chat
context builder would re-read disk via
`cyberclaw.quests.list()` on every send. The renderer's
`activeQuestId` was a *cache* of that — not the source of
truth. After v3.2.41 moved the preheat logic into the
builder, the in-memory cache became the primary source for
the chat path. The preheat re-read happens per-send, but
`activeQuestId` itself is set from the cache and only updates
when `renderQuests()` runs. So a mobile-driven change between
two chat sends left the cache stale.

## 2. Debug log in v3.2.42 (kept)

The `console.log('[SyncServer] set_quest_active received
from ${client.name}: id=${id}')` line is harmless and useful.
Leaving it in for now — cheap, and any future "did the mobile
even send it?" question gets an instant answer.

## Files changed

- `src/main.js` — `saveQuests()` adds a `webContents.send`
  for `quests-updated` after the WS broadcast.
- `src/js/app.js` — new `ipcRenderer.on('quests-updated',
  ...)` handler that updates `activeQuestId` and calls
  `renderQuests()`.
- `package.json` — version 3.2.42 → 3.2.43

**v3.2.43 (desktop).**
