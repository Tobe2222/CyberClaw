# v3.2.78 — strip non-serializable `ws` from IPC payloads (treat/voice IPCs were silently failing)

## The bug

Right after the v3.2.77 fix landed (which finally wired
the `onArenaTreatPlaced` / `onArenaTreatEaten` callbacks
in the SyncServer constructor), The user tested again and
reported on 2026-08-06:

> "He still says the same."

The companion was still hallucinating about food instead
of reacting. Looking at the desktop log revealed:

```
[SyncServer] msg type=arena_treat_placed from Android Phone
Error sending from webFrameMain:  Error: Failed to serialize arguments
    at SyncServer.onArenaTreatPlaced (.../src/main.js:3282:32)
```

Every single treat event was failing to cross the IPC
boundary. The IPC `mainWindow.webContents.send(...)`
threw an exception that Electron caught and logged; the
renderer never received the `mobile-arena-treat-placed`
event; `promptCompanionReaction` never ran; no chat
reaction fired.

## Root cause

`main.js`'s `onArenaTreatPlaced` and `onArenaTreatEaten`
callbacks passed `meta` directly into the IPC payload:

```js
mainWindow.webContents.send('mobile-arena-treat-placed', {
  treat, meta,    // <-- meta contains a ws.WebSocket instance
});
```

`meta` came from `sync-server.js`'s `_handleMessage`,
which built it like:

```js
this.onArenaTreatPlaced(msg.treat || 'apple', {
  ws,                              // <-- non-serializable
  deviceName: client.name,         // <-- serializable
});
```

The `ws` object is a `ws` library `WebSocket` instance.
Electron's `webContents.send` uses structured-clone-like
serialization to hand arguments off to the renderer
process, and structured-clone can't serialize a
`WebSocket` (it's a host object with internal state and
event handlers). The send throws, Electron catches it,
logs the error, the IPC drops on the floor.

The mobile-chat handler at line ~3206 already strips
the `ws`:

```js
const { ws: _ws, ...serializableMeta } = capturedMeta || {};
mainWindow.webContents.send('mobile-chat', { text, agentId, meta: serializableMeta });
```

But the arena_treat and voice handlers didn't get the
same treatment when they were added.

## The fix

Three handlers updated to strip `ws` before IPC:

1. `onArenaTreatPlaced` — `src/main.js:3273`
2. `onArenaTreatEaten` — `src/main.js:3287`
3. `onVoiceTranscript` — `src/main.js:3232` (defensive;
   no error seen yet but same risk)

Each uses the same destructure pattern the chat handler
already uses.

## Files

- `src/main.js`: strip `ws` in 3 handlers, add comments
  documenting the pattern + linking to the chat handler
  precedent.
- `package.json`: bump `3.2.77` → `3.2.78`

## Lesson (a fourth time, different bug class)

**Any time you pass user-supplied data across an IPC
boundary, strip non-cloneable fields (`ws`, `EventEmitter`,
Functions, etc.) at the producer side, not the consumer.**

The producer is the one that knows which fields are safe.
The consumer (renderer) gets a `meta` object and assumes
it's a clean POJO. When structured-clone fails, the
error is logged in the main process, not the renderer —
the renderer never gets the event and the only trace is
the main-process error log, which is easy to miss.

**Mitigation idea (deferred):** add a tiny helper,
`safeIpcSend(channel, payload)`, that JSON-clones the
payload through `JSON.parse(JSON.stringify(...))` before
calling `mainWindow.webContents.send`. JSON-clone strips
functions, host objects, circular refs. Cost: a few µs
per IPC + losing any non-JSON-serializable values
(never used in practice for these payloads). Worth it
for the safety net. Add at the same time as the v3.10.79
one-shot warning fix from v3.2.77.

## Verification (for the user to confirm)

1. Restart the desktop (one more time).
2. Drop a treat on the mobile arena.
3. Expected: log shows `[mobile-treat] placed: <treat>`
   (the renderer's IPC handler running) followed by a
   `[chat:send]` for the reaction prompt.
4. Expected: clawsuu actually comments on the food in
   chat (not "Still no hamburger" anymore).
5. Expected: no more `Failed to serialize arguments`
   errors in the desktop log for treat events.