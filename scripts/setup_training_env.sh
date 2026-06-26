#!/usr/bin/env bash
# setup_training_env.sh — idempotent setup for the openWakeWord training pipeline.
#
# Installs Python deps, downloads Piper TTS voice + openWakeWord feature files,
# and verifies all shim modules are in place. Safe to re-run.
#
# Usage: ./setup_training_env.sh [--features-dir /path/to/features/]
#
# What this does:
#   1. Installs onnx2tf + transitive deps (onnx, onnxruntime, tensorflow).
#      onnx2tf is the replacement for the deprecated onnx_tf that
#      openWakeWord's train.py requires for ONNX→TFLite conversion. We use
#      it via our wrapper script (`_oww_onnx_tflite_patch.py`).
#   2. Installs tflite-runtime (already on most systems, just confirms).
#   3. Confirms piper-sample-generator source is vendored in scripts/.
#   4. Downloads the pre-computed openWakeWord feature files if missing:
#      - openwakeword_features_ACAV100M_2000_hrs_16bit.npy (~17 GB)
#      - validation_set_features.npy (~177 MB)
#   5. Downloads the Piper LibriTTS voice model (~195 MB).
#   6. Runs a smoke test of the full pipeline on a tiny dataset.
#
# Why this is separate from package.json:
#   The training env is Python + system deps, not Electron + npm. Keeping it
#   out of the Node package means the dev who doesn't need wake training
#   doesn't pull in 17 GB of features they won't use.
#
# Idempotency: every step skips if its artifact already exists. Re-running
# this script after partial failure resumes from where it left off.

set -e

# ---- config -----------------------------------------------------------------

FEATURES_DIR="${FEATURES_DIR:-/tmp/oww-training}"
PIPER_VOICE_NAME="en_US-libritts_r-medium"
SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"

# ACAV100M features: ~17 GB. Source: openwakeword HuggingFace dataset.
ACAV100M_URL="https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/openwakeword_features_ACAV100M_2000_hrs_16bit.npy"
VALIDATION_URL="https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/validation_set_features.npy"

# Piper LibriTTS voice: ~195 MB. Source: Piper sample generator repo.
PIPER_VOICE_URL="https://github.com/rhasspy/piper-sample-generator/raw/master/models/${PIPER_VOICE_NAME}.pt"
PIPER_VOICE_JSON_URL="https://github.com/rhasspy/piper-sample-generator/raw/master/models/${PIPER_VOICE_NAME}.pt.json"

# ---- args -------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
    case "$1" in
        --features-dir)
            FEATURES_DIR="$2"
            shift 2
            ;;
        -h|--help)
            grep '^#' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *)
            echo "Unknown arg: $1" >&2
            exit 1
            ;;
    esac
done

mkdir -p "$FEATURES_DIR"
echo "[setup] Features dir: $FEATURES_DIR"
echo "[setup] Scripts dir: $SCRIPTS_DIR"

# ---- 1. Python deps ---------------------------------------------------------

echo "[setup] Checking Python deps..."
python3 -m pip install --user \
    "onnx2tf" \
    "onnx" \
    "onnxruntime" \
    "tflite-runtime" \
    "tensorflow" \
    "phonemizer" \
    2>&1 | tail -3 || {
    echo "[setup] WARN: pip install failed. Check your network/Python environment." >&2
}

# ---- 2. Verify piper-sample-generator vendored -----------------------------

PIPER_SHIM_DIR="$SCRIPTS_DIR/piper-sample-generator"
if [[ ! -d "$PIPER_SHIM_DIR" ]] || [[ ! -f "$PIPER_SHIM_DIR/generate_samples.py" ]]; then
    echo "[setup] ERROR: piper-sample-generator shim missing at $PIPER_SHIM_DIR" >&2
    echo "[setup] Run 'git checkout scripts/piper-sample-generator' to restore it" >&2
    exit 1
fi
echo "[setup] ✓ piper-sample-generator shim present"

DP_SHIM="$SCRIPTS_DIR/dp/phonemizer.py"
if [[ ! -f "$DP_SHIM" ]]; then
    echo "[setup] ERROR: dp.phonemizer shim missing at $DP_SHIM" >&2
    exit 1
fi
echo "[setup] ✓ dp.phonemizer shim present"

PATCH_SCRIPT="$SCRIPTS_DIR/_oww_onnx_tflite_patch.py"
if [[ ! -f "$PATCH_SCRIPT" ]]; then
    echo "[setup] ERROR: _oww_onnx_tflite_patch.py missing at $PATCH_SCRIPT" >&2
    exit 1
