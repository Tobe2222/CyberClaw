# v3.1.34 — defensive timeouts on the voice transcription pipeline

## Why

Tobe tested wake mode and the voice input hung at "Transcribing..." for 3+ minutes before he closed out. The mobile recorder had its 30s hard cap, so the audio file wasn't enormous. whisper-cli in isolation works fine (1s on a 2s test clip), so the actual root cause wasn't identified — could be a malformed m4a, ffmpeg getting stuck on a particular file, or whisper hanging on edge-case input.

The defensive fix: bound how long transcription can take. A hung process that the user has to close out by force is worse than a transcription failure that says "sorry, try again".

## What changed

**`src/local-ai.js`** — two new timeouts in `transcribeAudio`:

1. **ffmpeg/sox conversion: 30s timeout.** Wrapped in a small `withTimeout(promise, ms, label)` helper. ffmpeg normally completes in <2s for any reasonable audio file. 30s is generous. If ffmpeg hits a malformed input and hangs, we move on instead of hanging forever.

2. **whisper-cli transcription: 60s timeout.** Implemented with `Promise.race` against the existing `execFileAsync` call. Whisper base.en on a 30s clip typically takes 10-15s on modern hardware. 60s leaves plenty of headroom for slow CPUs. On timeout, the error propagates to the caller (`onAudioInput`) which already has try/catch — the user sees a "Transcription timed out" message instead of an indefinite hang.

Both changes preserve existing error handling: timeouts throw errors that flow through the same `catch (execErr)` paths, with a descriptive message (`"Whisper timed out after 60000ms"`).

## What the user sees on hang

Before v3.1.34:
- "📝 Transcribing..." forever (until they kill the app)

After v3.1.34:
- "📝 Transcribing..." for at most ~60s
- Then a `Voice Transcription error: ...` log entry
- The mobile UI falls back to "ready for next wake" — wake mode stays alive

## Files
- `src/local-ai.js` — `withTimeout` helper, applied to ffmpeg + whisper calls
- `package.json` — 3.1.33 → 3.1.34

## Lessons

- **A "should-be-fast" operation needs a timeout, period.** whisper-cli is fast in the happy path. But "happy path" assumes well-formed input, healthy CPU, and not under load. Any one of those failing silently hangs the whole voice flow. The cost of a timeout is one extra line; the cost of no timeout is a user closing the app by force.
- **The error path is the user path.** Pre-v3.1.34, a hung whisper meant the user had to kill the app. Now they get an error message and can retry. The 60s timeout is annoying but recoverable; the indefinite hang was not.
- **`Promise.race` against a setTimeout is the simplest timeout pattern in Node 22.** No need for `AbortController` plumbing on every child process call — `Promise.race` works for any promise-returning function.