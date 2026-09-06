# v3.1.40 — cache the most recent wake-training result for reconnecting phones

## Bug

After v3.1.39 fixed the wire format, the user successfully recorded 6
samples, hit Train, and watched the progress bar hit 30%
("Sending samples to desktop...") and freeze there. The training
was actually running on the GPU (TTS synthesizing 10000
positive variants), but the phone's WebSocket had dropped, so:

- Progress events had nowhere to land on the phone
- The final training result would be sent to a dead socket
- The user had no way to know whether to re-record or wait

The training that DID finish on the desktop was effectively
wasted from the phone's perspective.

## Root cause

Wake training takes 2-10 minutes (10K-sample TTS synthesis on
the RTX 2070). That's a long time for an Android WebSocket to
hold open — the OS can background-kill the socket during a
doze, network change, or app switch, even with the 10s ping
keepalive we already have. The training result is fire-and-
forget to the original WebSocket; if that socket is gone, the
result evaporates.

## Fix

Cache the most recent `wake_training_result` (ok or error) per
agent for 15 minutes. A reconnecting phone can now ask for the
cached result and continue from there.

**New wire message (mobile → desktop):**
```ts
{type: 'get_latest_wake_training_result', agentId}
```

**Desktop response:** replays the cached `wake_training_result`
if there is one, or sends:
```ts
{type: 'wake_training_result', ok: false, noResult: true, error: 'no recent wake training result for this agent'}
```

The `noResult` flag tells the phone "nothing to do, stay on the
idle screen" so it doesn't show a fake error.

## Files

- `src/main.js` — `lastWakeResult` map (15-min TTL), cache on
  every training outcome (success + both error paths), expose
  `syncServer._getCachedWakeResult` for the sync-server
- `src/sync-server.js` — new `get_latest_wake_training_result`
  WebSocket case; emits `noResult: true` when nothing is cached
- `package.json` — 3.1.39 → 3.1.40

## Mobile counterpart

Released as CyberClaw mobile v3.2.6 — the trainer's mount effect
now asks the desktop for the latest cached result (only when
the trainer is in the `idle` state, so a fresh training isn't
conflated with a previous one).

## Lesson

Long-running jobs (multi-minute) on a request/response socket
need a "polled status" fallback. A fire-and-forget design
assumes the connection will hold for the full duration — a
reasonable assumption for sub-second calls, not for
10-minute ones. The cheap fix is a server-side result cache +
client-side poll-on-reconnect; the proper fix is a job ID +
status endpoint. We went with the cheap fix because the
training frequency is "once per companion" and the result has a
natural TTL (15 min).