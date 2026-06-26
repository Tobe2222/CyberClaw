"""Shim package for `dp.phonemizer` — the DeepPhonemizer library was renamed to
`phonemizer` and is no longer importable as `dp.phonemizer`.

openWakeWord's `data.py` does:
    from dp.phonemizer import Phonemizer
    phonemizer = Phonemizer.from_checkpoint(phonemizer_mdl_path)
    ...
    phones = phonemizer(word, lang='en_us')

This shim provides a minimal `dp.phonemizer.Phonemizer` class that wraps the
modern `phonemizer` library (espeak backend). The shape is the same — a callable
that takes a word and returns a string of phonemes (no stress markers).

Why this exists:
- The `dp.phonemizer` package was an early version of DeepPhonemizer, last
  published to PyPI in 2021. It was deleted when the project was renamed to
  just `phonemizer` and the inference API changed.
- openWakeWord still imports `dp.phonemizer` for OOV-word phoneme prediction.
- Re-implementing the OOV fallback as espeak is actually BETTER for adversarial
  text generation — espeak is a well-tested grapheme-to-phoneme engine used by
  the official Piper TTS pipeline. The result is consistent with how the
  training positives get phonemized.

Tradeoff vs the original DeepPhonemizer model:
- Original: a neural G2P model trained on CMUDICT. Better at rare OOV words.
- Shim: espeak. Less accurate on proper nouns / novel words but consistent
  with how Piper TTS phonemizes the positives. For adversarial text
  generation this is actually desirable — the negatives should sound
  similar to the positives, and consistency of phonemization helps.
"""

from __future__ import annotations

import logging
from typing import List, Optional

_LOGGER = logging.getLogger(__name__)


class Phonemizer:
    """Thin wrapper that mimics the old dp.phonemizer.Phonemizer API.

    Usage (matching openWakeWord):
        p = Phonemizer.from_checkpoint("/path/to/checkpoint.pt")  # path unused
        phones_str = p("clawsuu", lang="en_us")
    """

    def __init__(self, checkpoint_path: Optional[str] = None) -> None:
        # The checkpoint path is accepted for API compatibility but not used —
        # we delegate to the modern `phonemizer` library instead.
        self._checkpoint_path = checkpoint_path

    @classmethod
    def from_checkpoint(cls, checkpoint_path: str) -> "Phonemizer":
        """openWakeWord calls this. We don't actually load the .pt file —
        espeak handles all the G2P we need.
        """
        _LOGGER.info(
            "dp.phonemizer shim: ignoring checkpoint %s; using espeak backend",
            checkpoint_path,
        )
        return cls(checkpoint_path=checkpoint_path)

    def __call__(self, word: str, lang: str = "en_us") -> str:
        """Phonemize a single word. Mirrors the old API.

        Returns:
            Space-separated phoneme tokens (with stress digits stripped),
            matching the format openWakeWord expects.

        Example:
            Phonemizer()( "clawsuu", "en_us" ) -> "K L AO S UW"
        """
        # Lazy import — keeps startup fast and lets us mock in tests
        from phonemizer import phonemize as _phonemize
        from phonemizer.backend import EspeakBackend

        # espeak uses "en-us" not "en_us"; normalize
        lang_arg = lang.replace("_", "-")

        try:
            raw = _phonemize(
                word,
                language=lang_arg,
                backend="espeak",
                strip=True,
                with_stress=False,
                njobs=1,
            )
        except Exception as e:
            _LOGGER.warning("Phonemizer shim: espeak failed on %r: %s", word, e)
            return ""

        raw = raw.strip()
        if not raw:
            return ""

        # espeak returns IPA-ish unicode (e.g. "klɔːsuː"). openWakeWord wants
        # ARPAbet-ish ASCII tokens ("K L AO S UW"). Do a coarse mapping.
        return _ipish_to_arpa_like(raw)


# ---------------------------------------------------------------------------
# IPA-ish to ARPAbet-ish mapping
#
# We don't need exact ARPAbet — adversarial text just needs SOMETHING that
# sounds different from the target. The downstream code (`data.py:957`)
# treats these as raw phoneme strings to feed into the random-walk phoneme
# substitution. So even partial mapping is fine.
# ---------------------------------------------------------------------------

_IPA_TO_ARPA = {
    # Vowels (most common)
    "ə": "AH", "ɛ": "EH", "æ": "AE", "ʌ": "AH", "ɔ": "AO", "oʊ": "OW",
    "aʊ": "AW", "aɪ": "AY", "eɪ": "EY", "i": "IH", "ɪ": "IH", "u": "UH",
    "ʊ": "UH", "ʉ": "UW", "iː": "IY", "uː": "UW", "e": "EH", "o": "OW",
    "ɑ": "AA", "ɒ": "AA", "ɜ": "ER", "ɝ": "ER", "ɐ": "AH", "œ": "ER",
    # Consonants
    "p": "P", "b": "B", "t": "T", "d": "D", "k": "K", "g": "G",
    "f": "F", "v": "V", "θ": "TH", "ð": "DH", "s": "S", "z": "Z",
    "ʃ": "SH", "ʒ": "ZH", "h": "HH", "tʃ": "CH", "dʒ": "JH",
    "m": "M", "n": "N", "ŋ": "NG", "l": "L", "ɹ": "R", "r": "R",
    "w": "W", "j": "Y", "ɲ": "N", "ʎ": "L",
    # Stress/length marks (drop)
    "ˈ": "", "ˌ": "", "ː": "", "̃": "", "̯": "",
}

# Diphthong combinations — espeak outputs multi-char tokens. Try longest first.
_DIPHTHONGS = sorted(
    [k for k in _IPA_TO_ARPA.keys() if len(k) > 1], key=len, reverse=True
)


def _ipish_to_arpa_like(ipa: str) -> str:
    """Map espeak IPA output to space-separated ARPAbet-ish tokens.

    Used to be a strict 1:1 lookup but espeak emits many multi-char tokens
    (diphthongs, affricates) so we greedy-match longest first.
    """
    out: List[str] = []
    i = 0
    s = ipa
    while i < len(s):
        matched = False
        # Try diphthongs first
        for d in _DIPHTHONGS:
            if s.startswith(d, i):
                out.append(_IPA_TO_ARPA[d])
                i += len(d)
                matched = True
                break
        if matched:
            continue
        ch = s[i]
        mapped = _IPA_TO_ARPA.get(ch, ch.upper() if ch.isalpha() else None)
        if mapped:
            out.append(mapped)
        # Skip anything unmapped silently — espeak uses diacritics we don't have
        i += 1
    return " ".join(t for t in out if t)


__all__ = ["Phonemizer"]