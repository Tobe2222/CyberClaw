#!/usr/bin/env python3
"""
Simple Piper TTS wrapper for CyberClaw.
Usage: python3 piper-tts.py <model_path> <config_path> <output_wav> "<text>"
"""

import sys
import wave
from piper.voice import PiperVoice

if len(sys.argv) < 5:
    print("Usage: piper-tts.py <model> <config> <output> <text>", file=sys.stderr)
    sys.exit(1)

model_path = sys.argv[1]
config_path = sys.argv[2]
output_path = sys.argv[3]
text = sys.argv[4]

try:
    voice = PiperVoice.load(model_path, config_path=config_path)
    with wave.open(output_path, 'wb') as wav_file:
        voice.synthesize_wav(text, wav_file)
    print("OK", flush=True)
except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr, flush=True)
    sys.exit(1)
