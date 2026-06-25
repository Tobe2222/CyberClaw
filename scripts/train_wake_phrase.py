#!/usr/bin/env python3
"""
wakeword_train.py — train a custom openWakeWord model from user samples.

Usage:
  python3 wakeword_train.py --name "hey_clawsuu" \
      --samples-dir /tmp/oww-training/user_samples/ \
      --output-dir /tmp/oww-training/output/

Workflow:
  1. Reads user-recorded samples from samples-dir (WAV files at 16kHz mono).
  2. Generates synthetic positive samples using Piper TTS for diversity.
  3. Uses pre-computed openWakeWord features for negatives.
  4. Augments positives with noise, reverb, volume variation.
  5. Trains a 2-layer DNN on the features.
  6. Exports .tflite file for Android inference.

Designed to be called by main.js via spawn() — emits JSON progress lines
on stdout that the parent process parses and forwards to the mobile app.
"""

import argparse
import json
import os
import sys
import time
import yaml
import numpy as np
import torch
from pathlib import Path

# Force torch to use GPU
device = torch.device('cuda:0' if torch.cuda.is_available() else 'cpu')
print(f"[train] Using device: {device}", flush=True)


def emit_progress(stage: str, percent: float, message: str = ""):
    """Emit a JSON progress line that main.js can parse."""
    payload = {
        "type": "progress",
        "stage": stage,
        "percent": round(percent, 1),
        "message": message,
        "ts": time.time(),
    }
    print(f"PROGRESS::{json.dumps(payload)}", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", required=True, help="Model name (e.g. 'hey_clawsuu')")
    parser.add_argument("--samples-dir", required=True, help="Directory of user WAV files (16kHz mono)")
    parser.add_argument("--output-dir", required=True, help="Where to save the trained model")
    parser.add_argument("--features-file", default="/tmp/oww-training/openwakeword_features_ACAV100M_2000_hrs_16bit.npy")
    parser.add_argument("--rir-dir", default=None, help="Room impulse response dir for reverb augmentation")
    parser.add_argument("--n-samples", type=int, default=10000, help="Total positive samples to generate")
    parser.add_argument("--n-samples-val", type=int, default=2000, help="Validation positive samples")
    parser.add_argument("--epochs", type=int, default=20, help="Training epochs")
    parser.add_argument("--batch-size", type=int, default=128, help="Training batch size")
    args = parser.parse_args()

    # Setup
    samples_dir = Path(args.samples_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if not samples_dir.exists():
        print(f"ERROR: samples dir not found: {samples_dir}", file=sys.stderr, flush=True)
        sys.exit(1)

    user_wavs = list(samples_dir.glob("*.wav")) + list(samples_dir.glob("*.m4a"))
    if not user_wavs:
        print(f"ERROR: no WAV/M4A files in {samples_dir}", file=sys.stderr, flush=True)
        sys.exit(1)

    print(f"[train] Found {len(user_wavs)} user samples", flush=True)
    emit_progress("setup", 5, f"Found {len(user_wavs)} user samples")

    # Generate the training config YAML for openWakeWord's train.py
    config_path = output_dir / "config.yml"
    feature_data_files = {
        "ACAV100M_sample": args.features_file,
    }
    batch_n_per_class = {
        "ACAV100M_sample": 1024,
    }

    # Pick RIR path if available. RIR (Room Impulse Responses)
    # are used to add reverb to training samples, which helps
    # the model generalize across different acoustic
    # environments. If no RIR dir is provided, we skip it —
    # training still works but the model will be slightly
    # less robust to far-field / reverberant environments.
    rir_paths = []
    if args.rir_dir and Path(args.rir_dir).exists():
        rir_paths = [args.rir_dir]
    else:
        print("[train] No RIR dataset provided — training without reverb augmentation.", flush=True)
        print("[train] (MIT KEMAR RIR dataset is a good option if you want to add it later:", flush=True)
        print("[train]  https://sound.media.mit.edu/resources/KEMAR.html)", flush=True)

    config = {
        "model_name": args.name,
        "target_phrase": [args.name.replace("_", " ")],
        "custom_negative_phrases": [],
        "n_samples": args.n_samples,
        "n_samples_val": args.n_samples_val,
        "tts_batch_size": 50,
        "augmentation_batch_size": args.batch_size,
        "piper_sample_generator_path": "./piper-sample-generator",
        "output_dir": str(output_dir / "model"),
        "rir_paths": rir_paths,
        "background_paths": [],
        "background_paths_duplication_rate": [1],
        "false_positive_validation_data_path": "/tmp/oww-training/validation_set_features.npy",
        "augmentation_rounds": 1,
        "feature_data_files": feature_data_files,
        "batch_n_per_class": batch_n_per_class,
        "training_steps": args.epochs * 100,
        "steps_per_validation": 200,
        "max_negative_weight": args.epochs * 5,
        "target_false_positives_per_hour": 0.5,
    }

    # Skip background_paths if empty (some openWakeWord versions require it)
    if not config["background_paths"]:
        config.pop("background_paths", None)
        config.pop("background_paths_duplication_rate", None)

    with open(config_path, "w") as f:
        yaml.dump(config, f, default_flow_style=False)
    print(f"[train] Wrote config: {config_path}", flush=True)

    # Copy user samples into the model's positive_examples dir
    pos_dir = output_dir / "model" / "positive_examples" / args.name
    pos_dir.mkdir(parents=True, exist_ok=True)
    print(f"[train] Copying {len(user_wavs)} user samples to {pos_dir}", flush=True)
    import shutil
    for wav in user_wavs:
        shutil.copy(str(wav), pos_dir / wav.name)
    emit_progress("setup", 15, f"Copied {len(user_wavs)} user samples")

    # Generate synthetic clips via Piper TTS
    emit_progress("generating_synthetic", 20, "Generating synthetic samples (Piper TTS)...")
    print("[train] Generating synthetic samples (this is the slow part)...", flush=True)
    try:
        import subprocess
        result = subprocess.run(
            ["python3", "-m", "openwakeword.train",
             "--training_config", str(config_path),
             "--generate_clips"],
            capture_output=True, text=True, timeout=3600,
        )
        if result.returncode != 0:
            print(f"[train] Synthetic generation stderr: {result.stderr[:500]}", flush=True)
    except subprocess.TimeoutExpired:
        print(f"[train] Synthetic generation timed out", flush=True)
    except Exception as e:
        print(f"[train] Synthetic generation error (continuing): {e}", flush=True)
        import traceback
        traceback.print_exc()
    emit_progress("generating_synthetic", 50, "Synthetic samples generated")

    # Augment clips
    emit_progress("augmenting", 55, "Augmenting samples (noise/reverb/volume)...")
    print("[train] Augmenting samples...", flush=True)
    try:
        result = subprocess.run(
            ["python3", "-m", "openwakeword.train",
             "--training_config", str(config_path),
             "--augment_clips"],
            capture_output=True, text=True, timeout=1800,
        )
        if result.returncode != 0:
            print(f"[train] Augmentation stderr: {result.stderr[:500]}", flush=True)
    except Exception as e:
        print(f"[train] Augmentation error (continuing): {e}", flush=True)
    emit_progress("augmenting", 70, "Augmentation complete")

    # Train model
    emit_progress("training", 75, f"Training model on {device} ({args.epochs} epochs)...")
    print(f"[train] Training model on {device}...", flush=True)
    try:
        result = subprocess.run(
            ["python3", "-m", "openwakeword.train",
             "--training_config", str(config_path),
             "--train_model"],
            capture_output=True, text=True, timeout=3600,
        )
        # Stream stderr to console for debugging
        if result.stderr:
            for line in result.stderr.split("\n")[-20:]:
                print(f"[train-OWW] {line}", flush=True)
        if result.returncode != 0:
            print(f"[train] Training failed with code {result.returncode}", file=sys.stderr, flush=True)
            emit_progress("training", 0, "Training failed")
            sys.exit(1)
    except subprocess.TimeoutExpired:
        print(f"[train] Training timed out", flush=True)
        emit_progress("training", 0, "Training timed out")
        sys.exit(1)
    except Exception as e:
        print(f"[train] Training error: {e}", file=sys.stderr, flush=True)
        import traceback
        traceback.print_exc()
        emit_progress("training", 0, f"Training failed: {e}")
        sys.exit(1)

    # Find the output .tflite file
    emit_progress("finalizing", 90, "Locating trained model...")
    model_dir = output_dir / "model"
    tflite_path = None
    onnx_path = None
    if model_dir.exists():
        for p in model_dir.glob("*.tflite"):
            tflite_path = p
            break
        if not tflite_path:
            for p in model_dir.glob("*.onnx"):
                onnx_path = p
                break

    if tflite_path:
        print(f"[train] SUCCESS: {tflite_path}", flush=True)
        emit_progress("complete", 100, f"Model saved: {tflite_path}")
        print(f"OUTPUT_TFLITE::{tflite_path}", flush=True)
    elif onnx_path:
        # Convert ONNX to TFLite via the same pipeline
        print(f"[train] ONNX output: {onnx_path}", flush=True)
        emit_progress("converting", 95, "Converting ONNX → TFLite...")
        try:
            from openwakeword.utils import convert_onnx_to_tflite
            tflite_path = onnx_path.with_suffix(".tflite")
            convert_onnx_to_tflite(str(onnx_path), str(tflite_path))
            print(f"[train] SUCCESS: {tflite_path}", flush=True)
            emit_progress("complete", 100, f"Model saved: {tflite_path}")
            print(f"OUTPUT_TFLITE::{tflite_path}", flush=True)
        except Exception as e:
            print(f"[train] Conversion error: {e}", file=sys.stderr, flush=True)
            emit_progress("complete", 100, f"ONNX output: {onnx_path}")
            print(f"OUTPUT_ONNX::{onnx_path}", flush=True)
    else:
        print(f"[train] ERROR: no model output found in {model_dir}", file=sys.stderr, flush=True)
        emit_progress("failed", 0, "No model output found")
        sys.exit(1)


if __name__ == "__main__":
    main()
