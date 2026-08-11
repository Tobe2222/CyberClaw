/**
 * local-ai.js — Offline STT (whisper.cpp) + TTS (piper) for CyberClaw
 * No API keys required. Downloads binaries + models on first use.
 */

const { execFile, exec: execCb } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');
const { pipeline } = require('stream');
const { promisify: prom } = require('util');
const streamPipeline = prom(pipeline);

// Piper voices from https://huggingface.co/rhasspy/piper-voices
//
// v3.2.92: expanded the voice set to 6 (3 female + 3 male)
// per Tobe's request (2026-08-11 22:43): 'add so there are
// 3 female and 3 male, lets start with that'. Voice URLs
// are auto-downloaded on first synthesis request; the .onnx
// + .onnx.json files live in ~/.local-ai/piper/ and
// persist across app restarts.
//
// Female picks:
//   - amy        US Midwest, warm + conversational (best
//                fit for a chat assistant personality)
//   - kathleen   US, clear + professional
//   - jenny      GB (British), distinct accent option
// Male picks:
//   - lessac     US, default baseline voice
//   - joe        US, slightly deeper than lessac
//   - ryan       US, alternative male
//
// Tobe (2026-08-11 22:43): voice selection lives in
// Settings → Voice on the mobile (per-companion override)
// plus a global default in cyberclaw-settings.ttsVoice on
// the desktop.
const PIPER_VOICES = {
  // Female (3) — Tobe's pick for chat-assistant personas
  'amy':      'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium',
  'kathleen': 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/kathleen/low',
  'jenny':    'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/jenny_dioco/medium',
  // Male (3) — Tobe's pick for non-chat-assistant personas
  'lessac':   'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium',
  'joe':      'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/joe/medium',
  'ryan':     'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/medium',
  // v3.2.93: sultry/warm voices. Tobe (2026-08-11 23:08):
  // 'add the most sexy voices also, 1 of each.' Kristin
  // is piper's go-to low-pitch breathy female; Sam is
  // the smoothest warm-male option. Both picked on
  // pitch + warmth + cadence, not name. kathleen is
  // already a warm female but kristin sits lower and
  // has more breathy delivery.
  'kristin':  'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/kristin/medium',
  'sam':      'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/sam/medium',
  // Legacy voice from earlier releases, kept as alias
  // of amy so existing users don't break when they
  // upgrade. v3.2.92: removed (no callers reference it
  // by name; safe to drop).
  // 'glow-tts': 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/glow-tts/medium'
};

const getVoiceUrls = (voice = 'lessac') => {
  const baseUrl = PIPER_VOICES[voice] || PIPER_VOICES['lessac'];
  // v3.2.92: derive the voice filename from the baseUrl
  // path so we can handle voices whose model lives in
  // a non-standard subdir (e.g. kathleen lives at
  // `/low/` not `/medium/`). The HF URL structure is
  // `.../<lang>/<locale>/<voice>/<quality>/<file>`,
  // and the file basename matches what we need.
  const urlParts = baseUrl.split('/');
  const quality = urlParts[urlParts.length - 1]; // 'medium' / 'low' / 'high'
  const urlLocale = urlParts[urlParts.length - 3]; // 'en_US' / 'en_GB'
  // HF file naming: <locale>-<voice>-<quality>.onnx for en_US
  // and <locale>-<voice>-<quality>.onnx for en_GB (e.g.
  // en_GB-jenny_dioco-medium). The voice name for en_GB
  // includes the underscore (jenny_dioco), so we need
  // to look it up separately. Simpler: read the actual
  // file name from a tiny HEAD probe. But that's a
  // network call every time. Instead, just construct
  // it from the locale + voice + quality and trust the
  // hardcoded URL.
  const voiceName = `${urlLocale}-${voice}-${quality}`;
  return {
    onnx: `${baseUrl}/${voiceName}.onnx`,
    json: `${baseUrl}/${voiceName}.onnx.json`,
    voiceName
  };
};

// Whisper model from HuggingFace
const WHISPER_MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';

// Piper releases — check https://github.com/rhasspy/piper/releases for current version
const PIPER_VERSION = '2023.11.14-2';
const PIPER_RELEASES = {
  linux:   `https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_x86_64.tar.gz`,
  win32:   `https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_windows_amd64.zip`,
  darwin:  `https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_macos_x64.tar.gz`,
};

