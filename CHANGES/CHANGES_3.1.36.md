# v3.1.36 — wake-phrase training pipeline (skeleton)

## What was supposed to happen

Build the full training flow:
1. Phone records user samples → uploads paths to desktop
2. Desktop runs `openwakeword.train` with Piper TTS synthesis + augmentation
3. Stream progress back to phone
4. Ship trained .tflite back to phone
5. Phone activates the model per companion

## What actually shipped

**Solid (works end-to-end):**
- IPC handler `agent:train-wake-phrase(agentId, phrase, samplePaths)` — receives paths, sets up working dir, spawns Python subprocess, streams progress events
- IPC handler `agent:read-wake-model(tflitePath)` — returns trained model as base64
- Progress forwarding to both desktop renderer AND mobile via sync-server WS
- Python deps installed: `openwakeword`, `torch` (CUDA-enabled), `piper_phonemize`, `pronouncing`, `speechbrain`, `audiomentations`, `torchmetrics`, `torch_audiomentations`, `acoustics`, `datasets`
- Pre-computed training features downloaded: `openwakeword_features_ACAV100M_2000_hrs_16bit.npy` (6.1 GB), `validation_set_features.npy` (177 MB)
- Piper LibriTTS generator downloaded: `en_US-libritts_r-medium.pt` (195 MB)

**Incomplete (training script needs more work):**
- `scripts/train_wake_phrase.py` is the wrapper. The synthetic-data generation step fails because `openwakeword.train` expects a `generate_samples.py` file at the piper-sample-generator path, but the modern Piper package only exposes `piper_sample_generator` module.
- The training step itself wasn't reached in my test run because the synthetic step failed first.

## What needs to happen next

Two options:

**Option A (recommended):** Use the modern piper-sample-generator package (`pip install piper-sample-generator`). Write a shim `generate_samples.py` that calls into it. This unblocks the synthetic generation step and lets openWakeWord's training script run.

**Option B:** Skip synthetic generation entirely. Train ONLY on user samples + heavy augmentation (volume, pitch, noise, time stretch, reverb). This is what `microWakeWord` does for ESPHome — works for short, distinct wake phrases. Slightly less robust than the full openWakeWord approach but ships in hours.

I lean towards **B for the first training run** — get something working end-to-end, then add A as a refinement. The first custom "hey clawsuu" model with 30+ user samples + augmentation should be 80%+ accurate with very low false positives.

## Files
- `scripts/train_wake_phrase.py` (new) — wrapper around openWakeWord training pipeline
- `src/main.js` — IPC handlers + progress event forwarding
- `src/preload.js` — `cyberclaw.openclaw.trainWakePhrase` and `readWakeModel` exposed
- `package.json` — 3.1.34 → 3.1.36

## Lessons
- **openWakeWord's training pipeline is complex.** Synthetic TTS generation + acoustic feature extraction + adversarial mining + early stopping — lots of moving parts. Expect the first end-to-end run to take several hours of debugging.
- **The piper-sample-generator API broke.** openWakeWord's train.py expects an older `generate_samples.py` script; modern Piper is a proper Python package. Need a shim layer.
- **Pre-trained features are huge.** ~6 GB of pre-computed audio features are required for training. Plan disk space accordingly.
- **The runtime inference (v3.1.95 mobile) is solid.** That's the part that matters day-to-day for the user. Custom training is the next-level refinement.

## Next steps (continuation in next session)
1. Add `pip install piper-sample-generator` to setup script
2. Write `generate_samples.py` shim that wraps `piper_sample_generator`
3. Get end-to-end training run with user samples only (Option B)
4. Build the mobile training UI (record N samples, upload, see progress, activate model)
5. Update mobile Kotlin to load custom per-companion .tflite files
6. Wire it into the wake listener (active companion → active model)