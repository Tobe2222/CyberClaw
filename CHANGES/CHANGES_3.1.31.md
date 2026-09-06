# v3.1.31 — desktop-side greeting audio synthesis

## Why

The mobile app needs the wake greeting to play audio, but on some Android devices the device-side TTS engine is missing (status=-1 from OnInitListener). Rather than try to install a TTS engine on every device, route the synthesis through the desktop: piper TTS produces the audio once, streams it to the phone, and the phone caches the WAV for instant local playback on every wake event.

This pairs with CyberClaw Mobile v3.1.91.

## What changed

**`src/sync-server.js`** — new `request_greeting_audio` message handler:

```js
case 'request_greeting_audio': {
  if (!client.authenticated) return;
  const text = (msg.text || '').trim();
  if (!text) return;
  this._handleGreetingAudio(ws, text).catch(...);
  break;
}
```

`_handleGreetingAudio(ws, text)`:
- Strips emojis (same `stripEmojisForTTS` helper used for AI replies)
- Calls `localAI.synthesizeSpeech(cleanText, 'lessac')` — same piper voice used for AI replies
- Sends back `audio_response` tagged with `requestId: 'greeting'` and echoes the source `text` so the phone can route it to the greeting cache

The phone-side `SyncClient` splits the audio_response by `requestId` and re-emits on a separate `greeting_audio` channel so this doesn't interfere with the AI-reply playback handler.

## Files
- `src/sync-server.js` — new handler + `_handleGreetingAudio` helper
- `package.json` — 3.1.30 → 3.1.31