fi
echo "[setup] ✓ _oww_onnx_tflite_patch.py present"

# ---- 3. Piper TTS voice model ----------------------------------------------

PIPER_MODEL_PATH="$PIPER_SHIM_DIR/models/${PIPER_VOICE_NAME}.pt"
PIPER_MODEL_JSON="$PIPER_SHIM_DIR/models/${PIPER_VOICE_NAME}.pt.json"
mkdir -p "$PIPER_SHIM_DIR/models"

if [[ ! -f "$PIPER_MODEL_PATH" ]]; then
    echo "[setup] Downloading Piper LibriTTS voice ($PIPER_VOICE_NAME, ~195 MB)..."
    curl -L --fail -o "$PIPER_MODEL_PATH" "$PIPER_VOICE_URL"
fi
if [[ ! -f "$PIPER_MODEL_JSON" ]]; then
    echo "[setup] Downloading Piper voice config..."
    curl -L --fail -o "$PIPER_MODEL_JSON" "$PIPER_VOICE_JSON_URL"
fi
echo "[setup] ✓ Piper voice: $PIPER_MODEL_PATH"

# ---- 4. openWakeWord feature files -----------------------------------------

ACAV_PATH="$FEATURES_DIR/openwakeword_features_ACAV100M_2000_hrs_16bit.npy"
VAL_PATH="$FEATURES_DIR/validation_set_features.npy"

if [[ ! -f "$ACAV_PATH" ]]; then
    echo "[setup] Downloading ACAV100M features (~17 GB, this will take a while)..."
    curl -L --fail -o "$ACAV_PATH" "$ACAV100M_URL"
fi
echo "[setup] ✓ ACAV100M features: $ACAV_PATH"

if [[ ! -f "$VAL_PATH" ]]; then
    echo "[setup] Downloading validation features (~177 MB)..."
    curl -L --fail -o "$VAL_PATH" "$VALIDATION_URL"
fi
echo "[setup] ✓ Validation features: $VAL_PATH"

# ---- 5. Sanity-check the shims end-to-end ----------------------------------

echo
echo "[setup] Running smoke test..."
SMOKE_OUT="$(mktemp -d)"
SMOKE_SAMPLES="$(mktemp -d)"
python3 -c "
import sys
sys.path.insert(0, '$SCRIPTS_DIR/piper-sample-generator')
import generate_samples
# 4 wavs of 'hey clawsuu' to prove the shim works
generate_samples.generate_samples(
    text=['hey clawsuu'] * 4,
    output_dir='$SMOKE_SAMPLES',
    max_samples=4,
    batch_size=2,
    noise_scales=[0.98],
    noise_scale_ws=[0.98],
    length_scales=[1.0],
    auto_reduce_batch_size=True,
)
print('smoke test: generated 4 wavs')
" 2>&1 | tail -3
WAV_COUNT=$(ls "$SMOKE_SAMPLES"/*.wav 2>/dev/null | wc -l)
if [[ "$WAV_COUNT" -lt 4 ]]; then
    echo "[setup] ERROR: smoke test failed (expected 4 wavs, got $WAV_COUNT)" >&2
    exit 1
fi
# Confirm 16kHz mono (openWakeWord's required input format)
python3 -c "
import wave
with wave.open('$SMOKE_SAMPLES/0.wav', 'rb') as w:
    assert w.getframerate() == 16000, f'expected 16000 Hz, got {w.getframerate()}'
    assert w.getnchannels() == 1, f'expected mono, got {w.getnchannels()}'
    assert w.getsampwidth() == 2, f'expected 16-bit, got {w.getsampwidth() * 8}-bit'
print('smoke test: wav format OK (16kHz mono PCM16)')
"
echo "[setup] ✓ Smoke test passed"
rm -rf "$SMOKE_OUT" "$SMOKE_SAMPLES"

# ---- done -------------------------------------------------------------------

echo
echo "[setup] All checks passed. You're ready to train wake-word models."
echo "[setup] Example:"
echo "[setup]   python3 scripts/train_wake_phrase.py \\"
echo "[setup]       --name hey_clawsuu \\"
echo "[setup]       --samples-dir /path/to/user/wavs/ \\"
echo "[setup]       --output-dir ~/.openclaw/cyberclaw/wake-training/companion_1/output/ \\"
echo "[setup]       --n-samples 10000 --n-samples-val 2000 --steps 20000"
echo "[setup] Features are at: $FEATURES_DIR"
echo "[setup] Pass --features-file / --validation-features to override these defaults."