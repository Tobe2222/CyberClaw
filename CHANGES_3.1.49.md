# v3.1.49

Wire the mobile's v3.6.0 send-word trainer end-to-end on the
desktop side. The mobile (Tobe2222/Cyber_Claw_Mobile) has shipped
the send-word trainer UI in v3.6.0 and the trainer has been
sending `request_send_training` / `get_latest_send_training_result`
/ `read_send_model` messages to the desktop — but the desktop's
`sync-server.js` had no handlers for any of them. The trainer
hung in the "training" stage, the watchdog timed out, and the
user got a "training failed" error with no clue why.

This commit fixes the wire-protocol gap by adding the three
missing sync-server cases plus the matching training handler in
`main.js`. Mirrors the wake-training path (v3.1.40/v3.1.46)
exactly, just with `send_` prefixes and per-phrase working
directories (send words are user-level, not per-companion).

## Changes

### `src/sync-server.js`

Three new cases at the end of the `switch (msg.type)` block:

| Case | Behaviour |
|---|---|
| `request_send_training` | Validates `phrase` + `[{name, data}]` samples; emits `send_training_request` event that `main.js` handles. |
| `get_latest_send_training_result` | Returns the cached `send_training_result` (15 min TTL) for a phrase, or `{ok: false, noResult: true}`. Also returns the latest progress if a training is currently in flight. Mobile v3.6.0+ doesn't poll this yet, but the case is here for symmetry with wake/exit and for future reconnect-driven trainer UI. |
| `read_send_model` | Reads the trained .tflite from disk, returns it as base64 in `send_model_data` (mirrors `read_wake_model`). |

### `src/main.js`

Two additions:

1. **Send cache helpers** — same pattern as `lastWakeResult` /
   `lastWakeProgress` (v3.1.40/v3.1.46), but keyed by phrase
   instead of agentId. Exposed on the sync-server as
   `_getCachedSendResult(phrase)` and
   `_getLastSendProgress(phrase)`. 15-minute TTL.

2. **Send training handler** — `syncServer.on('send_training_request', ...)`
   that spawns the same `scripts/train_wake_phrase.py` script
   the wake path uses, in a per-phrase working directory
   (`~/.openclaw/cyberclaw/send-training/<phrase>/`). The
   script's `PROGRESS::` / `OUTPUT_TFLITE::` stdout lines are
   routed back as `send_training_progress` (broadcast to all
   authenticated clients) and `send_training_result` (to the
   originating client). Same args (`--n-samples 10000`, etc.)
   as the wake path. Same error handling.

## Wire-protocol summary

Mobile sends: `request_send_training`, `get_latest_send_training_result`, `read_send_model`.
Desktop sends back: `send_training_progress` (broadcast), `send_training_result` (origin), `send_model_data` (origin).

These match the wake-training message chain (`request_wake_training` →
`wake_training_progress` / `wake_training_result` → `read_wake_model` →
`wake_model_data`) one-for-one. The exit-training chain added in
the WIP on `feature/companion-improvements` (`request_exit_training` →
`exit_training_progress` / `exit_training_result` → `read_exit_model` →
`exit_model_data`) follows the same shape.

## What did NOT change

- The training script (`scripts/train_wake_phrase.py`) — it's
  generic; openWakeWord doesn't care whether the trained
  keyword is the wake word, exit phrase, or send word.
- The mobile side — Tobe2222/Cyber_Claw_Mobile v3.6.0+ has
  always sent these messages; the trainer UI was ready and
  waiting. After this commit, the trainer UI will work
  end-to-end without any mobile change.
- The wake / exit / greeting / exit-reply audio / remote-tool
  pipelines — all functional before, all functional after.

## Why v3.1.49 on the desktop, not a higher version

The desktop is at v3.1.48. v3.1.49 is the next patch bump.
The exit-training work on `feature/companion-improvements` is
still WIP (uncommitted) and is the natural next item — once
that's merged, that can be v3.1.50 or roll into a v3.1.49
amendment.

## Files changed

- `src/sync-server.js` — three new switch cases
  (`request_send_training`, `get_latest_send_training_result`,
  `read_send_model`).
- `src/main.js` — `lastSendResult` / `lastSendProgress` caches
  with TTL + `getCachedSendResult` / `setLastSendProgress` /
  `getLastSendProgress` helpers, and the
  `syncServer.on('send_training_request', ...)` handler that
  spawns the training script and routes progress / completion
  back to the mobile.
