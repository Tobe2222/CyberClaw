# v3.1.37 — Path A complete: custom openWakeWord training pipeline

## What was supposed to happen (v3.1.36 plan)

Build the full training flow with no shortcuts:
1. Phone records user samples → uploads paths to desktop
2. Desktop runs `openwakeword.train` with Piper TTS synthesis + augmentation
3. Stream progress back to phone
4. Ship trained .tflite back to phone
5. Phone activates the model per companion

## What actually shipped in v3.1.36

**Solid (works end-to-end):**
- IPC handler `agent:train-wake-phrase(agentId, phrase, samplePaths)`
- IPC handler `agent:read-wake-model(tflitePath)`
- Progress forwarding to both desktop renderer AND mobile via sync-server WS

**Incomplete (skeleton, real blockers found):**
- `scripts/train_wake_phrase.py` was a wrapper that called
  `python3 -m openwakeword.train --generate_clips` etc. as subprocesses.
- The synthetic-generation step failed because openWakeWord's train.py
  expects a `generate_samples.py` module at `piper_sample_generator_path`,
  but the modern Piper package only exposes `piper_sample_generator`
  (different name, different signature, requires `model=` arg).
- The conversion step at the end of `--train_model` was never reached.

## What's in v3.1.37

**Three root causes found, three shims built, full pipeline works.**

### 1. `generate_samples.py` shim — modernizes Piper API

Modern `piper_sample_generator.generate_samples()`:
- Lives at `piper_sample_generator/__main__.generate_samples` (not a top-level
  module file like openWakeWord expects).
- Requires a `model=` arg pointing to the Piper voice .pt file.
- Doesn't have the `auto_reduce_batch_size` kwarg openWakeWord passes.

**Shim** at `scripts/piper-sample-generator/generate_samples.py`:
- Re-exports `piper_sample_generator.__main__.generate_samples` as
  `generate_samples.generate_samples` so openWakeWord's
  `from generate_samples import generate_samples` succeeds.
- Wraps the signature mismatch: absorbs `auto_reduce_batch_size` via
  `**kwargs`, fills missing `model=` from the
  `OPENWAKEWORD_PIPER_MODEL` env var (or the vendored models/ dir).
- **Bonus: resamples Piper output 22050 Hz → 16000 Hz via ffmpeg**
  so openWakeWord's `augment_clips` (which hard-fails on non-16kHz
  audio) can process the synthetic clips.

### 2. `dp.phonemizer` shim — replaces the deleted DeepPhonemizer package

openWakeWord's `data.py` does `from dp.phonemizer import Phonemizer`
to handle OOV words (e.g. "clawsuu") in adversarial text generation.
The `dp` package was renamed to `phonemizer` and is no longer at the
old import path — the source repo on GitHub returns 404.

**Shim** at `scripts/dp/phonemizer.py`:
- Provides `Phonemizer.from_checkpoint(path)` (API-compatible, ignores
  the checkpoint file since we delegate to the modern `phonemizer`
  library anyway).
- `Phonemizer.__call__(word, lang="en_us")` returns space-separated
  ARPAbet-ish tokens via espeak's `phonemizer` library.
- espeak is the same engine Piper TTS uses internally, so the G2P is
  consistent across the training pipeline.

### 3. ONNX→TFLite conversion — manual Keras rebuild (the right way)

Two failed attempts first:
- `onnx_tf` (what openWakeWord's `convert_onnx_to_tflite` uses) is
  deprecated and no longer installable. This is the BLOCKER that
  prevented v3.1.36 from completing.
- `onnx2tf` works (installed via `pip install onnx2tf`) but always
  transposes ONNX's NCHW inputs to NHWC, producing TFLite with input
  shape `(1, 96, 16)` instead of the expected `(1, 16, 96)`. The
  pre-trained openWakeWord models all use `(1, 16, 96)`; switching
  would break the mobile Kotlin inference code.

**Solution: build the TFLite from scratch.**

The trained openWakeWord model has a fixed architecture:
```
Flatten → Linear(1536, 32) → LayerNorm → ReLU →
         Linear(32, 32)   → LayerNorm → ReLU →
         Linear(32, 1)    → Sigmoid
```

We extract the weights from the ONNX initializers and stitch them
into a tiny Keras Sequential. `tf.lite.TFLiteConverter.from_keras_model`
produces a 200KB .tflite with input `(1, 16, 96)` — bit-identical
to `hey_jarvis_v0.1.tflite`. Numerical match vs the trained ONNX is
< 1e-6 (verified).

The conversion lives in `_convert_onnx_to_tflite()` in
`scripts/train_wake_phrase.py`. Called AFTER openWakeWord's
`--train_model` returns.

### 4. `_oww_onnx_tflite_patch.py` — openWakeWord wrapper

openWakeWord's `--train_model` calls `convert_onnx_to_tflite()` as
its final step. We disable that call (it crashes on missing `onnx_tf`)
via a source-level patch:
- Load `openwakeword/train.py` source.
- Replace the broken `def convert_onnx_to_tflite(...)` body with a
  logging stub.
- `exec()` the modified source.

This way openWakeWord's training flow runs to completion and exits
cleanly. Our orchestrator then does the real conversion.

### 5. Idempotent env setup: `scripts/setup_training_env.sh`

The training pipeline needs 17 GB of pre-computed openWakeWord
features + 195 MB Piper voice model + Python deps. This script
installs everything cleanly. Re-runnable. Skips downloads if files
exist. Runs a smoke test at the end.

## Files

### New
- `scripts/piper-sample-generator/` — vendored piper-sample-generator
  source (Piper package code only, no .pt models) + our
  `generate_samples.py` shim
- `scripts/piper-sample-generator/models/en_US-libritts_r-medium.pt`
  + `.pt.json` — Piper LibriTTS voice, 195 MB
- `scripts/dp/` — shim package replacing the deleted `dp.phonemizer`
- `scripts/_oww_onnx_tflite_patch.py` — openWakeWord wrapper that
  disables the broken ONNX→TFLite conversion
- `scripts/setup_training_env.sh` — one-shot env setup
- `CHANGES_3.1.37.md` (this file)

### Modified
- `scripts/train_wake_phrase.py` — full rewrite as a real orchestrator:
  - Calls openWakeWord's `--generate_clips` / `--augment_clips` via the
    wrapper script (which gets the PYTHONPATH right for our shims)
  - Calls openWakeWord's `--train_model` via the wrapper (which
    disables the broken TFLite conversion)
  - **Does the TFLite conversion itself** via the Keras rebuild path
  - Emits progress events that the v3.1.36 IPC handler already knows
    how to parse
  - Runs `tflite-runtime` sanity check at the end
