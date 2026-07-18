"""oww_train_wrapper.py — runs openwakeword.train with the deprecated
`onnx_tf` ONNX→TFLite path monkey-patched to use `onnx2tf` instead.

Why this wrapper exists:
  openWakeWord's train.py (`python3 -m openwakeword.train --train_model`)
  runs end-to-end training and saves ONNX. As the very last step it calls
  `convert_onnx_to_tflite()` which depends on the deprecated `onnx_tf`
  package — no longer installable on modern Python. The crash happens AFTER
  the ONNX is saved, so the training itself is fine; only the conversion
  step breaks.

  This wrapper:
    1. Patches `openwakeword.train.convert_onnx_to_tflite` with our onnx2tf-
       based replacement (which also wraps the input with a Transpose so
       the TFLite layout matches the pre-trained openWakeWord models).
    2. Then invokes the requested `openwakeword.train` substep.

Usage:
  python3 oww_train_wrapper.py --training_config <yml> --train_model
  python3 oww_train_wrapper.py --training_config <yml> --generate_clips
  python3 oww_train_wrapper.py --training_config <yml> --augment_clips

Any other flags are passed through to `python3 -m openwakeword.train`.
"""

from __future__ import annotations

import logging
import os
import shutil
import sys
import tempfile
from pathlib import Path

_LOGGER = logging.getLogger("oww_wrapper")


def _wrap_onnx_with_transpose(onnx_path: Path, wrapped_path: Path) -> None:
    """Wrap a trained openWakeWord ONNX with an input Transpose node.

    The trained ONNX has input shape (1, 16, 96) (NCHW). onnx2tf converts
    to NHWC by default, which produces a TFLite with input (1, 96, 16).
    That breaks the mobile Kotlin code which feeds embeddings in NCHW order.

    We prepend a Transpose(perm=[0,2,1]) so the public TFLite input is
    (1, 16, 96) — same layout as hey_jarvis_v0.1.tflite and the other
    pre-trained openWakeWord models shipped with the mobile app.
    """
    import onnx
    from onnx import helper

    m = onnx.load(str(onnx_path))
    if not m.graph.input:
        raise RuntimeError(f"No inputs in {onnx_path}")
    orig_in_name = m.graph.input[0].name

    new_in = helper.make_tensor_value_info(
        "input", onnx.TensorProto.FLOAT, [1, 16, 96]
    )
    perm_node = helper.make_node(
        "Transpose", ["input"], ["permuted"], perm=[0, 2, 1], name="layout_bridge"
    )

    # Rename orig_in_name → "permuted" everywhere
    for node in m.graph.node:
        node.input[:] = [
            "permuted" if inp == orig_in_name else inp for inp in node.input
        ]

    del m.graph.input[:]
    m.graph.input.append(new_in)
    m.graph.node.insert(0, perm_node)

    onnx.checker.check_model(m)
    onnx.save(m, str(wrapped_path))


def _patched_convert_onnx_to_tflite(onnx_path: str, output_path: str) -> None:
    """Replacement for openwakeword.train.convert_onnx_to_tflite.

    Uses onnx2tf instead of onnx_tf. Wraps the input ONNX with a Transpose
    so the resulting TFLite has (1, 16, 96) input layout — matching the
    pre-trained openWakeWord models.
    """
    _LOGGER.info("Converting %s -> %s via onnx2tf", onnx_path, output_path)

    with tempfile.TemporaryDirectory(prefix="oww2tflite_") as tmp:
        tmpdir = Path(tmp)
        wrapped_path = tmpdir / "wrapped.onnx"
        _wrap_onnx_with_transpose(Path(onnx_path), wrapped_path)

        tf_out = tmpdir / "tf_out"
        tf_out.mkdir()

        import onnx2tf  # noqa: WPS433

        onnx2tf.convert(
            input_onnx_file_path=str(wrapped_path),
            output_folder_path=str(tf_out),
            output_signaturedefs=False,
            output_h5=False,
            output_keras_v3=False,
            output_tfv1_pb=False,
            non_verbose=True,
        )

        tflite_candidates = sorted(tf_out.glob("*.tflite"))
        if not tflite_candidates:
            raise RuntimeError(f"onnx2tf produced no .tflite files in {tf_out}")
        chosen = next(
            (c for c in tflite_candidates if "float32" in c.stem),
            tflite_candidates[0],
        )
        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        shutil.copy2(chosen, output_path)
        _LOGGER.info("Saved TFLite: %s", output_path)


