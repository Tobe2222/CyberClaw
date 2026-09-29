# v3.3.20 — Desktop: broadcast agent-image bubbles to mobile (companion to mobile v3.11.19)

## The bug

Tobe (2026-09-29 11:38, Discord #cyber-dev):

> "@Clawsuu I see that clawsuu is posting pictures in the
> desktop app but they dont come through to the mobile end.
> They should."

The desktop was showing screenshot bubbles from clawsuu's
`[SCREENSHOT target=...]` directives (see the v3.2.83
`postAgentReplyWithScreenshots` flow in src/js/app.js
around line 4103). The mobile companion app showed nothing
for those same turns — the chat bubble appeared, but no
thumbnail.

The desktop's `addChatMsg` has a separate broadcast path for
realtime WS messages to the mobile (the
`sync-broadcast-chat` IPC at app.js line ~4312). The guard
on that broadcast only matched three message types:
`'agent'`, `'user'`, `'error'`. The fourth visual-only bubble
type, `'agent-image'`, was **not** matched, so the
`ipcRenderer.invoke('sync-broadcast-chat', ...)` call was
silently skipped. The bubble rendered locally on the
desktop but never reached the mobile's WS.

## Root cause (one line)

The broadcast type guard in app.js excluded the bubble type
that needed broadcasting. Visual-only bubbles (`agent-image`,
and any future ones) had no path to the mobile.

This is the same architectural class as the v3.3.19 lesson
"a broadcast is a hint, not a directive": the broadcast
path is a hand-written whitelist that drifts as new bubble
types are added. The renderer-side `addChatMsg` (app.js)
calls `ipcRenderer.invoke('sync-broadcast-chat', ...)` only
for `type === 'agent' || type === 'user' || type === 'error'`.
The `'agent-image'` type was added in v3.2.83 (the
postAgentReplyWithScreenshots flow) but the broadcast guard
was never extended to include it.

## Why a screenshot pipeline bypassed the broadcast

The screenshot pipeline is a fire-and-forget chain:

1. Agent reply text contains `[SCREENSHOT target=cyberclaw]`
2. `postAgentReplyWithScreenshots` (app.js:4103) parses it,
   calls `addChatMsg('agent', cleanedText, ...)` for the
   text reply (this DOES broadcast, fine), then for each
   directive fires `cyberclaw.screenshot(dir)` async.
3. The async screenshot resolves with `{ dataUri, target,
   width, height, filePath }`.
4. The result is `addChatMsg('agent-image', { dataUri, ...
   }, name, displayEmoji)` — this is the visual bubble that
   shows the thumbnail.
5. The renderer's case `'agent-image':` block (app.js:4390)
   renders the `<img>` with the dataUri. **No broadcast
   call.**

Step 5 was the silent failure point. The bubble render
worked fine — it just stopped there.

## The fix

### Desktop (this v3.3.20)

Extend the broadcast type guard in `addChatMsg` (app.js
~4312) to include `'agent-image'`. Translate the
desktop-internal `{ dataUri, target, width, height,
filePath }` shape into the mobile-understood
`attachments: [{ uri, data, type, name, size }]` shape
that the mobile's bubble renderer already accepts for
outbound user-image sends.

Two side-effects:

1. **`sync-broadcast-chat` IPC handler in main.js** now
   destructures `attachments` from the IPC payload and
   forwards it to `syncServer.broadcastChatMessage`. v3.3.19
   already added `activeQuestId` / `activeQuestName`
   destructuring here, so the pattern is in the codebase.

2. **`syncServer.broadcastChatMessage` in sync-server.js**
   now accepts an `attachments` parameter and includes it on
   the `chat_message` payload (and the
   `_recentAiMessages` replay buffer, so reconnects within
   the 50-message window also get the image).

### Mobile (v3.11.19 companion)

The mobile's `onChat` handler (HomeScreen.tsx ~3596) was
constructing `incoming: ChatMessage` and never reading
`msg.attachments`. Add a one-line passthrough:

```ts
attachments: Array.isArray(msg.attachments) && msg.attachments.length > 0
  ? msg.attachments
  : undefined,
```

The bubble renderer in `renderMessage` (HomeScreen.tsx
~6190, v3.10.20) already accepts `attachments` and renders
image previews — the existing user-side send path uses the
same code, so no bubble-component changes are needed.

## Persistence (intentional non-fix)

`agent-image` bubbles are **not** persisted to
`chatHistoryByAgentAndQuest` (the localStorage cache that
survives a desktop restart) and therefore do not appear in
mobile history sync. This matches the desktop's current
behavior: the screenshot file is written to
`/tmp/clawsuu-shot-*.png`, and the bubble shows once while
the process is running. After a desktop restart, the
desktop's local chat also loses those bubbles.

Persistence would require a separate design:
- Base64-encoded screenshots are 50KB-500KB each.
- `chatHistoryByAgentAndQuest` is capped at 200 entries per
  bucket; 200 × ~200KB average = 20MB. Way over localStorage's
  5-10MB cap.
- Alternative: persist file paths only, resolve on read. But
  `/tmp` is unreliable across restarts; would need to move
  the file to `~/.openclaw/cyberclaw/attachments/` and have
  a cleanup policy.

Out of scope for this fix. If we want images to survive
restarts, it's a follow-up design.

## Lessons

1. **Type-guarded broadcasts drift.** Whenever you add a
   new bubble type, audit every `if (type === ...)` guard
   downstream — not just the rendering pipeline but also
   the WS broadcast, the persistence layer, the history
   sync, and the audit log. The same architectural class
   as the v3.3.19 "broadcast is a hint" lesson and the
   v3.3.13 constructor-binding lesson: hand-written
   whitelists silently miss new entries.

2. **Visual-only bubble types need an explicit broadcast
   path.** A bubble that renders an `<img>` isn't going to
   benefit from "broadcast the text" — it needs its own
   shape on the wire. The mobile already understood
   `attachments` for user-side sends, so reusing that shape
   for agent-side image broadcasts is the cheapest
   extension.

3. **Test the on-the-other-side behavior for every new
   bubble type.** v3.2.83 added `agent-image` rendering
   on the desktop and tested it locally. The mobile side
   wasn't checked until Tobe noticed 6+ weeks later. The
   rule: any new chat-message surface on one device
   needs an automated or manual smoke test on the other.

4. **Data size is a real constraint on persistence.** Even
   if we wanted to persist image bubbles, the existing
   200-entry cap × per-bubble base64 size would blow
   localStorage. The fix here keeps the desktop's
   ephemeral-image behavior consistent: live broadcasts
   only, no persistence. If we later want persistent
   images, it's a separate design problem.

## Audit table — does this fix reach every layer?

Layer | Field | Preserves | This fix
---|---|---|---
renderer broadcast | attachments | n/a (didn't exist) | ✅ added
IPC handler (main.js) | attachments | n/a | ✅ forwarded
sync-server payload | attachments | n/a | ✅ included
sync-server replay cache | attachments | n/a | ✅ included
mobile onChat handler | attachments | n/a | ✅ forwarded
mobile ChatMessage type | attachments | already exists | ✅ no change needed
mobile bubble renderer | attachments | already accepts | ✅ no change needed
desktop persistence (chatHistoryByAgentAndQuest) | attachments | n/a | ⏸ intentional non-fix
mobile history sync | attachments | n/a | ⏸ intentional non-fix (no source data)