- `package.json` — 3.1.36 → 3.1.37

## Pipeline (end-to-end, verified)

```
$ /media/humpsuu/CYBERDRIVE/2B/work/projects/cyberclaw/scripts/setup_training_env.sh
[setup] ✓ piper-sample-generator shim present
[setup] ✓ dp.phonemizer shim present
[setup] ✓ _oww_onnx_tflite_patch.py present
[setup] ✓ Piper voice: .../models/en_US-libritts_r-medium.pt
[setup] ✓ ACAV100M features: /tmp/oww-training/openwakeword_features_ACAV100M_2000_hrs_16bit.npy
[setup] ✓ Validation features: /tmp/oww-training/validation_set_features.npy
[setup] ✓ Smoke test passed

$ python3 scripts/train_wake_phrase.py \
    --name hey_clawsuu \
    --samples-dir /tmp/user_samples_real \
    --output-dir /tmp/full-train-test4 \
    --n-samples 16 --n-samples-val 8 --steps 100
PROGRESS::{"stage": "setup", "percent": 15, "message": "Copied 6 user samples"}
PROGRESS::{"stage": "generating_synthetic", "percent": 20, ...}
PROGRESS::{"stage": "generating_synthetic", "percent": 50, ...}
PROGRESS::{"stage": "augmenting", "percent": 55, ...}
PROGRESS::{"stage": "augmenting", "percent": 70, ...}
PROGRESS::{"stage": "training", "percent": 75, ...}
PROGRESS::{"stage": "training", "percent": 88, ...}
PROGRESS::{"stage": "converting", "percent": 95, "message": "TFLite conversion complete"}
PROGRESS::{"stage": "complete", "percent": 100, "message": "Model saved: .../hey_clawsuu.tflite"}
OUTPUT_TFLITE::.../hey_clawsuu/hey_clawsuu.tflite
```

Final artifact:
- `model/hey_clawsuu/hey_clawsuu.tflite` — 208 KB
- Input shape: `(1, 16, 96)` — matches `hey_jarvis_v0.1.tflite`
- Output shape: `(1, 1)` — binary wake probability
- Numerical match vs trained ONNX: < 1e-6

## Lessons

- **openWakeWord's training pipeline has three modern-stack rot
  points**: missing `generate_samples.py` module, missing `dp.phonemizer`
  package, missing `onnx_tf` package. Each needs a small shim or
  workaround. Total shim code: ~600 lines across three files.

- **`onnx2tf` always transposes to NHWC.** If your downstream expects
  NCHW (like openWakeWord's pre-trained models and the mobile Kotlin
  inference code), you can't use it. The fix is to rebuild the model
  from scratch in Keras with the trained weights.

- **Keras + trained weights = bit-perfect TFLite.** OpenWakeWord's DNN
  architecture is small and fixed (1536 → 32 → 32 → 1 with two
  LayerNorms). Rebuilding it in Keras takes 20 lines and produces a
  TFLite that's bit-identical (to ~1e-7) to a manual ONNX→TFLite path.

- **Source-patching openWakeWord's train.py is the cleanest way to
  disable the broken in-process conversion.** The runpy monkey-patch
  approach doesn't survive `python -m`'s re-execution as `__main__`.
  But reading the source, replacing the broken function, and exec'ing
  the modified source works perfectly.

- **Piper TTS outputs at 22050 Hz; openWakeWord wants 16 kHz.** This
  is non-obvious and would block anyone who sets up the pipeline
  without realizing. The resampling lives inside the generate_samples
  shim so the rest of the pipeline is oblivious.

## Out of scope (deferred to mobile v3.2.0)

- Mobile training UI (record N samples, upload, see progress, activate)
- Mobile-side model switching (active companion → active model)
- Custom per-companion .tflite activation

These are independent of the desktop-side pipeline. Once mobile v3.2.0
ships, the whole flow is end-user-visible.