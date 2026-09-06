# v3.1.39 — wake training: expect base64 audio, not file paths

## Bug

Mobile v3.2.4 fixed the recording crash. Mobile v3.2.5 was then
blocked by:

```
sample not found: /data/user/0/com.cyberclawmobile/cache/wake_sample_1782646891464.m4a
```

The wire format had been `samplePaths` — absolute file paths on
the phone. The desktop did `fs.existsSync(p)` and reported not
found (correctly — those paths only exist on the Android device).

## Fix

Wire format is now:

```ts
{type: 'request_wake_training', samples: [{name, data}]}
```

where `data` is base64-encoded `.m4a` audio. Three call sites
updated to decode + write into the training dir:

- `src/main.js` — `agent:train-wake-phrase` IPC handler
- `src/main.js` — sync-server `wake_training_request` listener
- `src/sync-server.js` — `request_wake_training` WebSocket case
  (validates and forwards to main.js)

`src/preload.js` updated to match the new IPC signature.

## Files

- `src/main.js` — IPC handler + sync listener now decode + write
- `src/sync-server.js` — accept `{samples}` over WebSocket
- `src/preload.js` — preload wrapper updated
- `package.json` — 3.1.38 → 3.1.39

## Mobile counterpart

Released in tandem as CyberClaw mobile v3.2.5 — encodes each
sample with `RNFS.readFile(path, 'base64')` before sending.

## Lesson

Cross-process wire formats over IPC/WebSocket need to ship the
*data*, not references to wherever the producer happens to keep
it. The default for any "send a file to another process" flow
should be: read the bytes, base64 them if the transport is text,
decode and write on the other side. The desktop never had access
to `/data/user/0/...` on the phone — that wire format was
wrong from the moment we wrote it.