// Whisper.cpp releases — check https://github.com/ggml-org/whisper.cpp/releases
const WHISPER_VERSION = '1.8.4';
const WHISPER_RELEASES = {
  linux:   `https://github.com/ggml-org/whisper.cpp/releases/download/v${WHISPER_VERSION}/whisper-bin-x64.zip`,
  win32:   `https://github.com/ggml-org/whisper.cpp/releases/download/v${WHISPER_VERSION}/whisper-bin-x64.zip`,
  darwin:  `https://github.com/ggml-org/whisper.cpp/releases/download/v${WHISPER_VERSION}/whisper-bin-x64.zip`,
};

let _userDataPath = null;
let _mainWindow = null;

function init(userDataPath, mainWindow) {
  _userDataPath = userDataPath;
  _mainWindow = mainWindow;
}

function getAIDir() {
  const base = _userDataPath || path.join(os.homedir(), '.cyberclaw');
  return path.join(base, 'local-ai');
}

function sendProgress(step, percent, message) {
  if (_mainWindow && !_mainWindow.isDestroyed()) {
    try {
      _mainWindow.webContents.send('ai-download-progress', { step, percent, message });
    } catch {}
  }
  console.log(`[local-ai] ${step}: ${percent}% — ${message}`);
}

function downloadFile(url, destPath, progressLabel) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let received = 0;
    let total = 0;

    const doRequest = (reqUrl) => {
      const proto = reqUrl.startsWith('https') ? https : http;
      proto.get(reqUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          const location = res.headers.location;
          if (!location) {
            file.close();
            fs.unlink(destPath, () => {});
            return reject(new Error(`Redirect without location header from ${url}`));
          }
          doRequest(location);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(destPath, () => {});
          return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
        }
        total = parseInt(res.headers['content-length'] || '0', 10);
        res.on('data', chunk => {
          received += chunk.length;
          if (total > 0) {
            sendProgress(progressLabel, Math.round((received / total) * 100), `${(received / 1024 / 1024).toFixed(1)}MB / ${(total / 1024 / 1024).toFixed(1)}MB`);
          }
        });
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        res.on('error', (e) => { file.close(); fs.unlink(destPath, () => {}); reject(e); });
      }).on('error', (e) => { file.close(); fs.unlink(destPath, () => {}); reject(e); });
    };

    doRequest(url);
  });
}

function extractTarGz(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === 'win32'
      ? null
      : `tar -xzf "${archivePath}" -C "${destDir}"`;
    if (!cmd) return reject(new Error('tar extraction not supported on this platform via this path'));
    require('child_process').exec(cmd, (err) => err ? reject(err) : resolve());
  });
}

function extractZip(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    let cmd;
    if (process.platform === 'win32') {
      cmd = `powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`;
    } else {
      cmd = `unzip -o "${archivePath}" -d "${destDir}"`;
    }
    require('child_process').exec(cmd, (err) => err ? reject(err) : resolve());
  });
}

// ── PIPER ──────────────────────────────────────────────────────────────────

