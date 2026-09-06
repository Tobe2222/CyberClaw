# v3.1.48

## New feature: exit reply audio synthesis (sibling of wake greeting)

When the mobile voice mode closes, it can ask the desktop
to synthesize a short "goodbye" reply via piper TTS and
cache it locally. This is the desktop-side counterpart
to the mobile v3.2.29's `ExitReplyAudioCache` and the
new `requestExitReplyAudio` SyncClient method.

**Wire protocol:** same shape as the existing greeting
synthesis, only the request type and `requestId` differ.

- Request: `{ type: 'request_exit_reply_audio', text }`
- Response: `audio_response` with `requestId: 'exit_reply'`
  (sibling of `requestId: 'greeting'`).

**Implementation:** near-copy of `_handleGreetingAudio`.
Both go through `localAI.synthesizeSpeech(cleanText,
'lessac')` (the same piper voice the desktop uses for
AI replies and greetings). The only differences:

- Handler function name: `_handleExitReplyAudio` vs
  `_handleGreetingAudio`.
- requestId in the response payload: `'exit_reply'` vs
  `'greeting'`.
- Log messages: `[SyncServer] Exit reply audio …` vs
  `[SyncServer] Greeting audio …`.

**Reconnection fallback:** same pattern as
`_handleGreetingAudio` — if the original WS isn't open
when the synthesis finishes (brief network blip during
the 2-5s piper window), fall back to any currently-
authenticated client so the cache write isn't lost.

## Files

**Modified:**
- `src/sync-server.js` — new `case
  'request_exit_reply_audio'` in the WS message
  switch; new `_handleExitReplyAudio(ws, text)` method
  next to `_handleGreetingAudio(ws, text)`.

**Unchanged on this side:**
- `src/main.js` — no IPC handler change; the
  exit-reply synthesis is purely a sync-server concern.
- `src/local-ai.js` — reuses the existing
  `synthesizeSpeech(text, voice)` entry point.

## Verification

- `node --check src/sync-server.js` clean.
- Searched for the new symbols: 4 occurrences total
  (case + handler definition + 2 log lines), all in
  the same file.

## Coordination with mobile v3.2.29

The mobile side landed in v3.2.29 with:
- `ExitReplyAudioCache.ts` (cache module).
- `SyncClient.requestExitReplyAudio(text)` (sender).
- `greeting_audio` + `exit_reply_audio` listeners
  registered in `HomeScreen` (the desktop sends on
  the `audio_response` channel; SyncClient re-emits
  on the sibling channel).
- New "Exit reply" TextInput in Settings → 🎤 Wake
  Word, mirror of the existing Wake greeting input.

Both sides need to be on these versions for the
feature to work end-to-end. Either side alone will
work — the missing side just means synthesis never
fires and the phone falls back to local TTS.
