# v3.2.9 — Mobile chat history shape mismatch (agent_history)

Tobe (on mobile v3.10.31, desktop v3.2.8):

> "i also noticed that that conversation is not in the chat for some
> reason. All voice mode chats should appear in the chat aswell."

## Root cause

The desktop's `ipcRenderer.on('mobile-request-agent-history', ...)`
handler (src/js/app.js ~3958) was sending back the raw
`chatHistoryByAgent[agentId]` entries, which are stored in the
internal desktop shape:

```js
{type: 'user'|'agent'|'system', text, name, emoji, ts}
```

The mobile's `onAgentHistory` handler (src/screens/HomeScreen.tsx
~2115) does:

```js
const loaded = msg.messages.map((m: any) => ({
  id: `hist-${m.ts}-...`,
  text: m.text,
  isUser: m.isUser,   // ← undefined for the legacy shape
  agentId: m.agentId || aid,
  agentName: m.agentName,
  ts: m.ts,
}));
```

So all messages came back with `isUser: undefined`. The mobile's
`renderMessage` guard (line 2573) explicitly rejects messages
where `typeof item.isUser !== 'boolean'`:

```js
if (!item || typeof item.text !== 'string' || !item.ts ||
    typeof item.isUser !== 'boolean') {
  return <View />;   // ← silent drop
}
```

Messages from the agent_history path rendered as empty `<View />`
bubbles. The user saw an empty chat even though the desktop
had the messages.

## Why YESTERDAY's messages appeared

Messages from the typed-message path and the legacy `chat_history`
flow were already wired with proper `isUser: true/false` values
(via the chat event broadcast payload and the legacy flat-history
loader), so they passed the guard. Only the agent_history path was
broken — and agent_history is what carries voice-mode sessions
(captured while WakeModeScreen was the active screen, so HomeScreen
couldn't persist them locally; the only persistence happens via
the desktop's chatHistoryByAgent, replayed through agent_history
on next HomeScreen mount).

## Fix

Two layers:

1. **Desktop (v3.2.9)** — `mobile-request-agent-history`
   handler normalizes each entry to `{text, isUser, agentId,
   agentName, ts}` before sending. `type === 'user'` →
   `isUser: true`; everything else → `isUser: false`.
   `name` (the desktop's display-name field) becomes
   `agentName` and `agentId`. This is the source-of-truth fix.

2. **Mobile (v3.10.33)** — `onAgentHistory` in HomeScreen
   adds a defensive fallback: if the incoming message has no
   `isUser` but has `type`, derive `isUser` from `type === 'user'`.
   Same for `agentId`/`agentName` falling back to `name`.
   This makes the mobile work correctly against older
   desktops that don't have this fix yet, so a user
   updating only one side still gets the right behavior.

## Why both layers

- **Desktop fix** is the source-of-truth change. Once
  shipped, both v3.2.9+ desktop and any mobile will work
  correctly via agent_history.
- **Mobile fallback** is defense in depth. If someone
  updates only the mobile (or only the desktop), the
  cross-version pairing still works. Without the mobile
  fallback, a v3.2.8 desktop talking to a v3.10.33
  mobile would still drop the chat history.

## Files

- `src/js/app.js` (`mobile-request-agent-history` IPC handler)
- `package.json` 3.2.8 → 3.2.9