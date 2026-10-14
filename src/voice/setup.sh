#!/usr/bin/env bash
# CyberClaw local voice engine installer (Linux / macOS).
# Creates ~/.openclaw/cyberclaw/voice/env with faster-whisper + Kokoro.
# GPU (NVIDIA) gets CUDA libraries; everything else runs on the CPU.
set -e
V="$HOME/.openclaw/cyberclaw/voice"
mkdir -p "$V"
command -v python3 >/dev/null || { echo "MISSING: python3"; exit 2; }
command -v ffmpeg  >/dev/null || { echo "MISSING: ffmpeg (Ubuntu: sudo apt install ffmpeg)"; exit 2; }
if [ ! -x "$V/env/bin/python3" ]; then
  python3 -m venv "$V/env" || { echo "MISSING: python3-venv (Ubuntu: sudo apt install python3-venv)"; exit 2; }
fi
"$V/env/bin/pip" install -q --upgrade pip wheel
"$V/env/bin/pip" install -q faster-whisper kokoro-onnx soundfile
if command -v nvidia-smi >/dev/null && nvidia-smi >/dev/null 2>&1; then
  echo "NVIDIA GPU found — installing CUDA libraries"
  "$V/env/bin/pip" install -q nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"
fi
"$V/env/bin/python3" -c "import faster_whisper, kokoro_onnx; print('IMPORT_OK')"
echo "SETUP_DONE"