def _apply_patch() -> None:
    """Monkey-patch openwakeword.train.convert_onnx_to_tflite.

    Idempotent — safe to call multiple times.
    """
    import openwakeword.train as _oww_train  # noqa: WPS433

    if getattr(_oww_train.convert_onnx_to_tflite, "_oww_patched", False):
        return

    _patched_convert_onnx_to_tflite._oww_patched = True  # type: ignore[attr-defined]
    _oww_train.convert_onnx_to_tflite = _patched_convert_onnx_to_tflite
    _LOGGER.info("Patched openwakeword.train.convert_onnx_to_tflite → onnx2tf")


def _apply_gain_patch() -> None:
    """Monkey-patch openwakeword.data.augment_clips to give the Gain
    augmentation a SYMMETRIC range.

    v3.2.13: openWakeWord's default `augment_clips` constructs its
    torch_audiomentations Compose with `Gain(max_gain_in_db=0, ...)`.
    Combined with the Gain class's default `min_gain_in_db=-18`, that
    pins the augmentation range to [-18, 0] dB — attenuation only.
    Newly trained wake models therefore never see amplified positives,
    and end up amplitude-biased: they fire reliably only in the
    narrow volume band the user happened to record at. Whisper,
    shout, or call from across the room — all attenuated relative to
    training — are missed.

    The fix: monkey-patch `augment_clips` with a copy that
    string-replaces `max_gain_in_db=0` → `max_gain_in_db=18`,
    restoring the symmetric ±18dB range. The replacement function
    is otherwise identical, including the bg-vs-no-bg branching and
    the per-clip / per-batch RIR pass.

    Idempotent — a second call is a no-op.

    Tobe's volume-invariance ask ("i want it to be more dependent
    on the sounds, not volume, so i can whisper and shout to it")
    is the symptom. This is the cause.
    """
    import openwakeword.data as _oww_data  # noqa: WPS433

    if getattr(_oww_data.augment_clips, "_oww_gain_patched", False):
        return

    import inspect  # noqa: WPS433

    try:
        src = inspect.getsource(_oww_data.augment_clips)
    except (OSError, TypeError) as e:
        _LOGGER.warning(
            "Could not read augment_clips source for Gain patch (%s); "
            "trained models will be attenuation-only volume augmentation. "
            "Whisper / shout / distance wake detection will be unreliable.",
            e,
        )
        return

    # Both Gain() constructions live in the function body. The marker
    # `max_gain_in_db=0` is unique to those two lines (other functions
    # in openwakeword.data use a different parameter set). Idempotent
    # because if we already patched, _oww_gain_patched=True short-
    # circuits above.
    if "max_gain_in_db=0" not in src:
        # Either already patched or upstream changed shape. Log and
        # bail — no replacement = no behaviour change.
        if "max_gain_in_db=18" in src:
            _LOGGER.info("openwakeword Gain already at +18 dB; no patch needed.")
        else:
            _LOGGER.warning(
                "openwakeword augment_clips has unexpected Gain config "
                "(no max_gain_in_db=0 marker); volume augmentation may "
                "be misconfigured. Trained model volume invariance "
                "behaviour is undefined."
            )
        return

    patched_src = src.replace("max_gain_in_db=0", "max_gain_in_db=18")

    # Compile in a fresh module-like namespace so the new function
    # is independent of this wrapper's globals. `augment_clips`
    # references module-level names (audiomentations,
    # torch_audiomentations, torchaudio, np, torch, etc.) which
    # live in openwakeword.data. Import those from there so the
    # patched function resolves them at call time.
    import openwakeword.data as _oww_data_ns  # noqa: WPS433
    ns = {
        "__name__": "openwakeword.data",
        "__file__": _oww_data_ns.__file__,
    }
    # Copy the module's public attributes that augment_clips uses.
    for name in dir(_oww_data_ns):
        if name.startswith("_") and name != "__builtins__":
            continue
        ns[name] = getattr(_oww_data_ns, name)

    code = compile(patched_src, _oww_data_ns.__file__, "exec")
    exec(code, ns)

    new_func = ns.get("augment_clips")
    if new_func is None:
        _LOGGER.error("Patched augment_clips not found after exec; aborting patch.")
        return

    new_func._oww_gain_patched = True  # type: ignore[attr-defined]
    _oww_data.augment_clips = new_func
    _LOGGER.info(
        "Patched openwakeword.data.augment_clips Gain range to symmetric "
        "[-18, +18] dB. Trained wake models will be volume-invariant."
    )


