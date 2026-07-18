# v3.2.13 — openWakeWord Gain augmentation: symmetric range for volume-invariant wake models

## What

Trained wake models were amplitude-biased. They fired reliably only
in the narrow volume band the user happened to record their 6 samples
in. Whisper, shout, or call from across the room — all attenuated
relative to training — were missed or detected unreliably.

Tobe (verbatim, 2026-07-18 17:26 GMT+2): "i also want it to be
more dependent on the sounds, not volume, so i can whisper and shout
to it. Or if the phone is further away i would like it to pick up so
i can call to it"

## Why

openWakeWord's `augment_clips` (in `openwakeword/data.py`,
`augment_clips`, lines ~649 and ~666) constructs its
`torch_audiomentations` Compose with:

```python
torch_audiomentations.Gain(max_gain_in_db=0, p=augmentation_probabilities["Gain"]),
```

Combined with the Gain class's default `min_gain_in_db=-18`, that
pins the augmentation range to `[-18, 0]` dB — **attenuation only**.
Newly trained wake models therefore never see amplified positives,
and end up amplitude-biased.

This is upstream in openWakeWord (a misconfig in their default
augment_clips Compose), not in our code. We inherit the
consequence.

## Fix

`scripts/_oww_onnx_tflite_patch.py` gains a new function
`_apply_gain_patch()`. It runs at the start of every openwakeword
subprocess (via `_run_openwakeword_substep` in
`train_wake_phrase.py`), reads the source of
`openwakeword.data.augment_clips` via `inspect.getsource`,
string-replaces `max_gain_in_db=0` → `max_gain_in_db=18` (the
symmetric counterpart to the unchanged `min_gain_in_db=-18`), and
re-execs the function in the openwakeword.data module namespace.

Restored symmetric `[-18, +18]` dB Gain range. Trained models now
see the full volume distribution, including positive gain (with
int16 quantization as a soft cap at ~+6dB for typical-volume
inputs, which prevents heavily clipped positives).

Idempotent — a second call is a no-op. The patch is applied
in-memory only; no upstream files are modified.

## Verification

`scripts/_oww_onnx_tflite_patch.py`'s `_apply_gain_patch()` tested
end-to-end with a 1-second 440Hz sine tone as the input clip:

- UNPATCHED (original openwakeword): 20 trials, all deltas in
  `[-18, 0]` dB, mean ≈ -10 dB, **0 amplifications**.
- PATCHED (this fix): 20 trials, deltas span `[-18, +6]` dB, mean
  ≈ -2 dB, **12/20 trials are amplifications**.

Volume invariance achieved: the same model now sees positives at
varied volumes during training, and should fire across the full
range at inference time.

## Files

- `scripts/_oww_onnx_tflite_patch.py` — new `_apply_gain_patch()`
  function, called from `main()` before the openwakeword.train
  exec. Idempotent guard via `_oww_gain_patched` attribute.
- `package.json` — version 3.2.12 → 3.2.13.

## Mobile impact

Wake sets trained BEFORE this fix (Tobe's current "Hey Clawsuu"
model, and any other v3.2.12-or-earlier trained sets) are unaffected
— they were trained with the asymmetric range and remain
amplitude-biased. **Users who want volume invariance must retrain
their wake sets after pulling this desktop version.**

Mobile v3.10.53 will add a UI hint on the wake-trainer prompting
the user to record at varied volumes (whisper, normal, shout) so the
new augmentation has human-curated diversity to work with.

## General lesson

**When adopting a third-party ML pipeline, audit its augmentation
defaults.** openWakeWord's `augment_clips` defaults to attenuation-
only Gain (`max_gain_in_db=0`). Symmetric augmentation is the
correct intent; the upstream config silently breaks volume
invariance. The fix is one constant change but the consequence
("wake doesn't fire when I whisper or shout") is a user-visible
failure mode.

A startup-time assertion that augmentation ranges are symmetric
would catch this at integration time. Or just reading the
augmentation defaults once when adopting a new pipeline.

**User feature requests can be diagnostic opportunities.** Tobe's
"I want volume invariance" surfaced a specific upstream misconfig
that wasn't on our radar. Listen to feature asks as signals about
hidden bugs in the system.

## Related

- Tobe's 2026-07-18 17:26 report (peak=0% across all chunks even
  with right model loaded, RMS 0.089 at conversational volume) —
  the trained classifier was dead, and volume invariance was a
  related-but-separately-broken axis.
- Mobile v3.10.50 diagnostic (`loadedWakeword` field in
  `scoreWavFile`) — confirms the wake-set registry binding now
  works correctly. With the binding fixed, the volume-invariance
  bug becomes the next layer to address. v3.2.13 fixes it.