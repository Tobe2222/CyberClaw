const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');
// v3.2.32: companion soul + memory + CYBERCLAW.md prompt loader
const companionPrompts = require('./companion-prompts');

// Desktop log panel — sends structured log entries to renderer via IPC
function discordLog(emoji, title, detail = '', level = 'info') {
  try {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length) wins[0].webContents.send('desktop-log', { emoji, title, detail, level });
  } catch {}
  console.log(`[LOG] ${emoji} ${title}${detail ? ' — ' + detail : ''}`);
}

let mainWindow;

// v3.2.52: attachment batching buffer. The mobile sends
// each image as a SEPARATE WS `attachment` message (one
// per file in the user's selection). Without batching, the
// desktop fires one `mobile-attachment` IPC per image, and
// each one triggers its own chat:send-message HTTP call
// to the gateway. A 9-image paste would queue 9 separate
// LLM calls in the renderer's per-agent chatSendChain,
// each of which could take 10-30s — easily exceeding the
// chain timeout. Tobe 2026-08-02 22:13: 'No response
// from OpenClaw.' (the chain timed out before all calls
// completed).
//
// Batching: hold attachments for 700ms after the LAST
// one arrives. Then fire ONE mobile-attachment-batch IPC
// with all attachments in a single payload. The renderer's
// handler builds ONE multimodal content array, fires ONE
// chat:send-message call. Same Discord-style flow.
let pendingAttachments = [];
let attachmentFlushTimer = null;
const ATTACHMENT_FLUSH_MS = 700;
// v3.2.56: buffer the inbound mobile chat text so an
// attachment batch can merge with it before the LLM call
// is fired. The mobile sends text and attachments as
// separate WS messages; the text arrives immediately,
// the attachment bytes take 50-200ms to upload. Without
// buffering, the renderer fires a text-only LLM call
// (the user sees "I can't see image" in the chat bubble)
// and then a separate image-only LLM call 700ms later
// (TTS'd, never shown as a chat bubble). Buffering here
// in main.js lets us know about both text AND the
// pendingAttachments array at the same time.
let pendingMobileChatText = null; // { text, agentId, meta, timer }
const MOBILE_CHAT_HOLD_MS = 1500;

function flushAttachmentBatch() {
  if (pendingAttachments.length === 0) return;
  const batch = pendingAttachments;
  pendingAttachments = [];
  attachmentFlushTimer = null;
  // v3.2.54: log the batch we're about to send so we
  // can see whether the base64 data is actually in the
  // payload. Tobe 2026-08-02 22:35 test showed the
  // desktop log had body=4483b with attachments=1 — way
  // too small for a 264KB image. The base64 must be
  // getting dropped somewhere in the IPC chain.
  for (const a of batch) {
    const dataLen = a.data ? a.data.length : 0;
    console.log(`[mobile-attachment-batch] flushing ${a.fileName} (${a.size} bytes on disk, data=${dataLen} chars of base64, hasData=${!!a.data})`);
  }
  // v3.2.56: if a mobile chat is buffered, merge the text
  // with the attachments. The mobile sends text and
  // attachments as separate WS messages; without merging
  // the LLM sees a text-only turn followed by an image-only
  // turn (split-turn bug — Tobe 2026-08-03 09:23 confirmed
  // the split was still happening with the v3.2.56
  // 600ms renderer hold). The fix lives here in main.js
  // because this is the only layer that has visibility
  // into both pendingAttachments and the buffered text.
  if (pendingMobileChatText) {
    if (pendingMobileChatText.timer) clearTimeout(pendingMobileChatText.timer);
    const text = pendingMobileChatText.text;
    const agentId = pendingMobileChatText.agentId;
    const capturedMeta = pendingMobileChatText.meta;
    pendingMobileChatText = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      const { ws: _ws, ...serializableMeta } = capturedMeta || {};
      console.log(`[mobile-attachment-batch] merging text from pending mobile chat: ${text.substring(0, 60)}`);
      // Send a single combined IPC. The renderer's
      // mobile-chat handler will see the attachments
      // array and route to sendChatMessage(text, attachments)
      // instead of a text-only send.
      mainWindow.webContents.send('mobile-chat-with-attachments', {
        text,
        agentId,
        meta: serializableMeta,
        attachments: batch,
      });
      return;
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mobile-attachment-batch', {
      attachments: batch,
    });
  }
}
let ptyProcess = null;
let chatPty = null;
let isQuitting = false;

// v3.2.4: renderer-hang watchdog. Counts consecutive
// unacked mobile-voice IPCs (Tobe's v3.10.12 + v3.10.13
// hang case). After 3 consecutive hangs within a 5-minute
// window, reload the renderer (webContents.reload()).
// The reload clears the hung JS context but loses any
// in-memory state (chat history in renderer memory, etc.)
// — acceptable trade-off for restoring voice-mode
// usability, since the user's primary feedback was "it
// failed to respond" with no path forward.
let rendererHangCount = 0;
let rendererLastHangTs = 0;
const RENDERER_HANG_RELOAD_THRESHOLD = 1;
const RENDERER_HANG_RELOAD_WINDOW_MS = 5 * 60 * 1000;
// v3.2.6: pending-voice queue. Holds voice transcripts
// whose routing to the renderer has not yet been
// acknowledged. If the renderer hangs and we reload
// it, we re-route the queue so the user's prompts
// aren't lost. Tobe's v3.10.14 complaint: "the user
// should not need to repeat himself often" — without
// this queue, every renderer hang means the user has
// to speak the prompt again. Cap at 3 entries so a
// runaway queue can't stack up; if 3 are queued we
// drop the oldest.
const PENDING_VOICE_QUEUE_CAP = 3;
const pendingVoiceQueue = [];
// v3.2.7: Set of voiceIds that have been ack'd by the
// renderer (received the mobile-voice IPC). Used by the
// ack-watcher to distinguish "renderer never received
// the IPC" (true hang) from "renderer received the IPC
// but hung on the LLM call" (different bug, handled
// by the response tracker instead).
const ackedVoiceIds = new Set();
function drainPendingVoiceQueue() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.webContents || mainWindow.webContents.isDestroyed()) return;
  if (mainWindow.webContents.isCrashed()) return;
  const now = Date.now();
  let drained = 0;
  while (pendingVoiceQueue.length > 0) {
    const entry = pendingVoiceQueue[0];
    if (now - entry.ts > 60000) {
      // Drop entries older than 60s — user has likely
      // moved on.
      pendingVoiceQueue.shift();
      continue;
    }
    try {
      mainWindow.webContents.send('mobile-voice', {
        transcript: entry.transcript,
        context: entry.context || '',
        meta: entry.meta || { source: 'mobile' },
      });
      pendingVoiceQueue.shift();
      drained++;
      console.log(`[Voice] Re-routed pending transcript after renderer reload (ts=${entry.ts})`);
    } catch (e) {
      console.error('[Voice] drain failed:', e.message);
      break;
    }
  }
  if (drained > 0) {
    console.log(`[Voice] Drained ${drained} pending voice transcript(s) after renderer reload`);
    discordLog('🔁', 'Replayed queued voice prompts',
      `${drained} pending transcript(s)`, 'info');
  }
}
function maybeReloadRenderer() {
  const now = Date.now();
  if (now - rendererLastHangTs > RENDERER_HANG_RELOAD_WINDOW_MS) {
    // Window expired — reset counter.
    rendererHangCount = 0;
  }
  rendererHangCount++;
  rendererLastHangTs = now;
  if (rendererHangCount >= RENDERER_HANG_RELOAD_THRESHOLD) {
    if (mainWindow && !mainWindow.isDestroyed() &&
        mainWindow.webContents && !mainWindow.webContents.isDestroyed() &&
        !mainWindow.webContents.isCrashed()) {
      console.warn(`[Renderer] ${rendererHangCount} consecutive hangs — reloading`);
      discordLog('🔄', 'Renderer auto-reload',
        `${rendererHangCount} consecutive hangs`, 'warn');
      try { mainWindow.webContents.reload(); } catch (e) {
        console.error('[Renderer] reload failed:', e.message);
      }
    }
    rendererHangCount = 0;
  }
}

const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');
const CYBERCLAW_DIR = path.join(OPENCLAW_DIR, 'cyberclaw');
const QUESTS_FILE = path.join(CYBERCLAW_DIR, 'quests.json');
const STATS_FILE = path.join(CYBERCLAW_DIR, 'companion-stats.json');
const PROVIDERS_FILE = path.join(CYBERCLAW_DIR, 'providers.json');
// v3.1.33: user-managed LLM endpoints (Ollama, LM Studio,
// llama.cpp server, etc.). Stored separately from the
// existing providers.json (which is for API providers like
// Anthropic/OpenAI). Endpoints expose an OpenAI-compatible
// /v1/models + /v1/chat/completions API, so they can serve
// any GGUF/transformer model the user has downloaded.
const LLM_ENDPOINTS_FILE = path.join(CYBERCLAW_DIR, 'llm-endpoints.json');

// Companion stats persistence (skills, XP, levels)
function loadStats() {
  let stats;
  try { stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch { return {}; }
  // v3.2.84: migrate legacy skill names. v3.2.84 renamed
  // "Coding" → "Building" (and dropped a few overly-broad
  // keywords). Existing saved stats from earlier versions
  // still have entries under the old name; without this
  // migration the renderer would show them at "level 1,
  // 0 XP" forever (since it now looks up the new name).
  //
  // Map is small and stable. If we add more renames later,
  // append here. Removal of a name (no migration target)
  // just drops the entry — its XP is forfeit. Not great
  // but acceptable; alternative is to keep the old names
  // in the renderer too, which is worse for clarity.
  const SKILL_RENAMES = { Coding: 'Building' };
  let mutated = false;
  for (const agentId of Object.keys(stats)) {
    const agent = stats[agentId];
    if (!agent || !agent.skills) continue;
    for (const [oldName, newName] of Object.entries(SKILL_RENAMES)) {
      if (agent.skills[oldName] && !agent.skills[newName]) {
        agent.skills[newName] = agent.skills[oldName];
        delete agent.skills[oldName];
        mutated = true;
      }
    }
  }
  if (mutated) saveStats(stats);
  return stats;
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
//
// v3.1.50: each quest is migrated on load to add `active: false`
// (no quest is selected by default) and `latestChanges: []` (the
// companion's running journal of what it did on this quest).
// The migration is idempotent — existing fields are preserved.
//
// We do this in loadQuests (not in a separate migration step) so
// every reader sees the same shape regardless of when the file
// was last touched. The cost is a per-load O(n) sweep on the
// array; n is the number of quests (typically < 20) so the cost
// is negligible.
function loadQuests() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(QUESTS_FILE, 'utf8'));
  } catch { return []; }
  if (!Array.isArray(raw)) return [];
  let mutated = false;
  for (const q of raw) {
    if (typeof q.active !== 'boolean') { q.active = false; mutated = true; }
    if (!Array.isArray(q.latestChanges)) { q.latestChanges = []; mutated = true; }
    // v3.2.59: per-quest conversation log — automatic running
    // transcript of every user + agent message exchanged while
    // this quest was active. Each entry is {ts, role, text,
    // agentId, agentName} with text capped at 1000 chars.
    // Capped at 200 entries (oldest shifted out); the most
    // recent 20 are injected into the LLM context by
    // buildActiveQuestContext so the companion has
    // cross-session memory of what was discussed on this quest.
    // Existing pre-v3.2.59 quests get an empty array; the
    // next session on that quest starts populating it.
    if (!Array.isArray(q.conversationLog)) { q.conversationLog = []; mutated = true; }
  }
  // v3.1.50: enforce the invariant that at most one quest is
  // `active: true`. If a migration left multiple active (shouldn't
  // happen, but defensive), keep the first and clear the rest.
  let sawActive = false;
  for (const q of raw) {
    if (q.active) {
      if (sawActive) { q.active = false; mutated = true; }
      else sawActive = true;
    }
  }
  return raw;
}
function saveQuests(quests) {
  fs.mkdirSync(CYBERCLAW_DIR, { recursive: true });
  fs.writeFileSync(QUESTS_FILE, JSON.stringify(quests, null, 2));
  // v3.1.95: every persistent quest change broadcasts the full
  // list to connected mobiles so they keep their mirror in sync
  // without polling. We broadcast the source-of-truth list from
  // disk (just-written), not the in-memory array the caller
  // passed, so a malformed write doesn't propagate.
  if (syncServer) {
    try { syncServer.broadcastQuestsList(loadQuests()); } catch (e) { console.warn('[IPC] broadcastQuestsList after save failed:', e?.message); }
  }
  // v3.2.42: also push the updated list to the desktop's own
  // renderer. Without this, when the mobile changes the
  // active quest, the renderer's in-memory activeQuestId
  // stays stale — the renderer only re-reads the disk
  // state when something it does triggers renderQuests().
  // The next chat send then builds the context with the
  // stale active quest and the companion's reply says
  // 'wait, what's the active quest?' — exactly the bug
  // Tobe hit on 2026-08-02 17:27: "Yeah it says
  // Cyber_Music is active" when the disk (and the mobile)
  // said CYBERHIVE_WEBSITE V3 was active. mainWindow is
  // declared at module scope above; safe to reference here.
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('quests-updated', loadQuests()); } catch (e) { console.warn('[IPC] quests-updated to renderer failed:', e?.message); }
  }
}

const { execSync, exec: execCb, spawn } = require('child_process');
const SyncServer = require('./sync-server');
// v3.2.21: friendly tool-name mapping for the better
// "thinking" indicator. Maps internal OpenClaw tool
// names to short, concise text the mobile can show
// while the agent is working. Tobe asked for "short
// and concise" — each entry is a single short phrase.
function toolFriendlyName(tool) {
  switch (tool) {
    case 'exec': return 'Running command...';
    case 'read': return 'Reading file...';
    case 'write': return 'Writing file...';
    case 'edit': return 'Editing file...';
    case 'message': return 'Sending message...';
    case 'browser': return 'Browsing...';
    case 'web_search': return 'Searching...';
    case 'process': return 'Running process...';
    case 'cron': return 'Scheduling...';
    case 'memory_search': return 'Searching memory...';
    case 'memory_write': return 'Saving to memory...';
    default: return 'Thinking...';
  }
}

// v3.2.21: tail OpenClaw session JSONL files so Discord-
// routed agent replies reach the mobile chat. See
// ./openclaw-session-tail.js for the full rationale.
const { OpenClawSessionTail } = require('./openclaw-session-tail');
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

