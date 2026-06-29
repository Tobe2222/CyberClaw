# v3.1.45 — Wake trainer: don't let the payload's `type` field overwrite the wire type

After v3.1.44 broadcast progress events, Tobe re-tested and
the phone bar STILL didn't move. The logging card on the
mobile side (v3.2.9) showed `Last event: 113s ago` (red) and
zero entries in the event log. The desktop log showed tqdm
bars flowing but zero `PROGRESS::` lines captured.

I wrote a fake WebSocket client using the saved device token
and ran a test training. The client received progress events
with `msg.type === 'progress'` — not `wake_training_progress`.
The trainer listens for `wake_training_progress` and ignores
everything else.

**Root cause:** the python parent's `emit_progress` emits a
payload with `type: 'progress'` (an internal field used by
the parent's own logging). My v3.1.44 code in main.js did:

```js
syncServer._broadcast({ type: 'wake_training_progress', agentId, ...payload });
```

The `...payload` spread runs AFTER `type: 'wake_training_progress'`,
so payload's `type: 'progress'` overwrites it. The phone
receives `{type: 'progress', agentId, stage, percent, ...}`
which the trainer's `sync.on('wake_training_progress', ...)`
filter drops.

**Fix:** strip the redundant `type` field from the payload
before spreading:

```js
const { type: _ignore, ...fields } = payload;
syncServer._broadcast({ type: 'wake_training_progress', agentId, ...fields });
```

Same fix for the renderer's `webContents.send` (so the
desktop's own progress UI updates too).

**Diagnostic that pointed at it:** writing a Node.js
WebSocket test client using the saved device token from
`~/.openclaw/cyberclaw/sync-config.json` pairedDevices
array. The client printed every message it received and
the type was clearly `progress` not `wake_training_progress`.
Without that test client I'd still be guessing.

**Lesson:** when spreading objects into a property bag, the
LATER property wins. If the source object has a key with the
same name as your target's, the spread overwrites the target
value. Always either:
- Destructure the colliding key out: `const { type, ...rest } = payload`
- Use explicit assignment: `broadcast({ type: 'wake_training_progress', agentId, stage: payload.stage, percent: payload.percent, message: payload.message, ts: payload.ts })`
- Rename the source field: `emit_progress(...) { payload.event_type = 'progress'; delete payload.type; ... }`

The destructure-and-rest pattern is the cleanest because it
makes the intent explicit: "use everything from payload
EXCEPT this one field".

ALSO: when debugging wire-format bugs, build a fake client
that just dumps every message. It's the cheapest way to
verify what's actually arriving on the wire vs. what you
THINK is arriving. Two minutes of writing a test client
beats an hour of reading code.

**Files:**

- `src/main.js` — destructure `{ type: _ignore, ...fields }`
  from the payload before broadcasting / sending to renderer.
- `package.json` — 3.1.44 → 3.1.45

**No mobile-side change required.** v3.2.9 already listens
for `wake_training_progress` correctly — it just wasn't
receiving any events with that type field.