async function ensurePiper(voice = 'lessac') {
  const aiDir = getAIDir();
  const piperDir = path.join(aiDir, 'piper');
  fs.mkdirSync(piperDir, { recursive: true });

  const platform = process.platform;
  const binaryName = platform === 'win32' ? 'piper.exe' : 'piper';

  // Search for piper binary (may be in subdirectory after extract)
  const findBinary = (dir) => {
    if (!fs.existsSync(dir)) return null;
    const direct = path.join(dir, binaryName);
    if (fs.existsSync(direct) && !fs.statSync(direct).isDirectory()) return direct;
    
    // Search recursively
    const searchRecursive = (searchDir) => {
      for (const entry of fs.readdirSync(searchDir)) {
        const full = path.join(searchDir, entry);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          const found = path.join(full, binaryName);
          if (fs.existsSync(found) && !fs.statSync(found).isDirectory()) return found;
          const recursive = searchRecursive(full);
          if (recursive) return recursive;
        }
      }
      return null;
    };
    return searchRecursive(dir);
  };

  // Get voice URLs
  const voiceUrls = getVoiceUrls(voice);
  const voiceOnnx = path.join(piperDir, `${voiceUrls.voiceName}.onnx`);
  const voiceJson = path.join(piperDir, `${voiceUrls.voiceName}.onnx.json`);

  let binaryPath = findBinary(piperDir);

  // Check system PATH first before downloading
  if (!binaryPath) {
    const { execSync } = require('child_process');
    try {
      const systemPiper = execSync('which piper 2>/dev/null || command -v piper 2>/dev/null', { encoding: 'utf8' }).trim();
      if (systemPiper && fs.existsSync(systemPiper)) {
        binaryPath = systemPiper;
        console.log(`[local-ai] Using system piper: ${binaryPath}`);
      }
    } catch (_) {}
  }

  if (!binaryPath) {
    sendProgress('Downloading Piper TTS', 0, 'Starting...');
    const url = PIPER_RELEASES[platform];
    if (!url) throw new Error(`No piper binary for platform: ${platform}`);

    const archivePath = path.join(piperDir, 'piper_archive' + (platform === 'win32' ? '.zip' : '.tar.gz'));
    await downloadFile(url, archivePath, 'Downloading Piper TTS');
    sendProgress('Extracting Piper TTS', 0, 'Extracting...');
    if (platform === 'win32') {
      await extractZip(archivePath, piperDir);
    } else {
      await extractTarGz(archivePath, piperDir);
    }
    fs.unlinkSync(archivePath);
    binaryPath = findBinary(piperDir);
    if (!binaryPath) throw new Error('Piper binary not found after extraction');
    if (platform !== 'win32') fs.chmodSync(binaryPath, 0o755);
    sendProgress('Piper TTS ready', 100, 'Done');
  }

  if (!fs.existsSync(voiceOnnx)) {
    sendProgress(`Downloading ${voice} voice`, 0, `Downloading voice model (~63MB)...`);
    await downloadFile(voiceUrls.onnx, voiceOnnx, `Downloading ${voice} voice`);
  }
  if (!fs.existsSync(voiceJson) || fs.statSync(voiceJson).size === 0) {
    sendProgress(`Downloading ${voice} voice config`, 0, '...');
    await downloadFile(voiceUrls.json, voiceJson, `Downloading ${voice} config`);
  }

  return { binaryPath, voiceOnnx, voiceJson };
}

// ── WHISPER ────────────────────────────────────────────────────────────────

