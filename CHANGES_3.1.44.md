# v3.1.44 — Wake trainer: broadcast progress events to all authenticated clients

After v3.1.43 added fine-grained PROGRESS:: events from
inside the augment/train substeps, the user re-tested and
the phone bar STILL didn't move. The desktop log showed tqdm
bars and PROGRESS:: events firing (when the parent was
spawned manually), but the phone stayed at 30% "Sending
samples to desktop...".

**Root cause:** main.js was sending PROGRESS:: events to
ONLY the originating WebSocket via `syncServer._send(ws, ...)`:

```js
syncServer._send(ws, { type: 'wake_training_progress', agentId, ...payload });
```

If the phone's WebSocket had disconnected (Android killed
the background app, brief wifi blip, etc.) between when it
sent the `request_wake_training` and when the first
PROGRESS:: came back, the dead `ws.readyState` was no
longer `OPEN` and `_send` silently no-op'd. All subsequent
progress events were lost.

**The fix:** use `syncServer._broadcast(...)` instead of
`syncServer._send(ws, ...)`. Broadcast sends to all
authenticated clients, so a reconnected phone picks up
progress events automatically. The trainer ignores
progress events for other agents, so we don't have to
filter by agentId on the desktop.

Also broadcast the `wake_training_result` for the same
reason — if the originating phone has dropped, a
reconnected phone still gets the final answer.

**Diagnostic that pointed at this:** the desktop log showed
zero PROGRESS:: events reaching main.js even though the
python parent was emitting them and `proc.stdout.on('data')`
was reading `[train-OWW]` lines fine. The missing piece
was: the phone's ws was dead, the _send was no-op'ing
silently, and we weren't seeing the failure because
_send's failure mode is silent. A small instrumentation
print (`console.log('PROGRESS_FIRED: ...')`) confirmed that
the parse + broadcast code was reached.

**Lesson:** when forwarding events over a request/response
socket, distinguish between "events that need to be
delivered to a specific client" (chat replies, form
submissions) and "events that should reach whoever is
listening" (progress, state changes). The latter should be
broadcast, not direct-send. Direct-send to a stale ws is
silently lost; broadcast survives a reconnect.

**Files:**

- `src/main.js` — wake_training_progress (and
  wake_training_result on the close handler) now use
  syncServer._broadcast instead of syncServer._send(ws, ...).
- `package.json` — 3.1.43 → 3.1.44

**No mobile-side change required.** The phone's SyncClient
already handles `wake_training_progress` (via the default
case in `_handleMessage`, which re-emits any unknown
msg.type as an event).