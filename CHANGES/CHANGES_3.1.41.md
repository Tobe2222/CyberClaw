# v3.1.41 — Wake trainer: resample synthetic clips, clear stale cache on new run

v3.1.40 cached the last `wake_training_result` per agent so a phone
that lost its WebSocket mid-training could pick up the cached result
on reconnect. The phone-side v3.2.7 ships the complementary fixes.
This release ships the desktop-side pair.

## Two desktop-side bugs, both real

### Bug 1: synthetic clips at 22050 Hz poison the cached training set

When a user re-trains a wake word, the orchestrator
(`scripts/train_wake_phrase.py`) short-circuits Piper TTS clip
generation with:

```
WARNING:root:Skipping generation of positive clips for training, as ~10000 already exist
```

That's fine if all the cached clips are at 16 kHz. But
piper_sample_generator changed its output sample rate at some
point, and 2,520 of the 24,001 cached clips ended up at 22050 Hz.
openwakeword's `augment_clips` does:

```python
clip_data, clip_sr = torchaudio.load(clip)
...
if clip_sr != sr:
    raise ValueError("Error! Clip does not have the correct sample rate!")
```

and crashes the moment it hits one. The training process exits 1,
the phone gets a cached `ok: false, error: 'training process exited
1'`, the phone's v3.2.6 mount-time recovery tries to pick it up —
and the inverted `noResult` guard in the trainer dropped the
result on the floor (fixed in v3.2.7).

`scripts/train_wake_phrase.py` now calls a new
`_normalize_clip_sample_rates(output_dir, model_name)` helper
right before the `--augment_clips` substep. It walks the four clip
directories openwakeword reads from
(`<output>/<name>/{positive_train, positive_test, negative_train,
negative_test}`), finds any non-16 kHz WAV, and resamples it in
place. Idempotent: a no-op if everything's already at 16 kHz, with
a `[train] All clips already at 16000 Hz` log line so you can see
it ran.

### Bug 2: stale cached error leaks into a fresh training run

v3.1.40's `lastWakeResult` map is set on completion (success or
error) and never cleared. If a user starts a fresh training, the
phone's watchdog might re-poll before the desktop's new training
has had time to cache a new result — and get back the OLD error
from the previous failed run, convincing the phone that the new
training also failed.

`src/main.js` now does `lastWakeResult.delete(agentId)` at the
start of every `wake_training_request`, so the phone always sees
"no cached result" (`noResult: true`) until the new run completes.

The phone-side `_onResult` then correctly bails out on `noResult`
and stays on whatever stage the new training is actually in.

## Lesson

The "fire and forget with a mount-time poll" pattern for
multi-minute jobs needs three pieces working in lockstep, not two:

1. The producer caches the result on every outcome.
2. The consumer polls on mount, in case it was the one that
   missed it.
3. The consumer also re-polls while the UI is mounted but the
   producer hasn't sent a progress event in a while.

We had (1) and (2) but not (3), and the consumer was also
silently dropping (1)'s output. The fix on the consumer side
(v3.2.7) and the producer side (this release) are independent.
Neither alone is sufficient.

Also: always clear the cache on the producer side at the start
of a new run, not just on completion. A "no recent result for
this agent" is the correct answer to "did a previous run
finish?" when a new run is in flight.

## Files

- `scripts/train_wake_phrase.py` — new
  `_normalize_clip_sample_rates()` helper, wired in before
  `--augment_clips`.
- `src/main.js` — `lastWakeResult.delete(agentId)` at the start
  of every `wake_training_request`.
- `package.json` — 3.1.40 → 3.1.41