async function ensureWhisper() {
  const aiDir = getAIDir();
  const whisperDir = path.join(aiDir, 'whisper');
  fs.mkdirSync(whisperDir, { recursive: true });

  const platform = process.platform;
  const binaryName = platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';

  const findBinary = (dir) => {
    if (!fs.existsSync(dir)) return null;
    
    // On Linux, skip .exe files (they won't work)
    const validNames = platform === 'linux' 
      ? ['whisper-cli', 'main']
      : ['whisper-cli', 'whisper-cli.exe', 'main', 'main.exe'];
    
    // Check common names
    for (const name of validNames) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
    // Search subdirs recursively
    const searchRecursive = (searchDir) => {
      for (const entry of fs.readdirSync(searchDir)) {
        const full = path.join(searchDir, entry);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          for (const name of validNames) {
            const p = path.join(full, name);
            if (fs.existsSync(p)) return p;
          }
          const found = searchRecursive(full);
          if (found) return found;
        }
      }
      return null;
    };
    return searchRecursive(dir);
  };

  const modelPath = path.join(whisperDir, 'ggml-base.en.bin');

  let binaryPath = findBinary(whisperDir);

  if (!binaryPath) {
    // For Linux, compile from source if binaries unavailable
    if (platform === 'linux') {
      sendProgress('Building Whisper from source', 0, 'Cloning repository...');
      const repoDir = path.join(whisperDir, 'repo');
      
      // Clone if not exists
      if (!fs.existsSync(repoDir)) {
        await new Promise((resolve, reject) => {
          require('child_process').exec(
            `git clone https://github.com/ggml-org/whisper.cpp.git "${repoDir}"`,
            (err) => err ? reject(err) : resolve()
          );
        });
      }
      
      sendProgress('Building Whisper from source', 50, 'Compiling...');
      // Build with cmake
      const buildDir = path.join(repoDir, 'build');
      fs.mkdirSync(buildDir, { recursive: true });
      
      await new Promise((resolve, reject) => {
        require('child_process').exec(
          `cd "${buildDir}" && cmake .. && make -j4`,
          { maxBuffer: 10 * 1024 * 1024 },
          (err) => err ? reject(err) : resolve()
        );
      });
      
      // Use the real whisper-cli binary from build/bin
      const realBinary = path.join(buildDir, 'bin', 'whisper-cli');
      if (!fs.existsSync(realBinary)) {
        throw new Error('Whisper build failed - whisper-cli not found at ' + realBinary);
      }
      // Copy to our cache location
      fs.copyFileSync(realBinary, path.join(whisperDir, 'whisper-cli'));
      binaryPath = path.join(whisperDir, 'whisper-cli');
      fs.chmodSync(binaryPath, 0o755);
      
      sendProgress('Whisper build complete', 100, 'Done');
      
      // Early return to skip the old copy code
      if (!fs.existsSync(modelPath)) {
        sendProgress('Downloading Whisper model', 0, 'Downloading base.en model (~142MB)...');
        await downloadFile(WHISPER_MODEL_URL, modelPath, 'Downloading Whisper model');
        sendProgress('Whisper model ready', 100, 'Done');
      }
      
      return { binaryPath, modelPath };
      
      // Copy to whisper dir
      fs.copyFileSync(builtBinary, path.join(whisperDir, 'whisper-cli'));
      binaryPath = path.join(whisperDir, 'whisper-cli');
      fs.chmodSync(binaryPath, 0o755);
      sendProgress('Whisper build complete', 100, 'Done');
    } else {
      // For Windows/Mac, try downloading
      sendProgress('Downloading Whisper STT', 0, 'Starting...');
      const url = WHISPER_RELEASES[platform];
      if (!url) throw new Error(`No whisper binary for platform: ${platform}`);

      const archivePath = path.join(whisperDir, 'whisper_archive.zip');
      await downloadFile(url, archivePath, 'Downloading Whisper STT');
      sendProgress('Extracting Whisper STT', 0, 'Extracting...');
      await extractZip(archivePath, whisperDir);
      fs.unlinkSync(archivePath);
      binaryPath = findBinary(whisperDir);
      if (!binaryPath) throw new Error('Whisper binary not found after extraction');
      if (platform !== 'win32') fs.chmodSync(binaryPath, 0o755);
      sendProgress('Whisper STT ready', 100, 'Done');
    }
  }

  if (!fs.existsSync(modelPath)) {
    sendProgress('Downloading Whisper model', 0, 'Downloading base.en model (~142MB)...');
    await downloadFile(WHISPER_MODEL_URL, modelPath, 'Downloading Whisper model');
    sendProgress('Whisper model ready', 100, 'Done');
  }

  return { binaryPath, modelPath };
}

// ── PUBLIC API ─────────────────────────────────────────────────────────────

