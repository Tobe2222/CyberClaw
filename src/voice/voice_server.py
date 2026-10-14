#!/usr/bin/env python3
"""CyberClaw local voice server (127.0.0.1 only).

Keeps the models loaded so a voice turn costs inference time, not load time.
  POST /stt  {audio_b64, mime, prompt?}  -> {text, ms, language}
  POST /tts  {text, voice, speed?}       -> {audio_b64 (wav), ms}
  GET  /health                           -> {stt, tts, device, voices}
STT: faster-whisper (default large-v3-turbo on CUDA, falls back to CPU int8).
TTS: Kokoro-82M (onnx). Everything runs on this machine.
"""
import base64, io, json, os, subprocess, sys, tempfile, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("CC_VOICE_PORT", "9251"))
MODELS = os.path.join(HERE, "models")
os.makedirs(MODELS, exist_ok=True)
CONFIG = os.path.join(HERE, "config.json")

# Speech model tiers. "auto" picks by hardware:
#   high     large-v3-turbo  (CUDA GPU with >= 6 GB)
#   balanced small.en        (smaller GPU, or a strong CPU)
#   light    base.en         (modest CPU — slower but works anywhere)
TIERS = {"high": "large-v3-turbo", "balanced": "small.en", "light": "base.en"}
def gpu_mem_mb():
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=5).stdout
        return max(int(x) for x in out.split() if x.strip().isdigit())
    except Exception:
        return 0
def read_config():
    try: return json.load(open(CONFIG))
    except Exception: return {}
def pick_stt_model():
    want = os.environ.get("CC_STT_MODEL") or read_config().get("stt_model") or "auto"
    if want in TIERS: return TIERS[want], want
    if want != "auto": return want, "custom"
    mem = gpu_mem_mb()
    if mem >= 6000: return TIERS["high"], "high"
    if mem >= 2000 or (os.cpu_count() or 1) >= 8: return TIERS["balanced"], "balanced"
    return TIERS["light"], "light"
STT_MODEL, STT_TIER = pick_stt_model()

# Make pip-installed CUDA libs visible to CTranslate2.
try:
    import nvidia.cublas, nvidia.cudnn  # noqa
    libs = [os.path.join(list(m.__path__)[0], "lib") for m in (nvidia.cublas, nvidia.cudnn)]
    os.environ["LD_LIBRARY_PATH"] = ":".join(libs + [os.environ.get("LD_LIBRARY_PATH", "")])
    import ctypes
    for d in libs:
        for f in sorted(os.listdir(d)):
            if f.endswith(".so") or ".so." in f:
                try: ctypes.CDLL(os.path.join(d, f), mode=ctypes.RTLD_GLOBAL)
                except OSError: pass
except Exception as e:
    print("[voice] cuda libs:", e, flush=True)

_stt = None; _stt_device = None; _tts = None
_lock = threading.Lock()

def stt():
    global _stt, _stt_device
    if _stt is None:
        from faster_whisper import WhisperModel
        try:
            if gpu_mem_mb() <= 0: raise RuntimeError("no NVIDIA GPU")
            _stt = WhisperModel(STT_MODEL, device="cuda", compute_type="float16" if gpu_mem_mb() >= 6000 else "int8_float16", download_root=MODELS)
            _stt_device = "cuda"
        except Exception as e:
            print("[voice] CUDA STT failed, using CPU:", e, flush=True)
            _stt = WhisperModel(STT_MODEL, device="cpu", compute_type="int8", download_root=MODELS)
            _stt_device = "cpu"
    return _stt

KOKORO_FILES = {
    "kokoro-v1.0.onnx": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
    "voices-v1.0.bin": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
}
def tts():
    global _tts
    if _tts is None:
        for name, url in KOKORO_FILES.items():
            p = os.path.join(MODELS, name)
            if not os.path.exists(p):
                print("[voice] downloading", name, flush=True)
                urllib.request.urlretrieve(url, p + ".part"); os.replace(p + ".part", p)
        from kokoro_onnx import Kokoro
        _tts = Kokoro(os.path.join(MODELS, "kokoro-v1.0.onnx"), os.path.join(MODELS, "voices-v1.0.bin"))
    return _tts

