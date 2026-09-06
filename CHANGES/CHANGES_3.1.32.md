# v3.1.32 — handle WS reconnection during greeting audio synthesis

## Why

In the v3.1.91 testing, the desktop synthesized and sent 32768 chars of greeting audio back to the phone — but the phone's voice log still showed `no cached audio, requesting synthesis` and `no-tts-engine`. The audio response was sent to a WebSocket that the phone had already closed and reconnected from during the 2-5s synthesis window.

The v3.1.31 handler only checked the original `ws.readyState === OPEN`. If the WS had reconnected (even briefly), the audio response was silently dropped — the desktop logged `Sent greeting audio (X chars) to mobile` but the message never reached the app.

## What changed

**`src/sync-server.js`** — `_handleGreetingAudio` now falls back to any currently-authenticated client if the original WS is closed, same pattern as the existing `sendAudioResponse` method. Adds a log line `Sent greeting audio (X chars) to reconnected mobile` so it's visible whether the original or fallback path was used.

## Files
- `src/sync-server.js` — fallback path in `_handleGreetingAudio`
- `package.json` — 3.1.31 → 3.1.32