// v3.10.9: strip Markdown formatting for TTS. The chat
// display keeps the formatting (so Tobe sees the rendered
// markdown), but the spoken version removes noise that
// the LLM produces for visual emphasis.
//
// What gets stripped:
// - **bold** / __bold__  → "bold" (no asterisks read aloud)
// - *italic* / _italic_  → "italic"
// - # / ## / ### headers  → remove the leading hash signs
// - - or * list bullets  → remove the bullet prefix
// - `code`               → "code" (no backticks read aloud)
// - [text](url)          → "text" (URLs not read)
// - > blockquote         → remove the > prefix
//
// What is KEPT:
// - /paths/like/this    → spoken as "slash paths slash like
//                         slash this" — Tobe explicitly
//                         wants filesystem paths kept
//                         ("i still want it to say
//                         tobe/projects/cool things with
//                         the slash")
// - _var_names_with_underscores → kept as-is (single
//                                 underscores inside words
//                                 are not markdown)
function stripMarkdownForTTS(text) {
  return text
    // Bold (**text** or __text__) — strip the markers.
    // Order matters: do the double-char markers first so
    // we don't accidentally strip the inner * of **.
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    // Italic (*text* or _text_) — but only when the
    // markers are at word boundaries, so we don't strip
    // underscores inside identifiers (snake_case).
    .replace(/(^|[\s(>])(\*([^*]+)\*)(?=[\s.,!?:;)]|$)/g, '$1$3')
    .replace(/(^|[\s(>])(_([^_]+)_)(?=[\s.,!?:;)]|$)/g, '$1$3')
    // Inline code (`text`) — strip backticks.
    .replace(/`([^`]+)`/g, '$1')
    // Links [text](url) — keep text, drop url.
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Headers (### text, ## text, # text) — strip leading hashes.
    .replace(/^\s*#{1,6}\s+/gm, '')
    // List bullets (- or *) at the start of a line — strip the
    // bullet and any leading whitespace after it. Two patterns
    // because the LLM sometimes produces '-**bold:**' where
    // the - is glued to the next markdown construct.
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^[-*+](?=[*_`])/gm, '')
    // v3.10.9: leftover bullets after the ** / __ strip.
    // Example: "-**commit:**" → after the ** strip becomes
    // "-commit:" — still has a leading -. Strip a - or *
    // at the start of a line that's now followed by a word.
    .replace(/^[-*+](?=\w)/gm, '')
    // Inline list bullets too: `text -**commit:** abc` →
    // `text commit: abc`. Strip a - or * immediately followed
    // by another markdown char, after whitespace.
    .replace(/(\s)[-*+](?=[*_`])/g, '$1')
    .replace(/(\s)[-*+](?=\w)/g, '$1')
    // v3.10.9: catch-all for inline bullets after the **
    // strip has run. By this point the ** markers are gone
    // and `-` is followed by a word. Strip it.
    // Pattern: whitespace-dash-space-word. Only fires
    // AFTER the inline (no-space) bullet strip above
    // fails (otherwise `text -**` would match here too
    // and we'd over-strip). Since we already removed the
    // no-space case above, this only fires when there's
    // a space between - and the next word.
    .replace(/(\s)- (?=\w)/g, '$1')
    // Blockquote (>) at the start of a line — strip the >.
    .replace(/^\s*>\s+/gm, '')
    // Collapse extra whitespace from the strip operations.
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
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

  // v3.2.4: capture renderer console output to the
  // main-process log. Without this, renderer-side
  // console.log (e.g. "[mobile-voice] received:")
  // only shows in DevTools. When the renderer hangs
  // and DevTools isn't open, we can't see WHY.
  // Tobe's v3.10.14 hang: the desktop log showed
  // 'webContents.send("mobile-voice", ...) was called'
  // but the renderer's console.log never produced
  // '[mobile-voice] received' — was it because the
  // handler never ran, or because the console output
  // was lost? With this listener, we can tell.
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    // level: 0=verbose, 1=info, 2=warning, 3=error
    const tag = ['[VR]', '[RI]', '[RW]', '[RE]'][level] || '[R?]';
    console.log(`${tag} ${message}`);
  });

  // v3.2.4: surface renderer crashes/unresponsiveness.
  // did-fail-load fires when the page fails to load
  // (network error, JS error during load, etc.).
  // unresponsive fires when the renderer becomes
  // unresponsive (no input handling for N seconds).
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error(`[Renderer] did-fail-load: ${errorCode} ${errorDescription} url=${validatedURL}`);
    discordLog('❌', 'Renderer failed to load', `${errorCode} ${errorDescription}`, 'error');
  });
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error(`[Renderer] render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`);
    discordLog('💥', 'Renderer crashed', `reason=${details.reason}`, 'error');
  });
  mainWindow.webContents.on('unresponsive', () => {
    console.error('[Renderer] unresponsive event fired');
    discordLog('⚠️', 'Renderer unresponsive', 'OS reported renderer hung', 'error');
  });
  mainWindow.webContents.on('responsive', () => {
    console.log('[Renderer] responsive event fired');
    discordLog('✅', 'Renderer responsive', 'recovered', 'success');
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

  // v3.2.4: renderer-readiness ping. After the page
  // loads, fire a `renderer-ready-check` IPC and
  // wait for the renderer's `renderer-ready-ack`
  // response. If no ack within 5s, the renderer's
  // JS context is dead-on-arrival (e.g. app.js
  // failed to load, IPC listener wasn't registered).
  // Tobe's v3.10.14 test: fresh desktop, renderer
  // never logged "[mobile-voice] received" — could
  // be hang OR dead-on-arrival. This ping
  // distinguishes the two cases.
  //
  // Tobe also asked us to ship a fix so voice mode
  // is usable on a fresh desktop — auto-reload on
  // boot if the renderer doesn't ack.
  let rendererReadyTimer = null;
  const onRendererReadyAck = () => {
    if (rendererReadyTimer) {
      clearTimeout(rendererReadyTimer);
      rendererReadyTimer = null;
    }
    console.log('[Renderer] startup ready ack received');
    rendererHangCount = 0; // reset on successful boot
  };
  ipcMain.on('renderer-ready-ack', onRendererReadyAck);
  // v3.2.6: switched from `once` to `on` so subsequent
  // renderer reloads also fire this. Each time the
  // page finishes loading (initial boot OR reload),
  // we send the ready-check AND drain any pending
  // voice transcripts that were queued before the
  // reload. This is the auto-recovery path for Tobe's
  // "user shouldn't have to repeat himself" complaint.
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Renderer] page finished loading, sending ready check');
    try { mainWindow.webContents.send('renderer-ready-check', { ts: Date.now() }); } catch (_) {}
    rendererReadyTimer = setTimeout(() => {
      console.error('[Renderer] no ready ack within 5s — reloading');
      discordLog('❌', 'Renderer not responsive on boot', 'Reloading...', 'error');
      if (mainWindow && !mainWindow.isDestroyed() &&
          mainWindow.webContents && !mainWindow.webContents.isDestroyed() &&
          !mainWindow.webContents.isCrashed()) {
        try { mainWindow.webContents.reload(); } catch (_) {}
      }
    }, 5000);
    // Drain queued voice transcripts. The renderer
    // is fresh now — re-route anything that was
    // pending before the reload.
    drainPendingVoiceQueue();
  });
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

// v3.2.51: read the OpenClaw gateway config to get the
// base URL and bearer token for HTTP API calls. The
// gateway runs on the loopback by default (port 18789)
// and is reachable as http://127.0.0.1:<port>/. Auth is
// a token configured under gateway.auth.token (mode
// 'token') in ~/.openclaw/openclaw.json.
//
// We re-read the config on every call (not cached) so
// config changes take effect without restarting the
// desktop. The read is cheap — one JSON.parse of a
// small file. If the file is unreadable, we return null
// and the caller falls back to the CLI path.
function readGatewayConfig() {
  try {
    const cfgPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    if (!fs.existsSync(cfgPath)) return null;
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const cfg = JSON.parse(raw);
    const gw = cfg.gateway || {};
    const port = gw.port || 18789;
    const bind = gw.bind || 'loopback';
    // Default host: 127.0.0.1 for loopback bind,
    // 0.0.0.0 / [lan-ip] for non-loopback. The
    // gateway is always loopback in local mode.
    const host = bind === 'loopback' ? '127.0.0.1' : '0.0.0.0';
    const baseUrl = `http://${host}:${port}`;
    const token = (gw.auth && gw.auth.token) || null;
    const httpEnabled = !!(gw.http && gw.http.endpoints && gw.http.endpoints.chatCompletions && gw.http.endpoints.chatCompletions.enabled);
    return { baseUrl, token, httpEnabled, port };
  } catch (e) {
    console.warn('[gateway-config] read failed:', e?.message);
    return null;
  }
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

ipcMain.handle('chat:send-message', async (event, { agentId, message, attachments, silent }) => {
  // v3.2.51: prefer the OpenAI-compatible HTTP API on the
  // gateway over the `openclaw agent -m` CLI. The HTTP path
  // supports multimodal content (text + image_url), which is
  // the Discord-style attachment flow Tobe asked for on
  // 2026-08-02 21:45 ("make it such that it works like it
  // does in discord"). The CLI path is text-only.
  //
  // The CLI path is kept as a fallback if the gateway's HTTP
  // endpoint is disabled or unreachable.
  const gw = readGatewayConfig();
  // v3.2.55: log which path we picked. Tobe 2026-08-02
  // 22:35 test showed the LLM still couldn't see images
  // even though the renderer reported the dataUri was
  // built correctly. The POST log for the HTTP path
  // never fired, which means the handler went to CLI
  // instead. This log makes that decision visible.
  const useHttp = !!(gw && gw.httpEnabled && gw.token);
  console.log(`[chat:send] agent=${agentId} useHttp=${useHttp} gw.httpEnabled=${!!(gw && gw.httpEnabled)} gw.token=${!!(gw && gw.token)} attachments=${Array.isArray(attachments) ? attachments.length : 0} silent=${!!silent}`);
  if (useHttp) {
    return await sendChatMessageViaHttp(agentId, message, attachments, gw);
  }
  return await sendChatMessageViaCli(agentId, message, attachments);
});

// v3.2.51: HTTP API path. POSTs to /v1/chat/completions
// on the gateway. multimodal content array (text +
// image_url with base64 data URL) when attachments are
// present; plain string content otherwise.
async function sendChatMessageViaHttp(agentId, message, attachments, gw) {
  // v3.2.32: prepend the assembled system context (safety
  // preamble + CYBERCLAW.md + soul.md + memory.md) to the
  // user message before sending to the LLM.
  let ctx;
  try {
    ctx = companionPrompts.assembleContext(agentId);
  } catch (e) {
    console.error('[chat:send/http] context assembly failed:', e.message);
    ctx = '';
  }
  // Build the user-content array. With attachments, the
  // OpenAI multimodal shape is:
  //   content: [
  //     {type: 'text', text: '...'},
  //     {type: 'image_url', image_url: {url: 'data:...'}}
  //   ]
  // Without attachments, plain string content is fine.
  let userContent;
  const textPart = ctx ? ctx + message : message;
  if (Array.isArray(attachments) && attachments.length > 0) {
    const parts = [{ type: 'text', text: textPart }];
    for (const att of attachments) {
      // att: { data: base64, mimeType, fileName, dataUri }
      // The gateway accepts data: URIs in image_url.url per
      // the OpenAI spec. Pass through as-is.
      const dataUri = att.dataUri || (att.data ? `data:${att.mimeType || 'image/png'};base64,${att.data}` : null);
      if (!dataUri) continue;
      // image_url is the multimodal content type for images.
      // We send the data URI directly; the gateway forwards
      // it to the underlying model.
      parts.push({
        type: 'image_url',
        image_url: { url: dataUri },
      });
    }
    userContent = parts;
  } else {
    userContent = textPart;
  }
  // Build the request body. The model id 'openclaw/<id>'
  // routes to the specific agent (vs 'openclaw/default'
  // which routes to the configured default).
  const body = {
    model: `openclaw/${agentId}`,
    messages: [{ role: 'user', content: userContent }],
    user: `cyberclaw:${agentId}`,
  };
  const url = `${gw.baseUrl}/v1/chat/completions`;
  // v3.2.68: bumped httpTimeoutMs from 60s to 600s and
  // changed the abort path to NOT fall through to the CLI
  // fallback. v3.2.65's 60s was too aggressive — legitimate
  // long LLM calls (multi-tool code refactors, BOS+ protobuf
  // reasoning, etc.) routinely exceed 60s, and aborting
  // them just to fall through to `sendChatMessageViaCli`
  // created a worse bug: the CLI path spawns a NEW isolated
  // `openclaw agent` session, so the user got TWO replies
  // for one message (the late HTTP reply + the immediate
  // CLI reply). Tobe 2026-08-05 11:00 saw exactly this:
  // 'now it timed out again. Cant it just run longer if hes
  // working?' The 600s now matches the renderer's UI cap
  // (Promise.race AGENT_TIMEOUT_MS = 600000, see app.js).
  // On abort we return the timeout error directly so the
  // renderer shows a clean retry-able message instead of
  // spawning a duplicate CLI session. The renderer-side
  // cap (600s) handles the 'wedged lane forever' case
  // already.
  const httpTimeoutMs = 600000; // 600s, matches renderer UI cap
  try {
    // v3.2.53: log the request shape we're sending so we
    // can debug what the model actually receives. Tobe
    // 2026-08-02 22:25: 'he claims to still not see the
    // images.' We need to know whether the bytes are
    // reaching the gateway or getting truncated along
    // the way.
    const bodySize = Buffer.byteLength(JSON.stringify(body), 'utf8');
    const attachmentsCount = Array.isArray(attachments) ? attachments.length : 0;
    console.log(`[chat:send/http] POST ${url} (body=${bodySize}b, attachments=${attachmentsCount})`);
    // v3.2.68: AbortController timeout matches renderer UI
    // cap. On abort we just return the error to the
    // renderer (no CLI fallback, no duplicate session).
    const ctrl = new AbortController();
    const httpTimer = setTimeout(() => ctrl.abort(), httpTimeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${gw.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(httpTimer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn('[chat:send/http] non-2xx:', res.status, text?.slice(0, 200));
      // Fall back to CLI path so a gateway hiccup doesn't
      // kill chat.
      return await sendChatMessageViaCli(agentId, message, attachments, `HTTP ${res.status}: ${text?.slice(0, 120)}`);
    }
    const json = await res.json();
    console.log(`[chat:send/http] response status=${res.status} keys=${Object.keys(json || {}).join(',')}`);
    // OpenAI shape: choices[0].message.content (string).
    // Some models can return multiple choices; we take the
    // first. v3.2.31's multi-payload concat still applies
    // if the message is a concatenation; for now we trust
    // the gateway's normalization.
    let reply = null;
    if (json && Array.isArray(json.choices) && json.choices[0]) {
      const m = json.choices[0].message || {};
      reply = m.content || m.reasoning_content || '';
      // v3.2.53: log whether the model's response includes
      // any image_url content (vision model acknowledging
      // it saw the image) — helps debug the "I can't see
      // the images" claim. Tobe 2026-08-02 22:25.
      if (Array.isArray(m.content)) {
        console.log(`[chat:send/http] multimodal reply content parts=${m.content.length}`);
      }
    }
    if (reply && reply.trim()) {
      const result = { ok: true, reply: reply.trim() };
      // v3.2.84: pass reply through so classifyTask can compare user
      // message vs. assistant reply and pick the more specific match.
      result.taskSkill = classifyTask(message, reply.trim());
      return result;
    }
    return { ok: false, error: 'No reply in HTTP response', output: JSON.stringify(json).slice(0, 300) };
  } catch (e) {
    const isAbort = e?.name === 'AbortError' || /aborted/i.test(e?.message || '');
    const reason = isAbort ? `aborted after ${httpTimeoutMs}ms` : (e?.message || 'unknown');
    console.warn(`[chat:send/http] fetch failed (${reason}):`, e?.message);
    if (isAbort) {
      // v3.2.68: on HTTP timeout, return a clean error
      // directly instead of falling through to the CLI
      // path. The CLI fallback spawns a NEW isolated
      // session, which caused duplicate replies when a
      // legitimate long LLM call eventually returned to
      // the original HTTP path. The user can retry; the
      // renderer shows the timeout error.
      return {
        ok: false,
        error: `HTTP request timed out after ${Math.round(httpTimeoutMs / 1000)}s. The model may still be working on the gateway — try again if you don't see a reply.`,
        output: `timeout after ${httpTimeoutMs}ms`,
        timedOut: true,
      };
    }
    // Non-abort failures (network unreachable, malformed
    // token, gateway crash) still benefit from the CLI
    // fallback — better a duplicate reply than no reply.
    return await sendChatMessageViaCli(agentId, message, attachments, `HTTP fetch failed: ${reason}`);
  }
}

// v3.2.51: legacy CLI path. Kept as the fallback when the
// gateway's HTTP endpoint is disabled or unreachable.
// Pre-3.2.51 code was inlined in the chat:send-message
// handler; we split it out for clarity.
async function sendChatMessageViaCli(agentId, message, attachments, hint) {
  // Attachments are not supported on the CLI path (the
  // -m flag is text-only). If attachments were provided
  // we include a hint in the text so the LLM knows they
  // arrived but couldn't be embedded inline.
  const bin = findOpenClaw();
  if (!bin) return { ok: false, error: 'OpenClaw not found' };

  let ctx;
  try {
    ctx = companionPrompts.assembleContext(agentId);
  } catch (e) {
    console.error('[chat:send/cli] context assembly failed:', e.message);
    ctx = '';
  }
  let finalMessage = ctx ? ctx + message : message;
  if (Array.isArray(attachments) && attachments.length > 0) {
    const lines = attachments.map((a, i) => `  ${i + 1}. ${a.fileName || 'attachment'} (${a.mimeType || 'image/png'}, ${a.size || '?'} bytes) — saved at ${a.path || a.uri || 'unknown'}`);
    finalMessage += `\n\n[Attachments received but not embedded inline (CLI path doesn't support image content):\n${lines.join('\n')}\n\nPlease acknowledge the attachments and ask the user to describe them if you cannot view them.]`;
  }
  if (hint) {
    finalMessage = `[Note: the HTTP API path was attempted but failed: ${hint}]\n\n` + finalMessage;
  }

  try {
    // v3.2.65: switch from execCb (which runs through
    // `/bin/sh -c "<giant string>"`) to spawn() with the
    // message as a real argv entry. The previous code did
    // `"` → `\"` shell escaping but left literal newlines,
    // backticks, and dollar signs in finalMessage (it can
    // be 30KB+ of multi-line system prompt + tags). /bin/sh
    // tried to parse the whole blob as a shell script and
    // barfed `cannot open agentId: No such file /
    // INSTRUCTIONS.md: not found / remember_fact: not found
    // / CREATE_QUEST: not found` etc. — and the renderer's
    // Error bubble displayed the entire err.message
    // verbatim. Tobe 2026-08-05 06:12: 'he spewed alot of
    // crap. He should not'. spawn() takes argv as an array
    // so there's no shell interpretation at all — newlines
    // and special chars go straight to the child as one
    // argv entry.
    const result = await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      const child = spawn(bin, ['agent', '-m', finalMessage, '--agent', agentId, '--json'], {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 180000);
      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('error', (err) => {
        clearTimeout(killTimer);
        resolve({ ok: false, error: err.message, output: stderr || err.message });
      });
      child.on('close', (code, signal) => {
        clearTimeout(killTimer);
        if (code !== 0 && (!stdout || !stdout.trim())) {
          // v3.2.65: don't surface raw stderr/err.message to
          // the renderer as the user-visible reply — that was
          // how we ended up dumping 30KB of system prompt
          // into the chat bubble. Instead, return a short
          // friendly error and put the verbose output in a
          // separate log-only field the desktop logger can
          // surface.
          const friendly = signal === 'SIGKILL'
            ? 'agent CLI timed out after 180s'
            : `agent CLI exited with code ${code}`;
          console.warn('[chat:send/cli] child failed:', friendly, '\n--- stderr ---\n', stderr.slice(0, 400));
          resolve({ ok: false, error: friendly, output: stderr.slice(0, 200), cliStderr: stderr });
          return;
        }
        const parsed = extractFirstJsonObject(stdout);
        if (parsed) {
          let reply = null;
          if (parsed.result && parsed.result.payloads && parsed.result.payloads.length > 0) {
            const parts = [];
            for (const p of parsed.result.payloads) {
              if (p && typeof p.text === 'string' && p.text.trim()) {
                parts.push(p.text);
              }
            }
            if (parts.length > 0) reply = parts.join('\n\n');
          }
          if (!reply) reply = parsed.reply || parsed.message || parsed.text;
          if (!reply && typeof parsed === 'string') reply = parsed;
          if (reply && reply.trim()) {
            resolve({ ok: true, reply: reply });
          } else {
            resolve({ ok: false, error: parsed.error || 'No reply in agent response', output: stderr || '' });
          }
        } else {
          const trimmed = (stdout || '').trim();
          const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[');
          if (trimmed && !looksLikeJson) {
            resolve({ ok: true, reply: trimmed });
          } else {
            resolve({ ok: false, error: 'Could not parse agent response', output: stderr || trimmed });
          }
        }
      });
    });
    if (result.ok) {
      // v3.2.84: pass reply through so classifyTask can compare user
      // message vs. assistant reply and pick the more specific match.
      result.taskSkill = classifyTask(message, result.reply);
    }
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Skill taxonomy (single source of truth — shared with renderer + mobile)
// ---------------------------------------------------------------------------
// v3.2.84: widened keyword lists + added "Building" rename for Coding,
// added "Game" coverage of arena/quest/feed work. Order matters — the
// FIRST match wins, so put more specific categories first.
//
// The renderer reads the same defs via a shared helper in app.js
// (loadSkillDefs). Keep these in sync if you change them here.
const SKILL_DEFS = [
  { name: 'Building',     icon: '🔧', keywords: /\b(code|bug|fix|function|class|api|build|compile|deploy|git|commit|push|pull|merge|rebase|branch|test|refactor|debug|install|run|start|stop|restart|exec|shell|bash|terminal|cmd|command|npm|pnpm|yarn|pip|apt|brew|ssh|scp|rsync|server|host|port|docker|kube|cron|service|process|script|bin|lib|package|module|import|export|require|include|config|env|var|path|app|launch|rebuild|update|upgrade|setup|provision|configure|provision|init|initialize)\b/i },
  { name: 'Writing',      icon: '✍️',  keywords: /\b(write|draft|essay|article|blog|post|story|copy|summarize|rewrite|document|readme|changelog|notes|message|email|letter|caption|headline|title|subject|paragraph|chapter|markdown|md|txt|text|script|dialogue|narration)\b/i },
  { name: 'Design',       icon: '🎨', keywords: /\b(design|css|layout|ui|ux|style|color|colour|font|image|icon|logo|theme|skin|palette|pixel|sprite|art|draw|paint|render|visual|graphic|animation|gif|emoji|avatar|redesign|stylesheet)\b/i },
  { name: 'Analysis',     icon: '📊', keywords: /\b(analy[sz]e|data|chart|graph|number|stat|metric|count|measure|calculat|math|equation|formula|log|trace|debug|dump|inspect|profile)\b/i },
  { name: 'Strategy',     icon: '🗺️',  keywords: /\b(plan|strategy|project|manage|organi[sz]e|schedule|prioriti[sz]e|prioriti[sz]ed|roadmap|goal|milestone|setup|workflow|pipeline|process|backlog|sprint|todo|task)\b/i },
  { name: 'Research',     icon: '🔍', keywords: /\b(search|find|research|look up|lookup|what is|what are|how to|how do|how does|why|when|where|who|which|explain|learn|read|check|fetch|lookup|discover|explore|browse|scan|review|version|latest|size|temperature|weather|forecast|price|stock|crypto|btc|eth)\b/i },
  { name: 'Communication', icon: '💬', keywords: /\b(chat|talk|tell me|say|speak|hello|hey|hi|thanks|thank|please|sorry|help|advice|suggest|recommend|ask|ping|status|update|notify|alert|remind)\b/i },
  { name: 'Game',         icon: '🎮', keywords: /\b(game|pixel|arena|sprite|quest|level|stats|skill|hp|mp|xp|treat|feed|play|move|attack|defend|spawn|battle|fight|win|lose|score|reward)\b/i },
  // 'General' is the fallback, no keywords needed
];

function classifyText(text) {
  if (!text) return 'General';
  for (const def of SKILL_DEFS) {
    if (def.keywords && def.keywords.test(text)) return def.name;
  }
  return 'General';
}

// v3.2.84: dual-classify — match BOTH the user's message AND the
// assistant's reply, pick whichever match is more specific (earlier in
// SKILL_DEFS = more specific). Returns just the skill name; the XP
// amount is decided in the renderer.
function classifyTask(userMessage, assistantReply) {
  const userSkill = classifyText(userMessage);
  const replySkill = assistantReply ? classifyText(assistantReply) : 'General';
  // Same match on both sides → return it.
  if (userSkill === replySkill) return userSkill;
  // If only one side matched, that wins (the other side was 'General'
  // = no signal). This is the common case for short replies like
  // "thanks!" or "done!" where the user's message carries the skill.
  if (userSkill !== 'General' && replySkill === 'General') return userSkill;
  if (replySkill !== 'General' && userSkill === 'General') return replySkill;
  // Both sides matched something different — pick the more specific
  // (earlier in SKILL_DEFS = higher index of specificity).
  const userIdx = SKILL_DEFS.findIndex(d => d.name === userSkill);
  const replyIdx = SKILL_DEFS.findIndex(d => d.name === replySkill);
  return (userIdx <= replyIdx) ? userSkill : replySkill;
}

// ---------------------------------------------------------------------------
// v3.2.83: screenshot IPC. Lets the renderer (clawsuu, in
// response to a Tobe chat message) capture the desktop or
// a specific window and get back a file path + dataUri
// for embedding in the chat bubble.
//
// target values:
//   'cyberclaw' — mainWindow (the Electron app window
//                 itself). Uses webContents.capturePage()
//                 for a pixel-perfect render of the
//                 running app.
//   'desktop'   — full DISPLAY=:0 root. Shells out to
//                 `import` (ImageMagick) which is the
//                 reliable way to capture X11/Wayland
//                 from a Node process (capturePage only
//                 captures the Electron window).
//   'window'    — capture a specific X11 window by name.
//                 Default name is 'CyberClaw'. The render
//                 can pass `windowName` to override.
//
// Returns: { ok, filePath, dataUri, target, width, height }
//   filePath — absolute path on disk under /tmp
//   dataUri  — base64 data URI (data:image/png;base64,...)
//             so the renderer can drop it straight into
//             an <img> without a separate fetch.
// ---------------------------------------------------------------------------

ipcMain.handle('screenshot:capture', async (event, { target = 'cyberclaw', windowName } = {}) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const { execFile } = require('child_process');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = `/tmp/clawsuu-shot-${stamp}.png`;
    let width = 0, height = 0;

    let buf;
    if (target === 'cyberclaw') {
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { ok: false, error: 'mainWindow not available' };
      }
      const img = await mainWindow.webContents.capturePage();
      buf = img.toPNG();
      const size = img.getSize();
      width = size.width; height = size.height;
    } else if (target === 'desktop') {
      // Full root window capture.
      const env = { ...process.env, DISPLAY: ':0', XAUTHORITY: '/run/user/1000/gdm/Xauthority' };
      await new Promise((res, rej) => execFile('import', ['-window', 'root', outPath], { env }, (e) => e ? rej(e) : res()));
      buf = fs.readFileSync(outPath);
      width = 5680; height = 1920; // approx for the dual-monitor host; exact size comes from identify() if needed
    } else if (target === 'window') {
      // Capture a specific X11 window by name.
      const winName = windowName || 'CyberClaw';
      const env = { ...process.env, DISPLAY: ':0', XAUTHORITY: '/run/user/1000/gdm/Xauthority' };
      await new Promise((res, rej) => execFile('import', ['-window', winName, outPath], { env }, (e) => e ? rej(e) : res()));
      buf = fs.readFileSync(outPath);
      // Best-effort size from identify if available; falls through silently if not.
      try {
        const { execFileSync } = require('child_process');
        const out = execFileSync('identify', ['-format', '%w %h', outPath]).toString().trim();
        const [w, h] = out.split(/\s+/).map(Number);
        if (Number.isFinite(w) && Number.isFinite(h)) { width = w; height = h; }
      } catch { /* identify not present or failed — leave size 0 */ }
    } else {
      return { ok: false, error: `unknown target: ${target}` };
    }

    fs.writeFileSync(outPath, buf);
    const dataUri = `data:image/png;base64,${buf.toString('base64')}`;
    console.log(`[screenshot] captured target=${target} path=${outPath} bytes=${buf.length} ${width}x${height}`);
    return { ok: true, filePath: outPath, dataUri, target, width, height };
  } catch (err) {
    console.error('[screenshot] failed:', err.message);
    return { ok: false, error: err.message };
  }
});

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

// v3.2.3: renderer-ack for mobile-voice IPC. When the
// renderer's chat pipeline receives a `mobile-voice`
// IPC, it sends `mobile-voice-ack` back so we know the
// renderer's JS context is responsive. Without this,
// a hung renderer (event loop stuck, blocked promise,
// etc.) looks identical to "still processing" from
// main.js's perspective — main.js can't tell whether
// the IPC was received.
//
// Tobe's v3.10.12 report: "it failed to respond for
// some reason and again it continued the conversation
// Instead of retrying" — the desktop log showed
// `webContents.send('mobile-voice', ...)` was called
// but the renderer never logged `[mobile-voice]
// received`, indicating the IPC was sent into a hung
// JS context. With this ack, we can detect that and
// either:
//   - Log a warning so the desktop user sees something
//   - Surface an error to the mobile so the user knows
//     the desktop pipeline is stuck
//   - Eventually: auto-restart the renderer
ipcMain.on('mobile-voice-ack', (e, { ts, id }) => {
  if (!ts) return;
  const latencyMs = Date.now() - ts;
  // Log every ack at debug level so we can see them
  // when debugging hangs. In production we'd sample
  // or only log when latency is suspicious.
  if (latencyMs > 5000) {
    discordLog('⚠️', 'Slow renderer ack', `${latencyMs}ms after send`, 'warn');
    console.warn(`[Voice] Slow renderer ack: ${latencyMs}ms`);
  }
  // v3.2.6: remove the corresponding entry from the
  // pending-voice queue. The renderer's IPC handler
  // forwards `id` in the ack payload. This means: once
  // the renderer acks, the transcript is no longer
  // pending — if the renderer subsequently hangs
  // mid-LLM-call, we won't replay a transcript the
  // renderer already processed (which would lead to
  // duplicate LLM responses).
  if (id) {
    // v3.2.7: mark this voiceId as acked so the
    // ack-watcher doesn't fire spuriously. The ack
    // arrived (renderer received the IPC) but the
    // renderer may still hang on the LLM call later.
    // The pending-voice queue tracks the first-stage
    // ack; the LLM-response tracker (added in this
    // change) tracks the second-stage completion.
    ackedVoiceIds.add(id);
    const idx = pendingVoiceQueue.findIndex((e) => e.id === id);
    if (idx >= 0) {
      pendingVoiceQueue.splice(idx, 1);
      console.log(`[Voice] Ack received, removed ${id} from pending queue (remaining=${pendingVoiceQueue.length})`);
    }
  }
});

// v3.2.7: track voice prompts whose LLM response has
// completed. The renderer sends this IPC after the
// sendChatMessage promise resolves (or rejects). We
// use it to confirm the FULL voice pipeline
// (renderer IPC + LLM call + TTS synthesis +
// audio_response) ran to completion, not just the
// first-stage IPC ack. Without this, the 8s
// ack-watcher fires on a renderer that acked but
// then hung on the LLM call (Tobe's v3.10.14 hang
// case — ack came in, renderer called sendChatMessage,
// LLM provider crashed, renderer context went dead,
// desktop logs "No renderer ack" 8s later but the
// ack DID arrive. The 8s deadline should not fire
// if we got a "voice done" signal in the meantime).
//
// Cleared automatically: the entry in the map is
// removed once we observe voice-done or 60s pass
// since the original routing.
const voiceResponseTracker = new Map(); // voiceId -> { ts, voiceSendTs, ws }
ipcMain.on('voice-response-done', (e, { id }) => {
  if (!id) return;
  const entry = voiceResponseTracker.get(id);
  if (entry) {
    voiceResponseTracker.delete(id);
    console.log(`[Voice] Response done for ${id}`);
  }
});

// v3.2.7: renderer registers that it has started
// processing a voice prompt. We use this to suppress
// the 8s ack-watcher stall signal: the renderer may
// ack immediately and then hang on the LLM call,
// which is a different bug than "renderer never
// received the IPC". Without tracking, the watchdog
// fires on legitimate hangs that happen AFTER ack.
ipcMain.on('voice-response-tracking-start', (e, { id }) => {
  if (!id) return;
  voiceResponseTracker.set(id, { ts: Date.now() });
  console.log(`[Voice] Response tracking started for ${id}`);
});

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
  quest.status = quest.status || 'active';
  // v3.1.50: new quests default to inactive (user has to star
  // them to make them the working quest) and start with an empty
  // latestChanges log. `active: false` and `latestChanges: []` are
  // also enforced by loadQuests() on every read, so the field
  // defaults here are belt-and-suspenders for quests created in
  // the same process boot.
  quest.active = false;
  quest.latestChanges = [];
  // v3.2.59: same defaults for the per-quest conversation log.
  quest.conversationLog = [];
  // v3.10.156: auto-derive a directory when none was
  // supplied. Same logic as the WS path (onCreateQuest).
  // The renderer can pass `defaultQuestDir` in the quest
  // object to influence the auto-pick (it reads from
  // localStorage.cyberclaw-settings.defaultQuestDir);
  // otherwise we fall back to ~/quests/<safeName>.
  // Tobe 2026-08-11: 'i think we just need to adjust such
  // that it will be created in the defualt directory
  // with the quest name, what the user inputted as quest
  // name'.
  if (!quest.directory || !quest.directory.trim()) {
    const resolved = resolveQuestDirectory(quest.name, null, quest.defaultQuestDir);
    console.log(`[quests:create] auto-derived directory for "${quest.name}": ${resolved}`);
    quest.directory = resolved;
  }
  quests.unshift(quest);
  // v3.2.61: scaffold the quest directory if one was
  // supplied. mkdir + write INSTRUCTIONS.md + write
  // CONVERSATION.md (only if absent — never overwrites
  // user content). Tobe 2026-08-04 16:45: "when creating
  // quests it should default to that unless specified,
  // it should then create that folder, with all the
  // files that a quest needs, including conversation log,
  // quest instructions etc."
  //
  // A failed scaffold does NOT fail the create —
  // the quest still exists; only the file-co-location
  // is missing. The quest.conversationLog JSON array
  // still works as a fallback for any code that expects
  // the conversation state there.
  if (quest.directory) {
    const scaffold = scaffoldQuestDirectory(quest);
    if (!scaffold.ok) {
      console.warn(`[quests:create] scaffold failed for ${quest.id}: ${scaffold.error}`);
    } else {
      console.log(`[quests:create] scaffolded ${quest.directory} with INSTRUCTIONS.md + CONVERSATION.md`);
    }
  }
  saveQuests(quests);
  return quest;
});
ipcMain.handle('quests:update', (event, id, updates) => {
  const quests = loadQuests();
  const idx = quests.findIndex(q => q.id === id);
  if (idx < 0) return null;
  const oldQuest = quests[idx];
  // v3.2.62: detect a directory CHANGE and re-scaffold
  // the new directory. Tobe 2026-08-04 17:31: 'Tried to
  // edit a quest, its directory is not shown and should
  // be editable. Here we potentially need to move and/or
  // create new directories for the user.'
  //
  // The migration is file-system only — we do NOT copy
  // the old files into the new directory. The quest's
  // files (INSTRUCTIONS.md / CONVERSATION.md) are tied
  // to the project they describe, not the storage path;
  // moving the directory without the files is the
  // expected behaviour for "this quest is now about a
  // different folder". If the user wants to physically
  // move files too, they can do it on the desktop with a
  // regular `mv` and then re-set the directory here.
  //
  // We DO scaffold (mkdir + write placeholder files)
  // because the next chat send will need to write to
  // <quest.directory>/CONVERSATION.md and the file
  // should exist for `tail -f`-ers.
  //
  // Three cases:
  //   1. updates.directory is the SAME string as
  //      oldQuest.directory — no-op (don't re-scaffold).
  //   2. updates.directory is a NEW non-empty string —
  //      assign it and re-scaffold (mkdir + write
  //      placeholders).
  //   3. updates.directory was UNDEFINED in `updates`
  //      (key not present) — leave the old directory
  //      alone. We never blanket-clear the directory.
  //   4. updates.directory is an EMPTY string — treat as
  //      'clear directory', falls back to the v3.2.30
  //      <id>-based path on the next read. The desktop
  //      also re-scaffolds the id-based dir so the next
  //      write lands somewhere valid.
  let directoryChanged = false;
  if (Object.prototype.hasOwnProperty.call(updates, 'directory')) {
    const newDir = typeof updates.directory === 'string' ? updates.directory.trim() : '';
    const oldDir = (oldQuest.directory || '').trim();
    if (newDir !== oldDir) {
      directoryChanged = true;
      updates.directory = newDir || undefined;
    }
  }
  Object.assign(quests[idx], updates);
  saveQuests(quests);
  if (directoryChanged) {
    const scaffold = scaffoldQuestDirectory(quests[idx]);
    if (!scaffold.ok) {
      console.warn(`[quests:update] scaffold failed for ${id}: ${scaffold.error}`);
    } else {
      console.log(`[quests:update] re-scaffolded ${quests[idx].directory} with INSTRUCTIONS.md + CONVERSATION.md`);
    }
  }
  return quests[idx];
});

// v3.2.30: per-quest project instructions file. Each quest can have a
// markdown file (default: <quest.directory>/QUEST_QUEST_INSTRUCTIONS.md, or
// ~/.openclaw/cyberclaw/quests/<id>/QUEST_QUEST_INSTRUCTIONS.md if no
// directory is set) that holds project-specific behavior
// instructions for the companion. The file content is read
// by buildActiveQuestContext() on the renderer and injected
// into the chat prompt as a separate context block, so the
// LLM sees "when working on this quest, behave like this"
// before generating a reply.
//
// The renderer's Quests panel shows the file content with
// an Edit button; the mobile shows it read-only (no edit
// on mobile — the user can edit via the desktop). The
// IPCs are read-by-id (single quest) and write-by-id.
function questInstructionsFilePath(quest) {
  if (!quest) return null;
  if (quest.directory) {
    return path.join(quest.directory, 'QUEST_QUEST_INSTRUCTIONS.md');
  }
  return path.join(os.homedir(), '.openclaw', 'cyberclaw', 'quests', quest.id, 'QUEST_QUEST_INSTRUCTIONS.md');
}

// v3.2.61: per-quest directory files. Tobe's three-layer
// mental model (2026-08-04 16:45):
//   1. CYBERCLAW.md              — openclaw's standard behaviour (read by companion-prompts.js, NOT this file)
//   2. companions/<id>/soul.md  — companion character
//   3. <quest.directory>/       — task-specific behaviour + history
//        ├── INSTRUCTIONS.md    — quest-specific instructions
//        └── CONVERSATION.md    — conversation transcript (file form)
// Until this release, the conversation log lived in the
// `quest.conversationLog` JSON array inside quests.json.
// v3.2.61 promotes it to a per-quest markdown file at
// <quest.directory>/CONVERSATION.md so:
//   - the file is co-located with the project it's about
//     (Tobe's mental model: "all the files that a quest
//     needs")
//   - the user can `cat` / version-control / grep / share
//     the conversation
//   - the LLM has a clear single-source-of-truth for "what
//     we talked about on this quest"
// The JSON array stays as a fast-read mirror for the LLM
// context injector (buildActiveQuestContext) but the file
// is canonical. Both writers update both stores.
function questInstructionsFilePathV2(quest) {
  if (!quest) return null;
  if (quest.directory) {
    return path.join(quest.directory, 'INSTRUCTIONS.md');
  }
  return path.join(os.homedir(), '.openclaw', 'cyberclaw', 'quests', quest.id, 'INSTRUCTIONS.md');
}
function questConversationFilePath(quest) {
  if (!quest) return null;
  if (quest.directory) {
    return path.join(quest.directory, 'CONVERSATION.md');
  }
  return path.join(os.homedir(), '.openclaw', 'cyberclaw', 'quests', quest.id, 'CONVERSATION.md');
}

// Prefer the new filename; fall back to the v3.2.30-era
// `QUEST_QUEST_INSTRUCTIONS.md` so users on the old name
// don't see their work vanish. Returns the path that
// exists, or null if neither does.
function resolveExistingInstructionsPath(quest) {
  const v2 = questInstructionsFilePathV2(quest);
  const v1 = questInstructionsFilePath(quest);
  try { if (v2 && fs.existsSync(v2)) return v2; } catch {}
  try { if (v1 && fs.existsSync(v1)) return v1; } catch {}
  return null;
}
// v3.2.61: scaffold a newly-created quest's directory with
// the markdown files that future turns will write to. Idempotent:
// running on an already-scaffolded dir is a no-op (writeFileSync
// of the same content to the same path leaves the file
// unchanged). Writes:
//   - INSTRUCTIONS.md (with `# Project instructions` heading)
//   - CONVERSATION.md (empty, with a comment header)
//
// Returns { ok, instructionsPath, conversationPath, mkdirOk }
// on success, or { ok: false, error } if the directory could
// not be created (e.g. invalid path / no write permission).
// The desktop's quest-create flow continues regardless of
// the scaffold failing — a quest without scaffolded files
// is still a valid quest, the writes just bounce through
// the JSON-array fallback instead.
// v3.10.156: auto-derive a directory for a new quest
// when the caller didn't supply one. Returns a
// filesystem-safe absolute path under either the caller's
// default dir or ~/quests. Always returns a path so the
// downstream scaffold never has to handle "no directory"
// as a special case.
function resolveQuestDirectory(name, explicitDir, callerDefaultDir) {
  if (explicitDir && typeof explicitDir === 'string' && explicitDir.trim()) {
    return explicitDir.trim();
  }
  const safeName = (name || 'unnamed-quest')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (callerDefaultDir && typeof callerDefaultDir === 'string' && callerDefaultDir.trim()) {
    return path.join(callerDefaultDir.trim().replace(/\/+$/, ''), safeName);
  }
  return path.join(os.homedir(), 'quests', safeName);
}

function scaffoldQuestDirectory(quest) {
  if (!quest || !quest.directory) return { ok: false, error: 'no directory' };
  try {
    fs.mkdirSync(quest.directory, { recursive: true });
    const instructions = questInstructionsFilePathV2(quest);
    const conversation = questConversationFilePath(quest);
    // Don't overwrite the user's existing INSTRUCTIONS.md
    // content — only write the placeholder if the file is
    // absent. Same for CONVERSATION.md.
    if (!fs.existsSync(instructions)) {
      fs.writeFileSync(
        instructions,
        [
          `# Project instructions — ${quest.name || 'Untitled'}`,
          ``,
          `Task-specific behaviour rules for the companion on this quest.`,
          `The companion reads this file on every chat send and treats it as`,
          `authoritative for project context (paths, deploy commands, things`,
          `NOT to touch, language preferences, etc.). Edit freely — there's no`,
          `auto-write from the companion here. (For companion-authored notes,`,
          `see CONVERSATION.md and use the [QUEST_NOTE] tag in your reply.)`,
          ``,
        ].join('\n'),
        'utf-8',
      );
    }
    if (!fs.existsSync(conversation)) {
      fs.writeFileSync(
        conversation,
        [
          `# Conversation log — ${quest.name || 'Untitled'}`,
          ``,
          `Auto-written by CyberClaw on every chat exchange while this quest`,
          `is active. Each entry is appended below this header.`,
          ``,
        ].join('\n'),
        'utf-8',
      );
    }
    return { ok: true, instructionsPath: instructions, conversationPath: conversation, mkdirOk: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

ipcMain.handle('quests:read-quest-instructions', (event, questId) => {
  const quests = loadQuests();
  const quest = quests.find(q => q.id === questId);
  if (!quest) return { ok: false, error: 'quest not found' };
  // v3.2.61: prefer the new INSTRUCTIONS.md; fall back to
  // the v3.2.30-era QUEST_QUEST_INSTRUCTIONS.md for users
  // on the old name. If neither exists yet, return the
  // v2 path so the renderer's "create on first save"
  // writes land in the right place.
  const existing = resolveExistingInstructionsPath(quest);
  const file = existing || questInstructionsFilePathV2(quest);
  try {
    if (!fs.existsSync(file)) return { ok: true, content: '', path: file };
    const content = fs.readFileSync(file, 'utf-8');
    return { ok: true, content, path: file };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('quests:save-quest-instructions', (event, questId, content) => {
  const quests = loadQuests();
  const quest = quests.find(q => q.id === questId);
  if (!quest) return { ok: false, error: 'quest not found' };
  // v3.2.61: write to the v2 path (INSTRUCTIONS.md). If
  // the user is still on the v3.2.30 name, also keep it
  // happy by writing both files — but only the first time
  // we migrate, and only if the legacy file already has
  // content we don't want to lose.
  const newFile = questInstructionsFilePathV2(quest);
  const legacyFile = questInstructionsFilePath(quest);
  try {
    const parent = path.dirname(newFile);
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(newFile, content || '', 'utf-8');
    // v3.2.61 legacy migration: if the legacy file
    // exists AND has different content, copy its content
    // into the new file ONCE (preserves any user edits
    // that landed in the old filename before they noticed
    // the rename). After this pass, new edits land in
    // INSTRUCTIONS.md and the legacy file is left in
    // place until manually deleted (so a user who reverts
    // to the old flow can find their old content).
    try {
      if (fs.existsSync(legacyFile) && !fs.existsSync(newFile)) {
        // newFile was JUST created by writeFileSync above
        // — this branch is unreachable in practice. Kept
        // as belt-and-braces for race conditions where a
        // concurrent read sees the new file as missing.
        fs.writeFileSync(newFile, fs.readFileSync(legacyFile, 'utf-8'));
      } else if (fs.existsSync(legacyFile) && fs.existsSync(newFile)) {
        // Both files exist. If they have the same content
        // (no edits since the migration), silently delete
        // the legacy file to converge on the new name.
        // If they differ, leave both in place — the user
        // can manually reconcile.
        const legacyContent = fs.readFileSync(legacyFile, 'utf-8');
        const newContent = fs.readFileSync(newFile, 'utf-8');
        if (legacyContent === newContent) {
          try { fs.unlinkSync(legacyFile); } catch (_) {}
        }
      }
    } catch (_) { /* migration is best-effort */ }
    return { ok: true, path: newFile, bytes: Buffer.byteLength(content || '', 'utf-8') };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

// v3.2.41: per-quest instructions-file append. The companion
// can write its own notes to the active quest's
// QUEST_QUEST_INSTRUCTIONS.md so future turns (and future
// sessions) have a memory of what it learned about the
// project: SSH paths, deploy commands, "don't touch this
// file", "use British English", etc. Tobe's 2026-08-02
// 15:45 ask: "as it works within the quests it should
// leave notes for itself, and update key info in the
// quest instructions for itself, how to do things etc."
//
// The append is timestamped + grouped under a
// "## Companion notes" section so the user-written
// instructions stay untouched at the top and the agent's
// running notes accumulate at the bottom. If the section
// doesn't exist yet, it's created. If the file doesn't
// exist, it's created with just the notes section.
//
// The renderer is responsible for invalidating its
// in-memory cache so the next chat send sees the new note.
ipcMain.handle('quests:append-quest-instructions', (event, questId, text) => {
  const quests = loadQuests();
  const quest = quests.find(q => q.id === questId);
  if (!quest) return { ok: false, error: 'quest not found' };
  if (!text || typeof text !== 'string' || !text.trim()) return { ok: false, error: 'text is empty' };
  // v3.2.61: write notes to the v2 filename (INSTRUCTIONS.md).
  // If the legacy file exists AND the v2 doesn't yet, port
  // the legacy content into the v2 file first so the new
  // notes land alongside the user's existing notes (instead
  // of leaving them stranded in the old filename).
  const v2File = questInstructionsFilePathV2(quest);
  const legacyFile = questInstructionsFilePath(quest);
  // Legacy port: best-effort, must happen BEFORE the main
  // try so the read of `file` sees the ported content if
  // needed.
  try {
    if (fs.existsSync(legacyFile) && !fs.existsSync(v2File)) {
      const legacyContent = fs.readFileSync(legacyFile, 'utf-8');
      fs.writeFileSync(v2File, legacyContent);
    }
  } catch (_) { /* legacy port is best-effort */ }
  const file = v2File;
  try {
    const parent = path.dirname(file);
    fs.mkdirSync(parent, { recursive: true });
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    const now = new Date();
    const ts = now.toISOString();
    // The note line. "+ a leading blank line" so the
    // append doesn't run into the previous note.
    const noteBlock = `\n\n## Companion note (${ts})\n\n${text.trim()}\n`;
    // If the file already has a "## Companion notes"
    // section, append at its end. Otherwise create the
    // section. We use the FIRST "## Companion note" /
    // "## Companion notes" heading as the anchor so
    // multiple notes accumulate under one section.
    const sectionHeader = '## Companion notes';
    const sectionRe = /^## Companion notes\s*$/m;
    let next;
    if (sectionRe.test(existing)) {
      // Append after the section header (and any
      // existing note blocks). The simplest safe
      // choice is to append at the end of the file —
      // earlier notes never get touched, the new note
      // lands at the bottom, and the user just sees
      // a timeline.
      next = existing.replace(/\s*$/, '') + noteBlock;
    } else {
      // No section yet. Create one at the bottom of
      // the file. Keep user-written content above
      // untouched.
      next = (existing.replace(/\s*$/, '') + '\n\n' + sectionHeader + noteBlock);
    }
    fs.writeFileSync(file, next, 'utf-8');
    return { ok: true, path: file, bytes: Buffer.byteLength(next, 'utf-8') };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
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
  try {
    const configs = JSON.parse(fs.readFileSync(spriteConfigPath, 'utf8'));
    // v3.2.32: migrate any companion with traits but no soul.md yet.
    try { companionPrompts.migrateAllSouls(configs); } catch (e) { console.error('[companion-prompts] migration error:', e.message); }
    return configs;
  } catch { return {}; }
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

// v3.2.32: companion soul + memory IPC. The renderer (and
// mobile via sync) reads/writes soul.md + memory.md through
// these. write-soul and remember-memory go through
// `cyberclaw.companions.*` from preload.js.
ipcMain.handle('companion:get-soul', (event, agentId) => {
  return { ok: true, content: companionPrompts.readSoul(agentId), presets: companionPrompts.SOUL_PRESETS };
});
ipcMain.handle('companion:save-soul', (event, agentId, content) => {
  try { return { ok: true, ...companionPrompts.writeSoul(agentId, content) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('companion:apply-soul-preset', (event, agentId, presetKey) => {
  const preset = companionPrompts.SOUL_PRESETS[presetKey];
  if (preset === undefined) return { ok: false, error: 'unknown preset: ' + presetKey };
  // For 'custom' preset, leave the soul as-is. Otherwise replace.
  if (presetKey === 'custom') return { ok: true, content: companionPrompts.readSoul(agentId) };
  try { return { ok: true, content: preset, ...companionPrompts.writeSoul(agentId, preset) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('companion:get-memory', (event, agentId) => {
  return { ok: true, content: companionPrompts.readMemory(agentId) };
});
ipcMain.handle('companion:remember-memory', (event, agentId, line) => {
  try { return companionPrompts.appendMemory(agentId, line); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('companion:clear-memory', (event, agentId) => {
  return companionPrompts.clearMemory(agentId);
});

// v3.2.32: overarching system prompt IPC.
ipcMain.handle('system:get-cyberclaw', () => {
  return {
    ok: true,
    content: companionPrompts.readSystemPrompt(),
    defaultContent: companionPrompts.DEFAULT_SYSTEM_PROMPT,
    path: companionPrompts.SYSTEM_PROMPT_FILE,
  };
});
ipcMain.handle('system:save-cyberclaw', (event, content) => {
  try { return { ok: true, ...companionPrompts.writeSystemPrompt(content) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('system:reset-cyberclaw', () => {
  return companionPrompts.resetSystemPrompt();
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

// ─── LLM Endpoints (user-managed local model servers) ──────────
// v3.1.33: a lightweight registry of OpenAI-compatible HTTP
// endpoints the user has set up locally (Ollama, LM Studio,
// llama.cpp server, Jan.ai, vLLM, etc.). Each endpoint serves
// one or more models the user has downloaded. CyberClaw
// doesn't manage the model downloads themselves — the user
// brings their own model, we just point at the endpoint.
//
// Storage: ~/.openclaw/cyberclaw/llm-endpoints.json
// Schema: { id, name, baseUrl, apiKey?, type, models[]?,
//            lastProbedAt?, lastError? }
//
// At app startup we auto-probe localhost:11434 (the default
// Ollama port) and add it as "Local Ollama" if it's reachable
// and not already configured. Other endpoints are added
// manually via Settings → LLM Endpoints.
function loadLlmEndpoints() {
  try { return JSON.parse(fs.readFileSync(LLM_ENDPOINTS_FILE, 'utf8')); }
  catch { return []; }
}
function saveLlmEndpoints(list) {
  if (!fs.existsSync(CYBERCLAW_DIR)) fs.mkdirSync(CYBERCLAW_DIR, { recursive: true });
  fs.writeFileSync(LLM_ENDPOINTS_FILE, JSON.stringify(list, null, 2));
}

// Probe an OpenAI-compatible endpoint for its available
// models. Returns { ok, models: [{id}], error? }. Handles
// Ollama's /api/tags endpoint specially (returns different
// shape) by detecting the response format.
async function probeLlmEndpoint(baseUrl, apiKey) {
  const cleanBase = String(baseUrl || '').replace(/\/+$/, '');
  if (!cleanBase) return { ok: false, error: 'baseUrl required' };
  const headers = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  // Try OpenAI-compatible /v1/models first
  try {
    const r = await fetchWithAbort(`${cleanBase}/v1/models`, { headers }, 4000);
    if (r.ok) {
      const data = await r.json();
      const models = Array.isArray(data?.data)
        ? data.data.map(m => ({ id: m.id, owned_by: m.owned_by }))
        : [];
      return { ok: true, models, kind: 'openai' };
    }
  } catch (_) {}
  // Fall back to Ollama's /api/tags
  try {
    const r = await fetchWithAbort(`${cleanBase}/api/tags`, { headers }, 4000);
    if (r.ok) {
      const data = await r.json();
      const models = Array.isArray(data?.models)
        ? data.models.map(m => ({ id: m.name, size: m.size }))
        : [];
      return { ok: true, models, kind: 'ollama' };
    }
  } catch (_) {}
  return { ok: false, error: 'Endpoint not reachable on /v1/models or /api/tags' };
}

// Fetch with timeout via AbortController. Node 22's
// built-in fetch supports { signal } for cancellation.
async function fetchWithAbort(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

ipcMain.handle('llm:endpoints:list', () => loadLlmEndpoints());

ipcMain.handle('llm:endpoints:add', async (event, ep) => {
  if (!ep || !ep.name || !ep.baseUrl) {
    return { ok: false, error: 'name and baseUrl are required' };
  }
  const list = loadLlmEndpoints();
  // Idempotent on baseUrl: if an endpoint with the same URL
  // already exists, update it instead of duplicating.
  const existingIdx = list.findIndex(e =>
    e.baseUrl.replace(/\/+$/, '') === String(ep.baseUrl).replace(/\/+$/, '')
  );
  const id = (existingIdx >= 0 ? list[existingIdx].id : (ep.id ||
    String(ep.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') ||
    `endpoint-${Date.now()}`
  ));
  const probeResult = await probeLlmEndpoint(ep.baseUrl, ep.apiKey).catch(() => ({ ok: false, error: 'probe failed' }));
  const clean = {
    id,
    name: String(ep.name).trim(),
    baseUrl: String(ep.baseUrl).trim().replace(/\/+$/, ''),
    apiKey: ep.apiKey ? String(ep.apiKey) : '',
    type: probeResult.kind || ep.type || 'openai',
    models: probeResult.ok ? probeResult.models : [],
    lastProbedAt: probeResult.ok ? Date.now() : null,
    lastError: probeResult.ok ? null : probeResult.error,
    autoDetected: !!ep.autoDetected,
  };
  if (existingIdx >= 0) list[existingIdx] = clean;
  else list.push(clean);
  saveLlmEndpoints(list);
  return { ok: true, endpoint: clean, probe: probeResult };
});

ipcMain.handle('llm:endpoints:delete', (event, id) => {
  const list = loadLlmEndpoints().filter(e => e.id !== id);
  saveLlmEndpoints(list);
  return { ok: true };
});

ipcMain.handle('llm:endpoints:probe', async (event, id) => {
  const list = loadLlmEndpoints();
  const idx = list.findIndex(e => e.id === id);
  if (idx < 0) return { ok: false, error: 'endpoint not found' };
  const probe = await probeLlmEndpoint(list[idx].baseUrl, list[idx].apiKey);
  list[idx].models = probe.ok ? probe.models : [];
  list[idx].lastProbedAt = probe.ok ? Date.now() : null;
  list[idx].lastError = probe.ok ? null : probe.error;
  saveLlmEndpoints(list);
  return { ok: true, endpoint: list[idx], probe };
});

// Auto-detect Ollama at the default port. Called from
// Settings → "Detect Ollama" button and at app startup.
ipcMain.handle('llm:endpoints:detect-ollama', async () => {
  const probe = await probeLlmEndpoint('http://localhost:11434');
  if (!probe.ok) return { ok: false, error: 'Ollama not reachable at localhost:11434' };
  const list = loadLlmEndpoints();
  const existing = list.find(e =>
    e.baseUrl.replace(/\/+$/, '') === 'http://localhost:11434'
  );
  if (existing) {
    existing.models = probe.models;
    existing.lastProbedAt = Date.now();
    existing.lastError = null;
    saveLlmEndpoints(list);
    return { ok: true, endpoint: existing, alreadyConfigured: true };
  }
  const ep = {
    id: 'ollama-local',
    name: 'Local Ollama',
    baseUrl: 'http://localhost:11434',
    apiKey: '',
    type: 'ollama',
    models: probe.models,
    lastProbedAt: Date.now(),
    autoDetected: true,
  };
  list.push(ep);
  saveLlmEndpoints(list);
  return { ok: true, endpoint: ep, alreadyConfigured: false };
});

// v3.1.33: change a companion's primary model. Edits
// openclaw.json directly (openclaw doesn't expose an
// `agents edit --model` subcommand, so we patch the
// config and let the gateway pick it up on next session).
ipcMain.handle('agent:set-model', (event, { agentId, model, fallbacks }) => {
  const cfg = readOpenClawConfig();
  if (!cfg) return { ok: false, error: 'openclaw.json not readable' };
  if (!cfg.agents) cfg.agents = {};
  if (!cfg.agents.list) cfg.agents.list = [];
  const idx = cfg.agents.list.findIndex(a => a.id === agentId);
  if (idx < 0) return { ok: false, error: `agent '${agentId}' not found` };
  cfg.agents.list[idx].model = cfg.agents.list[idx].model || {};
  if (model) cfg.agents.list[idx].model.primary = model;
  if (Array.isArray(fallbacks)) cfg.agents.list[idx].model.fallbacks = fallbacks;
  try {
    writeOpenClawConfig(cfg);
    return { ok: true, agent: cfg.agents.list[idx] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// v3.1.36: Train a custom openWakeWord model for a companion.
// Receives audio sample paths from the phone, runs the
// training script, streams progress events back, and
// returns the trained .tflite path.
ipcMain.handle('agent:train-wake-phrase', async (event, { agentId, phrase, samples }) => {
  if (!agentId || !phrase || !Array.isArray(samples) || !samples.length) {
    return { ok: false, error: 'agentId, phrase, samples required' };
  }
  // v3.1.37: `samples` is an array of {name, data} where data is
  // base64-encoded audio. We decode + write into the work dir.
  // (Previously took `samplePaths` to local files; the renderer
  // and the phone are now expected to ship bytes.)
  for (const s of samples) {
    if (!s || !s.name || !s.data) {
      return { ok: false, error: 'each sample needs {name, data}' };
    }
  }
  // Prepare working dirs
  const workDir = path.join(os.homedir(), '.openclaw', 'cyberclaw', 'wake-training', agentId);
  fs.mkdirSync(workDir, { recursive: true });
  const samplesDir = path.join(workDir, 'user_samples');
  fs.mkdirSync(samplesDir, { recursive: true });
  // Decode + write each sample into the samples dir (with friendly names)
  const localPaths = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const ext = path.extname(s.name) || '.m4a';
    const dst = path.join(samplesDir, `sample_${i.toString().padStart(3, '0')}${ext}`);
    fs.writeFileSync(dst, Buffer.from(s.data, 'base64'));
    localPaths.push(dst);
  }
  // Find the python interpreter and the training script
  const scriptPath = path.join(__dirname, '..', 'scripts', 'train_wake_phrase.py');
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, error: `training script not found: ${scriptPath}` };
  }
  // Run training as a child process, stream progress
  return new Promise((resolve) => {
    const modelName = phrase.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const outputDir = path.join(workDir, 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    const proc = spawn('python3', [
      scriptPath,
      '--name', modelName,
      '--samples-dir', samplesDir,
      '--output-dir', outputDir,
      '--n-samples', '10000',
      '--n-samples-val', '2000',
      '--epochs', '20',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdoutBuf = '';
    let stderrBuf = '';
    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdoutBuf += text;
      // Forward progress events to all renderer windows
      for (const line of text.split('\n')) {
        if (line.startsWith('PROGRESS::')) {
          try {
            const payload = JSON.parse(line.slice('PROGRESS::'.length));
            // Send to the Electron renderer (so the desktop
            // forge UI can show progress, if it wants to)
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('wake-training-progress', { agentId, ...payload });
            }
            // Send to the mobile app over the sync-server WS
            if (syncServer) {
              syncServer.sendToMobile({
                type: 'wake_training_progress',
                agentId,
                ...payload,
              });
            }
          } catch (_) {}
        } else if (line.startsWith('OUTPUT_TFLITE::')) {
          const tflitePath = line.slice('OUTPUT_TFLITE::'.length).trim();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('wake-training-done', { agentId, tflitePath });
          }
          if (syncServer) {
            syncServer.sendToMobile({
              type: 'wake_training_done',
              agentId,
              tflitePath,
            });
          }
        } else if (line.trim()) {
          // Surface all other stdout to the main console
          console.log(`[train:${agentId}] ${line.trim()}`);
        }
      }
    });
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      for (const line of text.split('\n')) {
        if (line.trim()) console.error(`[train:${agentId}] ${line.trim()}`);
      }
    });
    proc.on('error', (err) => {
      console.error(`[train:${agentId}] spawn error: ${err.message}`);
      resolve({ ok: false, error: err.message });
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`[train:${agentId}] exited with code ${code}`);
        resolve({ ok: false, error: `training process exited ${code}`, stderr: stderrBuf.slice(-1000) });
      } else {
        // Find the output .tflite (we emitted OUTPUT_TFLITE::)
        const modelDir = path.join(outputDir, 'model');
        let tflitePath = null;
        if (fs.existsSync(modelDir)) {
          for (const f of fs.readdirSync(modelDir)) {
            if (f.endsWith('.tflite')) {
              tflitePath = path.join(modelDir, f);
              break;
            }
          }
        }
        if (tflitePath) {
          resolve({ ok: true, tflitePath, agentId });
        } else {
          resolve({ ok: false, error: 'no .tflite output found', stdout: stdoutBuf.slice(-1000) });
        }
      }
    });
  });
});

// v3.1.36: Read a trained wake model as base64 so the phone can
// download it. Used by the mobile training UI to grab the
// freshly-trained .tflite file.
ipcMain.handle('agent:read-wake-model', (event, { tflitePath }) => {
  if (!tflitePath || !fs.existsSync(tflitePath)) {
    return { ok: false, error: 'file not found' };
  }
  try {
    const buf = fs.readFileSync(tflitePath);
    return { ok: true, base64: buf.toString('base64'), size: buf.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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
// v3.1.50: set a quest as the active (working) one. Exactly one
// quest can be active at a time; setting one clears the others.
// Pass null/undefined to clear all (no active quest).
//
// We update the array in-place then saveQuests, which broadcasts
// the new list to all connected mobiles. The mobile's
// QuestsScreen reads the `active` flag from each quest in the
// broadcast and shows an ACTIVE badge on the matching card.
ipcMain.handle('quests:set-active', (event, id) => {
  const quests = loadQuests();
  let changed = false;
  for (const q of quests) {
    const shouldBeActive = q.id === id && !!id;
    if (q.active !== shouldBeActive) {
      q.active = shouldBeActive;
      changed = true;
    }
  }
  if (changed) saveQuests(quests);
  return quests.find(q => q.active) || null;
});
// v3.1.50: append a change to the quest's `latestChanges` log.
// Called by the agent (via the renderer's structured-output
// parser) when it does something worth logging on the active
// quest. Newest entry is at the end; the log is unbounded but
// trimmed to the last 100 entries to keep the JSON file small.
//
// Returns the new entry so the caller can echo it back in chat
// ("logged: <text>") if desired.
ipcMain.handle('quests:append-change', (event, id, text) => {
  if (!id || !text || typeof text !== 'string' || !text.trim()) return null;
  const quests = loadQuests();
  const q = quests.find(x => x.id === id);
  if (!q) return null;
  if (!Array.isArray(q.latestChanges)) q.latestChanges = [];
  const entry = { timestamp: new Date().toISOString(), text: text.trim() };
  q.latestChanges.push(entry);
  // Trim to last 100 entries — old changes can be archived
  // separately if needed but the working log stays small.
  if (q.latestChanges.length > 100) {
    q.latestChanges = q.latestChanges.slice(-100);
  }
  saveQuests(quests);
  return entry;
});
// v3.2.59: per-quest conversation log IPCs. Every chat
// exchange (user + agent) when there's an active quest gets
// stamped with the quest id and appended to that quest's
// `conversationLog`. The companion reads the most-recent N
// entries on every reply via buildActiveQuestContext so
// project context carries across sessions / restarts / LLM
// restarts.
//
// Field shape:
//   { ts: ISO timestamp, role: 'user'|'agent'|'system',
//     text: string (capped at 1000 chars),
//     agentId: agent id of the speaker (or null for user),
//     agentName: display name of the speaker (or null) }
//
// Storage:
//   - Up to 200 entries per quest, FIFO-trimmed.
//   - Each text capped at 1000 chars (long agent replies
//     get the first 1000 chars + '…' to keep the JSON
//     small; the full text is still in the desktop's
//     chatHistoryByAgent for the UI).
//   - Persisted to the same quests.json via saveQuests().
//
// Read IPC: quests:get-conversation-log (returns the array)
// Clear IPC: quests:clear-conversation-log (resets the array)
const CONVERSATION_LOG_MAX_ENTRIES = 200;
const CONVERSATION_LOG_MAX_TEXT_CHARS = 1000;
function appendConversationLog(q, role, text, agentId, agentName) {
  if (!q) return null;
  if (!Array.isArray(q.conversationLog)) q.conversationLog = [];
  const trimmedText = typeof text === 'string'
    ? (text.length > CONVERSATION_LOG_MAX_TEXT_CHARS
        ? text.slice(0, CONVERSATION_LOG_MAX_TEXT_CHARS - 1) + '…'
        : text)
    : '';
  const entry = {
    ts: new Date().toISOString(),
    role: role === 'user' ? 'user' : (role === 'agent' ? 'agent' : 'system'),
    text: trimmedText,
    agentId: agentId || null,
    agentName: agentName || null,
  };
  q.conversationLog.push(entry);
  if (q.conversationLog.length > CONVERSATION_LOG_MAX_ENTRIES) {
    q.conversationLog = q.conversationLog.slice(-CONVERSATION_LOG_MAX_ENTRIES);
  }
  // v3.2.61: also persist to the per-quest markdown file
  // (<quest.directory>/CONVERSATION.md). The file is the
  // canonical long-term store per Tobe's mental model
  // ("all the files that a quest needs, including
  // conversation log, quest instructions etc."). The
  // JSON array stays as the fast-read mirror for
  // buildActiveQuestContext's LLM-context injection.
  //
  // File format: one entry per line, prefixed with
  // `[ts] role:`. Reads back via the existing
  // buildActiveQuestContext path (which still reads the
  // JSON array as the primary source — the file is
  // advisory; we don't re-parse it for LLM context. That
  // would double-write and double-parse.) The file IS
  // what the user sees / cats / version-controls; the
  // JSON is what the LLM sees.
  try {
    const convFile = questConversationFilePath(q);
    if (convFile) {
      const parentDir = path.dirname(convFile);
      fs.mkdirSync(parentDir, { recursive: true });
      // If the file doesn't exist (e.g. the quest was
      // created before v3.2.61's scaffold, or the
      // scaffold failed for some reason), create a
      // minimal header so the next reader knows what
      // they're looking at.
      if (!fs.existsSync(convFile)) {
        fs.writeFileSync(
          convFile,
          [
            `# Conversation log — ${q.name || 'Untitled'}`,
            ``,
            `Auto-written by CyberClaw on every chat exchange while this quest`,
            `is active. Each entry below has the format:`,
            ``,
            `    [ISO timestamp] role(agentId|agentName): message`,
            ``,
            ``,
          ].join('\n'),
          'utf-8',
        );
      }
      const line = `[${entry.ts}] ${entry.role}${entry.agentName ? `(${entry.agentName})` : entry.agentId ? `(${entry.agentId})` : ''}: ${entry.text}\n`;
      // We open with 'a' flag so the file is appended in
      // place — keep the OS-level guarantee that the file
      // is always consistent at rest for readers that
      // tail -f. (Using writeFileSync over the whole
      // file would atomically replace it every chat turn,
      // which is wasted IO for a transcript that's only
      // ever appended.)
      fs.appendFileSync(convFile, line, 'utf-8');
    }
  } catch (e) {
    // Best-effort. A failed append to the file doesn't
    // fail the JSON-array append (which is the load-
    // bearing store for context injection).
    console.warn(`[ConversationLog] file append failed for quest ${q.id}: ${e?.message}`);
  }
  return entry;
}

ipcMain.handle('quests:append-conversation-log', (event, questId, role, text, agentId, agentName) => {
  if (!questId) return { ok: false, error: 'no questId' };
  const quests = loadQuests();
  const q = quests.find(x => x.id === questId);
  if (!q) return { ok: false, error: 'quest not found' };
  const entry = appendConversationLog(q, role, text, agentId, agentName);
  if (!entry) return { ok: false, error: 'append failed' };
  saveQuests(quests);
  return { ok: true, entry };
});

ipcMain.handle('quests:get-conversation-log', (event, questId) => {
  if (!questId) return { ok: false, error: 'no questId' };
  const quests = loadQuests();
  const q = quests.find(x => x.id === questId);
  if (!q) return { ok: false, error: 'quest not found' };
  // v3.2.61: also return the file path so the caller
  // (e.g. mobile UI) can navigate to the canonical
  // long-term store. The JSON `log` is still what
  // buildActiveQuestContext injects into the LLM
  // context, but the file is what the user can
  // version-control.
  return {
    ok: true,
    log: Array.isArray(q.conversationLog) ? q.conversationLog : [],
    questName: q.name || '',
    filePath: questConversationFilePath(q),
  };
});

ipcMain.handle('quests:clear-conversation-log', (event, questId) => {
  if (!questId) return { ok: false, error: 'no questId' };
  const quests = loadQuests();
  const q = quests.find(x => x.id === questId);
  if (!q) return { ok: false, error: 'quest not found' };
  q.conversationLog = [];
  saveQuests(quests);
  // v3.2.61: clear the markdown file too. Best-effort;
  // a missing file (or read failure) is silently ignored.
  try {
    const f = questConversationFilePath(q);
    if (f && fs.existsSync(f)) fs.unlinkSync(f);
  } catch (_) {}
  return { ok: true };
});

// v3.2.61: read the raw per-quest conversation file.
// Returns the file content as a string, plus the path
// so the caller can show "edit in your editor" or use
// a future "open in file viewer" UI on the mobile.
// If the file doesn't exist yet (brand new quest), returns
// { ok: true, content: '', path } so the caller can
// render an empty editor or show "(no messages yet)".
ipcMain.handle('quests:get-conversation-file', (event, questId) => {
  if (!questId) return { ok: false, error: 'no questId' };
  const quests = loadQuests();
  const q = quests.find(x => x.id === questId);
  if (!q) return { ok: false, error: 'quest not found' };
  const f = questConversationFilePath(q);
  if (!f) return { ok: false, error: 'no file path for this quest' };
  try {
    if (!fs.existsSync(f)) return { ok: true, content: '', path: f };
    return { ok: true, content: fs.readFileSync(f, 'utf-8'), path: f };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});
// v3.1.50: toggle a goal's completed flag by index. The agent
// uses this when it finishes a step on the active quest. Returns
// the updated quest, or null if id/index is invalid.
ipcMain.handle('quests:mark-goal-done', (event, id, goalIndex, completed) => {
  const quests = loadQuests();
  const q = quests.find(x => x.id === id);
  if (!q) return null;
  const goals = Array.isArray(q.goals) ? q.goals : [];
  const idx = parseInt(goalIndex, 10);
  if (isNaN(idx) || idx < 0 || idx >= goals.length) return null;
  // Goals may be plain strings (legacy) or {text, completed}.
  // Normalize to the object form before flipping.
  if (typeof goals[idx] === 'string') {
    goals[idx] = { text: goals[idx], completed: !!completed };
  } else {
    goals[idx] = { ...goals[idx], completed: !!completed };
  }
  q.goals = goals;
  saveQuests(quests);
  return q;
});
// v3.1.50: convenience getter for the currently active quest,
// or null if none is selected. Used by the renderer's chat
// context builder to avoid the round-trip of
// `list().find(q => q.active)`.
ipcMain.handle('quests:get-active', () => {
  const quests = loadQuests();
  return quests.find(q => q.active) || null;
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

  const name = (opts?.name || '').toString().trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  if (!name) throw new Error('name required');
  const model = (opts?.model || '').toString().trim();
  const workspace = (opts?.workspace || path.join(os.homedir(), 'workspace', name)).toString();

  // v3.1.33: actually pass --workspace and --model to
  // `agents add` so the new agent is registered with the
  // user's chosen LLM. Pre-v3.1.33 the wizard ran the
  // command without these flags, so every new companion
  // silently inherited the global default model.
  const args = [`"${bin}"`, 'agents', 'add', '--non-interactive', '--workspace', `"${workspace}"`];
  if (model) args.push('--model', `"${model}"`);
  try {
    const result = execSync(args.join(' ') + ' 2>&1', { encoding: 'utf8' });
    return { ok: true, output: result };
  } catch {
    // Agent might already exist; fall through to set-model
    // so the user's chosen model is applied even on retry.
    try {
      const cfg = readOpenClawConfig();
      if (cfg?.agents?.list && model) {
        const idx = cfg.agents.list.findIndex(a => a.id === name);
        if (idx >= 0) {
          cfg.agents.list[idx].model = cfg.agents.list[idx].model || {};
          cfg.agents.list[idx].model.primary = model;
          writeOpenClawConfig(cfg);
        }
      }
    } catch (_) {}
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

  // v3.1.33: auto-detect Ollama at the default port and
  // register it as "Local Ollama" so the friendliest
  // possible UX means the user's already-downloaded
  // models are usable without manual setup. We only
  // add it if no Ollama entry exists yet — don't
  // stomp on a user-registered non-default port.
  // Failures are silent (don't block app startup).
  setImmediate(async () => {
    try {
      const probe = await probeLlmEndpoint('http://localhost:11434');
      if (!probe.ok) return; // Ollama not running, no-op
      const list = loadLlmEndpoints();
      const existing = list.find(e =>
        e.baseUrl.replace(/\/+$/, '') === 'http://localhost:11434'
      );
      if (existing) {
        existing.models = probe.models;
        existing.lastProbedAt = Date.now();
        saveLlmEndpoints(list);
      } else {
        list.push({
          id: 'ollama-local',
          name: 'Local Ollama',
          baseUrl: 'http://localhost:11434',
          apiKey: '',
          type: 'ollama',
          models: probe.models,
          lastProbedAt: Date.now(),
          autoDetected: true,
        });
        saveLlmEndpoints(list);
        console.log(`[main] Auto-detected Ollama at localhost:11434 (${probe.models.length} model${probe.models.length === 1 ? '' : 's'})`);
      }
    } catch (_) {}
  });

  // Start sync server for mobile companion app
  syncServer = new SyncServer({
    port: 9247,
    mainWindow,
    onChatMessage: (text, agentId, meta) => {
      // Mark this ws for TTS reply — same as audio_input flow
      if (meta.ws && syncServer) syncServer._voiceReplyWs = meta.ws;
      discordLog('💬', 'Mobile chat received', `"${text.substring(0, 60)}"`, 'voice');
      // v3.2.56: hold the text for MOBILE_CHAT_HOLD_MS to
      // allow a follow-up attachment batch to merge. If
      // an attachment arrives in the window, send a single
      // combined IPC; otherwise fall through to the
      // existing text-only send after the timer.
      if (pendingMobileChatText && pendingMobileChatText.timer) {
        clearTimeout(pendingMobileChatText.timer);
      }
      const capturedMeta = meta;
      const flush = () => {
        if (!pendingMobileChatText || pendingMobileChatText.text !== text) return;
        pendingMobileChatText = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
          const { ws: _ws, ...serializableMeta } = capturedMeta || {};
          console.log(`[mobile-chat] hold elapsed, sending text-only: ${text.substring(0, 60)}`);
          mainWindow.webContents.send('mobile-chat', { text, agentId, meta: serializableMeta });
        }
      };
      pendingMobileChatText = {
        text,
        agentId,
        meta: capturedMeta,
        timer: setTimeout(flush, MOBILE_CHAT_HOLD_MS),
      };
      // If an attachment has ALREADY been saved (text
      // arrived after the attachment batch was queued),
      // flush immediately so the renderer can merge.
      if (pendingAttachments.length > 0) {
        console.log(`[mobile-chat] ${pendingAttachments.length} attachment(s) already pending, flushing immediately`);
        if (attachmentFlushTimer) {
          clearTimeout(attachmentFlushTimer);
          attachmentFlushTimer = null;
        }
        // The flush will see pendingMobileChatText and
        // forward text + attachments in one batch.
        flushAttachmentBatch();
      }
    },
    onVoiceTranscript: (transcript, context, meta) => {
      // v3.2.78: strip the non-serializable `ws` from
      // meta before IPC. Same fix as the arena_treat
      // handlers below — Electron's structured-clone
      // can't serialize a WebSocket instance. Defensive
      // here even though we haven't seen this path
      // fail yet, because it would be silent and the
      // mobile-voice handler is just as critical.
      if (mainWindow && !mainWindow.isDestroyed()) {
        const { ws: _ws, ...serializableMeta } = meta || {};
        mainWindow.webContents.send('mobile-voice', {
          transcript, context, meta: serializableMeta,
        });
      }
    },
    onMobileWakeAgent: (agentId, meta) => {
      // v3.10.3: relay the mobile's wake-request to the
      // renderer. The renderer's mobile-wake-request IPC
      // handler flips sleepState for the targeted agent.
      // The broadcastAgentsListToMobile() call inside the
      // renderer pushes the new state back to all
      // connected mobile clients.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('mobile-wake-request', { agentId });
      }
    },
    onMobileActivityPing: (agentId, meta) => {
      // v3.10.91: relay the mobile's activity heartbeat to
      // the renderer. The renderer's mobile-activity-ping
      // IPC handler bumps lastInteractionTs on the targeted
      // agent so its auto-sleep timer resets. The agent
      // stays awake while the mobile user is actively
      // engaged (chat tab open + app foregrounded).
      //
      // Without this, a mobile-only user (no chat submit,
      // no voice, no treats on desktop) sees the companion
      // fall asleep after 12 min, even though they're
      // actively looking at the chat on mobile. Tobe's
      // report (2026-07-23 23:28): "The companions should
      // sleep on the mobile also like they do on desktop."
      //
      // Implementation note: the IPC sends through to the
      // renderer because the agents[] data structure lives
      // there (renderer is the source of truth for
      // sleepState + lastInteractionTs). The renderer's
      // handler calls bumpCompanionInteraction() and is
      // done — no state update needed since
      // lastInteractionTs isn't broadcast to the mobile.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('mobile-activity-ping', { agentId });
      }
    },
    onArenaTreatPlaced: (treat, meta) => {
      // v3.10.72: mobile dropped a food/treat on the
      // arena. Forward to the renderer which calls
      // promptCompanionReaction('I just gave you ' +
      // TREAT_NAMES[treat] + '. What do you think?') so
      // the AI text reply matches the visual reaction.
      // Mirrors the desktop's placeTreatOnArena() in
      // src/js/app.js:4905.
      // v3.2.78: strip the non-serializable `ws`
      // WebSocket from meta before crossing the IPC
      // boundary. Same pattern as the mobile-chat
      // handler (line ~3206) — destructures
      // `const { ws: _ws, ...serializableMeta }`.
      // Without this, mainWindow.webContents.send
      // throws "Error: Failed to serialize arguments"
      // (Electron's structured-clone can't serialize
      // a ws.WebSocket instance), the IPC silently
      // fails to reach the renderer, and
      // promptCompanionReaction never runs. Tobe
      // 2026-08-06 hit this immediately after the
      // v3.2.77 fix landed (which finally wired the
      // callbacks) — every treat_placed/treat_eaten
      // was logged arriving at sync-server, every
      // IPC send failed, no companion reacted.
      if (mainWindow && !mainWindow.isDestroyed()) {
        const { ws: _ws, ...serializableMeta } = meta || {};
        mainWindow.webContents.send('mobile-arena-treat-placed', {
          treat, meta: serializableMeta,
        });
      }
    },
    onArenaTreatEaten: (treat, meta) => {
      // v3.10.72: companion ate a treat (from the
      // mobile arena's seek-and-eat logic). Forward to
      // the renderer for the same reaction as the
      // desktop's promptCompanionEat() callback.
      // v3.2.78: strip the non-serializable `ws` from
      // meta — same fix as onArenaTreatPlaced above.
      if (mainWindow && !mainWindow.isDestroyed()) {
        const { ws: _ws, ...serializableMeta } = meta || {};
        mainWindow.webContents.send('mobile-arena-treat-eaten', {
          treat, meta: serializableMeta,
        });
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
    onRequestAgentHistory: (ws, agentId) => {
      // v3.1.17: per-agent chat history for the mobile companion tab bar.
      console.log(`[SyncServer] Mobile requested history for agent: ${agentId}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('mobile-request-agent-history', { agentId });
        if (!syncServer._pendingAgentHistoryWs) syncServer._pendingAgentHistoryWs = [];
        syncServer._pendingAgentHistoryWs.push({ ws, agentId });
        console.log(`[SyncServer] Stored agent-history request for ${agentId}, waiting for renderer`);
      } else {
        console.log('[SyncServer] Main window not available!');
      }
    },
    onRequestAgentsList: () => {
      // v3.1.16: when a mobile reconnects after the desktop's
      // initial agents_list broadcast already went out (or the
      // cache was cleared), ask the renderer to re-broadcast the
      // current agents list. The renderer's existing
      // 'sync-broadcast-agents-list' IPC handler then sends the
      // payload to the main process, which calls
      // broadcastAgentsList — that hits the cache path in
      // sync-server.js's _sendFullState for any subsequent
      // reconnects.
      console.log('[SyncServer] Asking renderer to re-broadcast agents list');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('mobile-request-agents-list', {});
      } else {
        console.log('[SyncServer] Main window not available!');
      }
    },
    // v3.1.95: quests live in main.js's domain (loadQuests/
    // saveQuests), so this callback can read the source of truth
    // directly and push it to the sync server — no renderer
    // roundtrip needed. Mirrors the agents-list pattern but with
    // one fewer hop.
    onRequestQuestsList: () => {
      console.log('[SyncServer] No cached quests_list — broadcasting fresh');
      if (syncServer) syncServer.broadcastQuestsList(loadQuests());
    },
    // v3.2.32: read a companion's soul.md for the mobile.
    // Mobile is read-only — the desktop forge is the editor.
    onReadCompanionSoul: async (agentId) => {
      try {
        return { ok: true, content: companionPrompts.readSoul(agentId) };
      } catch (e) { return { ok: false, error: e?.message || String(e) }; }
    },
    // v3.2.32: read a companion's memory.md for the mobile.
    onReadCompanionMemory: async (agentId) => {
      try {
        return { ok: true, content: companionPrompts.readMemory(agentId) };
      } catch (e) { return { ok: false, error: e?.message || String(e) }; }
    },
    // v3.2.32: clear a companion's memory.md from the mobile.
    // Mirrors the desktop's companion:clear-memory IPC.
    onClearCompanionMemory: async (agentId) => {
      try { return companionPrompts.clearMemory(agentId); }
      catch (e) { return { ok: false, error: e?.message || String(e) }; }
    },
    // v3.2.30: read a quest's project instructions file (markdown).
    // The mobile is read-only on this file; the desktop's
    // quest editor is the source of truth for changes.
    // We call the same IPC the desktop's renderer uses
    // (ipcMain.handle('quests:read-quest-instructions', ...)) so
    // the resolution path is identical: if the quest has
    // a directory, read <directory>/QUEST_QUEST_INSTRUCTIONS.md; else
    // read ~/.openclaw/cyberclaw/quests/<id>/QUEST_QUEST_INSTRUCTIONS.md.
    // Returns { ok, content, path } (or { ok: false, error }).
    onReadQuestInstructions: async (questId) => {
      try {
        // Re-use the IPC handler's logic by simulating a
        // call. The handler is private to the IPC layer,
        // so we inline the path-resolution + read here.
        const quests = loadQuests();
        const quest = quests.find(q => q.id === questId);
        if (!quest) return { ok: false, error: 'quest not found' };
        const file = questInstructionsFilePath(quest);
        if (!fs.existsSync(file)) return { ok: true, content: '', path: file };
        const content = fs.readFileSync(file, 'utf-8');
        return { ok: true, content, path: file };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    },
    // v3.2.33: write counterpart for the read above. The
    // mobile's quest editor sends save_quest_instructions
    // with the file content; we write via the same IPC
    // the desktop's renderer uses (which mkdirs the
    // parent dir if needed). Returns { ok, path, bytes }
    // or { ok: false, error }.
    onSaveQuestInstructions: async (questId, content) => {
      try {
        const quests = loadQuests();
        const quest = quests.find(q => q.id === questId);
        if (!quest) return { ok: false, error: 'quest not found' };
        const file = questInstructionsFilePath(quest);
        const parent = path.dirname(file);
        fs.mkdirSync(parent, { recursive: true });
        fs.writeFileSync(file, content || '', 'utf-8');
        return { ok: true, path: file, bytes: Buffer.byteLength(content || '', 'utf-8') };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    },
    // v3.2.26: phone-side companion edit (Personalize
    // screen). The mobile sends a sprite_config_sync with
    // { agentId, config: <partial patch> }. We forward it
    // to the renderer which is the source of truth for the
    // in-memory agents map — the renderer merges the patch
    // with the existing config, calls the existing
    // cyberclaw.agents.saveSpriteConfig (which writes
    // sprites.json + regenerates the avatar if sprite
    // changed), and triggers broadcastAgentsListToMobile()
    // so every connected client (including the phone that
    // initiated the edit) sees the updated agents_list.
    //
    // Return values: { ok: true } on success,
    // { ok: false, reason, error } on failure. The
    // sync-server uses this to send a sprite_config_sync_ok
    // ack or a sprite_config_sync_failed error.
    onSaveSpriteConfig: (agentId, patch) => {
      if (!agentId) return { ok: false, reason: 'missing_agentId', error: 'agentId is required' };
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { ok: false, reason: 'no_main_window', error: 'desktop window not available' };
      }
      try {
        mainWindow.webContents.send('mobile-sprite-config-saved', { agentId, patch });
        return { ok: true };
      } catch (e) {
        console.warn('[SyncServer] onSaveSpriteConfig: webContents.send failed:', e?.message);
        return { ok: false, reason: 'send_failed', error: e?.message || 'unknown' };
      }
    },
    // v3.10.77: returns the current list of quests
    // (with id + name) for diagnostic inclusion in
    // failed-mutation error responses. Lets the mobile
    // show "looking for X, available: [{id: a, name:
    // foo}, {id: b, name: bar}]" so we can see whether
    // the id is genuinely unknown or just stale.
    // v3.10.74 returned just the ids; the user couldn't
    // tell "wrong id for the right quest" from "quest
    // doesn't exist anymore".
    onListQuests: () => {
      try {
        const all = loadQuests();
        return all.map(q => ({ id: q.id, name: q.name || '(unnamed)' }));
      } catch { return []; }
    },
    // v3.8.0: phone-side quest edit. Each callback is the
    // WebSocket counterpart of the corresponding IPC handler.
    // The mutation goes through the same loadQuests → modify →
    // saveQuests flow; saveQuests broadcasts the updated list
    // back to all connected clients (including the mobile that
    // initiated the edit) so the mobile's optimistic update
    // is replaced with the canonical data within ~100ms.
    //
    // Return values: truthy on success, falsy on failure
    // (quest not found, invalid id, etc.). The SyncServer uses
    // this to send a `quests_update_failed` ack.
    onSetQuestActive: (id) => {
      const quests = loadQuests();
      let changed = false;
      for (const q of quests) {
        const shouldBeActive = q.id === id && !!id;
        if (q.active !== shouldBeActive) {
          q.active = shouldBeActive;
          changed = true;
        }
      }
      if (changed) saveQuests(quests);
      return !!id && quests.some(q => q.id === id);
    },
    onUpdateQuest: (id, updates) => {
      if (!id) return null;
      const quests = loadQuests();
      let idx = quests.findIndex(q => q.id === id);
      // v3.10.77: name-based fallback. If the exact id
      // doesn't match, try to find a quest with the
      // same name (and directory, if provided). Tobe
      // hit repeated "quest not found" errors on
      // 2026-07-22 even with the v3.10.73 broadcast-
      // acked gate on the mobile. The most likely cause
      // is a desktop reinstall/restart that regenerated
      // ids while the mobile's broadcast cached the old
      // ones. The cache gets refreshed on the next
      // broadcast but the editor's `editorOpen.id` is
      // captured at open time — if the broadcast
      // arrived mid-edit, the editor's id is from the
      // OLD cache, the desktop has the NEW id.
      //
      // The fallback: if we can't find by id, try by
      // name. If we find a single match, log the
      // mismatch (so we can see how often it happens)
      // and proceed with the update. This trades a
      // little safety ("is the user's edit really
      // meant for THIS quest?") for usability ("don't
      // fail just because ids drifted"). The desktop
      // log captures the warning so we can diagnose.
      if (idx < 0 && updates && typeof updates.name === 'string') {
        const wantedName = String(updates.name).trim();
        if (wantedName) {
          const nameMatches = quests
            .map((q, i) => ({ q, i }))
            .filter(({ q }) => (q.name || '').trim() === wantedName);
          if (nameMatches.length === 1) {
            idx = nameMatches[0].i;
            console.warn(
              '[main.js] onUpdateQuest: id mismatch, recovered by name. wanted id:',
              id, 'matched:', idx, 'quest name:', wantedName,
            );
          } else if (nameMatches.length > 1) {
            console.warn(
              '[main.js] onUpdateQuest: id mismatch, multiple name matches, refusing to guess. wanted id:',
              id, 'name:', wantedName, 'matches:',
              nameMatches.map(m => m.q.id),
            );
          }
        }
      }
      if (idx < 0) return null;
      // v3.8.0: only allow a safe set of fields to be
      // updated over WebSocket. Block `active` and
      // `latestChanges` (those have their own dedicated
      // messages / are desktop-only), and block `id` and
      // `created` (immutable after creation). The renderer
      // is the only place that should set `active: true`
      // on a quest — but we expose that via onSetQuestActive
      // above so the user can star from the phone too.
      const safe = { ...updates };
      delete safe.id;
      delete safe.created;
      delete safe.active;
      delete safe.latestChanges;
      // Block `skills` too — that field was removed from
      // the quest model in v3.1.49 but legacy data may
      // still have it; the mobile shouldn't be writing it.
      delete safe.skills;
      Object.assign(quests[idx], safe);
      saveQuests(quests);
      return quests[idx];
    },
    onDeleteQuest: (id) => {
      if (!id) return false;
      const quests = loadQuests();
      const next = quests.filter(q => q.id !== id);
      if (next.length === quests.length) return false;
      saveQuests(next);
      return true;
    },
    onMarkQuestGoalDone: (id, goalIndex, completed) => {
      if (!id) return null;
      const quests = loadQuests();
      const q = quests.find(x => x.id === id);
      if (!q) return null;
      const goals = Array.isArray(q.goals) ? q.goals : [];
      const idx = parseInt(goalIndex, 10);
      if (isNaN(idx) || idx < 0 || idx >= goals.length) return null;
      if (typeof goals[idx] === 'string') {
        goals[idx] = { text: goals[idx], completed: !!completed };
      } else {
        goals[idx] = { ...goals[idx], completed: !!completed };
      }
      q.goals = goals;
      saveQuests(quests);
      return q;
    },
    onCreateQuest: (quest) => {
      // v3.8.0: phone can create new quests. Mirror the
      // IPC handler's logic: assign id, created, defaults
      // (status: 'active', active: false, latestChanges: []).
      // The mobile doesn't pick a directory in v3.8.0 (that
      // needs the Android SAF picker which lands in v3.8.1);
      // for now, the user can leave directory undefined or
      // paste a path string.
      //
      // v3.2.61: conversationLog default for parity with the
      // IPC handler (the renderer routes here for create_quest
      // WS messages from the mobile).
      //
      // v3.10.156: auto-derive a directory when none is
      // provided. The old behaviour was to leave the quest
      // without a directory on disk, which meant the desktop
      // never scaffolded INSTRUCTIONS.md / CONVERSATION.md
      // and the user ended up with a "ghost quest" — visible
      // in the list but no project files anywhere. Tobe
      // (2026-08-11): 'i think we just need to adjust such
      // that it will be created in the defualt directory
      // with the quest name, what the user inputted as
      // quest name'. We now resolve in this order:
      //   1. Explicit quest.directory if provided
      //   2. quest.defaultQuestDir (passed in by the
      //      caller — the mobile or the renderer reads
      //      it from localStorage and forwards; this
      //      avoids an async bridge into the renderer
      //      from the WS path) + '/<sanitized-name>'
      //   3. ~/quests/<sanitized-name>
      // The auto-derived directory is logged + persisted on
      // the new quest so the user can see where it landed
      // (and edit later from the quest detail page).
      const quests = loadQuests();
      const newQuest = {
        name: quest.name || 'Untitled quest',
        description: quest.description || '',
        goals: Array.isArray(quest.goals) ? quest.goals : [],
        status: 'active',
        active: false,
        latestChanges: [],
        conversationLog: [],
      };
      newQuest.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      newQuest.created = new Date().toISOString();
      // v3.10.156: resolve directory — explicit > caller-
      // provided defaultDir > ~/quests fallback. Always
      // pick a path so scaffolding has something to work
      // with. Same helper as the IPC handler.
      const existingDir = (typeof quest.directory === 'string' && quest.directory.trim())
        ? quest.directory.trim()
        : null;
      newQuest.directory = resolveQuestDirectory(newQuest.name, existingDir, quest.defaultQuestDir);
      if (!existingDir) {
        console.log(`[onCreateQuest] auto-derived directory for "${newQuest.name}": ${newQuest.directory}`);
      }
      // v3.2.61: scaffold the quest directory if a path was
      // supplied. Same logic as the IPC handler — best-effort,
      // does not fail the create if the path is unwritable.
      if (newQuest.directory) {
        const scaffold = scaffoldQuestDirectory(newQuest);
        if (!scaffold.ok) {
          console.warn(`[onCreateQuest] scaffold failed for ${newQuest.id}: ${scaffold.error}`);
        } else {
          console.log(`[onCreateQuest] scaffolded ${newQuest.directory} with INSTRUCTIONS.md + CONVERSATION.md`);
        }
      }
      quests.unshift(newQuest);
      saveQuests(quests);
      return newQuest;
    },
    // v3.2.61: WS-side wiring for the per-quest conversation
    // log IPCs. The mobile sends a `request_quest_conversation_log`
    // WS message; the SyncServer routes it here; we return
    // the same shape as the renderer-side IPC. The SyncServer
    // also has its own shapes for file-path / clear, so we
    // expose three callbacks.
    onGetQuestConversationLog: async (questId) => {
      if (!questId) return { ok: false, error: 'no questId' };
      const quests = loadQuests();
      const q = quests.find(x => x.id === questId);
      if (!q) return { ok: false, error: 'quest not found' };
      return {
        ok: true,
        log: Array.isArray(q.conversationLog) ? q.conversationLog : [],
        questName: q.name || '',
        filePath: questConversationFilePath(q),
      };
    },
    onGetQuestConversationFile: async (questId) => {
      if (!questId) return { ok: false, error: 'no questId' };
      const quests = loadQuests();
      const q = quests.find(x => x.id === questId);
      if (!q) return { ok: false, error: 'quest not found' };
      const f = questConversationFilePath(q);
      if (!f) return { ok: false, error: 'no file path for this quest' };
      try {
        if (!fs.existsSync(f)) return { ok: true, content: '', path: f };
        return { ok: true, content: fs.readFileSync(f, 'utf-8'), path: f };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    },
    onClearQuestConversationLog: async (questId) => {
      if (!questId) return { ok: false, error: 'no questId' };
      const quests = loadQuests();
      const q = quests.find(x => x.id === questId);
      if (!q) return { ok: false, error: 'quest not found' };
      q.conversationLog = [];
      saveQuests(quests);
      try {
        const f = questConversationFilePath(q);
        if (f && fs.existsSync(f)) fs.unlinkSync(f);
      } catch (_) {}
      return { ok: true };
    },
    // v3.2.62: CYBERCLAW.md (overarching system prompt)
    // round-trip. The desktop's `system:get-cyberclaw` /
    // `system:save-cyberclaw` / `system:reset-cyberclaw`
    // IPC handlers wrap the file IO; the SyncServer
    // callbacks here wrap those for the mobile. The
    // same companion-prompts module is the source of
    // truth for both Desktop's renderer AND the
    // mobile's Settings screen, so edits from either
    // side land in the same physical file.
    onGetCyberclawSystem: async () => {
      try {
        return {
          ok: true,
          content: companionPrompts.readSystemPrompt(),
          defaultContent: companionPrompts.DEFAULT_SYSTEM_PROMPT,
          path: companionPrompts.SYSTEM_PROMPT_FILE,
        };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    },
    onSaveCyberclawSystem: async (content) => {
      try {
        return { ok: true, ...companionPrompts.writeSystemPrompt(content || '') };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    },
    onResetCyberclawSystem: async () => {
      try {
        return { ok: true, ...companionPrompts.resetSystemPrompt() };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
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

        // 2.5 — v3.2.21 fix: route the transcript to the
        // desktop renderer's chat/LLM pipeline. Without this
        // send, the renderer's `mobile-voice` IPC handler
        // (src/js/app.js:3794) never fires, the transcript
        // never reaches the LLM, and the user sees
        // "Transcribing..." forever on the mobile. This send
        // used to exist in the original sync-server commit
        // (c275eae) and got dropped at some point. Re-adding
        // it restores the audio→LLM→audio_response loop.
        if (mainWindow && !mainWindow.isDestroyed()) {
          const voiceSendTs = Date.now();
          // v3.2.6: tag each routing with a unique id so
          // the ack handler can remove the right queue
          // entry. Without this, the ack handler can't
          // tell which transcript the ack is for (and a
          // re-routed transcript from drainPendingVoiceQueue
          // could be ack'd twice if its original ack
          // arrived late).
          const voiceId = `voice-${voiceSendTs}-${Math.random().toString(36).slice(2, 8)}`;
          // v3.2.6: queue the routing so we can replay
          // it if the renderer hangs and we reload. Tobe's
          // "user shouldn't have to repeat himself"
          // complaint — without this queue, every hang
          // means lost work.
          pendingVoiceQueue.push({
            id: voiceId,
            transcript,
            context: '',
            meta: { source: 'mobile', deviceName: meta?.deviceName || 'Mobile' },
            ts: voiceSendTs,
          });
          if (pendingVoiceQueue.length > PENDING_VOICE_QUEUE_CAP) {
            const dropped = pendingVoiceQueue.shift();
            console.warn(`[Voice] Dropped pending entry ${dropped.id} — queue cap reached`);
          }
          mainWindow.webContents.send('mobile-voice', {
            id: voiceId,
            transcript,
            context: '',
            meta: { source: 'mobile', deviceName: meta?.deviceName || 'Mobile' },
          });
          console.log(`[Voice] Routed transcript to renderer via mobile-voice IPC (id=${voiceId}, queue=${pendingVoiceQueue.length})`);

          // v3.2.3: ack-watcher. If the renderer doesn't
          // ack within 8s, the renderer's JS context is
          // hung (Tobe's v3.10.12 hang). Surface this to
          // the mobile so the user knows the desktop
          // pipeline is stuck — the mobile's transcribing
          // timeout (30s) is the user's primary signal,
          // but this 8s ack-watcher surfaces a more
          // specific failure: "the desktop received the
          // audio but its renderer is unresponsive."
          //
          // We use a Promise that resolves either when
          // the ack IPC arrives OR after 8s. The ack IPC
          // is handled separately above (mobile-voice-ack).
          // Here we just observe the deadline.
          if (ws && ws.readyState === 1) {
            setTimeout(() => {
              // v3.2.3 (extended): ack-watcher deadline.
              // v3.2.7: distinguish three cases:
              // 1. ackedVoiceIds has voiceId — renderer
              //    received the IPC, may be working on LLM.
              //    Don't fire the hang signal yet.
              // 2. voiceResponseTracker has voiceId —
              //    renderer is processing the voice but
              //    hasn't sent a response yet. Wait.
              // 3. Neither has voiceId — true hang.
              const gotAck = ackedVoiceIds.has(voiceId);
              const inResponseTracker = voiceResponseTracker.has(voiceId);
              if (gotAck && inResponseTracker) {
                // Renderer is processing normally.
                return;
              }
              if (gotAck && !inResponseTracker) {
                // Renderer received the IPC but never
                // registered for response tracking.
                // Probably hung between ack and LLM call.
                console.warn(`[Voice] Renderer acked ${voiceId} but never started tracking`);
                // Fall through to hang signal.
              }
              if (!gotAck) {
                // Renderer never received the IPC.
                // True hang.
                console.warn(`[Voice] No renderer ack within 8s for ${voiceId} — renderer may be hung`);
              }
              discordLog('⚠️', 'Renderer hang suspected', `id=${voiceId} ack=${gotAck} tracking=${inResponseTracker}`, 'error');
              // v3.2.4: count this hang and reload the
              // renderer after 3 consecutive hangs.
              // The reload clears the hung JS context.
              maybeReloadRenderer();
              // Notify the mobile. The mobile uses
              // this to surface a 'desktop received
              // your message but isn't responding' hint
              // earlier than its own 30s transcribing
              // timeout.
              try {
                if (syncServer) {
                  syncServer.sendToMobile({
                    type: 'voice_pipeline_stalled',
                    ts: voiceSendTs,
                    hint: 'desktop renderer unresponsive',
                  });
                }
              } catch (_) {}
            }, 8000);
          }
        } else {
          console.warn('[Voice] No main window — cannot route transcript to renderer');
        }

        // 3. Mark that the next AI reply should be spoken back (TTS audio response)
        syncServer._voiceReplyWs = ws;
      } catch (e) {
        console.error('[Voice] Transcription error:', e.message);
        if (syncServer && ws) syncServer.sendTranscript(ws, '');
      }
    },
    // v3.2.8: image / file attachment upload from
    // mobile. Writes to disk under ~/.openclaw/cyberclaw/
    // attachments/ (auto-created), broadcasts via the
    // renderer's chat pipeline so the LLM can use it
    // for vision tasks (text-only models ignore it).
    // Tobe's v3.10.20 follow-up: "handle the desktop
    // side with the image handling". The mobile was
    // already sending the bytes (v3.10.20 added
    // sendAttachment on the SyncClient), but the desktop
    // had no handler so they were silently dropped.
    onAttachment: async (base64, mimeType, fileName, ws, meta) => {
      try {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        // Auto-create the attachments dir if missing.
        // mkdir with recursive is idempotent.
        const attachDir = path.join(os.homedir(), '.openclaw', 'cyberclaw', 'attachments');
        fs.mkdirSync(attachDir, { recursive: true });
        // Generate a timestamped filename so collisions
        // are impossible and the on-disk name carries
        // time-of-arrival for debugging.
        const ext = (fileName && fileName.includes('.'))
          ? fileName.substring(fileName.lastIndexOf('.'))
          : (mimeType.startsWith('image/') ? '.' + mimeType.split('/')[1] : '');
        const ts = Date.now();
        const safeBase = (fileName || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_');
        const savedName = `${ts}-${safeBase}${ext.startsWith('.') ? ext : (ext ? '.' + ext : '')}`;
        const savedPath = path.join(attachDir, savedName);
        fs.writeFileSync(savedPath, Buffer.from(base64, 'base64'));
        const fileSize = fs.statSync(savedPath).size;
        console.log(`[Attachment] Saved ${fileName} (${fileSize} bytes) -> ${savedPath}`);
        discordLog('📎', 'Attachment saved', `${fileName} (${fileSize} bytes)`, 'info');
        // Broadcast to renderer so the LLM gets a
        // message that includes the attachment path.
        // The renderer's chat pipeline can then forward
        // this to the LLM as a vision-enabled message
        // (GPT-4V / Claude Sonnet 4 / etc.) or skip it
        // for text-only models.
        if (mainWindow && !mainWindow.isDestroyed()) {
          // v3.2.51: include the base64-encoded attachment
          // data in the IPC payload. The renderer-side
          // handler passes it through to chat:send-message
          // v3.2.52: buffer attachments for 700ms before
          // firing the IPC, so a multi-image paste
          // results in ONE multimodal chat send instead
          // of N. The mobile sends each image as a
          // separate WS message, but the user's
          // intent is "send all of these together" —
          // batching preserves that.
          let dataBase64 = null;
          try {
            dataBase64 = fs.readFileSync(savedPath, 'base64');
          } catch (e) {
            console.warn('[Attachment] failed to re-read for IPC payload:', e?.message);
          }
          pendingAttachments.push({
            path: savedPath,
            mimeType,
            fileName,
            size: fileSize,
            data: dataBase64,
            meta: {
              source: 'mobile',
              deviceName: meta?.deviceName || 'Mobile',
              agentId: meta?.agentId || null,
            },
            receivedAt: Date.now(),
          });
          if (attachmentFlushTimer) clearTimeout(attachmentFlushTimer);
          attachmentFlushTimer = setTimeout(flushAttachmentBatch, ATTACHMENT_FLUSH_MS);
        }
        // Ack back to mobile so the chat can update
        // with the attachment preview on the mobile side.
        if (ws && ws.readyState === 1) {
          syncServer._send(ws, {
            type: 'attachment_received',
            path: savedPath,
            fileName: savedName,
            size: fileSize,
          });
        }
      } catch (e) {
        console.error('[Attachment] Error:', e.message);
        discordLog('❌', 'Attachment failed', e.message, 'error');
        if (ws && ws.readyState === 1) {
          syncServer._send(ws, {
            type: 'attachment_error',
            error: e.message,
          });
        }
      }
    },
  });
  syncServer.start();

  // v3.2.21: start the OpenClaw session tailer. When a
  // Discord-routed agent run completes (e.g. user types
  // in Discord #cyber-dev), the tailer picks up the
  // assistant text message from the OpenClaw session
  // JSONL file and broadcasts it via sync-broadcast-chat
  // to the mobile. Without this, the mobile's chat
  // history shows nothing when the user types in Discord
  // — the chat pipeline only handles replies from its
  // own channel (mobile chat, voice, typed desktop).
  //
  // Sessions owned by the desktop's own chat pipeline
  // (key `agent:clawsuu:main` and friends) are skipped
  // because they already broadcast via the normal
  // addChatMsg + sync-broadcast-chat IPC path. Skipping
  // them prevents double-broadcasting the same message.
  const openclawSessionTail = new OpenClawSessionTail({
    sessionsDir: path.join(os.homedir(), '.openclaw', 'agents', 'clawsuu', 'sessions'),
    agentId: 'clawsuu',
    onTyping: (active) => {
      // v3.2.25: don't broadcast typing from Discord-routed
      // runs to mobile. Same rationale as onChatMessage
      // (Tobe: "discord conversation should not appear on
      // the app"). The mobile's chat panel should only
      // react to activity that's part of an in-app
      // conversation. Tool-call broadcasts (onToolCall
      // below) are similarly suppressed because the user
      // isn't engaging with the agent via the mobile.
      // (The onChatMessage and onToolCall callbacks are
      // all no-ops now since the chat panel shouldn't
      // show anything from Discord. The tailer is kept
      // alive because it owns session-key bookkeeping
      // and the activeQuestRef update for cases where
      // the desktop-pipeline session does need it.)
      // See CHANGES_3.2.25.md for the full rationale.
    },
    onChatMessage: ({ agentId, agentName, text, isUser }) => {
      // v3.2.25: Discord-routed agent replies do NOT broadcast
      // to the mobile. Tobe reported (2026-07-24 00:13): "if we
      // have conversation here on discord it should not appear
      // on the app." The original v3.2.21 tailer existed to
      // bridge Discord-routed replies to mobile (which was the
      // missing case at the time), but that was wrong — the
      // mobile chat panel should reflect conversations the user
      // had IN THE APP, not conversations the agent had in
      // parallel channels (Discord / webchat / cron / etc.).
      //
      // The cyberclaw chat pipeline path (mobile-typed,
      // voice-typed) already broadcasts via
      // sync-broadcast-chat. This tailer was redundant for
      // that case. Removing the broadcast keeps the channels
      // cleanly separated:
      //   - User → mobile chat → desktop pipeline →
      //     addChatMsg → sync-broadcast-chat → mobile
      //   - User → Discord → OpenClaw → agent reply →
      //     (no mobile broadcast; reply goes to Discord only)
      //
      // We still send the IPC to the renderer so the
      // renderer's chatHistoryByAgent stays in sync — in case
      // the user later switches to the desktop and views the
      // chat there. But we do NOT broadcast to mobile.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('openclaw-session-chat-message', {
          agentId, agentName, text, isUser, ts: Date.now(),
        });
      }
    },
    // v3.2.21: tool-call events for the better "thinking"
    // indicator on mobile. When the agent calls a tool
    // (exec, read, etc.), we broadcast a tool-call event
    // so the mobile can show "💭 Running command..."
    // or "💭 Reading file...". This is a thin event that
    // doesn't replace the typing broadcast — the mobile
    // shows it briefly while typing is on. The text is
    // intentionally short (Tobe asked for "short and
    // concise") — the mobile cycles the text based on
    // the tool name.
    onToolCall: ({ tool }) => {
      // v3.2.25: tool-call broadcasts are also suppressed
      // for Discord-routed runs. The mobile's chat panel
      // should not react to activity from conversations the
      // user isn't having in the app. The chat pipeline
      // path (mobile-typed / voice-typed) handles its own
      // typing/tool-call visuals internally — no need for
      // the OpenClaw tailer to broadcast anything for
      // Discord-routed runs.
      console.log(`[openclaw-tail] ignoring tool call tool=${tool} for Discord session (no mobile broadcast)`);
    },
    onLog: (level, msg) => {
      discordLog('📡', 'OpenClaw tail', msg, level);
    },
  });
  openclawSessionTail.start().catch(e => {
    console.error('[main] OpenClawSessionTail start failed:', e);
  });

  // v3.1.95: prime the quests cache so a mobile that connects
  // immediately after desktop boot doesn't have to wait for the
  // first user action (create/update/delete) to see the list.
  // Mirrors the agents-list pattern: loadQuests reads the same
  // source-of-truth file the IPC handlers write to.
  try { syncServer.broadcastQuestsList(loadQuests()); } catch (e) { console.warn('[IPC] initial broadcastQuestsList failed:', e?.message); }

  // v3.1.40: cache the most recent wake-training result per agent
  // for 15 minutes, so a mobile that lost its WebSocket mid-training
  // (Android background-killed the socket, brief network blip, etc.)
  // can re-fetch the result on reconnect instead of having to
  // re-record + re-train from scratch. Tobe hit this when the
  // progress bar stuck at 30% on a 5-10 minute training run: the
  // desktop was grinding away on the GPU but the phone had no
  // way to find out the result.
  const WAKE_RESULT_TTL_MS = 15 * 60 * 1000;
  const lastWakeResult = new Map(); // agentId -> { result, completedAt }

  function cacheWakeResult(agentId, result) {
    lastWakeResult.set(agentId, { result, completedAt: Date.now() });
  }
  function getCachedWakeResult(agentId) {
    const entry = lastWakeResult.get(agentId);
    if (!entry) return null;
    if (Date.now() - entry.completedAt > WAKE_RESULT_TTL_MS) {
      lastWakeResult.delete(agentId);
      return null;
    }
    return entry.result;
  }
  // Expose for the sync-server 'get_latest_wake_training_result' case
  syncServer._getCachedWakeResult = getCachedWakeResult;

  // v3.1.46: track the most recent wake_training_progress per
  // agent for the same reason as the result cache above. A
  // phone that lost its WebSocket mid-training reconnects,
  // the watchdog polls get_latest_wake_training_result, and
  // we attach the latest progress so the bar re-paints to
  // where it actually is. Without this, the bar is stuck at
  // whatever the phone last saw before the WS died.
  const lastWakeProgress = new Map();  // agentId -> { stage, percent, message, ts }
  function setLastWakeProgress(agentId, payload) {
    lastWakeProgress.set(agentId, payload);
  }
  function getLastWakeProgress(agentId) {
    return lastWakeProgress.get(agentId) || null;
  }
  syncServer._getLastWakeProgress = getLastWakeProgress;

  // v3.5.0: parallel cache for exit-phrase training results.
  // Same TTL/cache pattern as wake (15 minutes). The exit
  // path is single-keyed by phrase (not per-agent), so a
  // re-train of the same phrase replaces the cached result.
  let lastExitResult = null;
  let lastExitResultCompletedAt = 0;
  let lastExitProgress = null;
  function cacheExitResult(result) {
    lastExitResult = result;
    lastExitResultCompletedAt = Date.now();
  }
  function getCachedExitResult() {
    if (!lastExitResult) return null;
    if (Date.now() - lastExitResultCompletedAt > WAKE_RESULT_TTL_MS) {
      lastExitResult = null;
      return null;
    }
    return lastExitResult;
  }
  function setLastExitProgress(payload) {
    lastExitProgress = payload;
  }
  function getLastExitProgress() {
    return lastExitProgress;
  }
  syncServer._getCachedExitResult = getCachedExitResult;
  syncServer._getLastExitProgress = getLastExitProgress;

  // v3.6.0: parallel cache for send-word training results.
  // Mirror of the exit-phrase cache above: single-keyed by
  // phrase (the send word is user-level, not per-companion),
  // 15-minute TTL, latest-progress stash for the mobile's
  // watchdog-poll path. The send-word pipeline was added to
  // the mobile in v3.6.0 but the desktop never wired up the
  // request handler — Tobe hit this when the trainer stuck
  // at "Uploading samples to desktop…" for 5 minutes: the
  // desktop's _handleMessage switch had no case for
  // `request_send_training` and silently dropped the
  // message into the default arm.
  let lastSendResult = null;
  let lastSendResultCompletedAt = 0;
  let lastSendProgress = null;
  function cacheSendResult(result) {
    lastSendResult = result;
    lastSendResultCompletedAt = Date.now();
  }
  function getCachedSendResult() {
    if (!lastSendResult) return null;
    if (Date.now() - lastSendResultCompletedAt > WAKE_RESULT_TTL_MS) {
      lastSendResult = null;
      return null;
    }
    return lastSendResult;
  }
  function setLastSendProgress(payload) {
    lastSendProgress = payload;
  }
  function getLastSendProgress() {
    return lastSendProgress;
  }
  syncServer._getCachedSendResult = getCachedSendResult;
  syncServer._getLastSendProgress = getLastSendProgress;

  // v3.2.0: wake-word training request from the mobile.
  // The mobile sends `request_wake_training` over the sync-server
  // WebSocket. We run the same openWakeWord training script the
  // desktop renderer's IPC handler uses, and forward progress +
  // completion events back to the originating mobile client.
  syncServer.on('wake_training_request', ({ ws, agentId, phrase, samples, nearMissSamples }) => {
    if (!syncServer) return;
    console.log(`[wake-train] Mobile requested: agent=${agentId} phrase="${phrase}" samples=${samples?.length || 0} nearMisses=${Array.isArray(nearMissSamples) ? nearMissSamples.length : 0}`);

    // v3.1.38: `samples` is now [{name, data}] (base64 audio), not
    // file paths. The phone can't expose its filesystem to us, so
    // we always wrote to `/data/user/0/...` which never existed
    // here.
    if (!Array.isArray(samples) || !samples.length) {
      syncServer._send(ws, { type: 'wake_training_result', ok: false, error: 'no samples provided' });
      return;
    }
    for (const s of samples) {
      if (!s || !s.name || !s.data) {
        syncServer._send(ws, { type: 'wake_training_result', ok: false, error: 'each sample needs {name, data}' });
        return;
      }
    }

    const scriptPath = path.join(__dirname, '..', 'scripts', 'train_wake_phrase.py');
    if (!fs.existsSync(scriptPath)) {
      syncServer._send(ws, { type: 'wake_training_result', ok: false, error: `training script not found: ${scriptPath}` });
      return;
    }

    const workDir = path.join(os.homedir(), '.openclaw', 'cyberclaw', 'wake-training', agentId);
    fs.mkdirSync(workDir, { recursive: true });
    const samplesDir = path.join(workDir, 'user_samples');
    fs.mkdirSync(samplesDir, { recursive: true });

    // v3.2.7: clear any cached result for this agent from a previous
    // run. Without this, a phone that polls for the latest result
    // mid-training (e.g. it reconnected after our WebSocket died)
    // could get back the OLD error from the previous failed run
    // instead of learning that a fresh training is in progress.
    // The new run will overwrite the cache entry on completion.
    lastWakeResult.delete(agentId);
    // v3.1.46: also clear the cached progress. Otherwise a
    // phone that reconnects mid-training would see the OLD
    // progress (from the previous run) before seeing any of
    // the new run's progress events. We want a clean slate
    // at the start of each new run.
    lastWakeProgress.delete(agentId);

    // Decode + write each sample into the work dir
    const localPaths = [];
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const ext = path.extname(s.name) || '.m4a';
      const dst = path.join(samplesDir, `sample_${i.toString().padStart(3, '0')}${ext}`);
      fs.writeFileSync(dst, Buffer.from(s.data, 'base64'));
      localPaths.push(dst);
    }

    // v3.1.53: optional user-recorded near-miss clips. The
    // trainer on the phone lets the user record 0-3 phrases
    // that sound similar but aren't the wake word, and
    // ships them here as base64 audio bytes. We decode
    // them into a separate `user_near_miss_samples/` dir
    // and pass the dir path to the python training script
    // via --user-negative-dir. If nearMissSamples is
    // missing or empty, the script falls back to using
    // only the Piper-TTS-generated adversarial negatives
    // (the v3.1.49 pattern).
    //
    // The python script copies the contents of this dir
    // into negative_train / negative_test (80/20 split) so
    // the augmentation step picks them up automatically.
    // Backward-compat: if no near-misses, the dir doesn't
    // exist and the script's `if user_neg_dir.exists()`
    // check is a no-op.
    let userNegativeDir = null;
    if (Array.isArray(nearMissSamples) && nearMissSamples.length > 0) {
      // v3.1.53: validate shape — each entry needs name + data,
      // mirroring the positive-samples validation above. This
      // prevents a malformed client from crashing the training
      // pipeline by sending garbage.
      const valid = nearMissSamples.every((s) => s && s.name && s.data);
      if (!valid) {
        syncServer._send(ws, { type: 'wake_training_result', ok: false, error: 'near-miss samples need {name, data}' });
        return;
      }
      userNegativeDir = path.join(workDir, 'user_near_miss_samples');
      fs.mkdirSync(userNegativeDir, { recursive: true });
      for (let i = 0; i < nearMissSamples.length; i++) {
        const s = nearMissSamples[i];
        const ext = path.extname(s.name) || '.m4a';
        const dst = path.join(userNegativeDir, `near_miss_${i.toString().padStart(3, '0')}${ext}`);
        fs.writeFileSync(dst, Buffer.from(s.data, 'base64'));
      }
      console.log(`[wake-train:${agentId}] wrote ${nearMissSamples.length} near-miss sample(s) to ${userNegativeDir}`);
    }

    const modelName = phrase.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const outputDir = path.join(workDir, 'output');
    fs.mkdirSync(outputDir, { recursive: true });

    const args = [
      scriptPath,
      '--name', modelName,
      '--samples-dir', samplesDir,
      '--output-dir', outputDir,
      '--n-samples', '10000',
      '--n-samples-val', '2000',
      '--epochs', '20',
    ];
    // v3.1.53: pass the user-negative dir only if we
    // actually wrote some near-miss samples. Without
    // this, the script defaults to using only the Piper
    // adversarial negatives (v3.1.49 pattern).
    if (userNegativeDir) {
      args.push('--user-negative-dir', userNegativeDir);
    }

    const proc = spawn('python3', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let tflitePath = null;
    let lastError = null;

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        if (line.startsWith('PROGRESS::')) {
          try {
            const payload = JSON.parse(line.slice('PROGRESS::'.length));
            // Strip the redundant 'type' field from the payload so
            // it doesn't override our 'wake_training_progress'
            // type when we spread it. (emit_progress() in
            // train_wake_phrase.py sets payload.type='progress'
            // for its own internal logging; we use
            // 'wake_training_progress' as the wire type the phone
            // listens for.)
            const { type: _ignore, ...fields } = payload;
            // Forward to the renderer (if any) and BROADCAST to all
            // authenticated mobile clients. We broadcast (not just
            // send to the originating ws) because the phone's
            // WebSocket may have died since the training started
            // — the user might have backgrounded the app, lost
            // wifi, etc. — and we want a reconnected phone to
            // pick up progress events too, not just the final
            // cached result. Filtering by agentId happens on the
            // phone side: the trainer ignores progress for other
            // agents.
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('wake-training-progress', { agentId, ...fields });
            }
            if (syncServer) {
              // v3.1.46: remember the latest progress so a phone
              // that lost its WebSocket mid-training can pick it
              // up on reconnect (via get_latest_wake_training_result).
              setLastWakeProgress(agentId, fields);
              const clients = Array.from(syncServer.clients.entries());
              const openClients = clients.filter(([ws, c]) => c.authenticated && ws.readyState === 1);
              console.log(`[wake-train:${agentId}] BROADCAST_PROGRESS stage=${fields.stage} pct=${fields.percent} → ${openClients.length}/${clients.length} open`);
              syncServer._broadcast({ type: 'wake_training_progress', agentId, ...fields });
            }
          } catch (_) {}
        } else if (line.startsWith('OUTPUT_TFLITE::')) {
          tflitePath = line.slice('OUTPUT_TFLITE::'.length).trim();
        } else if (line.startsWith('OUTPUT_ONNX::')) {
          // Fallback path: training finished but TFLite conversion failed
          tflitePath = line.slice('OUTPUT_ONNX::'.length).trim();
          lastError = 'tflite conversion failed; ONNX only';
        } else if (line.trim()) {
          console.log(`[wake-train:${agentId}] ${line.trim()}`);
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        if (line.trim()) console.error(`[wake-train:${agentId}] ${line.trim()}`);
      }
    });

    proc.on('error', (err) => {
      console.error(`[wake-train:${agentId}] spawn error: ${err.message}`);
      syncServer._send(ws, { type: 'wake_training_result', ok: false, error: err.message });
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        const errMsg = `training process exited ${code}`;
        console.error(`[wake-train:${agentId}] ${errMsg}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('wake-training-done', { agentId, error: errMsg });
        }
        const errResult = { type: 'wake_training_result', ok: false, agentId, error: errMsg };
        cacheWakeResult(agentId, errResult);
        syncServer._send(ws, errResult);
        return;
      }
      if (!tflitePath) {
        const errMsg = 'no .tflite output found';
        console.error(`[wake-train:${agentId}] ${errMsg}`);
        const errResult = { type: 'wake_training_result', ok: false, agentId, error: errMsg };
        cacheWakeResult(agentId, errResult);
        syncServer._send(ws, errResult);
        return;
      }
      console.log(`[wake-train:${agentId}] done -> ${tflitePath}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('wake-training-done', { agentId, tflitePath });
      }
      const okResult = {
        type: 'wake_training_result',
        ok: true,
        agentId,
        tflitePath,
        warning: lastError,
      };
      cacheWakeResult(agentId, okResult);
      syncServer._send(ws, okResult);
    });
  });

  // v3.5.0: exit-phrase training request from the mobile.
  // Mirror of wake_training_request but routed to a per-phrase
  // working directory and a separate message chain. Same training
  // script — openWakeWord doesn't care about the semantic phrase.
  syncServer.on('exit_training_request', ({ ws, phrase, samples }) => {
    if (!syncServer) return;
    console.log(`[exit-train] Mobile requested: phrase="${phrase}" samples=${samples?.length || 0}`);

    if (!Array.isArray(samples) || !samples.length) {
      syncServer._send(ws, { type: 'exit_training_result', ok: false, error: 'no samples provided' });
      return;
    }
    for (const s of samples) {
      if (!s || !s.name || !s.data) {
        syncServer._send(ws, { type: 'exit_training_result', ok: false, error: 'each sample needs {name, data}' });
        return;
      }
    }

    const scriptPath = path.join(__dirname, '..', 'scripts', 'train_wake_phrase.py');
    if (!fs.existsSync(scriptPath)) {
      syncServer._send(ws, { type: 'exit_training_result', ok: false, error: `training script not found: ${scriptPath}` });
      return;
    }

    const safePhrase = phrase.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const workDir = path.join(os.homedir(), '.openclaw', 'cyberclaw', 'exit-training', safePhrase);
    fs.mkdirSync(workDir, { recursive: true });
    const samplesDir = path.join(workDir, 'user_samples');
    fs.mkdirSync(samplesDir, { recursive: true });

    // Clear cached state from a previous train of the same phrase.
    lastExitResult = null;
    lastExitResultCompletedAt = 0;
    lastExitProgress = null;

    // Write the user samples.
    const localPaths = [];
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const safeName = s.name.replace(/[^a-zA-Z0-9._-]+/g, '_');
      const dst = path.join(samplesDir, `${i.toString().padStart(2, '0')}_${safeName}`);
      fs.writeFileSync(dst, Buffer.from(s.data, 'base64'));
      localPaths.push(dst);
    }

    const modelName = `exit_${safePhrase}`;
    const outputDir = path.join(workDir, 'output');
    fs.mkdirSync(outputDir, { recursive: true });

    // Same args as wake training — same script.
    const args = [
      scriptPath,
      '--name', modelName,
      '--samples-dir', samplesDir,
      '--output-dir', outputDir,
      '--n-samples', '10000',
      '--n-samples-val', '2000',
      '--epochs', '20',
    ];

    const proc = spawn('python3', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let tflitePath = null;
    let lastError = null;

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        if (line.startsWith('PROGRESS::')) {
          try {
            const payload = JSON.parse(line.slice('PROGRESS::'.length));
            const { type: _ignore, ...fields } = payload;
            setLastExitProgress(fields);
            if (syncServer) {
              syncServer._broadcast({ type: 'exit_training_progress', ...fields });
            }
          } catch (_) {}
        } else if (line.startsWith('OUTPUT_TFLITE::')) {
          tflitePath = line.slice('OUTPUT_TFLITE::'.length).trim();
        } else if (line.startsWith('OUTPUT_ONNX::')) {
          tflitePath = line.slice('OUTPUT_ONNX::'.length).trim();
          lastError = 'tflite conversion failed; ONNX only';
        } else if (line.trim()) {
          console.log(`[exit-train:${safePhrase}] ${line.trim()}`);
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      console.error(`[exit-train:${safePhrase}] stderr: ${chunk.toString().trim()}`);
    });

    proc.on('error', (err) => {
      console.error(`[exit-train:${safePhrase}] spawn error: ${err.message}`);
      syncServer._send(ws, { type: 'exit_training_result', ok: false, error: err.message });
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        const errMsg = `exit training process exited ${code}`;
        console.error(`[exit-train:${safePhrase}] ${errMsg}`);
        const errResult = { type: 'exit_training_result', ok: false, error: errMsg };
        cacheExitResult(errResult);
        syncServer._send(ws, errResult);
        return;
      }
      if (!tflitePath) {
        const errMsg = 'no .tflite output found';
        console.error(`[exit-train:${safePhrase}] ${errMsg}`);
        const errResult = { type: 'exit_training_result', ok: false, error: errMsg };
        cacheExitResult(errResult);
        syncServer._send(ws, errResult);
        return;
      }
      console.log(`[exit-train:${safePhrase}] done -> ${tflitePath}`);
      const okResult = {
        type: 'exit_training_result',
        ok: true,
        tflitePath,
        warning: lastError,
      };
      cacheExitResult(okResult);
      syncServer._send(ws, okResult);
    });
  });

  // v3.6.0: send-word training request from the mobile.
  // Third in the wake/exit/send trio. The send word is
  // user-level (not per-companion) so we key the work
  // directory on the sanitised phrase. Same training
  // script, same PROGRESS:: / OUTPUT_TFLITE:: protocol,
  // separate message chain (`send_training_progress` /
  // `send_training_result` / `send_model_data`) so wake
  // and exit trainings don't collide when the user has
  // multiple in flight.
  //
  // Why a separate pipeline (vs reusing exit): the
  // desktop routing distinguishes by message type, and
  // using distinct types keeps the wake/exit/send models
  // from colliding when the user has multiple trainings
  // queued (e.g. they kick off a retrain of exit while a
  // send training is still in flight).
  syncServer.on('send_training_request', ({ ws, phrase, samples }) => {
    if (!syncServer) return;
    console.log(`[send-train] Mobile requested: phrase="${phrase}" samples=${samples?.length || 0}`);

    if (!Array.isArray(samples) || !samples.length) {
      syncServer._send(ws, { type: 'send_training_result', ok: false, error: 'no samples provided' });
      return;
    }
    for (const s of samples) {
      if (!s || !s.name || !s.data) {
        syncServer._send(ws, { type: 'send_training_result', ok: false, error: 'each sample needs {name, data}' });
        return;
      }
    }

    const scriptPath = path.join(__dirname, '..', 'scripts', 'train_wake_phrase.py');
    if (!fs.existsSync(scriptPath)) {
      syncServer._send(ws, { type: 'send_training_result', ok: false, error: `training script not found: ${scriptPath}` });
      return;
    }

    const safePhrase = phrase.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const workDir = path.join(os.homedir(), '.openclaw', 'cyberclaw', 'send-training', safePhrase);
    fs.mkdirSync(workDir, { recursive: true });
    const samplesDir = path.join(workDir, 'user_samples');
    fs.mkdirSync(samplesDir, { recursive: true });

    // Clear cached state from a previous train of the same phrase.
    lastSendResult = null;
    lastSendResultCompletedAt = 0;
    lastSendProgress = null;

    // Write the user samples.
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const safeName = s.name.replace(/[^a-zA-Z0-9._-]+/g, '_');
      const dst = path.join(samplesDir, `${i.toString().padStart(2, '0')}_${safeName}`);
      fs.writeFileSync(dst, Buffer.from(s.data, 'base64'));
    }

    const modelName = `send_${safePhrase}`;
    const outputDir = path.join(workDir, 'output');
    fs.mkdirSync(outputDir, { recursive: true });

    // Same args as wake / exit training — same script.
    const args = [
      scriptPath,
      '--name', modelName,
      '--samples-dir', samplesDir,
      '--output-dir', outputDir,
      '--n-samples', '10000',
      '--n-samples-val', '2000',
      '--epochs', '20',
    ];

    const proc = spawn('python3', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let tflitePath = null;
    let lastError = null;

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        if (line.startsWith('PROGRESS::')) {
          try {
            const payload = JSON.parse(line.slice('PROGRESS::'.length));
            const { type: _ignore, ...fields } = payload;
            setLastSendProgress(fields);
            if (syncServer) {
              syncServer._broadcast({ type: 'send_training_progress', ...fields });
            }
          } catch (_) {}
        } else if (line.startsWith('OUTPUT_TFLITE::')) {
          // v3.1.55: the .length suffix is mandatory —
          // `String.prototype.slice` accepts a string arg
          // but treats it as a number via Number(str),
          // which is NaN. slice(NaN) is slice(0), so the
          // marker wasn't being stripped and tflitePath
          // came out as the full "OUTPUT_TFLITE::<path>"
          // string. The not-absolute-path branch below
          // then re-prepended outputDir to the marker-
          // prefixed string, producing a doubled path
          // like "output/OUTPUT_TFLITE::/home/.../model.tflite"
          // that fs.existsSync could never find. v3.1.54
          // had this exact bug (Tobe's training run took
          // 40 min and the desktop reported a false
          // "tflite path does not exist" error). Wake and
          // exit handlers correctly use .length.
          tflitePath = line.slice('OUTPUT_TFLITE::'.length).trim();
        } else if (line.startsWith('OUTPUT_ONNX::')) {
          tflitePath = line.slice('OUTPUT_ONNX::'.length).trim();
          lastError = 'tflite conversion failed; ONNX only';
        } else if (line.trim()) {
          console.log(`[send-train:${safePhrase}] ${line.trim()}`);
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      console.error(`[send-train:${safePhrase}] stderr: ${chunk.toString().trim()}`);
    });

    proc.on('error', (err) => {
      console.error(`[send-train:${safePhrase}] spawn error: ${err.message}`);
      syncServer._send(ws, { type: 'send_training_result', ok: false, error: err.message });
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        const errMsg = `send training process exited ${code}`;
        console.error(`[send-train:${safePhrase}] ${errMsg}`);
        const errResult = { type: 'send_training_result', ok: false, error: errMsg };
        cacheSendResult(errResult);
        syncServer._send(ws, errResult);
        return;
      }
      if (!tflitePath) {
        const errMsg = 'no .tflite output found';
        console.error(`[send-train:${safePhrase}] ${errMsg}`);
        const errResult = { type: 'send_training_result', ok: false, error: errMsg };
        cacheSendResult(errResult);
        syncServer._send(ws, errResult);
        return;
      }
      // The python script emits an absolute path (verified —
      // it's the result of Path(...).resolve() at script
      // boot). Sanity-check it exists before sending it to
      // the mobile — fs.existsSync catches the case where
      // the script's print line was missed (chunked across
      // a stdout buffer boundary) and tflitePath stayed null.
      if (!fs.existsSync(tflitePath)) {
        const errMsg = `tflite path does not exist after training: ${tflitePath}`;
        console.error(`[send-train:${safePhrase}] ${errMsg}`);
        const errResult = { type: 'send_training_result', ok: false, error: errMsg };
        cacheSendResult(errResult);
        syncServer._send(ws, errResult);
        return;
      }
      console.log(`[send-train:${safePhrase}] done -> ${tflitePath}`);
      const okResult = {
        type: 'send_training_result',
        ok: true,
        tflitePath,
        warning: lastError,
      };
      cacheSendResult(okResult);
      syncServer._send(ws, okResult);
    });
  });

  // v3.9.0: trainer manager (wake). The desktop's
  // ~/.openclaw/cyberclaw/wake-training/ tree is the
  // canonical backup of every .tflite the mobile ever
  // trained. The mobile's WakeSetManagerScreen queries
  // this list so the user can pull an old training
  // back to the device (e.g. after a phone wipe), and
  // pushes new trainings back as an extra backup.
  //
  // The send / exit versions of this trio will ship in
  // v3.9.1 / v3.9.2 alongside the corresponding
  // SetListScreen variants.
  const fs = require('fs');

  syncServer.on('list_wake_sets_from_desktop', ({ ws }) => {
    if (!syncServer) return;
    try {
      const wakeRoot = path.join(os.homedir(), '.openclaw', 'cyberclaw', 'wake-training');
      const sets = [];
      if (fs.existsSync(wakeRoot)) {
        for (const agentDir of fs.readdirSync(wakeRoot)) {
          const agentPath = path.join(wakeRoot, agentDir);
          if (!fs.statSync(agentPath).isDirectory()) continue;
          // Each agent's tree: <agentId>/output/model/<name>.tflite
          // (the python script writes the .tflite under output/model/).
          const modelRoot = path.join(agentPath, 'output', 'model');
          if (!fs.existsSync(modelRoot)) continue;
          for (const modelFile of fs.readdirSync(modelRoot)) {
            if (!modelFile.endsWith('.tflite')) continue;
            const fullPath = path.join(modelRoot, modelFile);
            const stat = fs.statSync(fullPath);
            sets.push({
              setId: `${agentDir}/${modelFile.replace(/\.tflite$/, '')}`,
              agentId: agentDir,
              phrase: modelFile.replace(/\.tflite$/, ''),
              sourcePath: fullPath,
              sizeBytes: stat.size,
              modifiedAt: stat.mtimeMs,
            });
          }
        }
      }
      console.log(`[wake-mgr] Listed ${sets.length} cached wake set(s) from desktop`);
      syncServer._send(ws, { type: 'wake_sets_list', sets });
    } catch (e) {
      console.error(`[wake-mgr] list_wake_sets failed: ${e.message}`);
      syncServer._send(ws, { type: 'wake_sets_list', sets: [], error: e.message });
    }
  });

  syncServer.on('import_wake_set_from_desktop', async ({ ws, setId, sourcePath }) => {
    if (!syncServer) return;
    try {
      if (!fs.existsSync(sourcePath)) {
        return syncServer._send(ws, { type: 'wake_set_imported', ok: false, error: `source not found: ${sourcePath}`, setId });
      }
      const bytes = fs.readFileSync(sourcePath);
      const base64 = bytes.toString('base64');
      console.log(`[wake-mgr] Imported wake set ${setId} (${bytes.length} bytes)`);
      syncServer._send(ws, {
        type: 'wake_set_imported',
        ok: true,
        setId,
        base64,
        sizeBytes: bytes.length,
      });
    } catch (e) {
      console.error(`[wake-mgr] import_wake_set failed: ${e.message}`);
      syncServer._send(ws, { type: 'wake_set_imported', ok: false, error: e.message, setId });
    }
  });

  syncServer.on('export_wake_set_to_desktop', async ({ ws, setId, base64, phrase }) => {
    if (!syncServer) return;
    try {
      const safePhrase = phrase.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      // Mirror the python script's output layout:
      //   ~/.openclaw/cyberclaw/wake-training/<agentId>/output/model/<name>.tflite
      // We don't have an agentId here (just a setId), so we
      // extract it from the setId (format: <agentId>/<phrase>)
      // or fall back to "imported" if the shape is wrong.
      const slashIdx = setId.indexOf('/');
      const agentDir = slashIdx > 0 ? setId.slice(0, slashIdx) : 'imported';
      const outDir = path.join(os.homedir(), '.openclaw', 'cyberclaw', 'wake-training', agentDir, 'output', 'model');
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, `${safePhrase || 'imported'}.tflite`);
      fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
      console.log(`[wake-mgr] Exported wake set ${setId} -> ${outPath}`);
      syncServer._send(ws, { type: 'wake_set_exported', ok: true, setId, savedPath: outPath });
    } catch (e) {
      console.error(`[wake-mgr] export_wake_set failed: ${e.message}`);
      syncServer._send(ws, { type: 'wake_set_exported', ok: false, error: e.message, setId });
    }
  });

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

ipcMain.handle('sync-broadcast-chat', async (e, { agentId, agentName, text, isUser }) => {
  console.log('[IPC] sync-broadcast-chat received:', { agentId, agentName, text: text.substring(0, 100), isUser });
  const wsState = syncServer?._voiceReplyWs ? `OPEN(${syncServer._voiceReplyWs.readyState})` : 'NULL';
  console.log('[IPC] _voiceReplyWs state:', wsState);
  discordLog('📡', 'Chat broadcast', `isUser=${isUser} voiceWs=${wsState}`);
  if (syncServer) {
    syncServer.broadcastChatMessage(agentId, text, isUser, agentName);
    console.log('[IPC] Message broadcast to mobile clients');
  }
  // If this AI reply follows a voice input, synthesize TTS and send audio back
  if (!isUser && syncServer && syncServer._voiceReplyWs) {
    const ws = syncServer._voiceReplyWs;
    syncServer._voiceReplyWs = null;
    const cleanText = stripMarkdownForTTS(stripEmojisForTTS(text));
    
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

// v3.1.15: broadcast the full list of agents so the mobile can mirror
// the desktop arena (one companion per agent). Each entry has the
// fields needed to render the sprite: id, name, sprite (companionId),
// scale.
ipcMain.handle('sync-broadcast-agents-list', (e, { agents }) => {
  console.log('[IPC] sync-broadcast-agents-list received:', agents?.length, 'agents:', agents?.map(a => a.id).join(','));
  if (syncServer) syncServer.broadcastAgentsList(agents);
});

// v3.1.95: broadcast the full list of quests so the mobile can
// mirror the desktop's quest panel. Same pattern as
// sync-broadcast-agents-list: the renderer reads quests.json and
// sends the array here, we forward it to every connected mobile
// via sync-server.broadcastQuestsList. Quests are global (not
// per-companion) on the desktop, so we don't include a companionId
// in the payload.
ipcMain.handle('sync-broadcast-quests-list', (e, { quests } = {}) => {
  console.log('[IPC] sync-broadcast-quests-list received:', quests?.length, 'quest(s)');
  if (syncServer) syncServer.broadcastQuestsList(quests || []);
});

ipcMain.handle('sync-send-chat-history', (e, { messages }) => {
  if (!syncServer || !syncServer._pendingHistoryWs) return;
  const pending = syncServer._pendingHistoryWs.splice(0);
  for (const ws of pending) {
    syncServer.sendChatHistory(ws, messages);
  }
});

// v3.1.17: per-agent chat history for the mobile companion tab bar.
ipcMain.handle('sync-send-agent-history', (e, { agentId, messages }) => {
  if (!syncServer || !syncServer._pendingAgentHistoryWs) return;
  // Drain the FIFO of ws requests for this specific agent
  const pending = syncServer._pendingAgentHistoryWs.filter(p => p.agentId === agentId);
  syncServer._pendingAgentHistoryWs = syncServer._pendingAgentHistoryWs.filter(p => p.agentId !== agentId);
  for (const p of pending) {
    syncServer.sendAgentHistory(p.ws, agentId, messages);
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