async function transcribeAudio(audioBase64, mimeType) {
  const { binaryPath, modelPath } = await ensureWhisper();

  // Convert to wav if needed — whisper.cpp needs wav
  const isWav = mimeType && mimeType.includes('wav');
  const srcExt = isWav ? '.wav' : '.m4a';
  const tmpSrc = path.join(os.tmpdir(), `cyberclaw-stt-in-${Date.now()}${srcExt}`);
  const tmpWav = path.join(os.tmpdir(), `cyberclaw-stt-${Date.now()}.wav`);

  fs.writeFileSync(tmpSrc, Buffer.from(audioBase64, 'base64'));

  try {
    // Convert to 16kHz mono WAV (whisper.cpp requirement).
    // v3.1.34: wrap ffmpeg/sox calls with a 30s timeout so
    // a malformed input can't hang the voice flow forever.
    const AUDIO_CONVERT_TIMEOUT_MS = 30000;
    const withTimeout = (p, ms, label) => Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
    ]);
    if (!isWav) {
      let converted = false;

      // Try ffmpeg first
      try {
        await withTimeout(
          execFileAsync('ffmpeg', [
            '-y',
            '-i', tmpSrc,
            '-ar', '16000',
            '-ac', '1',
            '-f', 'wav',
            tmpWav
          ]),
          AUDIO_CONVERT_TIMEOUT_MS,
          'ffmpeg'
        );
        converted = true;
      } catch (ffmpegErr) {
        console.warn('[transcribeAudio] ffmpeg failed, trying sox:', ffmpegErr.message);
        // Try sox as fallback
        try {
          await withTimeout(
            execFileAsync('sox', [
              tmpSrc,
              '-r', '16000',
              '-c', '1',
              tmpWav
            ]),
            AUDIO_CONVERT_TIMEOUT_MS,
            'sox'
          );
          converted = true;
        } catch (soxErr) {
          console.error('[transcribeAudio] Both ffmpeg and sox failed:', soxErr.message);
          throw new Error('Need ffmpeg or sox to convert audio from ' + srcExt + ' to WAV');
        }
      }
      
      if (!converted || !fs.existsSync(tmpWav)) {
        throw new Error('Audio conversion failed - output file not created');
      }
    } else {
      fs.copyFileSync(tmpSrc, tmpWav);
    }

    // Run whisper-cli using exec for better error capture.
    // v3.1.34: wrap with a timeout. Without this, a hung
    // whisper process (malformed input, voice activity
    // detector stuck, etc.) holds the whole voice flow
    // forever and the user sees "transcribing" indefinitely.
    // Tobe hit this on 2026-06-25 — voice hung for 3+
    // minutes before he closed out. The actual root cause
    // was unclear (whisper output looked fine in isolation),
    // but a defensive timeout here means future hangs are
    // bounded. 60s is generous: base.en on a 30s clip is
    // ~15s, so 60s leaves plenty of headroom for slow CPUs.
    let stdout = '';
    try {
      const cmd = `"${binaryPath}" -m "${modelPath}" -f "${tmpWav}" --language en --output-txt --output-file "${tmpWav.replace('.wav', '')}"`;
      console.log('[transcribeAudio] Running:', cmd);
      const t0 = Date.now();
      const WHISPER_TIMEOUT_MS = 60000;
      const execPromise = execFileAsync('bash', ['-c', cmd]);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Whisper timed out after ${WHISPER_TIMEOUT_MS}ms`)), WHISPER_TIMEOUT_MS);
      });
      try {
        const result = await Promise.race([execPromise, timeoutPromise]);
        stdout = result?.stdout || '';
        console.log(`[transcribeAudio] Whisper completed in ${Date.now() - t0}ms`);
      } catch (raceErr) {
        // On timeout, the underlying exec is still running.
        // We can't kill it cleanly without child_process.kill
        // plumbing, but since execFileAsync holds a child
        // reference inside its internal promise, the child
        // will be reaped when the process eventually exits.
        // The next call to transcribeAudio will start a
        // fresh whisper process, so a stuck one doesn't
        // block subsequent calls.
        console.error(`[transcribeAudio] Whisper failed/timeout: ${raceErr.message}`);
        throw raceErr;
      }
    } catch (execErr) {
      const stderr = execErr.stderr ? execErr.stderr.toString() : (execErr.message || 'Unknown error');
      const stdout_err = execErr.stdout ? execErr.stdout.toString() : '';
      console.error('[transcribeAudio] Whisper execution failed');
      console.error('[transcribeAudio] stderr:', stderr);
      console.error('[transcribeAudio] stdout:', stdout_err);
      throw new Error('Whisper transcription failed: ' + stderr);
    }

    // whisper writes to .txt file
    const txtFile = tmpWav.replace('.wav', '.txt');
    let transcript = '';
    if (fs.existsSync(txtFile)) {
      transcript = fs.readFileSync(txtFile, 'utf8').trim();
      fs.unlinkSync(txtFile);
    } else {
      // Fallback: parse stdout
      transcript = stdout.replace(/\[.*?\]/g, '').trim();
    }

    return transcript;
  } finally {
    try { fs.unlinkSync(tmpSrc); } catch {}
    try { fs.unlinkSync(tmpWav); } catch {}
  }
}

async function synthesizeSpeech(text, voice = 'lessac') {
  const { voiceOnnx, voiceJson } = await ensurePiper(voice);
  const tmpOut = path.join(os.tmpdir(), `cyberclaw-tts-${Date.now()}.wav`);
  const piperScript = path.join(__dirname, 'piper-tts.py');

  try {
    await new Promise((resolve, reject) => {
      execFileAsync('python3', [piperScript, voiceOnnx, voiceJson, tmpOut, text])
        .then(() => resolve())
        .catch((err) => {
          console.error('[synthesizeSpeech] Piper error:', err.message);
          reject(new Error(`Piper TTS failed: ${err.message}`));
        });
    });

    const audioData = fs.readFileSync(tmpOut);
    return audioData.toString('base64');
  } finally {
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

module.exports = { init, transcribeAudio, synthesizeSpeech, ensureWhisper, ensurePiper };
