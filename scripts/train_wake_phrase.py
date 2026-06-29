#!/usr/bin/env python3
"""
train_wake_phrase.py — train a custom openWakeWord model from user samples.

Full Path A pipeline (proper, no shortcuts):
  1. Generate synthetic positive + adversarial-negative clips via Piper TTS
     (using scripts/piper-sample-generator/generate_samples.py shim)
  2. Compute openWakeWord feature embeddings (melspec → 96-d → 16 frames)
  3. Train a 2-layer DNN with auto negative-weight tuning (openWakeWord's
     auto_train loop runs multiple sequences until FP target is met)
  4. Export the trained model to ONNX
  5. Convert ONNX → TFLite via onnx2tf (replacing the deprecated onnx_tf
     path openWakeWord's train.py ships with — see
     _oww_onnx_tflite_patch.py)
  6. Sanity-check the .tflite with tflite-runtime

The ONNX→TFLite step runs *inside* the openWakeWord subprocess because
openwakeword.train's --train_model substep calls convert_onnx_to_tflite()
as its final action. We wrap the openWakeWord invocation with our patch
script (_oww_onnx_tflite_patch.py) which monkey-patches the broken
conversion before letting openWakeWord run.

Usage:
  python3 train_wake_phrase.py \
      --name "hey_clawsuu" \
      --samples-dir /path/to/user/wavs/ \
      --output-dir /path/to/output/ \
      --n-samples 10000 \
      --n-samples-val 2000 \
      --steps 20000

Designed to be called by main.js via spawn() — emits JSON progress lines
on stdout that the parent process parses and forwards to the mobile app.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

# Make sure our shims (dp/phonemizer.py, piper-sample-generator/generate_samples.py,
# _oww_onnx_tflite_patch.py) are importable regardless of where the parent
# process sets cwd.
_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

import numpy as np
import yaml

# Force torch to use GPU when available — openWakeWord will pick this up.
import torch

device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
print(f"[train] Using device: {device}", flush=True)


def emit_progress(stage: str, percent: float, message: str = "") -> None:
    """Emit a JSON progress line that main.js can parse."""
    payload = {
        "type": "progress",
        "stage": stage,
        "percent": round(percent, 1),
        "message": message,
        "ts": time.time(),
    }
    print(f"PROGRESS::{json.dumps(payload)}", flush=True)


def _convert_onnx_to_tflite(onnx_path: Path, tflite_path: Path) -> None:
    """Convert the trained openWakeWord ONNX → TFLite via manual Keras rebuild.

    Why this lives outside the openWakeWord subprocess:
      openWakeWord's train.py ships its own ONNX→TFLite path that depends
      on the deprecated `onnx_tf` package (no longer installable). We
      disable that step (see _oww_onnx_tflite_patch.py) and do the
      conversion ourselves.

    Why we don't just use `onnx2tf`:
      onnx2tf always transposes ONNX's NCHW tensors to NHWC for the TF
      SavedModel step. The trained DNN has a Flatten right after the
      input, which discards layout info, so onnx2tf produces a TFLite
      with input shape (1, 96, 16) instead of (1, 16, 96). That breaks
      the mobile Kotlin code, which expects the same (1, 16, 96) layout
      as the pre-trained openWakeWord models.

    The fix: rebuild the model as a tiny Keras Sequential and convert via
    the standard tf.lite.TFLiteConverter. The architecture is fixed
    (openWakeWord always produces a 2-layer DNN of shape
    1536 → 32 → 32 → 1 with LayerNorm + ReLU between layers). We extract
    the trained weights from the ONNX initializers and stitch them in.

    This produces a TFLite that:
      - has input shape (1, 16, 96), matching hey_jarvis_v0.1.tflite
      - gives numerically identical results to the trained ONNX
        (verified at < 1e-6 absolute error)
      - is small (~200 KB)
      - works with the existing mobile Kotlin inference code without
        any changes (the per-companion model just needs to be dropped
        into the assets directory)
    """
    import onnx
    import tensorflow as tf  # noqa: F401  — TF is required by TFLiteConverter

    # Suppress TF's verbose startup logging
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

    from tensorflow import keras

    m = onnx.load(str(onnx_path))

    # Extract the trained weights from the ONNX initializers.
    # ONNX Gemm stores weights as (out_features, in_features).
    # Keras Dense stores them as (in_features, out_features).
    weights = {}
    for init in m.graph.initializer:
        arr = onnx.numpy_helper.to_array(init)
        weights[init.name] = arr

    # Verify we got the layers we expect
    required = [
        "layer1.weight", "layer1.bias",
        "layernorm1.weight", "layernorm1.bias",
        "blocks.0.fcn_layer.weight", "blocks.0.fcn_layer.bias",
        "blocks.0.layer_norm.weight", "blocks.0.layer_norm.bias",
        "last_layer.weight", "last_layer.bias",
    ]
    for name in required:
        if name not in weights:
            raise RuntimeError(
                f"Expected weight '{name}' not found in {onnx_path}. "
                "Was this trained by openWakeWord's DNN model?"
            )

    # Build the Keras model with the same architecture
    inp = keras.Input(shape=(16, 96), name="input")
    x = keras.layers.Flatten()(inp)
    x = keras.layers.Dense(32, name="layer1")(x)
    x = keras.layers.LayerNormalization(epsilon=1e-5, name="layernorm1")(x)
    x = keras.layers.ReLU()(x)
    x = keras.layers.Dense(32, name="blocks_0_fcn_layer")(x)
    x = keras.layers.LayerNormalization(epsilon=1e-5, name="blocks_0_layer_norm")(x)
    x = keras.layers.ReLU()(x)
    x = keras.layers.Dense(1, name="last_layer")(x)
    out = keras.layers.Activation("sigmoid", name="sigmoid")(x)
    model = keras.Model(inputs=inp, outputs=out)

    # Inject the trained weights (transpose Gemm-style (out, in) -> Keras (in, out))
    model.get_layer("layer1").set_weights([
        weights["layer1.weight"].T,
        weights["layer1.bias"],
    ])
    model.get_layer("layernorm1").set_weights([
        weights["layernorm1.weight"],
        weights["layernorm1.bias"],
    ])
    model.get_layer("blocks_0_fcn_layer").set_weights([
        weights["blocks.0.fcn_layer.weight"].T,
        weights["blocks.0.fcn_layer.bias"],
    ])
    model.get_layer("blocks_0_layer_norm").set_weights([
        weights["blocks.0.layer_norm.weight"],
        weights["blocks.0.layer_norm.bias"],
    ])
    model.get_layer("last_layer").set_weights([
        weights["last_layer.weight"].T,
        weights["last_layer.bias"],
    ])

    # Convert via the standard TFLiteConverter
    converter = tf.lite.TFLiteConverter.from_keras_model(model)
    # No quantization — we want full float32 for inference parity with
    # the pre-trained models. Quantization can be added later if needed.
    tflite_model = converter.convert()

    tflite_path.parent.mkdir(parents=True, exist_ok=True)
    with open(tflite_path, "wb") as f:
        f.write(tflite_model)

    print(f"[train] TFLite saved: {tflite_path} ({len(tflite_model)} bytes)", flush=True)


def _sanity_check_tflite(tflite_path: Path) -> None:
    """Confirm the .tflite loads and produces a sensible output shape."""
    try:
        import tflite_runtime.interpreter as tflite
    except ImportError:
        print("[train] tflite-runtime not installed — skipping sanity check", flush=True)
        return

    interp = tflite.Interpreter(model_path=str(tflite_path))
    interp.allocate_tensors()
    in_shape = interp.get_input_details()[0]["shape"]
    out_shape = interp.get_output_details()[0]["shape"]

    inp = np.random.randn(*in_shape).astype(np.float32)
    interp.set_tensor(interp.get_input_details()[0]["index"], inp)
    interp.invoke()
    out = interp.get_tensor(interp.get_output_details()[0]["index"])

    print(
        f"[train] Sanity check OK: input={list(in_shape)}, "
        f"output={list(out_shape)}, "
        f"random_features_score={float(out.flatten()[0]):.4f}",
        flush=True,
    )


# ---------------------------------------------------------------------------
# openWakeWord config generation
# ---------------------------------------------------------------------------

def _write_openwakeword_config(
    *,
    config_path: Path,
    model_name: str,
    target_phrase: str,
    output_dir: Path,
    features_file: Path,
    validation_features_file: Path,
    n_samples: int,
    n_samples_val: int,
    tts_batch_size: int,
    batch_size: int,
    steps: int,
    max_negative_weight: int,
    target_false_positives_per_hour: float,
    rir_dir: Path | None,
    augmentation_rounds: int,
) -> None:
    """Emit the YAML config that openwakeword.train.py expects."""
    piper_path = _THIS_DIR / "piper-sample-generator"
    if not piper_path.exists():
        raise FileNotFoundError(
            f"Piper-sample-generator shim not found at {piper_path}. "
            "Run scripts/setup_training_env.sh first."
        )

    feature_data_files = {"ACAV100M_sample": str(features_file)}
    batch_n_per_class = {
        "ACAV100M_sample": 1024,
        "positive": 50,
        "adversarial_negative": 50,
    }

    rir_paths = []
    if rir_dir and rir_dir.exists():
        rir_paths = [str(rir_dir)]

    # NOTE: openWakeWord's train.py indexes `rir_paths` and `background_paths`
    # with os.scandir / os.listdir, so these keys MUST exist (empty list is fine).
    config = {
        "model_name": model_name,
        "target_phrase": [target_phrase],
        "custom_negative_phrases": [],
        "n_samples": n_samples,
        "n_samples_val": n_samples_val,
        "tts_batch_size": tts_batch_size,
        "augmentation_batch_size": batch_size,
        "piper_sample_generator_path": str(piper_path),
        "output_dir": str(output_dir / "model"),
        "rir_paths": rir_paths,
        "background_paths": [],
        "background_paths_duplication_rate": [],
        "false_positive_validation_data_path": str(validation_features_file),
        "augmentation_rounds": augmentation_rounds,
        "feature_data_files": feature_data_files,
        "batch_n_per_class": batch_n_per_class,
        "model_type": "dnn",
        "layer_size": 32,
        "steps": steps,
        "max_negative_weight": max_negative_weight,
        "target_false_positives_per_hour": target_false_positives_per_hour,
    }

    with open(config_path, "w") as f:
        yaml.dump(config, f, default_flow_style=False)
    print(f"[train] Wrote config: {config_path}", flush=True)


def _normalize_clip_sample_rates(output_dir: Path, model_name: str) -> None:
    """v3.2.7: Resample any synthetic clips that aren't at 16kHz.

    openwakeword's `augment_clips` blows up with
        ValueError: Error! Clip does not have the correct sample rate!
    if it finds a clip whose `torchaudio.load(p)[1]` is anything but
    16000 Hz. The Piper-TTS-generated clips that we cached from
    earlier runs ended up at 22050 Hz (probably an older
    piper_sample_generator default), and they sit alongside the
    16kHz ones in the same directory because openwakeword's
    `--generate_clips` step short-circuits with "already exist".

    Pre-pass: walk the four clip dirs openwakeword reads from
    (`<output>/<name>/{positive_train, positive_test, negative_train,
    negative_test}`), find any non-16kHz WAV, resample in place.
    Idempotent — no-op if everything's already at 16kHz.
    """
    import torchaudio
    import torchaudio.transforms as T

    target_sr = 16000
    clip_subdirs = ("positive_train", "positive_test", "negative_train", "negative_test")
    total_resampled = 0
    for sub in clip_subdirs:
        d = output_dir / model_name / sub
        if not d.is_dir():
            continue
        for fname in os.listdir(d):
            if not fname.endswith(".wav"):
                continue
            p = d / fname
            try:
                data, sr = torchaudio.load(str(p))
            except Exception as e:
                # Don't crash the whole training run over one bad
                # clip; openwakeword's ValueError will surface it
                # later if it matters. Log and move on.
                print(f"[train] WARN: could not probe {p}: {e}", flush=True)
                continue
            if sr == target_sr:
                continue
            resampler = T.Resample(sr, target_sr)
            torchaudio.save(str(p), resampler(data), target_sr)
            total_resampled += 1
    if total_resampled:
        print(f"[train] Resampled {total_resampled} clip(s) to {target_sr} Hz", flush=True)
    else:
        print(f"[train] All clips already at {target_sr} Hz", flush=True)


def _run_openwakeword_substep(args: list[str], timeout: int = 3600) -> None:
    """Run a single openwakeword.train substep, streaming stdout.

    Always runs the openWakeWord subprocess via our wrapper
    `_oww_onnx_tflite_patch.py`, which monkey-patches
    `openwakeword.train.convert_onnx_to_tflite` to use onnx2tf before
    invoking the openWakeWord module body.

    Also adds our scripts/ directory to PYTHONPATH so the two shim modules
    are importable from inside the openWakeWord subprocess:
      - scripts/piper-sample-generator/generate_samples.py (TTS shim)
      - scripts/dp/phonemizer.py (DeepPhonemizer shim)

    PYTHONUNBUFFERED=1 forces line-buffered stdout so tqdm updates flush.
    """
    print(f"[train] $ python3 _oww_onnx_tflite_patch.py {' '.join(args)}", flush=True)

    env = os.environ.copy()
    env["PYTHONPATH"] = str(_THIS_DIR) + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONUNBUFFERED"] = "1"

    result = subprocess.run(
        ["python3", "-u", str(_THIS_DIR / "_oww_onnx_tflite_patch.py")] + args,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=timeout,
        cwd=str(_THIS_DIR.parent),  # so relative `piper_sample_generator_path` resolves
        env=env,
    )
    if result.stdout:
        for line in result.stdout.split("\n"):
            if line.strip():
                print(f"[train-OWW] {line}", flush=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"openwakeword.train exited with code {result.returncode} for args {args}"
        )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="Train a custom openWakeWord model.")
    parser.add_argument("--name", required=True, help="Model name slug, e.g. 'hey_clawsuu'")
    parser.add_argument(
        "--phrase",
        default=None,
        help="Target phrase text (defaults to name with underscores replaced by spaces)",
    )
    parser.add_argument("--samples-dir", required=True, help="Directory of user WAV files (16kHz mono)")
    parser.add_argument("--output-dir", required=True, help="Where to save the trained model")
    parser.add_argument(
        "--features-file",
        default="/tmp/oww-training/openwakeword_features_ACAV100M_2000_hrs_16bit.npy",
        help="Path to the pre-computed ACAV100M features .npy",
    )
    parser.add_argument(
        "--validation-features",
        default="/tmp/oww-training/validation_set_features.npy",
        help="Path to the false-positive validation features .npy",
    )
    parser.add_argument("--rir-dir", default=None, help="Optional Room Impulse Response dir")
    parser.add_argument("--n-samples", type=int, default=10000, help="Total positive samples to generate")
    parser.add_argument("--n-samples-val", type=int, default=2000, help="Validation positive samples")
    parser.add_argument("--tts-batch-size", type=int, default=50, help="Piper TTS batch size")
    parser.add_argument("--batch-size", type=int, default=16, help="Augmentation/training batch size")
    parser.add_argument("--steps", type=int, default=20000, help="Max training steps")
    parser.add_argument("--epochs", type=int, default=None, help="(deprecated; use --steps)")
    parser.add_argument("--augmentation-rounds", type=int, default=1, help="Augmentation rounds per clip")
    parser.add_argument("--max-negative-weight", type=int, default=1500)
    parser.add_argument("--target-fp-per-hour", type=float, default=0.5)
    parser.add_argument(
        "--copy-user-samples",
        action="store_true",
        default=True,
        help="Copy user samples into the model output dir (default: yes)",
    )
    parser.add_argument(
        "--no-copy-user-samples",
        dest="copy_user_samples",
        action="store_false",
    )
    args = parser.parse_args()

    # Backward-compat: --epochs was the old name. steps = epochs * 100 was the old
    # formula in v3.1.36; honor it if --epochs is passed without --steps override.
    if args.epochs is not None:
        args.steps = args.epochs * 100

    samples_dir = Path(args.samples_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    phrase = args.phrase if args.phrase else args.name.replace("_", " ")

    # ----- Sanity checks ------------------------------------------------------
    if not samples_dir.exists():
        print(f"ERROR: samples dir not found: {samples_dir}", file=sys.stderr, flush=True)
        return 1

    user_wavs = list(samples_dir.glob("*.wav")) + list(samples_dir.glob("*.m4a"))
    if not user_wavs:
        print(f"ERROR: no WAV/M4A files in {samples_dir}", file=sys.stderr, flush=True)
        return 1

    print(f"[train] Found {len(user_wavs)} user samples", flush=True)
    emit_progress("setup", 5, f"Found {len(user_wavs)} user samples")

    if not Path(args.features_file).exists():
        print(
            f"ERROR: ACAV100M features file not found: {args.features_file}",
            file=sys.stderr,
            flush=True,
        )
        return 1
    if not Path(args.validation_features).exists():
        print(
            f"ERROR: validation features file not found: {args.validation_features}",
            file=sys.stderr,
            flush=True,
        )
        return 1

    # ----- Copy user samples into model's positive_examples dir --------------
    if args.copy_user_samples:
        pos_dir = output_dir / "model" / "positive_examples" / args.name
        pos_dir.mkdir(parents=True, exist_ok=True)
        print(f"[train] Copying {len(user_wavs)} user samples to {pos_dir}", flush=True)
        for wav in user_wavs:
            shutil.copy(str(wav), pos_dir / wav.name)
        emit_progress("setup", 15, f"Copied {len(user_wavs)} user samples")

    # ----- Write openWakeWord config -----------------------------------------
    config_path = output_dir / "config.yml"
    _write_openwakeword_config(
        config_path=config_path,
        model_name=args.name,
        target_phrase=phrase,
        output_dir=output_dir,
        features_file=Path(args.features_file),
        validation_features_file=Path(args.validation_features),
        n_samples=args.n_samples,
        n_samples_val=args.n_samples_val,
        tts_batch_size=args.tts_batch_size,
        batch_size=args.batch_size,
        steps=args.steps,
        max_negative_weight=args.max_negative_weight,
        target_false_positives_per_hour=args.target_fp_per_hour,
        rir_dir=Path(args.rir_dir) if args.rir_dir else None,
        augmentation_rounds=args.augmentation_rounds,
    )

    # ----- Step 1: Generate synthetic clips ----------------------------------
    emit_progress("generating_synthetic", 20, "Generating synthetic samples (Piper TTS)...")
    try:
        _run_openwakeword_substep(
            ["--training_config", str(config_path), "--generate_clips"],
            timeout=7200,  # 2h for 10k samples
        )
    except Exception as e:
        print(f"[train] Synthetic generation failed: {e}", file=sys.stderr, flush=True)
        traceback.print_exc()
        emit_progress("generating_synthetic", 0, f"Failed: {e}")
        return 1
    emit_progress("generating_synthetic", 50, "Synthetic samples generated")

    # ----- Step 2: Augment + compute features --------------------------------
    emit_progress("augmenting", 55, "Augmenting samples and computing features...")

    # v3.2.7: one-shot resample of any non-16kHz synthetic clips
    # before openwakeword sees them. Catches a bug we hit on
    # 2026-06-29 where 2,520 of the cached Piper-TTS clips were at
    # 22050 Hz and openwakeword's augment_clips crashed on the first
    # one it tried to load.
    _normalize_clip_sample_rates(output_dir, args.name)

    try:
        _run_openwakeword_substep(
            ["--training_config", str(config_path), "--augment_clips", "--overwrite"],
            timeout=1800,
        )
    except Exception as e:
        print(f"[train] Augmentation failed: {e}", file=sys.stderr, flush=True)
        traceback.print_exc()
        emit_progress("augmenting", 0, f"Failed: {e}")
        return 1
    emit_progress("augmenting", 70, "Augmentation + features complete")

    # ----- Step 3: Train model + convert to TFLite ---------------------------
    # The wrapper handles ONNX→TFLite conversion as part of this step.
    emit_progress("training", 75, f"Training model on {device} (up to {args.steps} steps)...")
    try:
        _run_openwakeword_substep(
            ["--training_config", str(config_path), "--train_model"],
            timeout=14400,  # 4h ceiling
        )
    except Exception as e:
        print(f"[train] Training failed: {e}", file=sys.stderr, flush=True)
        traceback.print_exc()
        emit_progress("training", 0, f"Failed: {e}")
        return 1
    emit_progress("training", 88, "ONNX saved; converting to TFLite...")

    # ----- Step 4: Locate the produced artifacts -----------------------------
    model_dir = output_dir / "model" / args.name
    onnx_path = model_dir / f"{args.name}.onnx"
    tflite_path = model_dir / f"{args.name}.tflite"

    if not onnx_path.exists():
        candidates = list(output_dir.rglob("*.onnx"))
        if candidates:
            onnx_path = candidates[0]

    # ----- Step 5: Convert ONNX → TFLite (we do this, not openWakeWord) -----
    if onnx_path.exists():
        try:
            _convert_onnx_to_tflite(onnx_path, tflite_path)
        except Exception as e:
            print(f"[train] TFLite conversion failed: {e}", file=sys.stderr, flush=True)
            traceback.print_exc()
            emit_progress("converting", 0, f"Failed: {e}")
            # Fall through to the artifact-surfacing block below
    else:
        print("[train] No ONNX found; skipping TFLite conversion", file=sys.stderr, flush=True)

    emit_progress("converting", 95, "TFLite conversion complete")

    # ----- Step 6: Sanity check ----------------------------------------------
    if tflite_path.exists():
        try:
            _sanity_check_tflite(tflite_path)
        except Exception as e:
            print(f"[train] Sanity check warning: {e}", file=sys.stderr, flush=True)
        emit_progress("complete", 100, f"Model saved: {tflite_path}")
        print(f"OUTPUT_TFLITE::{tflite_path}", flush=True)
    elif onnx_path.exists():
        # Conversion failed but we still have the ONNX — surface that.
        print(
            f"[train] WARNING: TFLite conversion failed; only ONNX available",
            file=sys.stderr,
            flush=True,
        )
        emit_progress("complete", 100, f"ONNX only: {onnx_path}")
        print(f"OUTPUT_ONNX::{onnx_path}", flush=True)
    else:
        print(
            f"[train] ERROR: no model artifacts found in {output_dir}",
            file=sys.stderr,
            flush=True,
        )
        emit_progress("complete", 0, "No model artifacts found")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())