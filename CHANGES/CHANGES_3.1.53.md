# v3.1.53 — Wake word training: optional user-recorded near-miss clips

the user: "we dont have near-miss in the training path, we
need to add that if we are to use it."

The v3.1.49 wake-word training pipeline uses Piper-TTS-
generated `adversarial_negative` clips to teach the model
what to reject. Those are useful for general robustness
but they don't match the user's voice or acoustic
environment, so they don't catch what actually trips up
the model in the field.

This release adds an OPTIONAL pass for user-recorded
near-miss clips. Record 3 similar-but-wrong phrases
("hey car" for "hey clawsuu") in your own voice, ship
them with the training request, and the python script
copies them into the negative_train / negative_test
folders so the augmentation step picks them up
alongside the Piper negatives.

## What changed

### 1. Python script (`scripts/train_wake_phrase.py`)

New CLI flag `--user-negative-dir <path>`. After the
Piper synthetic-clip generation step, the script
copies any `.wav` / `.m4a` files from the supplied dir
into the model's `negative_train` and `negative_test`
folders with an 80/20 train/test split:

- 1 file → train only (no test, model has to validate
  against Piper negatives)
- 2-4 files → 1 in test, rest in train
- 5+ files → 20% test, 80% train

Existing files in the dest dirs aren't clobbered;
collision-safe naming with `_user_N` suffix.

The script's existing `if user_neg_dir.exists()`
guard means the flag is a no-op when the dir doesn't
exist (preserves the v3.1.49 behavior of using only
Piper negatives when no user-recorded clips are
supplied).

### 2. Desktop (`src/main.js`)

`wake_training_request` handler accepts an optional
`nearMissSamples: Array<{name, data}>` field on the
payload (base64 audio, same shape as positive samples).
Validates each entry has `name` + `data` before
accepting (rejects malformed payloads with a
`wake_training_result` failure so a buggy client
doesn't crash the training pipeline).

If `nearMissSamples.length > 0`, the handler decodes
each clip into `<workDir>/user_near_miss_samples/`
and passes that dir path to the python script via
`--user-negative-dir`.

Backward-compat: if the field is absent or empty, no
near-miss dir is created and the script arg is omitted
— identical to v3.1.49 behavior.

### 3. Wire protocol

The `request_wake_training` message gains an optional
`nearMissSamples` field. Existing phones that don't
send the field keep working unchanged.

## Files touched

- `scripts/train_wake_phrase.py` (new arg + new
  `_copy_user_negatives()` helper + the post-
  generation copy step)
- `src/main.js` (extended handler signature, new
  decode block, new `--user-negative-dir` arg)
- `package.json` (3.1.52 → 3.1.53)

## Companion release

- **Mobile v3.8.2** — new "Record near-misses" section
  in the OpenWakeWordTrainer, with 3 slots, a text
  input for each phrase (so you know what to say), and
  auto-suggested variations of the wake phrase via
  phonetic swaps.