def fix_wav_header(raw):
    # A WAV read while the phone is still recording has size fields of 0.
    if len(raw) > 44 and raw[:4] == b"RIFF" and raw[8:12] == b"WAVE":
        b = bytearray(raw)
        b[4:8] = (len(b) - 8).to_bytes(4, "little")
        i = 12
        while i + 8 <= len(b):
            cid, size = bytes(b[i:i+4]), int.from_bytes(b[i+4:i+8], "little")
            if cid == b"data":
                b[i+4:i+8] = (len(b) - i - 8).to_bytes(4, "little"); break
            i += 8 + size
        return bytes(b)
    return raw

def to_wav16k(raw, mime):
    raw = fix_wav_header(raw)
    src = tempfile.NamedTemporaryFile(suffix=".wav" if "wav" in (mime or "") else ".m4a", delete=False)
    src.write(raw); src.close()
    out = src.name + ".16k.wav"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src.name, "-ar", "16000", "-ac", "1", out], check=True, timeout=30)
    os.unlink(src.name)
    return out

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path == "/health":
            voices = []
            try: voices = sorted(tts().get_voices())
            except Exception as e: voices = ["error: %s" % e]
            return self._send(200, {"ok": True, "stt": STT_MODEL, "tier": STT_TIER, "stt_loaded": _stt is not None, "device": _stt_device, "gpu_mb": gpu_mem_mb(), "cpus": os.cpu_count(), "voices": voices})
        self._send(404, {"error": "not found"})
    def do_POST(self):
        global STT_MODEL, STT_TIER, _stt, _stt_device
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
            t0 = time.time()
            if self.path == "/stt":
                wav = to_wav16k(base64.b64decode(body["audio_b64"]), body.get("mime"))
                try:
                    with _lock:
                        segs, info = stt().transcribe(wav, language=body.get("language") or None,
                            initial_prompt=body.get("prompt") or None, beam_size=5, vad_filter=True,
                            vad_parameters={"min_silence_duration_ms": 400})
                        text = " ".join(s.text.strip() for s in segs).strip()
                finally:
                    os.unlink(wav)
                return self._send(200, {"text": text, "language": info.language, "ms": int((time.time() - t0) * 1000), "device": _stt_device})
            if self.path == "/config":
                cfg = read_config(); cfg["stt_model"] = body.get("stt_model", "auto")
                json.dump(cfg, open(CONFIG, "w"))
                with _lock:
                    STT_MODEL, STT_TIER = pick_stt_model(); _stt = None; _stt_device = None
                threading.Thread(target=stt, daemon=True).start()
                return self._send(200, {"ok": True, "stt": STT_MODEL, "tier": STT_TIER})
            if self.path == "/tts":
                import soundfile as sf
                voice = body.get("voice") or "af_heart"
                lang = "en-gb" if voice.startswith(("bf_", "bm_")) else "en-us"
                samples, sr = tts().create(body["text"], voice=voice, speed=float(body.get("speed", 1.0)), lang=lang)
                buf = io.BytesIO(); sf.write(buf, samples, sr, format="WAV", subtype="PCM_16")
                return self._send(200, {"audio_b64": base64.b64encode(buf.getvalue()).decode(), "ms": int((time.time() - t0) * 1000)})
            self._send(404, {"error": "not found"})
        except Exception as e:
            self._send(500, {"error": str(e)})

if __name__ == "__main__":
    threading.Thread(target=lambda: (stt(), tts(), print("[voice] models ready", flush=True)), daemon=True).start()
    print("[voice] listening on 127.0.0.1:%d" % PORT, flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
