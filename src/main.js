const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');

// Desktop log panel — sends structured log entries to renderer via IPC
function discordLog(emoji, title, detail = '', level = 'info') {
  try {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length) wins[0].webContents.send('desktop-log', { emoji, title, detail, level });
  } catch {}
  console.log(`[LOG] ${emoji} ${title}${detail ? ' — ' + detail : ''}`);
}

let mainWindow;
let ptyProcess = null;
let chatPty = null;
let isQuitting = false;

const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');
const CYBERCLAW_DIR = path.join(OPENCLAW_DIR, 'cyberclaw');
const QUESTS_FILE = path.join(CYBERCLAW_DIR, 'quests.json');
const STATS_FILE = path.join(CYBERCLAW_DIR, 'companion-stats.json');
const PROVIDERS_FILE = path.join(CYBERCLAW_DIR, 'providers.json');

// Companion stats persistence (skills, XP, levels)
function loadStats() {
  try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch { return {}; }
}
function saveStats(stats) {
  fs.mkdirSync(CYBERCLAW_DIR, { recursive: true });
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

// XP needed for each level: 100, 250, 500, 1000, 2000, 4000...
function xpForLevel(level) { return Math.floor(100 * Math.pow(1.8, level - 1)); }

function addSkillXP(agentId, skillName, xpGain) {
  const stats = loadStats();
  if (!stats[agentId]) stats[agentId] = { level: 1, xp: 0, xpTotal: 0, skills: {} };
  const agent = stats[agentId];

  // Add skill XP
  if (!agent.skills[skillName]) agent.skills[skillName] = { level: 1, xp: 0 };
  const skill = agent.skills[skillName];
  skill.xp += xpGain;

  // Level up skill
  while (skill.xp >= xpForLevel(skill.level)) {
    skill.xp -= xpForLevel(skill.level);
    skill.level++;
  }

  // Add to companion total XP
  agent.xp += xpGain;
  agent.xpTotal += xpGain;

  // Level up companion
  while (agent.xp >= xpForLevel(agent.level)) {
    agent.xp -= xpForLevel(agent.level);
    agent.level++;
  }

  saveStats(stats);
  return stats[agentId];
}

// Quest persistence
function loadQuests() {
  try {
    return JSON.parse(fs.readFileSync(QUESTS_FILE, 'utf8'));
  } catch { return []; }
}
function saveQuests(quests) {
  fs.mkdirSync(CYBERCLAW_DIR, { recursive: true });
  fs.writeFileSync(QUESTS_FILE, JSON.stringify(quests, null, 2));
}

const { execSync, exec: execCb } = require('child_process');
const SyncServer = require('./sync-server');
const httpsNode = require('https');
const osNode = require('os');
const localAI = require('./local-ai');

// --- Audio helpers for mobile voice loop (local, no API key) ---
// Delegates to local-ai.js (whisper.cpp STT + piper TTS)
// local-ai is initialized once the app window is ready (see createWindow)
const transcribeAudio = (audioBase64, mimeType) => localAI.transcribeAudio(audioBase64, mimeType);
const synthesizeSpeech = (text) => localAI.synthesizeSpeech(text);

// Strip emojis and special symbols from text for TTS
function stripEmojisForTTS(text) {
  return text
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '') // Unicode emoji
    .replace(/:[a-z0-9_+-]+:/gi, '') // Custom emoji syntax :emoji:
    .replace(/\s+/g, ' ') // Clean up extra spaces
    .trim();
}
// --- End audio helpers ---

let syncServer = null;

function needsWizard() {
  // Show wizard if OpenClaw isn't installed or no agents configured
  const openclawBin = findOpenClaw();
  if (!openclawBin) return true;
  try {
    const config = readOpenClawConfig();
    if (!config) return true;
    const agents = config.agents?.list || [];
    if (agents.length === 0) return true;
  } catch { return true; }
  return false;
}

function createWindow() {
  const showWizard = needsWizard();

  mainWindow = new BrowserWindow({
    width: showWizard ? 700 : 1600,
    height: showWizard ? 600 : 1000,
    minWidth: showWizard ? 600 : 1200,
    minHeight: showWizard ? 500 : 800,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0a0f',
    icon: path.join(__dirname, 'assets/icons/cyberclaw.png'),
    resizable: !showWizard,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: true,
    }
  });

  if (showWizard) {
    mainWindow.loadFile(path.join(__dirname, 'wizard.html'));
  } else {
    mainWindow.loadFile(path.join(__dirname, 'index.html'), {
      query: { v: Date.now().toString() }
    });
  }

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // F12 opens DevTools
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') mainWindow.webContents.toggleDevTools();
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Init local AI with userData path and window reference for progress events
  const { app } = require('electron');
  localAI.init(app.getPath('userData'), mainWindow);
}