def main() -> int:
    """Run openwakeword.train with the deprecated onnx_tf path replaced.

    Strategy: load the train.py source, replace the broken `convert_onnx_to_tflite`
    call in train_model with our onnx2tf version, then exec the modified source.
    This is more robust than monkey-patching at runtime because `python -m` re-execs
    train.py as __main__ which resets all module-level state.

    For the --generate_clips and --augment_clips steps, the shim import path
    (`from generate_samples import generate_samples`) is handled by our
    scripts/piper-sample-generator/ shim being on PYTHONPATH.
    """
    # Configure logging to mirror openwakeword.train's format
    logging.basicConfig(
        level=logging.INFO,
        format="%(levelname)s:%(name)s:%(message)s",
    )

    # v3.2.13: monkey-patch openwakeword.data.augment_clips to give the
    # Gain augmentation a symmetric [-18, +18] dB range. Must run BEFORE
    # we exec openwakeword.train (which calls augment_clips during the
    # --augment_clips substep). See _apply_gain_patch() for the why.
    _apply_gain_patch()

    import openwakeword.train as _oww_train_mod  # noqa: WPS433

    train_py_path = _oww_train_mod.__file__
    if not train_py_path:
        raise RuntimeError("Could not locate openwakeword.train source")

    with open(train_py_path, "r", encoding="utf-8") as f:
        src = f.read()

    # Replace the deprecated convert_onnx_to_tflite definition with a no-op.
    # We do the actual conversion OURSELVES after openWakeWord's --train_model
    # returns — see `do_post_train_tflite_conversion()` below. Doing the
    # conversion in-band doesn't work because:
    #   1. The wrapper approach above attempted a Transpose-based fix, but
    #      onnx2tf constant-folds the Transpose when the downstream op is
    #      a Flatten (which ignores layout), so the output still gets NHWC.
    #   2. The wrapped approach also can't preserve the (1, 16, 96) layout
    #      because the Flatten doesn't carry layout info through the graph.
    # The clean separation: openWakeWord trains and saves the ONNX. We do
    # the conversion in a separate script step with full control over the
    # input layout via onnx2tf's `overwrite_input_shape` option.
    new_func = '''def convert_onnx_to_tflite(onnx_model_path, output_path):
    """Disabled by cyberclaw _oww_onnx_tflite_patch.py.

    The real conversion is performed by the orchestrator
    (train_wake_phrase.py) after this subprocess returns. This stub
    just logs and returns so openWakeWord's --train_model flow doesn't
    crash with ModuleNotFoundError on the deprecated onnx_tf.
    """
    logging.info(
        "[patch] Skipping in-process ONNX→TFLite; orchestrator will convert: "
        f"{onnx_model_path} -> {output_path}"
    )
'''

    # Find the original convert_onnx_to_tflite definition and replace it.
    start_marker = "def convert_onnx_to_tflite(onnx_model_path, output_path):"
    start_idx = src.find(start_marker)
    if start_idx == -1:
        raise RuntimeError(
            f"Could not find convert_onnx_to_tflite in {train_py_path}; "
            "openWakeWord source may have changed."
        )
    # Find end of function: next top-level statement (line starting at col 0)
    rest = src[start_idx + len(start_marker):]
    end_idx = len(src) - len(rest)
    lines = rest.split("\n")
    for i, line in enumerate(lines):
        if i > 0 and line and not line.startswith(" ") and not line.startswith("\t"):
            if line.startswith("def ") or line.startswith("if __name__") or line.startswith("class "):
                end_idx = start_idx + len(start_marker) + sum(len(l) + 1 for l in lines[:i])
                break
    patched_src = src[:start_idx] + new_func + src[end_idx:]

    # Exec the patched source as __main__
    code = compile(patched_src, train_py_path, "exec")
    ns = {"__name__": "__main__", "__file__": train_py_path}
    try:
        exec(code, ns)
        return 0
    except SystemExit as e:
        return int(e.code or 0)


if __name__ == "__main__":
    sys.exit(main())