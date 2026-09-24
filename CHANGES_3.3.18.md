# v3.3.18 — Stamp `activeQuestName` + `activeQuestId` on chat broadcasts and buckets

Companion to mobile v3.11.5 (per-bubble quest chip).

## What changed

### 1. `addChatMsg` stamps `activeQuestName` on the bucket push

The per-(agent, quest) bucket push in app.js (~line
4212) was previously:

```js
chatHistoryByAgentAndQuest[agentId][qk].push({ type, text, name, emoji, ts: Date.now(), activeQuestId: activeQuestId || null, activeQuestName: null });
```

`activeQuestName` was set to `null` (the v3.3.13 fix
dropped the enrichment that crashed the renderer).
This change restores it via a sync lookup against a
new module-scope `cachedQuestsList` cache:

```js
let activeQuestNameAtAppend = null;
try {
  if (typeof activeQuestId === 'string' && activeQuestId && Array.isArray(cachedQuestsList)) {
    const q = cachedQuestsList.find(qq => qq && qq.id === activeQuestId);
    if (q && q.name) activeQuestNameAtAppend = q.name;
  }
} catch (_) { /* defensive — fall back to null name */ }
chatHistoryByAgentAndQuest[agentId][qk].push({ type, text, name, emoji, ts: Date.now(), activeQuestId: activeQuestId || null, activeQuestName: activeQuestNameAtAppend });
```

The lookup is sync (against the cache) to avoid
converting `addChatMsg` to async. Per the v3.3.13
"enrichment should be opt-in, not eager" lesson in
MEMORY.md: making the function async would touch 15+
call sites for an enrichment that's only consumed by
the mobile's bubble header.

The cache is populated by the existing `quests-updated`
IPC handler (no new wiring — just an extra line):

```js
ipcRenderer.on('quests-updated', (e, list) => {
  try {
    if (!Array.isArray(list)) return;
    cachedQuestsList = list.slice();
    // ...existing logic
  }
});
```

### 2. `sync-broadcast-chat` includes `activeQuestId`

The chat broadcast IPC now carries `activeQuestId` so
live broadcasts (not just historical replays) include
the data for the mobile's bubble header:

```js
ipcRenderer.invoke('sync-broadcast-chat', {
  agentId: agentId || name || 'companion',
  agentName: name || null,
  text: text,
  isUser: type === 'user',
  activeQuestId: (typeof activeQuestId === 'string' && activeQuestId) ? activeQuestId : null,
});
```

The mobile's `renderMessage` uses `item.activeQuestId`
for the chip label; the name comes from the mobile's
own `questNameById` map (populated by the
`onQuestsList` listener from desktop broadcasts).

## Files changed

- `src/js/app.js`
  - New module-scope `cachedQuestsList = []`
    populated by the `quests-updated` IPC handler.
  - `addChatMsg` bucket push: stamps `activeQuestName`
    looked up from `cachedQuestsList`.
  - `sync-broadcast-chat`: includes `activeQuestId`.
- `package.json` — bumped to `3.3.18`.

## Compatibility

- Wire format: extended, not breaking. Old clients
  (pre-v3.11.5 mobile) ignore the `activeQuestId`
  field. New clients (v3.11.5 mobile) read it for the
  bubble header.
- Sync timing: `addChatMsg` is still sync. The cache
  lookup is O(n) over typically <20 quests, runs on
  every chat message — negligible cost.
- Stale cache: if `cachedQuestsList` is cold (haven't
  received any quests-updated IPC yet), the lookup
  falls through and `activeQuestName` is null. The
  mobile's `questNameById` map fills in this gap from
  its own quests_list broadcasts.

## Verified

- `node --check src/js/app.js` passes.
- Hand-trace: a new chat message lands → addChatMsg
  reads cachedQuestsList (populated by last
  quests-updated) → looks up activeQuestName → bucket
  push has both activeQuestId and activeQuestName.
  Mobile chat history pull returns the bucket → renders
  the chip on each bubble.
- Tag on origin verified with
  `git ls-remote --tags origin | grep v3.3.18` →
  annotated at `8853ab6`.
