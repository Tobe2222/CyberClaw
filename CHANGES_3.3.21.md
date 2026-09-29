# v3.3.21 — Desktop: persist agent-image bubbles in chatHistory (companion to mobile v3.11.20)

## The bug (third iteration)

Tobe (2026-09-29 16:10, Discord #cyber-dev):

> "@Clawsuu Okey. But i am on 3.11.19 and as you see here
> there is no image so please fix what is needed"

The v3.3.20 / v3.11.19 fix from earlier today (broadcast
type-guard extension + mobile onChat attachments passthrough)
should have made screenshot bubbles appear on the mobile. The
realtime broadcast was confirmed in the desktop log:

```
[IPC] sync-broadcast-chat received: {
  agentId: 'clawsuu', ..., text: '', isUser: false,
  activeQuestId: 'o2jnjx8115uk', attachments: 1
}
[IPC] Message broadcast to mobile clients
```

But the bubble never showed up in Tobe's mobile chat. Mobile
was on v3.11.19 at the time (top-right of his chat showed
"v3.11.19").

## Root cause

The realtime broadcast landed during a window where the
mobile wasn't connected to the WebSocket, or the broadcast
frame was dropped during a reconnect storm. Look at the
desktop log around the broadcast:

```
478: [SyncServer] Client disconnected: 4effea0123a08493
479: [SyncServer] Client connected: 047b1774895f0c7d (mobile)
538: [IPC] sync-broadcast-chat received: { ..., attachments: 1 }
547: [IPC] _voiceReplyWs state: NULL
547: [LOG] 📡 Chat broadcast — isUser=false voiceWs=NULL
547: [IPC] Message broadcast to mobile clients
569: [SyncServer] Client disconnected: 047b1774895f0c7d
```

The mobile was connected (line 479), the broadcast went out
(line 547), but somewhere between the broadcast and the
bubble landing in Tobe's chat, it was lost. Most likely
cause: the WS frame arrived during the brief window between
connect (line 479) and the mobile's chat history request
resolving (the mobile wasn't ready to process chat messages
yet — only the `_recentAiMessages` replay cache had it).

The replay cache WOULD have sent the bubble on the next
reconnect, but Tobe's mobile didn't reconnect after that.

## The fix

Persist agent-image bubbles in `chatHistoryByAgentAndQuest`
on the desktop. This makes them a durable artifact that
rides along on every `chat_history` / `agent_history`
response — not just a transient WS frame that can be lost
during reconnects.

Specifically: in `app.js` `addChatMsg`:

1. Added `agent-image` to the persistence type guard
   (was previously `agent` / `user` only).
2. Built an `attachments` array from the desktop-internal
   `{ dataUri, target, ... }` shape, mirroring the same
   shape the mobile renders for outbound user-image sends.
3. Included the attachments in BOTH the flat `chatHistory`
   push and the per-quest bucket push.

Size guard: attachments >200KB base64 get a thumbnail-only
fallback (50KB base64 + `thumbOnly: true` + `filePath`).
This keeps localStorage safe under the 200-entry cap.

## Companion fix on mobile (v3.11.20)

The mobile's `onAgentHistory` handler (HomeScreen.tsx
~4749) was stripping `attachments` when mapping the
desktop's history response to ChatMessage objects. Fixed
to preserve `attachments` on both the per-quest buckets
path and the legacy flat-`messages` fallback path. Same
fix pattern as the v3.11.19 realtime path (HomeScreen.tsx
~3700).

## Why "durable artifact, not transient WS frame"

The MEMORY.md "chat-projection decay modes" list has
reached layer 12 today. Each layer is a new symptom that
emerges as we add caches, refs, mirrors, and persistence
to the chat pipeline. Layer 1-11 were projection races,
remount fallbacks, hydration fallbacks, null conflations.
Layer 12 is:

**A broadcast is a network event, not a state event.**

If the user has a flaky network — sleep, app-switch,
brief disconnect, mobile reconnected at the wrong time —
the WS frame can be lost. The desktop has no way to know
the mobile missed it (the broadcast loop is fire-and-
forget; the mobile doesn't ACK). Persisting in the bucket
turns the broadcast into state that survives the network
gap: every chat_history / agent_history response carries
the bubble forward, even if the original realtime
broadcast was lost.

This is the same architectural class as the v3.3.19
"broadcast is a hint, not a directive" lesson, but
specifically about **delivery guarantees**: a hint that
arrives in time is fine; a hint that arrives late needs
to be backed by durable state.

## Lessons (cross-cutting)

1. **Persistence as a delivery guarantee.** Real-time
   broadcast over WebSocket is best-effort; it's not
   reliable. Anything the user "should" see in their chat
   history needs to be in the bucket that gets served
   on every history sync. Agent-image bubbles were not
   — they lived only in the renderer's DOM and the
   realtime broadcast. Fixed by persisting in
   `chatHistoryByAgentAndQuest`.

2. **Belt and braces for new visual types.** When adding
   a new bubble type (agent-image was new in v3.2.83),
   the audit needs to check: persistence? history sync?
   replay cache? mobile history handler? mobile realtime
   handler? Every layer that "handles" the bubble. We
   did this audit at v3.3.20 but missed the persistence
   step. Today's fix closes that gap.

3. **Size-aware persistence is a real constraint.** The
   desktop's localStorage is 5-10MB cap, with a 200-entry
   per-bucket cap. Inline base64 screenshots (50KB-1MB)
   blow that cap. The 200KB inline + thumbnail-only
   fallback is a compromise: full inline for small
   screenshots, thumbnail + file path for big ones. The
   realtime broadcast still carries the full base64, so
   when the mobile IS connected they get the full image.

## Audit table

Layer | Field | Preserves | This fix
---|---|---|---
renderer broadcast | attachments | n/a | ✅ v3.3.20
IPC handler (main.js) | attachments | n/a | ✅ v3.3.20
sync-server payload | attachments | n/a | ✅ v3.3.20
sync-server replay cache | attachments | n/a | ✅ v3.3.20
desktop addChatMsg persistence | attachments | n/a | ✅ v3.3.21
chatHistory flat mirror | attachments | n/a | ✅ v3.3.21
chatHistoryByAgentAndQuest | attachments | n/a | ✅ v3.3.21
chat_history response | attachments | yes (forwarded) | ✅ already
agent_history buckets | attachments | yes (forwarded) | ✅ already
mobile onChat (realtime) | attachments | n/a | ✅ v3.11.19
mobile onChatHistory | attachments | n/a | ✅ already
mobile onAgentHistory | attachments | n/a | ✅ v3.11.20
mobile bubble renderer | attachments | yes | ✅ already