function switchToMainApp() {
  if (!mainWindow) return;
  mainWindow.setMinimumSize(1200, 800);
  mainWindow.setSize(1600, 1000);
  mainWindow.setResizable(true);
  mainWindow.center();
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

// ---------------------------------------------------------------------------
// OpenClaw agent discovery
// ---------------------------------------------------------------------------
function readOpenClawConfig() {
  try {
    const raw = fs.readFileSync(path.join(OPENCLAW_DIR, 'openclaw.json'), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

function readSessionsForAgent(agentId) {
  try {
    const sessFile = path.join(OPENCLAW_DIR, 'agents', agentId, 'sessions', 'sessions.json');
    const raw = fs.readFileSync(sessFile, 'utf8');
    return JSON.parse(raw);
  } catch { return {}; }
}

function readSubagentRuns() {
  try {
    const raw = fs.readFileSync(path.join(OPENCLAW_DIR, 'subagents', 'runs.json'), 'utf8');
    return JSON.parse(raw);
  } catch { return []; }
}

function discoverAgents() {
  const config = readOpenClawConfig();
  if (!config) return { agents: [], bindings: [], subagents: [] };

  const agentList = config.agents?.list || [];
  const bindings = config.bindings || [];
  const defaults = config.agents?.defaults || {};

  // Model info from config
  const modelConfig = defaults.model || {};
  const primaryModel = modelConfig.primary || config.agents?.defaults?.model?.primary || 'anthropic/claude-opus-4-6';
  const fallbackModels = modelConfig.fallbacks || [];

  const agents = agentList.map(a => {
    const id = a.id;
    const sessions = readSessionsForAgent(id);

    // Find binding for this agent
    const binding = bindings.find(b => b.agentId === id);
    let channel = 'None';
    let channelDetail = 'Unbound';
    let channelBadge = 'none';
    let channelIcon = '—';

    if (binding?.match?.channel) {
      channel = binding.match.channel.charAt(0).toUpperCase() + binding.match.channel.slice(1);
      channelBadge = binding.match.channel;
      channelIcon = binding.match.channel === 'discord' ? '💬' : '⌨️';

      // Try to find channel name from sessions
      const sessionKeys = Object.keys(sessions);
      if (sessionKeys.length > 0) {
        const firstSession = sessions[sessionKeys[0]];
        channelDetail = firstSession.groupChannel || firstSession.displayName || channelDetail;
      }
    }

    // Check if agent has active sessions (heuristic for online status)
    const sessionKeys = Object.keys(sessions);
    const hasRecentSession = sessionKeys.some(k => {
      const s = sessions[k];
      return s.updatedAt && (Date.now() - s.updatedAt) < 3600000; // active in last hour
    });

    // Read workspace files for name/identity
    const workspace = a.workspace || defaults.workspace || '~/workspace';
    let agentName = a.name?.split(':').pop() || id.split('-').pop() || id;
    agentName = agentName.charAt(0).toUpperCase() + agentName.slice(1);
    let agentClass = 'Agent';
    let emoji = '🤖';
    let avatarPath = null;

    // Try reading IDENTITY.md from workspace
    try {
      const identityPath = path.join(workspace, 'IDENTITY.md');
      const identity = fs.readFileSync(identityPath, 'utf8');

      // Helper: extract value, skip template placeholders
      const extract = (pattern) => {
        const m = identity.match(pattern);
        if (!m) return null;
        const val = m[1].trim();
        // Skip unfilled template placeholders
        if (!val || val.startsWith('_(') || val.startsWith('(') || val.includes('pick something')) return null;
        return val;
      };

      const n = extract(/\*\*Name:\*\*\s*(.+)/i);
      const c = extract(/\*\*Creature:\*\*\s*(.+)/i);
      const e = extract(/\*\*Emoji:\*\*\s*(.+)/i);
      const av = extract(/\*\*Avatar:\*\*\s*(.+)/i);

      if (n) agentName = n;
      if (c) agentClass = c.replace(/\bAI\b/gi, 'companion').replace(/\s+/g, ' ').trim();
      if (e) emoji = e;
      if (av) {
        if (av.startsWith('http') || av.startsWith('data:')) {
          avatarPath = av;
        } else {
          const resolved = path.resolve(workspace, av);
          if (fs.existsSync(resolved)) avatarPath = resolved;
        }
      }
    } catch {}

    // Check for avatar in cyberclaw assets (fallback by agent short name)
    if (!avatarPath) {
      const shortName = agentName.toLowerCase();
      const assetsDir = path.join(__dirname, 'assets', 'avatars');
      for (const ext of ['png', 'jpg', 'webp']) {
        const candidate = path.join(assetsDir, `${shortName}.${ext}`);
        if (fs.existsSync(candidate)) { avatarPath = candidate; break; }
      }
    }

    // Per-agent model override or global
    const agentModel = a.model?.primary || primaryModel;
    const agentFallbacks = a.model?.fallbacks || fallbackModels;

    return {
      id,
      name: agentName,
      class: agentClass,
      workspace,
      channel,
      channelBadge,
      channelIcon,
      channelDetail,
      emoji,
      avatar: avatarPath,
      status: hasRecentSession ? 'online' : 'idle',
      isMain: binding?.match?.channel === 'discord' && !binding?.match?.peer,
      sessionCount: sessionKeys.length,
      primaryModel: agentModel,
      fallbackModels: agentFallbacks,
    };
  });

  // Subagent runs
  const subagentRuns = readSubagentRuns();

  return { agents, bindings, subagents: subagentRuns };
}

ipcMain.handle('openclaw:discover', () => discoverAgents());

// Pop-out companion arena window
let companionWindow = null;
ipcMain.handle('arena:popout', (event, state) => {
  if (companionWindow && !companionWindow.isDestroyed()) {
    companionWindow.focus();
    return;
  }
  companionWindow = new BrowserWindow({
    width: 500,
    height: 400,
    minWidth: 300,
    minHeight: 200,
    alwaysOnTop: true,
    frame: false,
    transparent: false,
    resizable: true,
    title: `🐾 ${state.companionName || 'Companion'} & Spirits`,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  companionWindow.loadFile(path.join(__dirname, 'companion-window.html'), {
    query: { state: JSON.stringify(state) },
  });
  companionWindow.on('closed', () => { companionWindow = null; });
});

ipcMain.handle('openclaw:system-info', () => {
  const config = readOpenClawConfig();
  return {
    host: os.hostname(),
    os: `${os.platform()} ${os.arch()}`,
    node: process.versions.node,
    gatewayPort: config?.gateway?.port || 18789,
  };
});

// ---------------------------------------------------------------------------
// Terminal (OpenClaw process viewer)
// ---------------------------------------------------------------------------
const shell = os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';

function findOpenClaw() {
  const candidates = [
    path.join(os.homedir(), '.npm-global', 'bin', 'openclaw'),
    '/usr/local/bin/openclaw',
    '/usr/bin/openclaw',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Try PATH via which
  try {
    const { execSync } = require('child_process');
    const result = execSync('which openclaw', { encoding: 'utf8' }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch {}
  return null;
}

function killPty(p) {
  if (!p) return;
  try { p.kill(); } catch {}
}

ipcMain.handle('terminal:spawn', (event, { cols, rows }) => {
  killPty(ptyProcess);

  // Find openclaw binary
  const openclawBin = findOpenClaw();

  // Check if gateway is already running as a service
  let gatewayRunning = false;
  try {
    const { execSync } = require('child_process');
    const status = execSync('systemctl --user is-active openclaw-gateway 2>/dev/null', { encoding: 'utf8' }).trim();
    gatewayRunning = status === 'active';
  } catch {}

  if (gatewayRunning) {
    // Gateway running as service — tail the log, with openclaw CLI available
    const today = new Date().toISOString().slice(0, 10);
    const logFile = `/tmp/openclaw/openclaw-${today}.log`;
    ptyProcess = pty.spawn(shell, ['-c',
      `echo "\\x1b[36m⚔️  CyberClaw — OpenClaw Gateway (systemd service)\\x1b[0m" && ` +
      `echo "\\x1b[33m   Type openclaw commands here. Log stream below.\\x1b[0m" && ` +
      `echo "---" && ` +
      `tail -n 50 -f "${logFile}" 2>/dev/null || echo "No log file at ${logFile}"`
    ], {
      name: 'xterm-256color',
      cols: cols || 120,
      rows: rows || 30,
      cwd: process.env.HOME,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
  } else if (openclawBin) {
    // No service — run gateway in foreground
    ptyProcess = pty.spawn(openclawBin, ['gateway', 'run'], {
      name: 'xterm-256color',
      cols: cols || 120,
      rows: rows || 30,
      cwd: process.env.HOME,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
  } else {
    // No openclaw found — plain shell
    ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: cols || 120,
      rows: rows || 30,
      cwd: process.env.HOME,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
  }
  ptyProcess.onData(data => {
    try {
      if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal:data', data);
      }
    } catch (e) { /* frame disposed */ }
  });
  ptyProcess.onExit(({ exitCode }) => {
    try {
      if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal:exit', exitCode);
      }
    } catch (e) { /* frame disposed */ }
  });
  return true;
});

ipcMain.on('terminal:input', (event, data) => {
  ptyProcess?.write(data);
});

ipcMain.on('terminal:resize', (event, { cols, rows }) => {
  try { ptyProcess?.resize(cols, rows); } catch {}
});

// ---------------------------------------------------------------------------
// Chat terminal (separate PTY for chat input)
// ---------------------------------------------------------------------------
ipcMain.handle('chat:spawn', (event, { cols, rows }) => {
  killPty(chatPty);
  chatPty = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: cols || 120,
    rows: rows || 10,
    cwd: process.env.HOME,
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  chatPty.onData(data => {
    if (!isQuitting) mainWindow?.webContents.send('chat:data', data);
  });
  return true;
});

ipcMain.on('chat:input', (event, data) => {
  chatPty?.write(data);
});

ipcMain.on('chat:resize', (event, { cols, rows }) => {
  try { chatPty?.resize(cols, rows); } catch {}
});

// ---------------------------------------------------------------------------
// Chat — send messages to agents via gateway
// ---------------------------------------------------------------------------
// Robust JSON extractor: scans for the first valid top-level JSON object
// in a buffer that may be polluted with stderr noise (e.g. "[state-migrations] ...").
function extractFirstJsonObject(buf) {
  if (typeof buf !== 'string' || !buf) return null;
  // Fast path: already valid JSON
  try { return JSON.parse(buf); } catch {}
  const start = buf.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < buf.length; i++) {
    const c = buf[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const candidate = buf.slice(start, i + 1);
          try { return JSON.parse(candidate); } catch { return null; }
        }
      }
    }
  }
  return null;
}

ipcMain.handle('chat:send-message', async (event, { agentId, message }) => {
  const bin = findOpenClaw();
  if (!bin) return { ok: false, error: 'OpenClaw not found' };

  try {
    const result = await new Promise((resolve) => {
      // Note: we intentionally do NOT use `2>&1` here. Stderr is captured
      // separately so it can't pollute the JSON payload and cause raw
      // debug output to leak into the chat.
      execCb(
        `"${bin}" agent -m "${message.replace(/"/g, '\\"')}" --agent "${agentId}" --json`,
        { timeout: 120000, maxBuffer: 1024 * 512, env: { ...process.env } },
        (err, stdout, stderr) => {
          if (err && (!stdout || !stdout.trim())) {
            resolve({ ok: false, error: err.message, output: stderr || err.message });
            return;
          }
          const parsed = extractFirstJsonObject(stdout);
          if (parsed) {
            // Extract reply from various response formats:
            // 1. OpenClaw agent --json: { result: { payloads: [{ text: "..." }] } }
            // 2. Simple: { reply: "..." } or { message: "..." } or { text: "..." }
            let reply = null;
            if (parsed.result && parsed.result.payloads && parsed.result.payloads.length > 0) {
              reply = parsed.result.payloads[0].text;
            }
            if (!reply) reply = parsed.reply || parsed.message || parsed.text;
            if (!reply && typeof parsed === 'string') reply = parsed;
            if (reply && reply.trim()) {
              resolve({ ok: true, reply: reply });
            } else {
              // Parsed but no reply field — surface a friendly note rather than dumping JSON
              resolve({ ok: false, error: parsed.error || 'No reply in agent response', output: stderr || '' });
            }
          } else {
            // No valid JSON — return stdout only if it looks like text, not a debug dump
            const trimmed = (stdout || '').trim();
            const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[');
            if (trimmed && !looksLikeJson) {
              resolve({ ok: true, reply: trimmed });
            } else {
              resolve({ ok: false, error: 'Could not parse agent response', output: stderr || trimmed });
            }
          }
        }
      );
    });
    // Classify task for XP (awarded by frontend to the right companion)
    if (result.ok) {
      result.taskSkill = classifyTask(message);
    }

    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function classifyTask(message) {
  const m = message.toLowerCase();
  if (/\b(code|bug|fix|function|class|api|build|compile|deploy|git|commit|test|refactor|debug)\b/.test(m)) return 'Coding';
  if (/\b(write|draft|edit|essay|article|blog|copy|summarize|rewrite|document)\b/.test(m)) return 'Writing';
  if (/\b(design|css|layout|ui|ux|style|color|font|image|icon|logo)\b/.test(m)) return 'Design';
  if (/\b(analyze|data|chart|graph|numbers|calculate|statistics|math)\b/.test(m)) return 'Analysis';
  if (/\b(plan|strategy|project|manage|organize|schedule|prioritize|roadmap)\b/.test(m)) return 'Strategy';
  if (/\b(search|find|research|look up|what is|how to|explain|learn)\b/.test(m)) return 'Research';
  if (/\b(chat|talk|tell me|hello|hey|thanks|help|advice)\b/.test(m)) return 'Communication';
  return 'General';
}

// ---------------------------------------------------------------------------
// Doctor — opens in a new terminal window
// ---------------------------------------------------------------------------
let doctorWindow = null;
let doctorPty = null;

ipcMain.handle('openclaw:list-skills', async () => {
  try {
    const { execSync } = require('child_process');
    const openclawBin = path.join(os.homedir(), '.npm-global', 'bin', 'openclaw');
    const output = execSync(`${openclawBin} skills list --no-color 2>/dev/null || true`, { encoding: 'utf8', timeout: 10000 });
    // Parse the table output
    const skills = [];
    const lines = output.split('\n');
    for (const line of lines) {
      const match = line.match(/│\s*(✓ ready|✗ missing)\s*│\s*([^\s│][^│]*?)\s*│\s*([^│]*?)\s*│/);
      if (match) {
        const [, status, name, desc] = match;
        skills.push({
          name: name.trim(),
          description: desc.trim(),
          ready: status.includes('ready'),
        });
      }
    }
    return skills;
  } catch { return []; }
});

ipcMain.handle('openclaw:doctor', () => {
  if (doctorWindow && !doctorWindow.isDestroyed()) {
    doctorWindow.focus();
    return { ok: true };
  }

  doctorWindow = new BrowserWindow({
    width: 800,
    height: 500,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0a0f',
    parent: mainWindow,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: true,
    }
  });

  doctorWindow.loadFile(path.join(__dirname, 'doctor.html'));
  doctorWindow.on('closed', () => {
    doctorWindow = null;
    if (doctorPty) { try { doctorPty.kill(); } catch {} doctorPty = null; }
  });

  return { ok: true };
});

ipcMain.handle('doctor:spawn', (event, { cols, rows }) => {
  if (doctorPty) { try { doctorPty.kill(); } catch {} }

  const openclawBin = findOpenClaw();
  const cmd = openclawBin
    ? `"${openclawBin}" doctor`
    : 'echo "OpenClaw not found. Install it first."';

  doctorPty = pty.spawn(shell, ['-c', cmd], {
    name: 'xterm-256color',
    cols: cols || 100,
    rows: rows || 24,
    cwd: process.env.HOME,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  doctorPty.onData(data => {
    if (doctorWindow && !doctorWindow.isDestroyed()) {
      doctorWindow.webContents.send('doctor:data', data);
    }
  });
  doctorPty.onExit(({ exitCode }) => {
    if (doctorWindow && !doctorWindow.isDestroyed()) {
      doctorWindow.webContents.send('doctor:exit', exitCode);
    }
  });

  return true;
});

ipcMain.on('doctor:input', (event, data) => { doctorPty?.write(data); });
ipcMain.on('doctor:resize', (event, { cols, rows }) => { try { doctorPty?.resize(cols, rows); } catch {} });
ipcMain.on('doctor:close', () => { doctorWindow?.close(); });

// ---------------------------------------------------------------------------
// Window controls
// ---------------------------------------------------------------------------
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('mobile-connected', (e, { name }) => discordLog('📱', 'Mobile connected', name || 'unknown', 'success'));
ipcMain.on('mobile-disconnected', (e, { clientId }) => discordLog('📴', 'Mobile disconnected', clientId || 'unknown', 'warn'));
ipcMain.on('mobile-paired', (e, { name }) => discordLog('🔗', 'Mobile paired', name || 'unknown', 'success'));

ipcMain.on('window:maximize', () => {
  mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());

// Quest CRUD
ipcMain.handle('quests:list', () => loadQuests());
ipcMain.handle('quests:create', (event, quest) => {
  const quests = loadQuests();
  quest.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  quest.created = new Date().toISOString();
  quest.status = 'active';
  quests.unshift(quest);
  saveQuests(quests);
  return quest;
});
ipcMain.handle('quests:update', (event, id, updates) => {
  const quests = loadQuests();
  const idx = quests.findIndex(q => q.id === id);
  if (idx >= 0) { Object.assign(quests[idx], updates); saveQuests(quests); }
  return quests[idx] || null;
});
ipcMain.handle('companion:stats', (event, agentId) => {
  const stats = loadStats();
  return stats[agentId] || { level: 1, xp: 0, xpTotal: 0, skills: {} };
});

ipcMain.handle('companion:add-xp', (event, agentId, skill, amount) => {
  addSkillXP(agentId, skill, amount);
  return true;
});

// ─── Companion Sprite Config ───
const spriteConfigPath = path.join(CYBERCLAW_DIR, 'sprites.json');
function loadSpriteConfigs() {
  try { return JSON.parse(fs.readFileSync(spriteConfigPath, 'utf8')); } catch { return {}; }
}
function saveSpriteConfigs(configs) {
  fs.writeFileSync(spriteConfigPath, JSON.stringify(configs, null, 2));
}

ipcMain.handle('companion:get-sprite', (event, agentId) => {
  const configs = loadSpriteConfigs();
  return configs[agentId] || null;
});
ipcMain.handle('companion:save-sprite', (event, agentId, config) => {
  const configs = loadSpriteConfigs();
  configs[agentId] = config;
  saveSpriteConfigs(configs);
  return true;
});
ipcMain.handle('companion:save-avatar', (event, agentId, dataUrl) => {
  // Save the generated sprite as a PNG file
  const avatarsDir = path.join(CYBERCLAW_DIR, 'avatars');
  if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir, { recursive: true });
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  const avatarPath = path.join(avatarsDir, `${agentId}.png`);
  fs.writeFileSync(avatarPath, Buffer.from(base64, 'base64'));
  return avatarPath;
});

// ─── Custom LLM Providers ────────────────────────────────────────────────
// Persisted in PROVIDERS_FILE. A provider is:
//   { id, name, baseUrl, apiKey?, defaultModel?, api? }   (api: 'openai-completions' | 'anthropic-messages')
function loadProviders() {
  try { return JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8')); } catch { return []; }
}
function saveProviders(list) {
  if (!fs.existsSync(CYBERCLAW_DIR)) fs.mkdirSync(CYBERCLAW_DIR, { recursive: true });
  fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(list, null, 2));
}
ipcMain.handle('providers:list', () => {
  return loadProviders();
});
ipcMain.handle('providers:save', (event, provider) => {
  if (!provider || !provider.name || !provider.baseUrl) {
    return { ok: false, error: 'name and baseUrl are required' };
  }
  const list = loadProviders();
  // id is optional; if absent, generate from name
  if (!provider.id) {
    const base = provider.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    let id = base || 'provider';
    let n = 2;
    while (list.some(p => p.id === id)) id = base + '-' + (n++);
    provider.id = id;
  }
  const existing = list.findIndex(p => p.id === provider.id);
  const clean = {
    id: provider.id,
    name: String(provider.name).trim(),
    baseUrl: String(provider.baseUrl).trim(),
    apiKey: provider.apiKey ? String(provider.apiKey) : '',
    defaultModel: provider.defaultModel ? String(provider.defaultModel) : '',
    api: provider.api || 'openai-completions',
  };
  if (existing >= 0) list[existing] = clean;
  else list.push(clean);
  saveProviders(list);
  return { ok: true, provider: clean };
});
ipcMain.handle('providers:delete', (event, id) => {
  const list = loadProviders().filter(p => p.id !== id);
  saveProviders(list);
  return { ok: true };
});

// ─── OpenClaw Config Read/Write ───────────────────────────────
// CyberClaw companions are openclaw agents. We read `models.providers`
// (the LLM provider list) and `agents.list` (the agent list) directly
// from `~/.openclaw/openclaw.json` so changes in either app stay in sync.
const OPENCLAW_CONFIG = path.join(OPENCLAW_DIR, 'openclaw.json');

function readOpenClawConfig() {
  try { return JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf8')); }
  catch (e) { return null; }
}
function writeOpenClawConfig(cfg) {
  // Atomic write: write to .tmp then rename
  const tmp = OPENCLAW_CONFIG + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, OPENCLAW_CONFIG);
}

ipcMain.handle('openclaw:read-config', () => {
  return readOpenClawConfig();
});

// LLM providers from openclaw config
ipcMain.handle('openclaw:list-providers', () => {
  const cfg = readOpenClawConfig();
  if (!cfg) return [];
  const providers = (cfg.models && cfg.models.providers) || {};
  return Object.entries(providers).map(([id, p]) => ({
    id,
    name: p.name || id,
    baseUrl: p.baseUrl || '',
    apiKey: p.apiKey || '',
    api: p.api || 'openai-completions',
    models: (p.models || []).map(m => m.id || m.name).filter(Boolean),
    defaultModel: (p.models && p.models[0] && (p.models[0].id || p.models[0].name)) || '',
    source: 'openclaw-config',
  }));
});

// Add or update a provider in openclaw config
ipcMain.handle('openclaw:upsert-provider', (event, provider) => {
  if (!provider || !provider.id) return { ok: false, error: 'provider.id is required' };
  const cfg = readOpenClawConfig();
  if (!cfg) return { ok: false, error: 'Could not read openclaw.json' };
  cfg.models = cfg.models || {};
  cfg.models.providers = cfg.models.providers || {};
  const existing = cfg.models.providers[provider.id] || { models: [] };
  const next = Object.assign({}, existing, {
    baseUrl: provider.baseUrl || existing.baseUrl,
    apiKey: provider.apiKey != null ? provider.apiKey : (existing.apiKey || ''),
    api: provider.api || existing.api || 'openai-completions',
  });
  // If a defaultModel is provided and not already in models, add it as a stub
  if (provider.defaultModel && !next.models.find(m => (m.id || m.name) === provider.defaultModel)) {
    next.models = next.models.concat([{ id: provider.defaultModel, name: provider.defaultModel, input: ['text'] }]);
  }
  cfg.models.providers[provider.id] = next;
  try { writeOpenClawConfig(cfg); return { ok: true, provider: { id: provider.id, ...next } }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('openclaw:delete-provider', (event, id) => {
  if (!id) return { ok: false, error: 'id is required' };
  const cfg = readOpenClawConfig();
  if (!cfg || !cfg.models || !cfg.models.providers) return { ok: false, error: 'No providers' };
  delete cfg.models.providers[id];
  try { writeOpenClawConfig(cfg); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// Agents in openclaw config
ipcMain.handle('openclaw:list-agents', () => {
  const cfg = readOpenClawConfig();
  if (!cfg) return [];
  return (cfg.agents && cfg.agents.list) || [];
});

// Create a new agent in openclaw config
ipcMain.handle('openclaw:create-agent', (event, agent) => {
  if (!agent || !agent.id) return { ok: false, error: 'agent.id is required' };
  const cfg = readOpenClawConfig();
  if (!cfg) return { ok: false, error: 'Could not read openclaw.json' };
  cfg.agents = cfg.agents || { list: [] };
  if (cfg.agents.list.find(a => a.id === agent.id)) {
    return { ok: false, error: 'Agent id "' + agent.id + '" already exists' };
  }
  const entry = {
    id: agent.id,
    name: agent.name || agent.id,
    workspace: agent.workspace || path.join(OPENCLAW_DIR, 'workspaces', agent.id),
  };
  if (agent.model) entry.model = { primary: agent.model, fallbacks: [] };
  if (agent.tools) entry.tools = agent.tools;
  cfg.agents.list.push(entry);
  try { writeOpenClawConfig(cfg); return { ok: true, agent: entry }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('openclaw:update-agent', (event, id, updates) => {
  if (!id) return { ok: false, error: 'id is required' };
  const cfg = readOpenClawConfig();
  if (!cfg || !cfg.agents) return { ok: false, error: 'No agents' };
  const idx = cfg.agents.list.findIndex(a => a.id === id);
  if (idx < 0) return { ok: false, error: 'Agent not found' };
  const allowed = ['name', 'workspace', 'model', 'tools'];
  const current = cfg.agents.list[idx];
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(updates || {}, k)) current[k] = updates[k];
  }
  try { writeOpenClawConfig(cfg); return { ok: true, agent: current }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('openclaw:delete-agent', (event, id) => {
  if (!id) return { ok: false, error: 'id is required' };
  const cfg = readOpenClawConfig();
  if (!cfg || !cfg.agents) return { ok: false, error: 'No agents' };
  cfg.agents.list = cfg.agents.list.filter(a => a.id !== id);
  try { writeOpenClawConfig(cfg); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('quests:detect-version', (event, dir) => {
  if (!dir) return null;
  try {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      return pkg.version || null;
    }
  } catch {}
  return null;
});
ipcMain.handle('quests:pick-directory', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select project directory',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});
ipcMain.handle('quests:delete', (event, id) => {
  let quests = loadQuests();
  quests = quests.filter(q => q.id !== id);
  saveQuests(quests);
  return true;
});
ipcMain.on('window:open-external', (event, url) => {
  const { shell } = require('electron');
  if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url);
  }
});

// ---------------------------------------------------------------------------
// Wizard IPC handlers
// ---------------------------------------------------------------------------
function execPromise(cmd) {
  return new Promise((resolve) => {
    execCb(cmd, { timeout: 60000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: stdout + stderr, error: err?.message });
    });
  });
}

ipcMain.handle('wizard:check', async (event, what) => {
  switch (what) {
    case 'check-node':
      try {
        const v = execSync('node --version', { encoding: 'utf8', timeout: 5000 }).trim();
        return { ok: true, version: v };
      } catch {
        // Also check common Windows install path
        if (os.platform() === 'win32') {
          try {
            const v = execSync('"C:\\Program Files\\nodejs\\node.exe" --version', { encoding: 'utf8', timeout: 5000 }).trim();
            return { ok: true, version: v };
          } catch {}
        }
        return { ok: false, message: 'not installed' };
      }

    case 'check-npm':
      try {
        const v = execSync('npm --version', { encoding: 'utf8', timeout: 5000 }).trim();
        return { ok: true, version: 'v' + v };
      } catch {
        // Check common paths
        const npmPath = findNpm();
        if (npmPath) {
          try {
            const v = execSync(`"${npmPath}" --version`, { encoding: 'utf8', timeout: 5000 }).trim();
            return { ok: true, version: 'v' + v };
          } catch {}
        }
        return { ok: false, message: 'not installed' };
      }

    case 'check-openclaw': {
      const bin = findOpenClaw();
      if (!bin) return { ok: false, message: 'not installed' };
      try {
        const v = execSync(`"${bin}" --version`, { encoding: 'utf8' }).trim();
        return { ok: true, version: v };
      } catch { return { ok: true, version: 'installed' }; }
    }

    case 'check-gateway':
      try {
        // Check systemd service
        const status = execSync('systemctl --user is-active openclaw-gateway 2>/dev/null', { encoding: 'utf8' }).trim();
        if (status === 'active') return { ok: true, version: 'running' };
      } catch {}
      // Check if port is listening
      try {
        const config = readOpenClawConfig();
        const port = config?.gateway?.port || 18789;
        execSync(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/health`, { timeout: 3000 });
        return { ok: true, version: 'running' };
      } catch { return { ok: false, message: 'not running' }; }

    case 'check-agents': {
      try {
        const config = readOpenClawConfig();
        const agents = config?.agents?.list || [];
        return { ok: agents.length > 0, count: agents.length };
      } catch { return { ok: false, count: 0 }; }
    }

    default: return { ok: false, message: 'unknown check' };
  }
});

ipcMain.handle('wizard:install', async (event, pkg) => {
  if (pkg === 'node') {
    return await installNode();
  }
  if (pkg === 'git') {
    return await installGit();
  }
  if (pkg === 'openclaw') {
    // Find npm
    let npmCmd = null;
    try {
      execSync('npm --version', { timeout: 5000 });
      npmCmd = 'npm';
    } catch {
      const npmPath = findNpm();
      if (npmPath) npmCmd = `"${npmPath}"`;
    }

    if (!npmCmd) {
      return { ok: false, error: 'npm not found. Please install Node.js first.' };
    }

    // Check if git is available (needed by some npm packages)
    let hasGit = false;
    try {
      execSync('git --version', { timeout: 5000 });
      hasGit = true;
    } catch {}

    if (!hasGit && os.platform() === 'win32') {
      // Try installing git first
      const gitResult = await installGit();
      if (!gitResult.ok) {
        // Try npm install anyway — it might work without git
      }
    }

    return await execPromise(`${npmCmd} install -g openclaw 2>&1`);
  }
  return { ok: false, error: 'unknown package' };
});

function findNpm() {
  const platform = os.platform();
  const candidates = platform === 'win32'
    ? [
        'C:\\Program Files\\nodejs\\npm.cmd',
        path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'npm.cmd'),
      ]
    : [
        '/usr/local/bin/npm',
        '/usr/bin/npm',
        path.join(os.homedir(), '.npm-global', 'bin', 'npm'),
        path.join(os.homedir(), '.nvm', 'current', 'bin', 'npm'),
      ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

async function installGit() {
  const platform = os.platform();
  if (platform === 'win32') {
    // Download Git for Windows (portable or installer)
    const url = 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.2/Git-2.47.1.2-64-bit.exe';
    const tmpPath = path.join(os.tmpdir(), 'Git-installer.exe');

    try {
      await downloadFile(url, tmpPath);
      // Run silent install
      let result = await execPromise(`"${tmpPath}" /VERYSILENT /NORESTART /NOCANCEL /SP- /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS /COMPONENTS="icons,ext\\reg\\shellhere,assoc,assoc_sh" 2>&1`);
      if (!result.ok) {
        // Try with UI
        execCb(`"${tmpPath}"`, () => {});
        return { ok: false, error: 'manual', output: 'Git installer launched. Complete installation, then click Retry.' };
      }
      // Add to PATH
      const gitPath = 'C:\\Program Files\\Git\\cmd';
      process.env.PATH = `${gitPath};${process.env.PATH}`;
      try { fs.unlinkSync(tmpPath); } catch {}
      return { ok: true, output: 'Git installed!' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  } else {
    return await execPromise('sudo apt-get install -y git 2>&1');
  }
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const http = require('http');

    function doGet(u, redirects) {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          return doGet(response.headers.location, redirects + 1);
        }
        if (response.statusCode !== 200) {
          return reject(new Error(`HTTP ${response.statusCode}`));
        }
        const file = fs.createWriteStream(destPath);
        response.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', reject);
      }).on('error', reject);
    }

    doGet(url, 0);
  });
}

async function installNode() {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === 'win32') {
    const nodeVersion = 'v22.12.0';
    const msiName = arch === 'x64' ? `node-${nodeVersion}-x64.msi` : `node-${nodeVersion}-x86.msi`;
    const url = `https://nodejs.org/dist/${nodeVersion}/${msiName}`;
    const tmpPath = path.join(os.tmpdir(), msiName);

    let output = '';
    try {
      // Download
      output += `Downloading ${url}...\n`;
      await downloadFile(url, tmpPath);

      const fileSize = fs.statSync(tmpPath).size;
      output += `Downloaded ${(fileSize / 1024 / 1024).toFixed(1)} MB\n`;

      if (fileSize < 1000000) {
        return { ok: false, error: 'Download too small — may have failed', output };
      }

      // Run MSI installer — try silent first, then with basic UI
      output += 'Running installer...\n';
      let installResult = await execPromise(`msiexec /i "${tmpPath}" /qn /norestart`);

      // msiexec /qn may fail without admin — try /qb (basic UI, user can approve UAC)
      if (!installResult.ok) {
        output += 'Silent install failed, trying with UI...\n';
        installResult = await execPromise(`msiexec /i "${tmpPath}" /qb /norestart`);
      }

      if (!installResult.ok) {
        // Last resort: just launch the MSI normally and let user click through
        output += 'Launching installer manually...\n';
        execCb(`msiexec /i "${tmpPath}"`, () => {});
        // Return NOT ok so the wizard shows Retry and waits
        return { ok: false, error: 'manual', output: output + '\nNode.js installer launched.\nComplete the installation wizard, then click Retry.' };
      }

      output += installResult.output + '\n';

      // Clean up
      try { fs.unlinkSync(tmpPath); } catch {}

      // Refresh PATH and verify
      const nodePath = 'C:\\Program Files\\nodejs';
      process.env.PATH = `${nodePath};${process.env.PATH}`;
      try {
        const v = execSync(`"${nodePath}\\node.exe" --version`, { encoding: 'utf8' }).trim();
        output += `Node.js ${v} installed successfully!\n`;
      } catch {
        output += 'Installer completed. You may need to restart CyberClaw for PATH to update.\n';
      }

      return { ok: true, output };
    } catch (err) {
      return { ok: false, error: `Failed: ${err.message}`, output };
    }
  } else if (platform === 'linux') {
    const cmds = [
      'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - 2>&1',
      'sudo apt-get install -y nodejs 2>&1',
    ];
    let output = '';
    for (const cmd of cmds) {
      const r = await execPromise(cmd);
      output += r.output + '\n';
      if (!r.ok) return { ok: false, error: r.error, output };
    }
    return { ok: true, output };
  } else {
    return { ok: false, error: `Auto-install not supported on ${platform}. Please install Node.js from https://nodejs.org` };
  }
}

ipcMain.handle('wizard:run', async (event, cmd) => {
  const bin = findOpenClaw();
  if (!bin) return { ok: false, error: 'openclaw not found' };

  switch (cmd) {
    case 'doctor':
      return await execPromise(`"${bin}" doctor --non-interactive 2>&1`);
    default:
      return { ok: false, error: 'unknown command' };
  }
});

ipcMain.handle('wizard:save-apikey', async (event, key) => {
  // Try CLI first, fall back to direct file write
  const bin = findOpenClaw();
  if (bin) {
    try {
      execSync(`"${bin}" config set anthropic.apiKey "${key}"`, { encoding: 'utf8' });
      return { ok: true };
    } catch {}
  }

  // Direct write — works even if openclaw binary isn't installed yet
  try {
    fs.mkdirSync(OPENCLAW_DIR, { recursive: true });
    const configFile = path.join(OPENCLAW_DIR, 'openclaw.json');
    let config = {};
    try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch {}
    if (!config.anthropic) config.anthropic = {};
    config.anthropic.apiKey = key;
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    return { ok: true };
  } catch (e) {
    throw new Error(e.message);
  }
});

ipcMain.handle('wizard:create-agent', async (event, opts) => {
  const bin = findOpenClaw();
  if (!bin) throw new Error('OpenClaw not installed');

  const vibeMap = {
    helpful: 'Warm, resourceful, and reliable. Always ready to help.',
    sharp: 'Witty, efficient, and direct. Gets things done fast.',
    creative: 'Imaginative, curious, and playful. Thinks outside the box.',
    technical: 'Precise, analytical, and thorough. Loves details.',
  };

  // Create agent via CLI
  try {
    const result = execSync(`"${bin}" agents add --non-interactive 2>&1`, { encoding: 'utf8' });
    return { ok: true, output: result };
  } catch {
    // Agent might already exist or CLI doesn't support non-interactive add
    // Return ok to continue the flow
    return { ok: true };
  }
});

ipcMain.handle('wizard:configure-channel', async (event, opts) => {
  const bin = findOpenClaw();
  if (!bin) throw new Error('OpenClaw not installed');

  // Write channel config
  try {
    const config = readOpenClawConfig() || {};
    if (!config.channels) config.channels = {};
    config.channels[opts.channel] = {
      enabled: true,
      token: opts.token,
    };
    const configPath = path.join(OPENCLAW_DIR, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return { ok: true };
  } catch (err) {
    throw new Error(err.message);
  }
});

ipcMain.handle('wizard:start-gateway', async () => {
  const bin = findOpenClaw();
  if (!bin) return { ok: false, error: 'openclaw not found' };

  // Try systemd first
  try {
    execSync('systemctl --user start openclaw-gateway 2>&1', { encoding: 'utf8' });
    return { ok: true, output: 'Gateway service started' };
  } catch {}

  // Fallback: start in background
  return await execPromise(`"${bin}" gateway start 2>&1`);
});

ipcMain.handle('wizard:launch', () => {
  switchToMainApp();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// App lifecycle — graceful shutdown
// ---------------------------------------------------------------------------
function cleanup() {
  if (isQuitting) return;
  isQuitting = true;
  killPty(ptyProcess);
  ptyProcess = null;
  killPty(chatPty);
  chatPty = null;
}

app.whenReady().then(() => {
  createWindow();

  // Start sync server for mobile companion app
  syncServer = new SyncServer({
    port: 9247,
    mainWindow,
    onChatMessage: (text, agentId, meta) => {
      // Mark this ws for TTS reply — same as audio_input flow
      if (meta.ws && syncServer) syncServer._voiceReplyWs = meta.ws;
      discordLog('💬', 'Mobile chat received', `"${text.substring(0, 60)}"`, 'voice');
      if (mainWindow && !mainWindow.isDestroyed()) {
        const { ws: _ws, ...serializableMeta } = meta || {};
        mainWindow.webContents.send('mobile-chat', { text, agentId, meta: serializableMeta });
      }
    },
    onVoiceTranscript: (transcript, context, meta) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('mobile-voice', { transcript, context, meta });
      }
    },
    onRequestChatHistory: (ws) => {
      // Ask renderer for current chat history, then send to mobile client
      console.log('[SyncServer] Mobile requested chat history');
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('[SyncServer] Requesting history from renderer');
        mainWindow.webContents.send('mobile-request-chat-history', {});
        // Store ws so IPC reply can find it
        if (!syncServer._pendingHistoryWs) syncServer._pendingHistoryWs = [];
        syncServer._pendingHistoryWs.push(ws);
        console.log('[SyncServer] Stored ws reference, waiting for renderer response');
      } else {
        console.log('[SyncServer] Main window not available!');
      }
    },
    onAudioInput: async (audioBase64, mimeType, ws, meta) => {
      try {
        // Immediately ack receipt so mobile can show "received at desktop"
        if (syncServer && ws && ws.readyState === 1) {
          syncServer._send(ws, { type: 'voice_received' });
          console.log('[Voice] Sent voice_received ack to mobile');
        } else {
          console.warn('[Voice] Could not send voice_received - syncServer or ws unavailable');
        }

        // Flash taskbar/dock to signal incoming voice message
        if (mainWindow && !mainWindow.isFocused()) {
          mainWindow.flashFrame(true);
          mainWindow.once('focus', () => mainWindow.flashFrame(false));
        }
        if (mainWindow) mainWindow.webContents.send('mobile-voice-incoming', {});

        // 1. Transcribe audio via Whisper
        console.log('[Voice] Starting transcription...');
        discordLog('🎤', 'Voice received', 'transcribing...', 'voice');
        const transcript = await transcribeAudio(audioBase64, mimeType);
        if (mainWindow) mainWindow.webContents.send('mobile-voice-transcribed', { transcript });
        if (!transcript) {
          console.warn('[Voice] Transcription returned empty result');
          if (syncServer && ws) syncServer.sendTranscript(ws, '');
          return;
        }

        console.log(`[Voice] Transcription complete: "${transcript.substring(0, 80)}"`);
        discordLog('📝', 'Transcribed', `"${transcript.substring(0, 80)}"`, 'info');
        // 2. Send transcript back to mobile for review / auto-send in focus mode
        const wsOpen = ws && ws.readyState === 1;
        console.log(`[Voice] Sending transcript back, ws.readyState=${ws?.readyState}`);
        discordLog('📤', 'Sending transcript to mobile', `ws=${wsOpen ? 'OPEN' : 'CLOSED'}`, wsOpen ? 'success' : 'warn');
        if (syncServer && ws) syncServer.sendTranscript(ws, transcript);

        // 3. Mark that the next AI reply should be spoken back (TTS audio response)
        syncServer._voiceReplyWs = ws;
      } catch (e) {
        console.error('[Voice] Transcription error:', e.message);
        if (syncServer && ws) syncServer.sendTranscript(ws, '');
      }
    },
  });
  syncServer.start();

  // Agent Reach — initialise remote tool bridge
  const RemoteToolBridge = require('./remote-tool-bridge');
  let remoteToolBridge = null;
  remoteToolBridge = new RemoteToolBridge(syncServer);
});

app.on('before-quit', cleanup);

app.on('window-all-closed', () => {
  if (syncServer) syncServer.stop();
  cleanup();
  app.quit();
});

// Sync server IPC handlers
ipcMain.handle('sync-status', () => {
  return syncServer ? syncServer.getStatus() : { running: false };
});

ipcMain.handle('sync-generate-pairing', () => {
  if (!syncServer) return null;
  return syncServer.generatePairingCode();
});

ipcMain.handle('sync-broadcast-state', (e, state) => {
  if (syncServer) syncServer.broadcastState(state);
});

ipcMain.handle('sync-broadcast-chat', async (e, { agentId, text, isUser }) => {
  console.log('[IPC] sync-broadcast-chat received:', { agentId, text: text.substring(0, 100), isUser });
  const wsState = syncServer?._voiceReplyWs ? `OPEN(${syncServer._voiceReplyWs.readyState})` : 'NULL';
  console.log('[IPC] _voiceReplyWs state:', wsState);
  discordLog('📡', 'Chat broadcast', `isUser=${isUser} voiceWs=${wsState}`);
  if (syncServer) {
    syncServer.broadcastChatMessage(agentId, text, isUser);
    console.log('[IPC] Message broadcast to mobile clients');
  }
  // If this AI reply follows a voice input, synthesize TTS and send audio back
  if (!isUser && syncServer && syncServer._voiceReplyWs) {
    const ws = syncServer._voiceReplyWs;
    syncServer._voiceReplyWs = null;
    const cleanText = stripEmojisForTTS(text);
    
    // Read TTS voice directly — can't call ipcMain.handle from within a handler
    let ttsVoice = 'lessac';
    try {
      const mainWin = BrowserWindow.getAllWindows()[0];
      if (mainWin) {
        ttsVoice = await mainWin.webContents.executeJavaScript(
          "(() => { const s = JSON.parse(localStorage.getItem('cyberclaw-settings') || '{}'); return s.ttsVoice || 'lessac'; })()"
        ) || 'lessac';
      }
    } catch (err) {
      console.warn('[TTS] Could not get voice setting, using default:', err.message);
    }
    
    console.log(`[TTS] Synthesizing voice response with ${ttsVoice}: "${cleanText.substring(0, 60)}..."`);
    discordLog('🔊', 'TTS synthesizing', `${ttsVoice}: "${cleanText.substring(0, 60)}"`);
    try {
      const audioBase64 = await synthesizeSpeech(cleanText, ttsVoice);
      if (audioBase64) {
        console.log(`[TTS] Synthesized ${audioBase64.length} chars, sending to mobile...`);
        syncServer.sendAudioResponse(ws, audioBase64, 'audio/wav');
        console.log('[TTS] Audio response sent to mobile');
        discordLog('✅', 'Audio sent to mobile', `${audioBase64.length} chars`);
      } else {
        console.warn('[TTS] synthesizeSpeech returned empty string');
      }
    } catch (e) {
      console.error('[TTS] voice reply synthesis failed:', e.message);
      discordLog('❌', 'TTS failed', e.message, 'error');
    }
  }
});

ipcMain.handle('sync-broadcast-typing', (e, { active }) => {
  if (syncServer) syncServer.broadcastTyping(active);
});

ipcMain.handle('sync-send-chat-history', (e, { messages }) => {
  if (!syncServer || !syncServer._pendingHistoryWs) return;
  const pending = syncServer._pendingHistoryWs.splice(0);
  for (const ws of pending) {
    syncServer.sendChatHistory(ws, messages);
  }
});

ipcMain.on('mobile-set-companion', (e, { companionId }) => {
  try {
    console.log(`[IPC] Mobile requesting companion change to: ${companionId}`);
    
    // Update companion window (same as desktop set)
    if (companionWindow) {
      if (!companionWindow.isDestroyed()) {
        companionWindow.webContents.send('companion-changed', { companionId });
        console.log(`[IPC] Sent companion-changed to arena for: ${companionId}`);
      }
    }
    
    // Update companion selector on main window (app.js)
    if (mainWindow) {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-companion-selector', { companionId });
        console.log(`[IPC] Sent update-companion-selector to UI for: ${companionId}`);
      }
    }
  } catch (e) {
    console.error('[IPC] Error handling mobile-set-companion:', e);
  }
});

ipcMain.on('desktop-set-companion', (e, { companionId }) => {
  try {
    console.log(`[IPC] ===== RECEIVED desktop-set-companion: ${companionId} =====`);
    
    // Broadcast to all connected mobile devices
    if (syncServer) {
      console.log(`[IPC] SyncServer exists, broadcasting...`);
      syncServer.broadcastCompanionChange(companionId);
      console.log(`[IPC] Broadcasted to mobile: ${companionId}`);
    } else {
      console.log(`[IPC] No SyncServer`);
    }
    
    // Update companion-window if it's open
    if (companionWindow) {
      console.log(`[IPC] Companion window exists`);
      if (!companionWindow.isDestroyed()) {
        console.log(`[IPC] Window not destroyed, sending IPC...`);
        companionWindow.webContents.send('companion-changed', { companionId });
        console.log(`[IPC] Sent companion-changed to window for: ${companionId}`);
      } else {
        console.log(`[IPC] Companion window is destroyed`);
      }
    } else {
      console.log(`[IPC] No companion window open`);
    }
  } catch (err) {
    console.error('[IPC] ERROR:', err);
  }
});

ipcMain.handle('test-tts-voice', async (e, { voice, text }) => {
  try {
    console.log(`[TEST] Testing TTS voice: ${voice}`);
    const audioBase64 = await synthesizeSpeech(text);
    if (audioBase64) {
      // Play the audio immediately
      const path = require('path');
      const os = require('os');
      const fs = require('fs');
      const tmpPath = path.join(os.tmpdir(), `tts-test-${Date.now()}.wav`);
      const buffer = Buffer.from(audioBase64, 'base64');
      fs.writeFileSync(tmpPath, buffer);
      
      // Try to play using the default system player
      const { exec } = require('child_process');
      if (process.platform === 'win32') {
        exec(`powershell -Command "(New-Object System.Media.SoundPlayer '${tmpPath}').PlaySync()"`);
      } else if (process.platform === 'darwin') {
        exec(`afplay "${tmpPath}"`);
      } else {
        exec(`aplay "${tmpPath}"`);
      }
      
      return { success: true, message: 'Playing test audio...' };
    }
  } catch (err) {
    console.error('[TEST] TTS test failed:', err.message);
    throw err;
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Handle uncaught errors gracefully
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
  cleanup();
  app.quit();
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

// Voice recording handler for desktop voice mode
ipcMain.handle('voice:start-recording', async (e, { durationMs }) => {
  try {
    const os = require('os');
    const path = require('path');
    const { execFile } = require('child_process');
    const tmpPath = path.join(os.tmpdir(), `voice-${Date.now()}.wav`);
    
    console.log(`[VOICE] Recording for ${durationMs}ms to ${tmpPath}`);
    
    // Use arecord to record audio
    const recorder = execFile('arecord', [
      '-f', 'S16_LE',
      '-r', '16000',
      '-c', '1',
      '-d', String(Math.ceil(durationMs / 1000)),
      '-q',
      tmpPath
    ]);
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        recorder.kill();
        resolve({ success: true, path: tmpPath });
      }, durationMs + 500);
      
      recorder.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Recording failed: ${err.message}`));
      });
      
      recorder.on('exit', (code) => {
        clearTimeout(timeout);
        if (code === 0 || code === 143) { // 0 = success, 143 = SIGTERM
          resolve({ success: true, path: tmpPath });
        } else {
          reject(new Error(`arecord exited with code ${code}`));
        }
      });
    });
  } catch (err) {
    console.error('[VOICE] Recording error:', err.message);
    throw err;
  }
});

// Whisper transcription handler for desktop voice mode
ipcMain.handle('whisper:transcribe', async (e, { audioBase64, mimeType, language }) => {
  try {
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    
    console.log(`[WHISPER] Transcribing audio (${language})...`);
    
    // Write base64 audio to temp file
    const tmpPath = path.join(os.tmpdir(), `whisper-input-${Date.now()}.wav`);
    const buffer = Buffer.from(audioBase64, 'base64');
    fs.writeFileSync(tmpPath, buffer);
    
    // Transcribe using local Whisper
    const transcript = await transcribeAudio(audioBase64, mimeType);
    
    // Clean up temp file
    try { fs.unlinkSync(tmpPath); } catch {}
    
    console.log(`[WHISPER] Transcribed: "${transcript.substring(0, 60)}..."`);
    return transcript || '';
    
  } catch (err) {
    console.error('[WHISPER] Transcription error:', err.message);
    throw err;
  }
});

// Get TTS voice setting from frontend
ipcMain.handle('settings:get-tts-voice', async (e) => {
  try {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) return 'lessac';
    
    // Execute JS in renderer to get the setting
    const voice = await mainWindow.webContents.executeJavaScript(
      "(() => { const s = JSON.parse(localStorage.getItem('cyberclaw-settings') || '{}'); return s.ttsVoice || 'lessac'; })()"
    );
    
    console.log('[SETTINGS] TTS voice:', voice);
    return voice || 'lessac';
  } catch (err) {
    console.warn('[SETTINGS] Could not get TTS voice:', err.message);
    return 'lessac';
  }
});
