# v3.3.19 — Desktop: full per-quest history sync to mobile (compatibility with mobile v3.11.12)

Companion to mobile v3.11.12.

## The bug

Tobe (2026-09-27 13:47, Discord #cyber-dev):

> "hmm. Its still happening. It spams up and down at this
> position. After i reopen after a while, still on the same
> quest."

He installed v3.11.11, which I had pushed as a fix for the
"— No quest" chat-flash. It did NOT help. The chat pill
still says "— No quest" and the chat panel bounces
up/down on a loop.

Screenshot confirms: active companion Clawsuu, pill on
each bubble says "— No quest", chat shows the database /
SSH-tunnel / "Live proof just now" content. Tobe confirms
the desktop's active quest (Cyber_Database) is unchanged.

## Root cause (v3.11.11 was wrong)

I had concluded the v3.11.11 fix (persist the anchor on
`onQuestsList` Case 1) was the right diagnosis. It wasn't.

The real chain of bugs:

### Layer 1: desktop's flat `chatHistory` mirror didn't stamp `activeQuestId`

`addChatMsg` does push the per-(agent, quest) bucket with
`activeQuestId` and `activeQuestName` (line 4234 of app.js,
per the v3.3.18 fix). But the legacy flat `chatHistory`
mirror push (line 4169-4172 in the v3.3.18 codebase)
stamps only `text / isUser / agentId / ts`:

```js
chatHistory.push({
  text: text,
  isUser: type === 'user',
  agentId: name || 'companion',
  ts: Date.now()
  // ← no activeQuestId / activeQuestName here
});
```

So `chat_history` (the flat legacy history response sent to
the mobile on first connect) loses the quest attribution.
The mobile has no way to route those messages to the
correct per-quest bucket on cold start.

### Layer 2: `agent_history` response only included the DEFAULT bucket

The desktop's `mobile-request-agent-history` IPC handler
(around line 7247 of app.js) read messages from
`chatHistoryByAgentAndQuest[agentId][DEFAULT_QUEST_KEY]`
only. **The active quest's bucket was never sent to the
mobile.**

So even if Tobe's chat with Clawsuu was happening under
the Cyber_Database quest on the desktop (stored in
`chatHistoryByAgentAndQuest['clawsuu']['<database-key>']`),
the mobile request only ever pulled from
`chatHistoryByAgentAndQuest['clawsuu']['__default__']`.

### Layer 3: `agent_history` payload stripped quest attribution even when multiple buckets were sent

The pre-v3.3.19 `agent_history` payload shape was
`{type, text, name, emoji, ts}` — no `activeQuestId` field
on the message. So even if Layer 2 had been fixed, the
mobile wouldn't know which bucket to file each message
into.

The combination is fatal:
- Layer 1 strips quest from `chat_history` flat messages.
- Layer 2 sends only DEFAULT from `agent_history`.
- Layer 3 strips quest from any `agent_history` messages
  that did arrive.

Result: the mobile's `messagesByAgentAndQuest[aid]` only
ever gets populated in the DEFAULT bucket. The
active-quest bucket stays empty. After a cold start, the
projection effect looks up the active-quest bucket, finds
nothing, and the chat panel flashes the DEFAULT bucket
content under "— No quest" pills.

For the scroll-jump loop symptom: each invalidation that
flips `messages` between `[]` (empty active-quest bucket
during cold start) and `[DEFAULT-bucket content]` (once
the chat_history response lands) triggers FlatList's
`onContentSizeChange → scrollToEnd`, then the next
flip (broadcast comes in with realtime message routed to
active-quest bucket, projection effect finds it empty
again on its initial state but eventually populates from
agent_history → re-bucket → another scrollToEnd). Each
flip is one scroll position change. Several flips in
quick succession = the user perceives "jumps up and down
in a loop."

## Fix (desktop side)

Three changes in this release:

### Fix 1: stamp `activeQuestId` and `activeQuestName` on the flat `chatHistory` mirror push

```js
chatHistory.push({
  text: text,
  isUser: type === 'user',
  agentId: name || 'companion',
  ts: Date.now(),
  activeQuestId: (typeof activeQuestId === 'string' && activeQuestId) ? activeQuestId : null,
  activeQuestName: activeQuestNameAtAppendForMirror,
});
```

Lookup pattern: `activeQuestNameAtAppendForMirror` is read
synchronously from `cachedQuestsList` (same pattern as
the per-quest bucket push at line 4234). Going async
inside `addChatMsg` would touch 15+ call sites for an
enrichment that only the mobile's bubble-header needs;
v3.3.13 already established the rule "don't make
addChatMsg async."

### Fix 2: `agent_history` sends ALL quest buckets for the agent, not just DEFAULT

```js
const buckets: Record<string, any[]> = {};
for (const [bucketKey, msgs] of Object.entries(agentBuckets)) {
  if (!Array.isArray(msgs) || msgs.length === 0) continue;
  buckets[bucketKey] = msgs.slice(-50).map((m) => ({
    text: ...,
    isUser: ...,
    agentId: ...,
    agentName: ...,
    ts: m.ts,
    activeQuestId: questKeyFromStorage(bucketKey),  // reverse the encoding
    activeQuestName: m.activeQuestName ?? null,
  }));
}
ipcRenderer.invoke('sync-send-agent-history', { agentId, buckets })
```

Each message is also stamped with `activeQuestId` (the
quest id back-decoded from the bucket key) and
`activeQuestName` (the cached quest name, read at
append-time, preserved across the sync).

Wire-format change: payload now contains `buckets` (the
new per-quest map). The shape is non-breaking for older
mobile builds:

- Old mobile builds read `msg.messages` (a flat array) on
  `agent_history`. With v3.3.19+ desktop sending only
  `buckets`, the `messages` field is missing for old
  builds. To avoid a hard break, the sync-server's
  `sendAgentHistory` (see Fix 3) ALSO synthesizes a
  backwards-compatible flat `messages` array from the
  DEFAULT bucket content (falling back to the first
  non-empty bucket if DEFAULT is empty).

### Fix 3: `sync-server.sendAgentHistory` is shape-aware

```js
sendAgentHistory(ws, agentId, source) {
  const payload = { type: 'agent_history', agentId, ts: Date.now() };
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    // v3.3.19+ map shape.
    payload.buckets = source;
    const defaultBucket = source['__default__']
      || Object.values(source)[0]
      || [];
    if (Array.isArray(defaultBucket)) {
      payload.messages = defaultBucket;  // back-compat for old mobile
    }
  } else {
    // v3.3.18 and earlier flat array shape.
    payload.messages = Array.isArray(source) ? source : [];
  }
  this._send(ws, payload);
}
```

The sync-server is the actual WS emitter. Putting the
compat logic here keeps the renderer-side
`mobile-request-agent-history` handler clean (it just
sends `buckets`, period). New mobile builds (v3.11.12+)
consume `buckets` directly. Old builds consume
`messages` and ignore the rest.

## Files changed

- `src/js/app.js`
  - Flat `chatHistory` push now stamps
    `activeQuestId` and `activeQuestName`.
  - `mobile-request-agent-history` handler sends
    ALL quest buckets (not just DEFAULT), with each
    message stamped `activeQuestId` and
    `activeQuestName`.
- `src/sync-server.js`
  - `sendAgentHistory` accepts either a flat array
    (legacy) or a `Record<bucketKey, messages>`
    (v3.3.19+). Synthesizes a flat `messages` fallback
    for old mobile builds.
- `src/main.js`
  - `sync-send-agent-history` IPC forwards `buckets`
    (preferred) or `messages` (legacy fallback).
- `package.json` → 3.3.19.

## Mobile-side companion release

This release requires the matching mobile v3.11.12 to
fully fix the bug — it adds the mobile-side consumer of
the new `buckets` payload (and of the per-quest
`chat_history` flat messages). Without mobile v3.11.12,
the desktop's per-quest data still won't surface to the
user; old mobile builds continue to receive the
DEFAULT-bucket fallback from the `messages` field
synthesis in `sendAgentHistory`, which gets them back to
v3.11.11-equivalent behavior (no regression, no fix).

## This is the 12th fix in the chat-flash family

Previous fixes tackled the projection-effect path
(anchor, bootstrap, remount-fallback). This one tackles
the data-source path (the chat history wasn't bringing
over the per-quest attribution that the projection
effect needed to look up the right bucket).

**Lesson (added to MEMORY.md):**

The "symptom matches" trap. When a bug surfaces as "the
view shows the wrong content," don't assume the fix lives
in the view-rendering path. The view can render
correctly against empty data. The bug might be in the
data-delivery path. Diagnose by reading the actual
content of the rendered chat and the actual content of
the source buckets. If the source bucket is missing
data, fix the data-delivery path; if the source has the
data and the view is showing something else, fix the
view-rendering path.

Tobe's report had everything I needed: "live proof just
now" was a real message about his active quest, but the
chat it appeared in had "— No quest" pills, which
contradicts itself unless EITHER the source data has the
message without quest attribution OR the messages
showing had a null stamp at the desktop. Either way,
the desktop had lost the quest attribution somewhere
between appending and shipping to the mobile.

The check I should have done FIRST: trace a single
desktop-side appendChatMsg call. Verify each message's
`activeQuestId` is preserved across every IPC hop:
- app.js addChatMsg → per-(agent, quest) bucket push
  (line 4234): ✓ stamped
- app.js addChatMsg → flat chatHistory mirror push
  (line 4169): ✗ NOT stamped (my Fix 1)
- app.js sync-broadcast-chat (line 4316): ✓ stamped
- app.js mobile-request-agent-history (line 7247): ✗ only DEFAULT bucket
  (my Fix 2) AND ✗ payload strips quest (my Fix 3)
- sync-server sendAgentHistory: ✗ payload shape strips quest (my Fix 3)

Three lost-stamp paths on a single message. The bug
class isn't "the mobile lost the data" — it's "three
independent desktop-side serialization layers each
independently failed to preserve the attribution that
the per-bucket push got right."

**Future-data-pipeline audit pattern:** when adding new
metadata fields to a structured record, find EVERY
serialization layer that touches the record (pushes,
mirrors, broadcasts, IPC handlers, sync handlers, WS
emitters, JSON.stringify at every IPC boundary) and
verify the field is preserved at each one. A single
omitted layer is enough to lose the field for any
downstream consumer that happens to use that path.

This applies beyond chat:
- Settings: TTS voice / engine changes broadcast over
  multiple IPCs. If any layer fails to preserve them,
  some clients see stale state.
- Quest metadata: project instructions text, quest
  files dir, latest changes — all of these have separate
  serialization layers. Audit each new field against
  each path.
- Companion metadata: avatar URL, sprite scale, theme
  preferences — same pattern.

The codebase has many such layers (Electron IPC + IPC
renderer.invoke + main.handle + sync-server WS send).
Tracing a single field across ALL of them on every new
field is the rule.
