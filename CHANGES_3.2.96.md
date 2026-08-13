# v3.2.96 — desktop TTS voice now drives the greeting/working/exit-reply syntheses sent to the mobile

## Bug

Tobe (post-v3.2.95, on mobile v3.10.165): the new mobile voice picker sends
`set_tts_voice` to the desktop, the desktop writes
`localStorage.cyberclaw-settings.ttsVoice`, the desktop's main reply path
(main.js:5200) reads it back when synthesizing the AI-response audio —
that worked. But the three mobile-cache paths in `src/sync-server.js`
hardcoded `'lessac'` for the piper synthesis call:

- `_handleGreetingAudio` at line 1780
- `_handleWorkingAudio` at line 1844
- `_handleExitReplyAudio` at line 1876

Result: even after picking 'kristin' (or any non-lessac voice), the mobile
caches got lessac audio. The mobile's per-(phrase, voice) cache (new in
mobile v3.10.166) then played back that lessac WAV on every subsequent
wake.

## Fix

`src/sync-server.js`: new `_getTtsVoice()` helper that reads the desktop's
`localStorage.cyberclaw-settings.ttsVoice` via the mainWindow's
webContents (same pattern main.js uses at line 5200 for the AI-reply
synthesis). All three synthesis calls now use
`await localAI.synthesizeSpeech(cleanText, await this._getTtsVoice())`.

The `audio_response` payload (greeting / working_speech / exit_reply)
now echoes the resolved `voice` field so the mobile's per-(phrase,
voice) cache write uses the same key the desktop synthesized against.

Defaults to 'lessac' on any failure (missing mainWindow, renderer not
ready, localStorage missing) — same default the main reply path uses.

## Files changed

- `src/sync-server.js` — new `_getTtsVoice()`; 3 hardcoded `'lessac'`
  calls replaced with `await this._getTtsVoice()`; 3 `audio_response`
  payloads now include `voice: resolvedVoice`.
- `package.json` 3.2.95 → 3.2.96.

## Companion release

Mobile v3.10.166. Both land together — if the desktop is still on
v3.2.95, the mobile's per-(phrase, voice) cache key matches but the
synthesized audio is still lessac, so the bar shows the new voice's
count but the WAV plays lessac. The fallback `getCurrentVoiceIdForCache`
on the mobile still picks a sensible default ('lessac') so a single-
sided upgrade doesn't crash; only the audio output is wrong.