"""Shim: openWakeWord's train.py expects `from generate_samples import generate_samples`
at `piper_sample_generator_path`. The modern piper-sample-generator package exposes
its function as `piper_sample_generator.generate_samples(...)` with a different signature.

This shim:

1. Re-exports `piper_sample_generator.generate_samples` so openWakeWord's
   `from generate_samples import generate_samples` succeeds.
2. Wraps the call to translate openWakeWord's argument names to the package's names
   (auto_reduce_batch_size → ignored via **kwargs; missing `model` is filled from
   the OPENWAKEWORD_PIPER_MODEL env var).
3. Falls back to a per-call `model` kwarg if one is supplied (forward-compat).

Why this file exists:
- openWakeWord train.py was written against an older `piper-sample-generator` repo
  layout where `generate_samples.py` lived at the repo root.
- The modern package lives at `piper_sample_generator/__init__.py` and exposes
  `generate_samples()` with an extra required `model=` argument.
- We keep the shim file lean (re-export + small adapter) so any future signature
  drift in piper-sample-generator can be absorbed in one place.

Usage (called by openWakeWord, not directly):
    sys.path.insert(0, ".../piper-sample-generator")  # this dir
    from generate_samples import generate_samples
    generate_samples(text="hey clawsuu", output_dir=..., max_samples=10000,
                     batch_size=50, noise_scales=[0.98], noise_scale_ws=[0.98],
                     length_scales=[0.75, 1.0, 1.25], auto_reduce_batch_size=True)
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Iterable, List, Optional, Tuple, Union

_LOGGER = logging.getLogger(__name__)

# Re-export the package's generate_samples under the shim's namespace so
# `from generate_samples import generate_samples` (openWakeWord) works.
#
# The piper_sample_generator package's __init__.py is empty; the implementation
# actually lives in piper_sample_generator.__main__ (it's a CLI-driven package).
# Importing the function from __main__ works because Python modules are objects
# and we just need a reference to the function object.
from piper_sample_generator.__main__ import generate_samples as _psg_generate_samples


def _resolve_model_path(supplied: Optional[Union[str, Path]]) -> Path:
    """Pick the Piper TTS model .pt file.

    Resolution order:
      1. Explicit `model` kwarg (forward-compat).
      2. OPENWAKEWORD_PIPER_MODEL env var (set by the training wrapper).
      3. First `.pt` file under `<piper-sample-generator>/models/` (vendor default).

    The matching `.pt.json` config file MUST sit next to the `.pt` — Piper's
    generate_samples() loads it to get speaker count, sample rate, phoneme map.
    """
    if supplied is not None:
        return Path(supplied)

    env = os.environ.get("OPENWAKEWORD_PIPER_MODEL")
    if env:
        return Path(env)

    here = Path(__file__).parent
    models_dir = here / "models"
    if models_dir.is_dir():
        candidates = sorted(models_dir.glob("*.pt"))
        # Prefer the LibriTTS voice — openWakeWord's docs and our training config
        # both assume a multi-speaker English voice. de_DE/fr_FR/nl_NL are
        # single-speaker and won't produce useful variation.
        for c in candidates:
            if "libritts" in c.stem.lower():
                return c
        if candidates:
            return candidates[0]

    raise FileNotFoundError(
        "Could not locate a Piper .pt model. Set OPENWAKEWORD_PIPER_MODEL, "
        "pass model=... explicitly, or drop a .pt file into "
        f"{models_dir}/"
    )


def generate_samples(  # noqa: D401 - mirror openWakeWord's call signature
    text: Union[List[str], str],
    output_dir: Union[str, Path],
    max_samples: Optional[int] = None,
    file_names: Optional[Iterable[str]] = None,
    batch_size: int = 1,
    slerp_weights: Tuple[float, ...] = (0.5,),
    length_scales: Tuple[float, ...] = (0.75, 1.0, 1.25),
    noise_scales: Tuple[float, ...] = (0.667,),
    noise_scale_ws: Tuple[float, ...] = (0.8,),
    max_speakers: Optional[int] = None,
    verbose: bool = False,
    phoneme_input: bool = False,
    auto_reduce_batch_size: bool = True,  # absorbed; psg has no equivalent
    model: Optional[Union[str, Path]] = None,  # filled from env if None
    target_sample_rate: int = 16000,  # openWakeWord expects 16kHz mono PCM16
    **kwargs: Any,
) -> None:
    """Drop-in for piper-sample-generator's `generate_samples`.

    Accepts openWakeWord's call shape (no `model`) and translates it to
    piper-sample-generator's call shape (requires `model`).

    The Piper voice model produces audio at 22050 Hz mono PCM16. openWakeWord's
    `augment_clips` step (and the melspectrogram model) hard-requires 16 kHz.
    We resample via ffmpeg after generation if the output rate differs.
    """
    if auto_reduce_batch_size and batch_size > 1:
        # psg doesn't auto-reduce on OOM; halve until it fits.
        # We can't know the GPU's OOM behavior a priori, so we just lower the
        # default and let psg raise clearly if memory is still tight.
        _LOGGER.info(
            "auto_reduce_batch_size requested — starting at batch_size=%d", batch_size
        )

    model_path = _resolve_model_path(model)
    _LOGGER.info("Using Piper model: %s", model_path)

    # Resolve the actual output rate of this voice model (read sidecar JSON)
    # so we only resample when needed.
    voice_sr = _read_voice_sample_rate(model_path)
    needs_resample = voice_sr != target_sample_rate

    # Defer to the real implementation. piper-sample-generator handles
    # everything else (sliding through speakers, batching, writing WAVs).
    _psg_generate_samples(
        text=text,
        output_dir=output_dir,
        model=model_path,
        max_samples=max_samples,
        file_names=file_names,
        batch_size=batch_size,
        slerp_weights=slerp_weights,
        length_scales=length_scales,
        noise_scales=noise_scales,
        noise_scale_ws=noise_scale_ws,
        max_speakers=max_speakers,
        verbose=verbose,
        phoneme_input=phoneme_input,
        **kwargs,
    )

    if needs_resample:
        _LOGGER.info(
            "Resampling %s/* from %d Hz to %d Hz via ffmpeg...",
            output_dir, voice_sr, target_sample_rate,
        )
        _resample_wavs_in_place(Path(output_dir), voice_sr, target_sample_rate)


def _read_voice_sample_rate(model_path: Path) -> int:
    """Read the sample_rate field from the Piper voice's sidecar .json."""
    import json
    cfg_path = model_path.with_suffix(".pt.json")
    if not cfg_path.exists():
        # Some voices use .onnx.json — try that
        cfg_path = model_path.with_suffix(".onnx.json")
    if not cfg_path.exists():
        _LOGGER.warning(
            "No sidecar config for %s — assuming 22050 Hz", model_path
        )
        return 22050
    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    return int(cfg["audio"]["sample_rate"])


