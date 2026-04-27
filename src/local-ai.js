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
const PIPER_VOICE_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium';
const PIPER_VOICE_ONNX = `${PIPER_VOICE_BASE}/en_US-lessac-medium.onnx`;
const PIPER_VOICE_JSON = `${PIPER_VOICE_BASE}/en_US-lessac-medium.onnx.json`;

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

async function ensurePiper() {
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

  const voiceOnnx = path.join(piperDir, 'en_US-lessac-medium.onnx');
  const voiceJson = path.join(piperDir, 'en_US-lessac-medium.onnx.json');

  let binaryPath = findBinary(piperDir);

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
    sendProgress('Downloading Piper voice', 0, 'Downloading voice model (~63MB)...');
    await downloadFile(PIPER_VOICE_ONNX, voiceOnnx, 'Downloading Piper voice');
  }
  if (!fs.existsSync(voiceJson)) {
    sendProgress('Downloading Piper voice config', 0, '...');
    await downloadFile(PIPER_VOICE_JSON, voiceJson, 'Downloading Piper voice config');
  }

  return { binaryPath, voiceOnnx };
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
    // Convert to 16kHz mono WAV (whisper.cpp requirement)
    if (!isWav) {
      let converted = false;
      
      // Try ffmpeg first
      try {
        await execFileAsync('ffmpeg', [
          '-y',
          '-i', tmpSrc,
          '-ar', '16000',
          '-ac', '1',
          '-f', 'wav',
          tmpWav
        ]);
        converted = true;
      } catch (ffmpegErr) {
        console.warn('[transcribeAudio] ffmpeg failed, trying sox:', ffmpegErr.message);
        // Try sox as fallback
        try {
          await execFileAsync('sox', [
            tmpSrc,
            '-r', '16000',
            '-c', '1',
            tmpWav
          ]);
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

    // Run whisper-cli using exec for better error capture
    let stdout = '';
    try {
      const cmd = `"${binaryPath}" -m "${modelPath}" -f "${tmpWav}" --language en --output-txt --output-file "${tmpWav.replace('.wav', '')}"`;
      console.log('[transcribeAudio] Running:', cmd);
      
      const { stdout: execStdout } = await execFileAsync('bash', ['-c', cmd]);
      stdout = execStdout || '';
      
      console.log('[transcribeAudio] Whisper completed successfully');
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

async function synthesizeSpeech(text) {
  const { binaryPath, voiceOnnx } = await ensurePiper();
  const tmpOut = path.join(os.tmpdir(), `cyberclaw-tts-${Date.now()}.wav`);

  try {
    await new Promise((resolve, reject) => {
      const proc = require('child_process').spawn(binaryPath, [
        '--model', voiceOnnx,
        '--output_file', tmpOut
      ]);
      proc.stdin.write(text);
      proc.stdin.end();
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Piper exited with code ${code}`));
      });
      proc.on('error', reject);
    });

    const audioData = fs.readFileSync(tmpOut);
    return audioData.toString('base64');
  } finally {
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

module.exports = { init, transcribeAudio, synthesizeSpeech, ensureWhisper, ensurePiper };
