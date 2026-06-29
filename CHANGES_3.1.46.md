# v3.1.46 — Wake trainer: replay the latest PROGRESS to a phone that lost its WebSocket mid-training

After v3.1.45 fixed the payload.type spread bug, Tobe
re-tested and STILL saw the same symptom. The phone
showed "Last event: 38s ago" (red) and the desktop log
showed the [train] and [train-OWW] lines flowing but
zero `PROGRESS::` events from main.js's handler.

I added aggressive debug logging (`PROGRESS:` and
`BROADCAST:` console.logs in the handler) and ran a test
client with a fake wake_training_request. The desktop
log showed everything working: `PROGRESS:` lines
firing, `BROADCAST: 1/1 clients open` — but **1/1 meant
the test client was the only connected client. The
phone was NOT connected.**

**Root cause:** the phone's WebSocket had died between
when Tobe pressed Train at 16:13 and when the first
PROGRESS event fired at 16:13:05. The phone's
SyncClient auto-reconnects, but a NEW WebSocket has a
new identity. The desktop's `_broadcast()` iterates
`this.clients` and skips wses that aren't OPEN, so
every PROGRESS event fired while the phone was
disconnected was lost. By the time the phone
reconnected, the broadcast was already happening to
empty air.

The v3.2.9 logging card on the phone correctly
surfaced this as "Last event: 38s ago (red)" — the
phone NEVER received a wake_training_progress event
during the entire training run.

**Fix:** track the latest wake_training_progress per
agent in main.js. When the phone's watchdog polls
`get_latest_wake_training_result` (every 20s while
training is active), the desktop also sends the
cached latest progress. The phone's `_onProgress`
handler re-paints the bar to where it actually is.

Implementation:
- main.js: new `lastWakeProgress` Map + `setLastWakeProgress`
  + `getLastWakeProgress` functions, exposed via
  `syncServer._getLastWakeProgress`. Called on every
  PROGRESS broadcast. Cleared at the start of every new
  training (alongside the existing result-cache clear)
  so we don't replay stale progress from a previous run.
- sync-server.js: in the `get_latest_wake_training_result`
  handler, before sending the cached result, send the
  cached latest progress if it's less than 5 min old.

**Why 5 minutes:** the wake_training_progress events
fire every 1-2 seconds during the active substeps. The
gap between substeps is at most 30-60s (DNN training
without intermediate progress). A 5-minute TTL is
generous — anything older than that means the training
has either finished (the result cache takes over) or
genuinely stalled.

**Lesson:** `_broadcast()` is the right primitive for
long-running events that should reach any active
listener, but it's not enough. A listener that was
disconnected and just reconnected has missed every
broadcast that happened while it was gone. The producer
side needs to remember the latest state and surface it
on demand — either via a "replay" call or by attaching
to the next "poll for result" message. The phone's
20s watchdog poll was the perfect vehicle: I just
needed to attach the latest progress to the reply.

ALSO: the v3.2.9 logging card saved the day again. It
showed `Last event: 38s ago (red)` — without that, I'd
have kept chasing the wire format, not the connection
state. The phone-side diagnostic was right; the bug
was on the desktop side (broadcasting to a dead ws).
Color-coded time-since-last-event > perfect stdout
hunting.

**Files:**

- `src/main.js` — new `lastWakeProgress` Map +
  `setLastWakeProgress` + `getLastWakeProgress`, exposed
  via `syncServer._getLastWakeProgress`. Called on
  every PROGRESS broadcast. Cleared at the start of
  every new training. Debug logging from v3.1.45
  removed.
- `src/sync-server.js` — `get_latest_wake_training_result`
  handler now also sends the cached latest progress
  if it's less than 5 min old. New
  `this._lastWakeProgress` Map in the constructor.
- `package.json` — 3.1.45 → 3.1.46

**No mobile-side change required.** The phone's existing
`_onProgress` handler already processes the message
correctly; it was just never receiving any. Now it
will via the watchdog's `get_latest_wake_training_result`
poll.