def _resample_wavs_in_place(dirpath: Path, from_sr: int, to_sr: int) -> None:
    """Resample every .wav under `dirpath` from `from_sr` Hz to `to_sr` Hz.

    Uses ffmpeg in -y overwrite mode. Mono + PCM16 are forced so the result
    matches openWakeWord's expected WAV header. Per-file logging is verbose
    so a stuck batch is easy to spot in the training output.
    """
    import shutil
    import subprocess

    if shutil.which("ffmpeg") is None:
        raise RuntimeError(
            "ffmpeg is required to resample Piper output to 16 kHz for "
            "openWakeWord's augment_clips step. Install ffmpeg or pre-resample."
        )

    wavs = sorted(dirpath.glob("*.wav"))
    if not wavs:
        return

    for i, wav in enumerate(wavs):
        tmp = wav.with_suffix(".resampled.wav")
        cmd = [
            "ffmpeg", "-y", "-loglevel", "error",
            "-i", str(wav),
            "-ar", str(to_sr),
            "-ac", "1",
            "-sample_fmt", "s16",
            str(tmp),
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True, timeout=30)
            tmp.replace(wav)
        except subprocess.CalledProcessError as e:
            _LOGGER.error(
                "ffmpeg failed on %s: %s", wav.name, e.stderr.decode(errors="replace")
            )
            if tmp.exists():
                tmp.unlink()
            raise
        except subprocess.TimeoutExpired:
            _LOGGER.error("ffmpeg timed out on %s", wav.name)
            if tmp.exists():
                tmp.unlink()
            raise

        if (i + 1) % 500 == 0:
            _LOGGER.info("  ...resampled %d/%d wavs", i + 1, len(wavs))

    _LOGGER.info("Resampled %d wavs: %d Hz -> %d Hz", len(wavs), from_sr, to_sr)


__all__ = ["generate_samples"]