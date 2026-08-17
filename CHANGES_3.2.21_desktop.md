# 3.2.21 (desktop) — fix: audio→LLM pipeline was broken

## Reported by the user (via mobile voice mode)

After v3.2.19 / v3.2.20 mobile, voice mode opens correctly,
greeting plays, recording works, audio is sent — but the
mobile stays on "Transcribing..." forever. Mobile's
transcribing timeout fires after 30s, starts a new
recording turn, same thing happens. The mobile's voice log
shows: silence detected → sent → no response → retry, in
an infinite loop.

## Root cause

`onAudioInput` in `src/main.js` (the audio-input IPC handler
that the sync-server calls when the mobile sends `audio_input`)
**was missing the `mobile-voice` IPC send** to the renderer.

The renderer's `ipcRenderer.on('mobile-voice', ...)` handler
(src/js/app.js:3794) is what feeds the transcript to the LLM
via `window.sendChatMessage(prompt)`. Without that IPC send,
the transcript never reaches the LLM, so the LLM never
replies, so no `chat_message` event is broadcast back to
the mobile, so no `_voiceReplyWs` audio response goes back.

Net effect: mobile sits on "Transcribing..." forever, exactly
what The user saw.

This send used to exist. It was added in commit c275eae
(2026-04-14) when the sync server was first built. At some
point during one of the v3.1.x wake-training refactors it
got dropped — probably when the onAudioInput / onVoiceTranscript
split happened and someone assumed onVoiceTranscript was the
newer path. The mobile's audio_input handler is the path
that actually runs in v3.x.

### Evidence

Direct WebSocket probe with the saved mobile device token:

```
Connected. Authenticating as Android Phone
Auth: OK
Sending audio_input (mime=audio/wav)...
[+32.261s] Msg: voice_received            ← desktop ack
[+33.272s] Msg: voice_transcript_result   ← desktop sends transcript
                                          ← STOPS HERE — no chat_message,
                                            no audio_response, no LLM reply
```

Without `mobile-voice` IPC, the transcript is a dead end.
The LLM never sees it.

## Fix

Re-added the `mobile-voice` IPC send in `onAudioInput`
after a successful transcription, alongside the existing
`sendTranscript` (which sends `voice_transcript_result` to
the mobile WS so the mobile can display the user's text).

Both paths are now active:
1. Mobile WS receives `voice_transcript_result` (existing,
   works fine for the mobile to display the user's text)
2. Renderer receives `mobile-voice` IPC, which calls
   `sendChatMessage(prompt)` to feed the LLM

After the LLM replies, `sync-broadcast-chat` IPC fires
`broadcastChatMessage(isUser=false)` (sends `chat_message`
to mobile) AND the existing `_voiceReplyWs` audio-response
flow sends TTS audio back. Both paths were already wired
correctly — they just weren't being triggered because the
LLM was never getting the input.

## Files

- `src/main.js` — `onAudioInput` handler now also sends
  `mobile-voice` IPC to the renderer after successful
  transcription (with `context: ''` since the audio
  path doesn't pre-supply context like the older
  `onVoiceTranscript` path did)
- (this CHANGES file)

## How to deploy

The desktop CyberClaw Electron app loads main.js once at
startup. The current running process (PID 21463) is running
the OLD code. **the user needs to close the desktop CyberClaw
and reopen it** to pick up this fix. After restart, voice
mode should work end-to-end.

## Lessons

- **Symptom lies about layer.** The mobile log shows
  "Sent, waiting..." → "Transcribing..." forever. That
  *looks* like a mobile bug. It's actually a desktop bug
  that happens to manifest on the mobile. Always check
  BOTH sides of the WebSocket when one side seems stuck.
- **WebSocket probing is the right diagnostic tool.**
  Pairing with the saved device token, sending `audio_input`,
  watching what comes back — that took 10 seconds and gave
  a definitive answer (`voice_transcript_result` was the
  last event, never followed by anything else). Faster than
  reading the entire pipeline.
- **"Removed in a refactor" bugs hide in git archaeology.**
  The original `mobile-voice` send was added in the very
  first sync-server commit (c275eae, April 14). It got
  dropped at some point during the v3.1.x wake-training
  work. `git log -S` found it immediately. Worth doing
  before assuming "the code never had this" — the answer
  might be "it had it and someone deleted it".
- **Sync handlers split = sync bugs.** `onVoiceTranscript`
  and `onAudioInput` are sibling handlers in main.js, and
  the rendering side (app.js:3794) only listens for
  `mobile-voice` (set by `onVoiceTranscript`). The mobile
  sends `audio_input` which calls `onAudioInput`. So the
  LLM path only works if `onAudioInput` ALSO sends
  `mobile-voice` to the renderer. The two paths need to
  share that IPC send or the audio_input flow goes
  nowhere. After this fix both handlers consistently
  emit the same IPC.