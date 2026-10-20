/* ============================================================
   CyberClaw — Main application logic
   ============================================================ */

const { Terminal } = require('xterm');
const path = require('path');

// Pixel arena instance (shared 2D scene)
let pixelArena = null;
let currentCompanionId = 'boar'; // Track current companion globally
// v3.2.56 (renderer): the merge logic now lives in main.js
// (it has access to pendingAttachments + the buffered text).
// The renderer just receives either `mobile-chat` (text-only,
// main.js already decided no attachments are queued) or
// `mobile-chat-with-attachments` (combined, sent atomically).
// The renderer-side 600ms hold from v3.2.55 wasn't enough
// because the desktop's 700ms attachment-flush timer fires
// AFTER the renderer's hold expired (Tobe 2026-08-03 09:23
// confirmed the split-turn still happened). Main.js is the
// only layer that can see both halves of the merge.
const { FitAddon } = require('xterm-addon-fit');
const { WebLinksAddon } = require('xterm-addon-web-links');

// ---------------------------------------------------------------------------
// Model name formatting
// ---------------------------------------------------------------------------

// Lookup the catalog `icon` for a given pixel sprite id.
function getSpriteIcon(pixelId) {
  if (!pixelId) return null;
  try {
    const catalog = loadPixelCatalog();
    const sprite = (catalog.companions || []).find(c => c.id === pixelId);
    return sprite?.icon || null;
  } catch (e) {
    return null;
  }
}

// Returns the relative path to the sprite icon SVG (Twemoji-style).
function getSpriteIconFile(pixelId) {
  if (!pixelId) return null;
  try {
    const catalog = loadPixelCatalog();
    const sprite = (catalog.companions || []).find(c => c.id === pixelId);
    return sprite?.iconFile || null;
  } catch (e) {
    return null;
  }
}

// Returns the iconFile contents as a base64 data URI so the mobile (React Native) can render it via <Image source={{ uri: dataUri }}>.

// Convert an avatar value to a data URI suitable for the mobile.
let _avatarCache = new Map(); // path -> { dataUri, mtimeMs }
function getAvatarDataUri(avatar) {
  if (!avatar) return null;
  if (typeof avatar === 'string' && avatar.startsWith('data:')) return avatar;
  // Resolve ~ to the user home. The desktop's openclaw config
  // uses ~/workspace paths from the IDENTITY.md read.
  let resolved = avatar;
  if (typeof avatar === 'string' && avatar.startsWith('~')) {
    try {
      const _os = require('os');
      resolved = _path.join(_os.homedir(), avatar.slice(1));
    } catch { return null; }
  }
  try {
    const _fs2 = require('fs');
    let stat;
    try { stat = _fs2.statSync(resolved); } catch { return null; }
    if (!stat.isFile()) return null;
    // Cache hit if mtime matches (file hasn't changed).
    const cached = _avatarCache.get(resolved);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.dataUri;
    }
    const buf = _fs2.readFileSync(resolved);
    const b64 = buf.toString('base64');
    // PNG signature sniff.
    let mime = 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8) mime = 'image/jpeg';
    else if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) mime = 'image/webp';
    else if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) mime = 'image/gif';
    const dataUri = `data:${mime};base64,${b64}`;
    _avatarCache.set(resolved, { dataUri, mtimeMs: stat.mtimeMs, size: stat.size });
    return dataUri;
  } catch {
    return null;
  }
}

function getSpriteIconDataUri(pixelId) {
  const f = getSpriteIconFile(pixelId);
  if (!f) return null;
  try {
    // Resolve relative to project root (same candidates as loadPixelCatalog)
    const candidates = [];
    if (window._assetsDir) candidates.push(_path.join(window._assetsDir, '..', f));
    if (typeof __dirname === 'string' && __dirname) {
      candidates.push(_path.join(__dirname, '..', f));
      candidates.push(_path.join(__dirname, f));
    }
    if (typeof process !== 'undefined' && process.cwd) {
      candidates.push(_path.join(process.cwd(), f));
    }
    for (const p of candidates) {
      try {
        const content = _fs.readFileSync(p, 'utf-8');
        const b64 = Buffer.from(content, 'utf-8').toString('base64');
        return `data:image/svg+xml;base64,${b64}`;
      } catch (_) { /* try next */ }
    }
    return null;
  } catch (e) {
    return null;
  }
}

function formatModelName(modelId) {
  if (!modelId) return 'Unknown';
  const parts = modelId.split('/');
  const name = parts[parts.length - 1];
  // Refreshed for the new catalog.
  const pretty = {
    // Anthropic
    'claude-opus-4-8': 'Claude Opus 4.8',
    'claude-opus-4-6': 'Claude Opus 4.6',
    'claude-sonnet-4-6': 'Claude Sonnet 4.6',
    'claude-haiku-3.5': 'Claude Haiku 3.5',
    'claude-3-5-sonnet-20241022': 'Claude 3.5 Sonnet',
    'claude-3-5-haiku-20241022': 'Claude 3.5 Haiku',
    // OpenAI
    'gpt-5.5': 'GPT-5.5',
    'gpt-5.4': 'GPT-5.4',
    'gpt-5.4-mini': 'GPT-5.4 Mini',
    'gpt-5-mini': 'GPT-5 Mini',
    'gpt-4o': 'GPT-4o',
    'gpt-4o-mini': 'GPT-4o Mini',
    // Google
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
    'gemini-2.5-flash': 'Gemini 2.5 Flash',
    'gemini-3-flash-preview': 'Gemini 3 Flash Preview',
    'gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview',
    // MiniMax
    'MiniMax-M3': 'MiniMax M3',
    'MiniMax-M2.7': 'MiniMax M2.7',
    // OpenRouter
    'auto': 'OpenRouter (auto)',
    // Ollama
    'llama3': 'Llama 3',
    'llama3.1': 'Llama 3.1',
    'llama3.2': 'Llama 3.2',
    'mistral': 'Mistral',
    'codellama': 'CodeLlama',
    'qwen2.5-coder': 'Qwen 2.5 Coder',
    'qwen2.5:7b': 'Qwen 2.5 7B',
    'qwen2.5:14b': 'Qwen 2.5 14B',
    'llama3.3': 'Llama 3.3',
    'deepseek-r1': 'DeepSeek R1',
  };
  return pretty[name] || name.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function updateModelArrow(agent) {
  const primaryRow = document.getElementById('inspect-model-primary');
  const fallbackRow = document.getElementById('inspect-model-fallback');
  if (!primaryRow) return;

  const isFallback = agent.activeModel && agent.activeModel !== agent.primaryModel;
  primaryRow.classList.toggle('model-active', !isFallback);
  if (fallbackRow) fallbackRow.classList.toggle('model-active', !!isFallback);
}

// ---------------------------------------------------------------------------
// Agent data — populated from OpenClaw at runtime
// ---------------------------------------------------------------------------
let agentOrder = [];
let agents = {};
let focusIndex = 0;
let terminalExpanded = false;
let mainTerminal = null, mainFit = null;
let startTime = Date.now();

// Rarity assignment based on role/binding (v3.1.3: no more "legendary
// leader" tier — first agent is now a plain rare/epic like the others).
function assignRarity(agent, index) {
  if (agent.channel !== 'None') return 'epic';
  if (agent.status === 'online') return 'rare';
  if (agent.sessionCount > 0) return 'uncommon';
  return 'common';
}

// Default RPG stats (can be made dynamic later)
function defaultStats(rarity) {
  switch (rarity) {
    case 'legendary': return { hp: [100,100], mp: [85,100], xp: [1250,4000], level: 42 };
    case 'epic':      return { hp: [100,100], mp: [70,100], xp: [800,3000], level: 15 };
    case 'rare':      return { hp: [100,100], mp: [60,100], xp: [400,2000], level: 8 };
    case 'uncommon':  return { hp: [100,100], mp: [50,100], xp: [100,1000], level: 3 };
    default:          return { hp: [100,100], mp: [100,100], xp: [0,1000], level: 1 };
  }
}

// Skills detection (from workspace skills availability)
const defaultSkills = ['Coding Agent', 'Weather', 'Healthcheck', 'Skill Creator'];

// Skill taxonomy — single source of truth for the renderer.
// v3.6.7: skills earned from what the companion actually does (tool activity,
// all channels incl. Discord). Strategy → Analysis; Game/General removed; Ops added.
const SKILL_DEFS = [
  { name: 'Building',      icon: '🔧' },
  { name: 'Ops',           icon: '🖥️' },
  { name: 'Research',      icon: '🔍' },
  { name: 'Analysis',      icon: '📊' },
  { name: 'Writing',       icon: '✍️' },
  { name: 'Design',        icon: '🎨' },
  { name: 'Communication', icon: '💬' },
];

async function loadAgents() {
  try {
    const result = await cyberclaw.agents.discover();
    if (!result || !result.agents || result.agents.length === 0) {
      console.warn('No agents discovered, using fallback');
      return;
    }

    agentOrder = [];
    agents = {};

    // Filter out unbound agents with no workspace (like "main") v3.3.2: only skip the generic default placeholder paths.
    const isDefaultWorkspace = (ws) => !ws || ws === '~/workspace' || /\/workspace$/.test(ws);
    const filtered = result.agents.filter(a => {
      if (a.id === 'main') return false; // OpenClaw default stub — always skip
      if (a.channel !== 'None') return true; // has a binding
      if (a.workspace && !isDefaultWorkspace(a.workspace)) return true;
      return false; // unbound + default workspace = skip
    });

    // Sort: by name.
    const sorted = filtered.sort((a, b) => a.name.localeCompare(b.name));

    sorted.forEach((a, i) => {
      const rarity = assignRarity(a, i);
      const stats = defaultStats(rarity);

      // Clean up class label — remove generic "Agent" suffix
      const cleanClass = (a.class || '')
        .replace(/^\(?\s*Agent\s*\)?\s*$/i, '')  // just "Agent" or "(Agent)"
        .replace(/\s*\(Agent\)\s*/i, '')          // "Something (Agent)"
        .replace(/\s*- Agent\s*/i, '')            // "Something - Agent"
        .replace(/^Companion$/i, '')
        .trim();

      // Parse model info from config
      const primaryModel = a.primaryModel || 'anthropic/claude-opus-4-6';
      const fallbacks = a.fallbackModels || [];
      const modelDisplay = formatModelName(primaryModel);
      const providerDisplay = primaryModel.split('/')[0] || 'Anthropic';

      agents[a.id] = {
        name: a.name,
        class: cleanClass,
        id: a.id,
        avatar: a.avatar,
        emoji: a.emoji || '🤖',
        rarity,
        model: modelDisplay,
        provider: providerDisplay.charAt(0).toUpperCase() + providerDisplay.slice(1),
        primaryModel,
        fallbackModels: fallbacks,
        activeModel: primaryModel, // will be updated dynamically
        workspace: a.workspace,
        channel: a.channel,
        channelBadge: a.channelBadge,
        channelIcon: a.channelIcon,
        channelDetail: a.channelDetail,
        level: stats.level,
        hp: stats.hp,
        mp: stats.mp,
        xp: stats.xp,
        status: a.status,
        isMain: false, // legacy field, kept false (no leader concept in v3.1.3+)
        sleepState: 'awake', // 'awake' or 'sleeping' — toggled manually or auto on chat
        bootTs: Date.now(), // for auto-sleep-on-inactivity
        lastInteractionTs: Date.now(), // reset by bumpCompanionInteraction()
        skills: defaultSkills,
      };
      agentOrder.push(a.id);
    });

    // Load saved sprite configs (custom names, focus skills, quest assignments)
    for (const id of agentOrder) {
      try {
        const cfg = await cyberclaw.agents.getSpriteConfig(id);
        if (cfg) {
          if (cfg.customName) agents[id].name = cfg.customName;
          if (cfg.focusSkills) agents[id].focusSkills = cfg.focusSkills;
          if (cfg.traits) agents[id].traits = cfg.traits;
          if (cfg.primaryModel) {
            agents[id].primaryModel = cfg.primaryModel;
            agents[id].model = formatModelName(cfg.primaryModel);
          }
          if (cfg.secondaryModel) agents[id].secondaryModel = cfg.secondaryModel;
          // v3.2.26: hydrate chattiness from sprite config. Default 3
          // (= balanced, matches the v3.1.3 baseline) when missing.
          const ch = parseInt(cfg.chattiness, 10);
          if (ch >= 1 && ch <= 5) agents[id].chattiness = ch;
          else if (agents[id].chattiness == null) agents[id].chattiness = 3;
          // Support both legacy single assignedQuest and new assignedQuests array
          if (cfg.assignedQuests) agents[id].assignedQuests = cfg.assignedQuests;
          else if (cfg.assignedQuest) agents[id].assignedQuests = [cfg.assignedQuest];
          // Set _pixelCompanionId at load time so the chat tab icon lookup (which reads agent._pixelCompanionId) works even if initArenaCompanions…
          if (cfg.pixelCompanionId) {
            agents[id]._pixelCompanionId = cfg.pixelCompanionId;
          }
        }
      } catch {}
    }

    // Add subagent runs as temporary entries
    if (result.subagents && Array.isArray(result.subagents)) {
      result.subagents.forEach((run, i) => {
        if (run.status === 'running' || run.status === 'pending') {
          const subId = `subagent-${i}`;
          agents[subId] = {
            name: run.label || `Sub-Agent ${i+1}`,
            class: 'Sub-Agent',
            id: subId,
            avatar: null,
            emoji: '⚡',
            rarity: 'uncommon',
            model: run.model ? formatModelName(run.model) : 'Claude Opus 4',
            provider: run.model ? run.model.split('/')[0]?.charAt(0).toUpperCase() + run.model.split('/')[0]?.slice(1) : 'Anthropic',
            primaryModel: run.model || 'anthropic/claude-opus-4-6',
            fallbackModels: [],
            activeModel: run.model || 'anthropic/claude-opus-4-6',
            workspace: run.workspace || '—',
            channel: 'Internal',
            channelBadge: 'none',
            channelIcon: '🔄',
            channelDetail: 'Background task',
            level: 1,
            hp: [100,100], mp: [100,100], xp: [0,1000],
            status: run.status === 'running' ? 'online' : 'idle',
            isMain: false,
            skills: [],
          };
          agentOrder.push(subId);
        }
      });
    }
  } catch (err) {
    console.error('Agent discovery failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Shared 2D Pixel Arena — Companions
// ---------------------------------------------------------------------------
function buildCarousel() {
  // Dispose old arena (treats survive via window._arenaTreats)
  if (pixelArena) { pixelArena.dispose(); pixelArena = null; }

  const container = document.getElementById('pixel-arena-container');
  if (!container) return;
  container.innerHTML = '';

  // Create shared pixel arena
  pixelArena = new PixelArena(container);
  window.pixelArena = pixelArena; // expose globally for feed/bubble system

  // Setup drop zone on container (only once — container survives rebuilds)
  if (typeof setupArenaDrop === 'function') setupArenaDrop(); // no-op after first call

  // Restore background
  applyBackground(currentBgId);

  // Wire click-to-select
  pixelArena.onSelect = (agentId) => {
    const idx = agentOrder.indexOf(agentId);
    if (idx >= 0) {
      focusIndex = idx;
      updateCarousel();
    }
  };

  // Populate companions
  initArenaCompanions();
  updateCarousel();
}

async function initArenaCompanions() {
  if (!pixelArena) { debugLog('[Arena] ERROR: No pixelArena!'); return; }
  debugLog('[Arena] initArenaCompanions called, agents: ' + agentOrder.join(', '));

  const catalog = loadPixelCatalog();
  const defaultCompanions = catalog.companions || [];

  // Every non-hidden companion is rendered in the arena.
  const MAX_ARENA_COMPANIONS = 6;
  const visibleOrder = [
    ...(activeChatAgentId && !hiddenCompanions.has(activeChatAgentId) ? [activeChatAgentId] : []),
    ...agentOrder.filter(id =>
      id !== activeChatAgentId && !hiddenCompanions.has(id)
    ),
  ].slice(0, MAX_ARENA_COMPANIONS);
  const primaryId = visibleOrder[0] || null;
  window.leaderId = primaryId; // legacy field name; still used by mobile sync etc.

  debugLog(`[Arena] ${visibleOrder.length} visible companion(s), catalog size: ${defaultCompanions.length}`);

  for (let i = 0; i < visibleOrder.length; i++) {
    const id = visibleOrder[i];
    const agent = agents[id];
    if (!agent) continue;
    let pixelId = null;
    let savedScale = null;
    try {
      const config = await cyberclaw.agents.getSpriteConfig(id);
      pixelId = config?.pixelCompanionId;
      // v3.1.6: read the saved size too so the arena sprite matches
      // what the user picked in the forge.
      if (config && typeof config.scale === 'number') {
        savedScale = config.scale;
        agent._pixelCompanionScale = savedScale;
      }
    } catch (e) { debugLog('[Arena] ERROR ' + id + ' config: ' + e.message); }

    if (!pixelId && defaultCompanions.length > 0) {
      pixelId = defaultCompanions[i % defaultCompanions.length].id;
      // Persist the default sprite.
      try {
        const prev = await cyberclaw.agents.getSpriteConfig(id);
        await cyberclaw.agents.saveSpriteConfig(id, { ...(prev || {}), pixelCompanionId: pixelId });
      } catch (e) { debugLog('[Arena] could not persist default sprite for ' + id + ': ' + e.message); }
    }

    if (!pixelId) { debugLog('[Arena] WARN: No pixelId for ' + id); continue; }

    agent._pixelCompanionId = pixelId;
    try {
      // Add ALL visible companions; the pixelArena positions them in
      // even slots across the width. The first one (the active chat
      // companion, if visible) becomes the "primary" (this.companion).
      await pixelArena.addCompanion(id, pixelId, agent.name, savedScale);
      // Apply the saved sleep state to the sprite we just added.
      const added = pixelArena.companions.find(c => c.id === id);
      if (added) added.sleepState = agent.sleepState || 'awake';
      debugLog('[Arena] Companion added: ' + agent.name + ' (' + pixelId + ', scale=' + (savedScale || 5) + ')');
    } catch (e) { debugLog('[Arena] ERROR add companion for ' + id + ': ' + e.message + '\n' + e.stack); }
  }
  // Set the legacy "selected companion" for currentCompanionId / mobile sync
  if (primaryId && agents[primaryId]?._pixelCompanionId) {
    currentCompanionId = agents[primaryId]._pixelCompanionId;
    localStorage.setItem('cyberclaw-selected-companion', currentCompanionId);
  }
  debugLog('[Arena] Init complete. Companions in arena: ' + pixelArena.companions.length);

  // v3.4.1: the channel tabs are first rendered before the arena
  // has resolved each companion's sprite. Re-render now so every
  // tab gets its sprite icon (🦊 / 🐗 / ...).
  try { renderCompanionChannelTabs(); } catch (e) { debugLog('[Arena] tab re-render failed: ' + e.message); }

  broadcastAgentsListToMobile();
}

// Factored out so saveCompanion (and other code that mutates the agent list) can re-broadcast the mobile list without duplicating the…
async function broadcastAgentsListToMobile() {
  try {
    // Reuse the same visibleOrder construction as
    // initArenaCompanions: active chat companion first, then
    // the rest, minus hidden ones.
    const order = [
      ...(activeChatAgentId && !hiddenCompanions.has(activeChatAgentId) ? [activeChatAgentId] : []),
      ...agentOrder.filter(id =>
        id !== activeChatAgentId && !hiddenCompanions.has(id)
      ),
    ];
    const mobileList = (await Promise.all(order.map(async id => {
      const a = agents[id];
      if (!a) return null;
      // Read the full sprite config so the mobile can hydrate its Personalize screen with the same values the desktop has.
      let spriteConfig = null;
      try {
        spriteConfig = await cyberclaw.agents.getSpriteConfig(id);
      } catch (_) { /* ignore */ }
      return {
        id: a.id,
        name: a.name,
        sprite: a._pixelCompanionId || null,
        scale: a._pixelCompanionScale || null,
        // Distinguish "user explicitly set an emoji" from "no user-set emoji, fell back to the desktop's 🤖 default".
        emoji: a.emoji === '🤖' ? null : (a.emoji || null),
        // The sprite catalog icon is a separate concept from the user's per-agent emoji override.
        icon: getSpriteIcon(a._pixelCompanionId) || null,
        // v3.1.26: also send iconFile for the Twemoji SVG so
        // the mobile can render the bundled SVG instead of
        // relying on the system emoji font.
        iconFile: getSpriteIconFile(a._pixelCompanionId),
        // v3.1.29: also send the SVG as a base64 data URI so
        // React Native's <Image> can render it without needing
        // to resolve a relative file path from the broadcast.
        iconDataUri: getSpriteIconDataUri(a._pixelCompanionId),
        // The actual pixel-art sprite (not the Twemoji SVG).
        avatar: getAvatarDataUri(a.avatar),
        // Include sleepState so the mobile arena can render a sleeping-sprite visual (CSS grayscale + dim) when the desktop considers the companion…
        sleepState: a.sleepState || 'awake',
        // Chattiness scale (1–5).
        chattiness: typeof a.chattiness === 'number' ? a.chattiness : 3,
        // The full sprite config (traits, scale, pixelCompanionId, models, customName, focusSkills).
        spriteConfig: spriteConfig || null,
        // Companion skill XP + levels (the same data the desktop inspect panel renders).
        skills: await cyberclaw.agents.getStats(id).catch(() => ({ level: 1, xp: 0, xpTotal: 0, skills: {} })),
      };
    }))).filter(Boolean);
    if (mobileList.length > 0) {
      ipcRenderer.invoke('sync-broadcast-agents-list', { agents: mobileList });
    }
  } catch (e) {
    debugLog('[Arena] broadcast agents list failed: ' + e.message);
  }
}

// Camera view render loop — renders a cropped arena view into inspect panel
function startCameraLoop() {
  const cam = document.getElementById('inspect-camera');
  if (!cam) return;
  function renderCamera() {
    if (pixelArena && window._inspectAgentId) {
      const agent = agents[window._inspectAgentId];
      const zoom = 1.2; // (v3.1.3: no leader/non-leader distinction in camera zoom)
      pixelArena.renderCameraView(cam, window._inspectAgentId, zoom);
    }
    requestAnimationFrame(renderCamera);
  }
  requestAnimationFrame(renderCamera);
}

// ---------------------------------------------------------------------------
// Background selector
// ---------------------------------------------------------------------------
const BACKGROUNDS = [
  { id: 'meadow', label: 'Summer Meadow', file: 'pixel_landscape_1.png', horizon: 0.30, season: 'summer', vibe: 'a warm sunny meadow full of flowers' },
  { id: 'forest', label: 'Dark Forest', file: 'pixel_landscape_2.png', horizon: 0.63, /* v3.4.3: was 0.55 — feet reached the tree line */ season: 'autumn', vibe: 'a dark mysterious forest, feels like autumn' },
  { id: 'grove', label: 'Forest Edge', file: 'pixel_landscape_3.png', horizon: 0.30, season: 'spring', vibe: 'a peaceful forest edge in spring' },
];

let currentBgId = 'forest'; // default

function applyBackground(bgId, react) {
  const bg = BACKGROUNDS.find(b => b.id === bgId);
  if (!bg || !pixelArena) return;
  const isChange = currentBgId && currentBgId !== bgId;
  currentBgId = bgId;
  const bgPath = path.join(__dirname, 'assets', 'backgrounds', bg.file);
  pixelArena.setBackground(bgPath);
  pixelArena.horizonLine = bg.horizon || 0.5;
  localStorage.setItem('cyberclaw-arena-bg', bgId);
  // Update bg name label
  var bgLabel = document.getElementById('arena-bg-label');
  if (bgLabel) bgLabel.textContent = bg.label;

  // React to background change (not on initial load)
  if (isChange && react !== false) {
    setTimeout(function() {
      promptCompanionReaction('The scenery just changed to ' + bg.vibe + '. Comment on the new surroundings in 1 sentence.');
    }, 500);
  }
}

function loadSavedBackground() {
  const saved = localStorage.getItem('cyberclaw-arena-bg') || currentBgId;
  applyBackground(saved);
}

window.openBgSelector = function() {
  const overlay = document.getElementById('bg-selector-overlay');
  overlay.classList.remove('hidden');

  const grid = document.getElementById('bg-grid');
  grid.innerHTML = '';

  for (const bg of BACKGROUNDS) {
    const card = document.createElement('div');
    card.className = `bg-card${bg.id === currentBgId ? ' selected' : ''}`;
    
    const imgPath = path.join(__dirname, 'assets', 'backgrounds', bg.file);
    card.innerHTML = `<img src="file://${imgPath}" alt="${bg.label}"><div class="bg-card-label">${bg.label}</div>`;
    
    card.addEventListener('click', () => {
      applyBackground(bg.id);
      grid.querySelectorAll('.bg-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
    });
    
    grid.appendChild(card);
  }
};

window.closeBgSelector = function(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('bg-selector-overlay').classList.add('hidden');
};

// ---------------------------------------------------------------------------
// Arena Settings — background picker + companion show/hide
// ---------------------------------------------------------------------------
window.openArenaSettings = function() {
  const overlay = document.getElementById('arena-settings-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  // Populate background grid
  const bgGrid = document.getElementById('arena-settings-bg-grid');
  if (bgGrid) {
    bgGrid.innerHTML = '';
    for (const bg of BACKGROUNDS) {
      const card = document.createElement('div');
      card.className = `bg-card${bg.id === currentBgId ? ' selected' : ''}`;
      const imgPath = path.join(__dirname, 'assets', 'backgrounds', bg.file);
      card.innerHTML = `<img src="file://${imgPath}" alt="${escHtml(bg.label)}"><div class="bg-card-label">${escHtml(bg.label)}</div>`;
      card.addEventListener('click', () => {
        applyBackground(bg.id);
        bgGrid.querySelectorAll('.bg-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
      });
      bgGrid.appendChild(card);
    }
  }
  // Populate companion show/hide list
  renderArenaSettingsCompanions();
};

window.closeArenaSettings = function(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('arena-settings-overlay').classList.add('hidden');
};

function renderArenaSettingsCompanions() {
  const wrap = document.getElementById('arena-settings-companions');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!agentOrder.length) {
    wrap.innerHTML = '<div style="color:var(--text-muted);font-size:10px;padding:4px 0;">No companions yet.</div>';
    return;
  }
  for (const id of agentOrder) {
    const agent = agents[id];
    if (!agent) continue;
    const hidden = hiddenCompanions.has(id);

    const row = document.createElement('label');
    row.className = 'arena-companion-row' + (hidden ? ' hidden-from-arena' : '');

    // Avatar
    const avatar = document.createElement('span');
    avatar.className = 'arena-companion-avatar';
    if (agent.avatar && String(agent.avatar).startsWith('data:')) {
      avatar.innerHTML = `<img src="${escAttr(agent.avatar)}" alt="${escAttr(agent.name)}">`;
    } else {
      // Prefer per-agent emoji, fall back to sprite icon from the catalog so the avatar matches the sprite.
      avatar.textContent = (agent.emoji && agent.emoji !== '🤖') ? agent.emoji : (getSpriteIcon(agent._pixelCompanionId) || '🤖');
    }
    row.appendChild(avatar);

    // Info
    const info = document.createElement('div');
    info.className = 'arena-companion-info';
    const name = document.createElement('div');
    name.className = 'arena-companion-name';
    name.textContent = agent.name;
    const cls = document.createElement('div');
    cls.className = 'arena-companion-class';
    cls.textContent = agent.class || agent.id;
    info.appendChild(name);
    info.appendChild(cls);
    row.appendChild(info);

    // Toggle — v3.1.3: every companion can be hidden, no leader exemption
    const lbl = document.createElement('span');
    lbl.className = 'arena-companion-toggle';
    lbl.title = 'Show / hide in the arena';
    const sw = document.createElement('span');
    sw.className = 'toggle-switch' + (!hidden ? ' on' : '');
    const lblText = document.createElement('span');
    lblText.textContent = !hidden ? 'shown' : 'hidden';
    lbl.appendChild(sw);
    lbl.appendChild(lblText);
    sw.style.cursor = 'pointer';
    lbl.style.cursor = 'pointer';
    const toggle = () => {
      if (hiddenCompanions.has(id)) {
        hiddenCompanions.delete(id);
        sw.classList.add('on');
        lblText.textContent = 'shown';
        row.classList.remove('hidden-from-arena');
      } else {
        hiddenCompanions.add(id);
        sw.classList.remove('on');
        lblText.textContent = 'hidden';
        row.classList.add('hidden-from-arena');
      }
      applyCompanionVisibility();
    };
    lbl.addEventListener('click', (e) => { e.preventDefault(); toggle(); });
    row.appendChild(lbl);
    wrap.appendChild(row);
  }
}

// Apply the current hiddenCompanions set to the pixelArena.
async function applyCompanionVisibility() {
  if (!pixelArena) return;
  // Remove companions that are now hidden
  for (const c of [...pixelArena.companions]) {
    if (hiddenCompanions.has(c.id)) pixelArena.removeCompanion(c.id);
  }
  // Add companions that are now visible v3.1.18: cap the arena at 6.
  const MAX_ARENA_COMPANIONS = 6;
  let arenaSlotsUsed = pixelArena.companions.length;
  for (const id of agentOrder) {
    if (hiddenCompanions.has(id)) continue;
    if (pixelArena.companions.find(c => c.id === id)) continue;
    // Active chat companion is always allowed, even over the cap.
    const isActiveChat = id === activeChatAgentId;
    if (!isActiveChat && arenaSlotsUsed >= MAX_ARENA_COMPANIONS) {
      debugLog(`[Arena] Skipping add for ${id} — arena cap of ${MAX_ARENA_COMPANIONS} reached`);
      continue;
    }
    const agent = agents[id];
    if (!agent) continue;
    let pixelId = agent._pixelCompanionId;
    let savedScale = agent._pixelCompanionScale;
    if (!pixelId) {
      const cfg = await cyberclaw.agents.getSpriteConfig(id).catch(() => null);
      pixelId = cfg?.pixelCompanionId;
      if (!savedScale && cfg && typeof cfg.scale === 'number') {
        savedScale = cfg.scale;
        agent._pixelCompanionScale = savedScale;
      }
    }
    if (!pixelId) {
      const cat = loadPixelCatalog();
      const def = cat.companions?.[0]?.id;
      if (def) pixelId = def;
    }
    if (!pixelId) continue;
    await pixelArena.addCompanion(id, pixelId, agent.name, savedScale);
    arenaSlotsUsed++;
    const added = pixelArena.companions.find(c => c.id === id);
    if (added) added.sleepState = agent.sleepState || 'awake';
  }
  try { localStorage.setItem('cyberclaw-hidden-companions', JSON.stringify([...hiddenCompanions])); } catch {}
}

// Manual sleep / wake toggle for the currently-focused companion.
window.toggleCompanionSleep = function() {
  const id = agentOrder[focusIndex] || pickCurrentCompanionId();
  if (!id) return;
  const agent = agents[id];
  if (!agent) return;
  if (agent.sleepState === 'sleeping') {
    agent.sleepState = 'awake';
    // Wake the arena sprite if this is the one currently shown.
    // The _updateCompanion loop checks comp.sleepState; we just need to
    // clear it and reset velocity so the sprite doesn't keep drifting.
    if (pixelArena && pixelArena.companion && pixelArena.companion.id === id) {
      pixelArena.companion.sleepState = 'awake';
      pixelArena.companion.vx = 0;
      pixelArena.companion.vy = 0;
      pixelArena.companion.frame = 0;
      pixelArena.companion.animation = 'idle';
    }
    // Nudge the night-wake timer too.
    nudgeNightWake();
    addChatMsg('system', `☀️ ${agent.name} woke up`);
  } else {
    agent.sleepState = 'sleeping';
    if (pixelArena && pixelArena.companion && pixelArena.companion.id === id) {
      pixelArena.companion.sleepState = 'sleeping';
      pixelArena.companion.vx = 0;
      pixelArena.companion.vy = 0;
    }
    addChatMsg('system', `💤 ${agent.name} is sleeping`);
  }
  // Refresh the inspect panel and the channel header
  if (window._inspectAgentId === id) updateInspect(id);
  if (activeChatAgentId === id) updateChatHeader(id);
  // Refresh the green-dot online indicator on every channel tab — the toggled companion is not necessarily the active chat companion, and the…
  refreshChannelTabsOnlineState();
  bumpCompanionInteraction(id); // v3.1.4: manual toggle counts as interaction
  // v3.10.3: push the new sleepState to the mobile via the
  // agents_list broadcast. The mobile renders a sleeping
  // sprite (CSS filter + overlay dim) when sleepState is
  // 'sleeping', and the user expectation (Tobe's v3.10.42
  // report) is that the phone shows the same awake/asleep
  // state as the desktop. Without this rebroadcast, the
  // mobile stays on the stale agents_list until the next
  // periodic broadcast (rare).
  try { broadcastAgentsListToMobile(); } catch (_) {}
};

// Pop-out companion window via Electron BrowserWindow
let arenaExpanded = false;
window.toggleArenaExpand = function() {
  arenaExpanded = !arenaExpanded;
  const app = document.getElementById('app');
  const left = document.getElementById('panel-left');
  const right = document.getElementById('panel-right');
  const btn = document.getElementById('arena-expand-btn');

  const terminal = document.getElementById('terminal-strip');

  if (arenaExpanded) {
    app.classList.add('arena-expanded');
    left.style.display = 'none';
    right.style.display = 'none';
    terminal.style.display = 'none';
    btn.title = 'Collapse arena';
  } else {
    app.classList.remove('arena-expanded');
    left.style.display = '';
    right.style.display = '';
    terminal.style.display = '';
    btn.title = 'Expand arena';
  }

  // Resize the arena canvas to fill available space
  if (pixelArena) {
    setTimeout(() => pixelArena.resize(), 50);
  }
};

function updateCarousel() {
  if (agentOrder.length === 0) return;

  // Update focused agent strip + right panel
  const focusedId = agentOrder[focusIndex];
  bumpCompanionInteraction(focusedId); // v3.1.4: count focus change as interaction
  updateFocused(focusedId);
  updateInspect(focusedId);
  updateChatTarget();

  // Switching the carousel also switches the chat channel so the user is
  // always talking to the currently-focused companion.
  if (focusedId && focusedId !== activeChatAgentId) {
    switchActiveChat(focusedId);
  } else {
    // Just refresh the channel tabs (e.g. avatar may have updated)
    renderCompanionChannelTabs();
  }
}

window.carouselNext = function() {
  focusIndex = (focusIndex + 1) % agentOrder.length;
  updateCarousel();
};

window.carouselPrev = function() {
  focusIndex = (focusIndex - 1 + agentOrder.length) % agentOrder.length;
  updateCarousel();
};

document.addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft') { window.carouselPrev(); e.preventDefault(); }
  if (e.key === 'ArrowRight') { window.carouselNext(); e.preventDefault(); }
});

// ---------------------------------------------------------------------------
// Focused agent (no-op — old strip removed, inspect panel handles everything)
function updateFocused(agentId) {
  // Just updates the carousel nameplate if it exists
  const nameEl = document.getElementById('carousel-name');
  if (nameEl) nameEl.textContent = agents[agentId]?.name || '';
  const classEl = document.getElementById('carousel-class');
  if (classEl) classEl.textContent = agents[agentId]?.class || '';
}

// ---------------------------------------------------------------------------
// Inspect panel (shows focused/selected companion)
// ---------------------------------------------------------------------------
function updateInspect(agentId) {
  const agent = agents[agentId];
  if (!agent) return;
  // Wrap the whole body in try/catch so any internal error doesn't take down the renderer's chat pipeline.
  try {

  // v3.1.4: the type badge was removed (every companion is just a
  // Companion; the badge was redundant noise).


  // Camera view — track the currently inspected agent ID for the render loop
  window._inspectAgentId = agentId;

  // (v3.1.3: the inspect-equipment-section was removed; the new
  // "Skills" section has its own #inspect-skills-section.)

  document.getElementById('inspect-name').textContent = agent.name;
  document.getElementById('inspect-name').className = `${agent.rarity}-text`;
  document.getElementById('inspect-class').textContent = agent.class;
  document.getElementById('inspect-id').textContent = agent.id;

  const statusEl = document.getElementById('inspect-status');
  // v3.1.3: status reflects the manual sleep/wake toggle, not the openclaw status.
  const sleeping = agent.sleepState === 'sleeping';
  statusEl.innerHTML = `<span class="status-dot ${sleeping ? 'sleeping' : 'online'}"></span> ${sleeping ? 'Sleeping' : 'Online'}`;

  // Sleep/wake button text + state
  const sleepBtn = document.getElementById('inspect-sleep-btn');
  if (sleepBtn) {
    sleepBtn.textContent = sleeping ? '☀️ Wake' : '💤 Sleep';
    sleepBtn.classList.toggle('is-sleeping', sleeping);
    sleepBtn.title = sleeping ? `Wake ${agent.name} up` : `Put ${agent.name} to sleep`;
  }

  // Channel info (bottom section)
  const platformEl = document.getElementById('inspect-channel-platform');
  if (platformEl) platformEl.innerHTML = `<span class="channel-badge ${agent.channelBadge}">${agent.channelIcon} ${agent.channelDetail}</span>`;
  const wsRight = document.getElementById('inspect-workspace-right');
  if (wsRight) { wsRight.textContent = agent.workspace; wsRight.title = agent.workspace; }

  // Focuses section
  const focusesEl = document.getElementById('inspect-focuses');
  const focusSection = document.getElementById('inspect-focuses-section');
  if (focusesEl && focusSection) {
    const focuses = agent.focusSkills || [];
    if (focuses.length > 0) {
      focusSection.style.display = '';
      focusesEl.innerHTML = focuses.map(f =>
        `<span class="focus-tag">${f}</span>`
      ).join('');
    } else {
      focusSection.style.display = 'none';
    }
  }

  // Load earned stats + rate limit HP
  cyberclaw.agents.getStats(agentId).then(async (stats) => {
    const xpNeeded = Math.floor(100 * Math.pow(1.8, stats.level - 1));

    // HP = rate limit health (green=unlimited/healthy, red=low)
    let hpCur = 100, hpMax = 100, isLocal = false;
    try {
      const resp = await fetch('http://localhost:18789/v1/models', {
        headers: { 'Authorization': 'Bearer ' + (window._gwToken || '') },
        signal: AbortSignal.timeout(3000),
      });
      const remaining = resp.headers.get('x-ratelimit-remaining-requests')
        || resp.headers.get('anthropic-ratelimit-requests-remaining');
      const limit = resp.headers.get('x-ratelimit-limit-requests')
        || resp.headers.get('anthropic-ratelimit-requests-limit');
      if (remaining && limit) {
        hpCur = parseInt(remaining);
        hpMax = parseInt(limit);
      } else {
        isLocal = true; // No rate limit headers = likely local/unlimited
      }
    } catch { isLocal = true; }

    setBar('inspect-hp', [hpCur, hpMax]);
    // Color the HP bar based on health
    const hpFill = document.getElementById('inspect-hp');
    if (hpFill) {
      const pct = hpCur / hpMax;
      if (isLocal) {
        hpFill.style.background = 'linear-gradient(90deg, #39ff14, #4ade80)'; // green = unlimited
      } else if (pct > 0.5) {
        hpFill.style.background = 'linear-gradient(90deg, #4ade80, #22c55e)'; // green
      } else if (pct > 0.2) {
        hpFill.style.background = 'linear-gradient(90deg, #ffaa00, #ff6b35)'; // orange
      } else {
        hpFill.style.background = 'linear-gradient(90deg, #ff4444, #cc0000)'; // red
      }
    }

    // Detect if fallback model is likely active (rate limit exhausted)
    if (!isLocal && hpCur === 0 && agent.fallbackModels?.length) {
      agent.activeModel = agent.fallbackModels[0];
    } else {
      agent.activeModel = agent.primaryModel;
    }
    // Update arrow indicator after rate limit check
    updateModelArrow(agent);

    setBar('inspect-mp', agent.mp);
    setBar('inspect-xp', [stats.xp, xpNeeded]);

    // Show level
    const levelEl = document.getElementById('inspect-level');
    if (levelEl) levelEl.textContent = `Lv.${stats.level}`;

    // Skill list — all companions show their full skill set
    const skillsEl = document.getElementById('inspect-skills');
    // v3.2.84: use the shared SKILL_DEFS so the renderer can't drift
    // from main.js's classifier. Was 9 inline defs with a different
    // "Coding" name + 💻 icon.
    const allSkillDefs = SKILL_DEFS;

    const displaySkills = allSkillDefs;

    const skills = stats.skills || {};
    if (displaySkills.length === 0) {
      skillsEl.innerHTML = '<div style="color:var(--text-muted);font-size:9px;padding:2px">No specializations assigned</div>';
    } else {
      skillsEl.innerHTML = displaySkills.map(s => {
        const sk = skills[s.name] || { level: 1, xp: 0 };
        const xpNeeded = Math.floor(100 * Math.pow(1.8, sk.level - 1)); // same curve as main.js
        const pct = Math.min(100, (sk.xp / xpNeeded) * 100);
        return `<div class="rs-skill-row">
          <span class="rs-skill-icon">${s.icon}</span>
          <span class="rs-skill-name">${s.name}</span>
          <span class="rs-skill-level">${sk.level}</span>
          <div class="rs-skill-bar"><div class="rs-skill-fill" style="width:${pct}%"></div></div>
        </div>`;
      }).join('');
    }
    // v3.3.0: per-companion enabled-skills toggles
    refreshInspectEnabledSkills(agentId);
  });

  // Model stack — primary + fallback rows
  const primaryRow = document.getElementById('inspect-model-primary');
  const fallbackRow = document.getElementById('inspect-model-fallback');
  document.getElementById('inspect-model-name').textContent = agent.model;
  document.getElementById('inspect-provider').textContent = agent.provider;

  // Show secondary model (from forge) or fallback model (from discovery)
  var secondary = agent.secondaryModel || (agent.fallbackModels?.length ? agent.fallbackModels[0] : '');
  if (secondary) {
    const fbProvider = secondary.split('/')[0] || '?';
    document.getElementById('inspect-fallback-name').textContent = formatModelName(secondary);
    document.getElementById('inspect-fallback-provider').textContent = fbProvider.charAt(0).toUpperCase() + fbProvider.slice(1);
    fallbackRow.style.display = '';
  } else {
    fallbackRow.style.display = 'none';
  }

  // Arrow shows which is active (updated after rate limit check below)
  updateModelArrow(agent);

  loadEquipment(agentId);
  const chEl = document.getElementById('inspect-channel');
  if (chEl) chEl.textContent = agent.channel;
  const wsEl = document.getElementById('inspect-workspace');
  if (wsEl) { wsEl.textContent = agent.workspace; wsEl.title = agent.workspace; }
  } catch (e) {
    // Log instead of throwing so a render bug doesn't take down the chat pipeline or the agents_list broadcast (which the mobile arena needs to…
    try { console.warn('[updateInspect] suppressed error:', e?.message); } catch (_) {}
  }
}

function setBar(id, [cur, max]) {
  const bar = document.getElementById(id);
  if (bar) {
    bar.style.width = `${(cur / max) * 100}%`;
    const v = document.getElementById(id + '-val');
    if (v) v.textContent = `${cur.toLocaleString()}/${max.toLocaleString()}`;
  }
}

window.openDoctor = function() {
  cyberclaw.agents.openDoctor();
};

// --------------------------------------------------------------------------- Quest Management…
let activeQuestId = null;
// Single setter for activeQuestId.
let _casualFromQuestId = null;
function setActiveQuestId(newId) {
  const prev = activeQuestId;
  activeQuestId = newId || null;
  if (activeQuestId) _casualFromQuestId = null;
  // Auto-jump the chat panel to the new quest's bucket.
  if (prev !== activeQuestId) {
    try { window.switchActiveChatQuest(activeQuestId); } catch (e) { console.warn('[Quests] switchActiveChatQuest failed:', e?.message); }
    // Also refresh the centered quest toggle pill above the chat input.
    try { updateChatQuestToggle(); } catch (e) { console.warn('[setActiveQuestId->toggle] suppressed:', e?.message); }
  }
  return prev;
}
// Pre-warm the quest-instructions cache when a quest becomes active.
const questInstructionsPreheat = new Map();
// Helper: pull the current active quest id from the quest list
// without going through disk. Falls back to the in-memory cache
// if the list is empty.
function getActiveQuestId(quests) {
  const found = quests?.find(q => q.active);
  if (found) setActiveQuestId(found.id);
  return activeQuestId;
}
// Build the chat context for the active quest.
async function buildActiveQuestContext(quest) {
  if (!quest) return '';
  let ctx = `[Active Quest: "${quest.name}"`;
  if (quest.description) ctx += ` — ${quest.description}`;
  if (quest.directory) ctx += ` | Project dir: ${quest.directory}`;
  const goals = normalizeGoals(quest.goals);
  if (goals.length > 0) {
    const incomplete = goals.filter(g => !g.completed);
    if (incomplete.length > 0) {
      ctx += ` | Incomplete goals: ${incomplete.map(g => g.text).join('; ')}`;
    } else {
      ctx += ` | All ${goals.length} goal(s) completed`;
    }
  }
  const changes = Array.isArray(quest.latestChanges) ? quest.latestChanges : [];
  if (changes.length > 0) {
    const recent = changes.slice(-5);
    const now = Date.now();
    const fmtAgo = (iso) => {
      const t = new Date(iso).getTime();
      if (isNaN(t)) return '';
      const diff = Math.max(0, now - t);
      const min = Math.floor(diff / 60000);
      if (min < 1) return 'just now';
      if (min < 60) return `${min}m ago`;
      const hr = Math.floor(min / 60);
      if (hr < 24) return `${hr}h ago`;
      const d = Math.floor(hr / 24);
      return `${d}d ago`;
    };
    const items = recent.map(c => `${c.text} (${fmtAgo(c.timestamp)})`).join('; ');
    ctx += ` | Recent changes: ${items}`;
  }
  // Teach the agent about the quest-edit tags when there's an active quest.
  ctx += ` | Tools: [CREATE_QUEST: name="..." desc="..." dir="optional/path"] [QUEST_APPEND_CHANGE: text="..."] [QUEST_NOTE: text="..."] [QUEST_MARK_GOAL: index="N" done="true|false"] [QUEST_SET_ACTIVE: id="<id-or-name>"]`;
  // ALWAYS pair tool tags with a chat-visible reply.
  ctx += ` | [QUEST_SUMMARY: text=\"...\"] rewrites this quest's SUMMARY.md (current state, next steps, open problems) — do it after a work session or a milestone, keep it short | [QUEST_DECISION: text=\"...\"] records one settled decision in DECISIONS.md — never contradict a listed decision without asking`;
  ctx += ` | IMPORTANT: tags alone are silent in the user's chat — always pair a tag with a normal chat-visible reply (or a short "logged." ack).`;
  ctx += `] `;

  // Per-quest instructions file.
  if (!quest._questInstructionsCache) quest._questInstructionsCache = {};
  const cached = quest._questInstructionsCache[quest.id];
  if (cached !== undefined) {
    if (cached.content) {
      ctx += `\n[Quest instructions at ${cached.path}]\n${cached.content}\n[/Quest instructions] `;
    }
  } else {
    // BuildActiveQuestContext is now async so we can await the read.
    const preheat = questInstructionsPreheat.get(quest.id);
    try {
      // Await the preheat if it's still pending; if it's
      // already resolved, this is a no-op await. Either
      // way, the cache is filled before we read it.
      if (preheat) {
        await preheat;
        questInstructionsPreheat.delete(quest.id);
      }
      // Re-check the cache — the preheat may have just
      // populated it. If not, do the read now.
      const afterPreheat = quest._questInstructionsCache[quest.id];
      if (afterPreheat !== undefined) {
        if (afterPreheat.content) {
          ctx += `\n[Quest instructions at ${afterPreheat.path}]\n${afterPreheat.content}\n[/Quest instructions] `;
        }
      } else {
        const res = await cyberclaw.quests.readQuestInstructions(quest.id);
        if (res && res.ok) {
          quest._questInstructionsCache[quest.id] = { content: res.content, path: res.path };
          if (res.content) {
            ctx += `\n[Quest instructions at ${res.path}]\n${res.content}\n[/Quest instructions] `;
          }
        } else {
          quest._questInstructionsCache[quest.id] = { content: '', path: null };
        }
      }
    } catch (e) {
      quest._questInstructionsCache[quest.id] = { content: '', path: null };
    }
  }

  // Per-quest conversation log.
  try {
    const mem = await cyberclaw.quests.readQuestMemory(quest.id);
    if (mem && mem.ok) {
      const body = (t) => String(t || '').replace(/^#.*$/m, '').replace(/^_.*_$/gm, '').trim();
      const sum = body(mem.summary.content);
      if (sum && sum !== '(nothing yet)') ctx += `\n[Quest summary — ${mem.summary.path}]\n${sum.slice(0, 4000)}\n[/Quest summary] `;
      const dec = body(mem.decisions.content).split('\n').filter(l => l.trim()).slice(-60).join('\n');
      if (dec) ctx += `\n[Settled decisions — ${mem.decisions.path}]\n${dec.slice(-4000)}\n[/Settled decisions] `;
    }
  } catch (e) { console.warn('[quest-memory] read failed:', e && e.message); }

  const CONVERSATION_LOG_CONTEXT_INJECT = 8;
  const CONVERSATION_LOG_LINE_CHARS = 300;
  if (Array.isArray(quest.conversationLog) && quest.conversationLog.length > 0) {
    const recent = quest.conversationLog
      .filter(e => e && typeof e.text === 'string' && e.role)
      .slice(-CONVERSATION_LOG_CONTEXT_INJECT);
    if (recent.length > 0) {
      ctx += '\n[Recent conversation on this quest]\n';
      for (const entry of recent) {
        const label = entry.role === 'user' ? 'You' : (entry.agentName || 'Companion');
        let line = entry.text;
        if (line.length > CONVERSATION_LOG_LINE_CHARS) {
          line = line.slice(0, CONVERSATION_LOG_LINE_CHARS - 1) + '…';
        }
        ctx += `  ${label}: ${line}\n`;
      }
      ctx += '[/Recent conversation on this quest] ';
    }
  }

  return ctx;
}

// Standalone quest-tools hint.
function buildQuestToolsHint() {
  return '[Quest tools available — emit these tags in your reply when applicable: [CREATE_QUEST: name="..." desc="..." dir="optional/path"] to create a new quest, [QUEST_APPEND_CHANGE: text="..."] to log a change to the active quest, [QUEST_SUMMARY: text="..."] to rewrite the active quest\'s SUMMARY.md, [QUEST_DECISION: text="..."] to record a settled decision, [QUEST_NOTE: text="..."] to leave a note for yourself in the active quest\'s instructions file (project-specific knowledge that future turns should see), [QUEST_MARK_GOAL: index="N" done="true|false"] to toggle a goal on the active quest, [QUEST_SET_ACTIVE: id="<id-or-name>"] to switch the active quest. Tags are parsed by the desktop on every reply and the action is performed immediately.] ';
}

// Work-first reminder appended at the END of every user message.
function buildWorkFirstSuffix() {
  // Relaxed from "ONE specific question" — Tobe flagged the cap as too tight.
  return '[Action rule: do the work in this turn, then reply with the result. Only ask if you genuinely cannot proceed. A short list of clarifying questions is fine when each is a real blocker; default to acting on a stated assumption rather than asking. The user should see your reply when the work is done, not when you start.]';
}
// Strip any quest-tool tags from a reply before showing it in the chat.
function stripQuestTags(reply) {
  if (!reply) return reply;
  return reply
    // Each tag form. Match the [TAG_NAME: ...] chunk up
    // to the closing "]". The tag parsers below still run
    // on the unmodified reply.
    .replace(/\[CREATE_QUEST:[^\]]*\]/g, '')
    .replace(/\[QUEST_APPEND_CHANGE:[^\]]*\]/g, '')
    .replace(/\[QUEST_NOTE:[^\]]*\]/g, '')
    .replace(/\[QUEST_SUMMARY:[\s\S]*?"\]/g, '')
    .replace(/\[QUEST_DECISION:[^\]]*\]/g, '')
    .replace(/\[QUEST_MARK_GOAL:[^\]]*\]/g, '')
    .replace(/\[QUEST_SET_ACTIVE:[^\]]*\]/g, '')
    // [REMEMBER: text="..."] is the silent-log structured output (see promptCompanionSilent below).
    .replace(/\[REMEMBER:[^\]]*\]/g, '')
    // The full hint string the LLM occasionally echoes back.
    .replace(/\[Quest tools available[^\]]*\]/g, '')
    // Collapse leftover blank lines so a tag-alone line
    // doesn't leave a double blank behind.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Strip tool-call warning lines from agent reply text.
function stripToolWarnings(reply) {
  if (!reply) return reply;
  // Mirror OpenClaw's own sanitize regexes (see
  // ~/.npm-global/lib/node_modules/openclaw/dist/
  // sanitize-user-facing-text-*.js for kc and Ac).
  const toolHeaderLine = /^\s*(?:>\s*)?(?:⚠️\s*)?(?:📊|🛠️|📖|📝|🔍|🔎|⚙️)\s*(?:Session Status|Exec|Read|Edit|Write|Patch|Search|Open|Click|Find|Screenshot|Update Plan|Tool Call|Tool Result|Function Call|Shell|Command)\s*:.*$/i;
  const toolFailedLine = /^\s*(?:>\s*)?(?:⚠️\s*)?(?:🛠️|📝|📖|🔍|🔎|⚙️)\s+\S[\s\S]*\s+\(agent\)`{0,2}\s+failed(?:\s*:.*)?\s*$/i;
  return reply
    .split('\n')
    .filter((line) => !toolHeaderLine.test(line) && !toolFailedLine.test(line))
    .join('\n')
    // Collapse leftover blank lines from the strip
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// v3.2.69: combined stripper — quest tags + tool warnings.
// Most call sites want both, so wrap them together to keep
// call sites small and avoid forgetting either stripper.
function stripAgentReplyDecorations(reply) {
  return stripToolWarnings(stripQuestTags(reply));
}

// Helper: pull the current active quest id from the quest list
// without going through disk. Falls back to the in-memory cache
// if the list is empty.
function getActiveQuestId(quests) {
  const found = quests?.find(q => q.active);
  if (found) setActiveQuestId(found.id);
  return activeQuestId;
}

// Pull all [REMEMBER: text="..."] tags from an LLM reply and return them as a list of strings (without the tag wrappers).
function extractRememberTags(reply) {
  if (!reply) return [];
  const out = [];
  const re = /\[REMEMBER:\s*text="([^"]*)"\]/gi;
  let m;
  while ((m = re.exec(reply)) !== null) {
    const t = (m[1] || '').trim();
    if (t) out.push(t);
  }
  return out;
}

window.pickQuestDir = async function() {
  const dir = await cyberclaw.quests.pickDirectory();
  if (dir) document.getElementById('quest-dir-input').value = dir;
};

window.showQuestForm = function() {
  document.getElementById('quest-form').classList.remove('hidden');
  document.getElementById('quest-name-input').focus();
};

window.hideQuestForm = function() {
  document.getElementById('quest-form').classList.add('hidden');
  document.getElementById('quest-name-input').value = '';
  document.getElementById('quest-desc-input').value = '';
  document.getElementById('quest-dir-input').value = '';
};

// v3.4.1: Import quest — the button next to + in the Quest Log.
// Lists project folders that aren't quests yet (quests:scan-projects)
// with one-click Import, plus Browse… for any other folder.
window.showImportQuest = async function() {
  hideQuestForm();
  const picker = document.getElementById('quest-import-picker');
  const list = document.getElementById('quest-import-list');
  if (!picker || !list) return;
  picker.classList.remove('hidden');
  list.innerHTML = '<div class="quest-import-loading">Scanning projects…</div>';
  let projects = [];
  try { projects = await cyberclaw.quests.scanProjects(); } catch (e) {
    list.innerHTML = '<div class="quest-import-loading">Scan failed: ' + escapeHtml(e && e.message ? e.message : String(e)) + '</div>';
    return;
  }
  if (!projects || projects.length === 0) {
    list.innerHTML = '<div class="quest-import-loading">Every project folder is already a quest. Use Browse… to pick another folder.</div>';
    return;
  }
  list.innerHTML = '';
  for (const proj of projects) {
    const row = document.createElement('div');
    row.className = 'quest-import-row';
    row.title = proj.path;
    const nameEl = document.createElement('span');
    nameEl.className = 'quest-import-name';
    nameEl.textContent = proj.name;
    const btn = document.createElement('button');
    btn.className = 'quest-form-btn save';
    btn.textContent = 'Import';
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = '…';
      const ok = await importProjectAsQuest(proj);
      if (ok) { row.classList.add('imported'); btn.textContent = '✓'; }
      else { btn.disabled = false; btn.textContent = 'Import'; }
    };
    row.appendChild(nameEl);
    row.appendChild(btn);
    list.appendChild(row);
  }
};

window.hideImportQuest = function() {
  const picker = document.getElementById('quest-import-picker');
  if (picker) picker.classList.add('hidden');
};

window.importQuestFromFolder = async function() {
  const dir = await cyberclaw.quests.pickDirectory();
  if (!dir) return;
  const ok = await importProjectAsQuest({ name: path.basename(dir), path: dir });
  if (ok) showImportQuest();
};

async function importProjectAsQuest(project) {
  try {
    await cyberclaw.quests.create({
      name: project.name,
      // v3.4.3: no auto description — the 📁 line already shows the folder.
      description: '',
      directory: project.path,
    });
    await renderQuests();
    return true;
  } catch (e) {
    alert('Failed to import: ' + (e && e.message ? e.message : String(e)));
    return false;
  }
}

window.startQuestConversation = function() {
  // Switch to chat tab and send a system-prompted message to the companion
  switchTermTab('chat');
  var input = document.getElementById('chat-input');
  if (input) {
    input.value = 'I want to create a new quest! Help me figure out what it should be — ask me what I want to work on, then create it for me. When we agree on the quest, respond with exactly this format on its own line: [CREATE_QUEST: name="Quest Name" desc="Description" dir="optional/path"]'
    window.sendChat();
  }
};

window.createQuest = async function() {
  const name = document.getElementById('quest-name-input').value.trim();
  if (!name) return;
  const desc = document.getElementById('quest-desc-input').value.trim();
  const dir = document.getElementById('quest-dir-input').value.trim();
  // Forward the user's defaultQuestDir from cyberclaw-settings so main.js's auto-derive picks the same place the mobile suggests in its…
  let defaultQuestDir = '';
  try {
    const s = JSON.parse(localStorage.getItem('cyberclaw-settings') || '{}');
    defaultQuestDir = (s.defaultQuestDir || '').trim();
  } catch (_) {}
  await cyberclaw.quests.create({
    name,
    description: desc,
    directory: dir || undefined,
    defaultQuestDir: defaultQuestDir || undefined,
  });
  hideQuestForm();
  renderQuests();
};

window.toggleQuestStatus = async function(e, id) {
  e.stopPropagation();
  const quests = await cyberclaw.quests.list();
  const q = quests.find(q => q.id === id);
  if (!q) return;
  const newStatus = q.status === 'active' ? 'completed' : 'active';
  await cyberclaw.quests.update(id, { status: newStatus });
  renderQuests();
};

window.deleteQuest = async function(e, id) {
  e.stopPropagation();
  await cyberclaw.quests.delete(id);
  renderQuests();
};

// Toggle a quest as the active (working) one.
window.selectQuest = async function(el, questId) {
  const wasSelected = el.classList.contains('quest-selected');
  // Optimistic local update for instant feedback.
  document.querySelectorAll('.quest-item').forEach(q => q.classList.remove('quest-selected'));
  if (wasSelected) {
    // Deselect — clear active on all
    el.classList.remove('quest-selected');
    setActiveQuestId(null);
    try { await cyberclaw.quests.setActive(null); } catch (e) { console.warn('[Quests] setActive(null) failed:', e?.message); }
  } else {
    el.classList.add('quest-selected');
    setActiveQuestId(questId);
    try { await cyberclaw.quests.setActive(questId); } catch (e) { console.warn('[Quests] setActive failed:', e?.message); }
    // Pre-warm the quest-instructions cache so the first chat send after a quest switch sees the file content.
    const existing = questInstructionsPreheat.get(questId);
    if (!existing) {
      const preheat = cyberclaw.quests.readQuestInstructions(questId)
        .then((res) => {
          // Stash into the quest's cache.
          if (res && res.ok) {
            // We need the quest object to write to its
            // cache. list() is the canonical source.
            return cyberclaw.quests.list().then((quests) => {
              const q = quests.find(qq => qq.id === questId);
              if (q) {
                if (!q._questInstructionsCache) q._questInstructionsCache = {};
                q._questInstructionsCache[questId] = { content: res.content, path: res.path };
              }
            });
          }
        })
        .catch(() => { /* swallow — buildActiveQuestContext will retry */ });
      questInstructionsPreheat.set(questId, preheat);
    }
  }
  updateQuestIndicator();
  // Re-render to pull the canonical `active` flag from disk
  // (the IPC handler also broadcasts to mobile, so the next
  // renderQuests() will see the latest state).
  renderQuests();
};

// Normalize goals: accept string[] (legacy) or {text,completed}[]
function normalizeGoals(goals) {
  if (!Array.isArray(goals)) return [];
  return goals.map(g => typeof g === 'string' ? { text: g, completed: false } : g).filter(g => g.text && g.text.trim());
}

function getGoalProgress(q) {
  const goals = normalizeGoals(q.goals);
  if (goals.length === 0) return 0;
  const done = goals.filter(g => g.completed).length;
  return Math.round((done / goals.length) * 100);
}

function getGoalProgressText(q) {
  const goals = normalizeGoals(q.goals);
  if (goals.length === 0) return '0%';
  const done = goals.filter(g => g.completed).length;
  return `${done}/${goals.length}`;
}

function renderQuestGoals(q) {
  const goals = normalizeGoals(q.goals);
  if (goals.length === 0) return '';
  return `<div class="quest-goals-list">${goals.map((g, i) =>
    `<div class="quest-goal-item ${g.completed ? 'completed' : ''}" onclick="toggleGoal(event,'${q.id}',${i})">
      <span class="quest-goal-check">${g.completed ? '☑' : '☐'}</span>
      <span class="quest-goal-text">${escapeHtml(g.text)}</span>
    </div>`
  ).join('')}</div>`;
}

window.toggleGoal = async function(event, questId, goalIndex) {
  event.stopPropagation();
  const quests = await cyberclaw.quests.list();
  const quest = quests.find(q => q.id === questId);
  if (!quest) return;
  const goals = normalizeGoals(quest.goals);
  if (goalIndex >= goals.length) return;
  goals[goalIndex].completed = !goals[goalIndex].completed;
  await cyberclaw.quests.update(questId, { goals });
  renderQuests();
};

window.setQuestVersion = async function(e, id) {
  e.stopPropagation();
  const current = (await cyberclaw.quests.list()).find(q => q.id === id)?.version || '';
  const version = prompt('Enter current version (e.g. 0.1.2):', current);
  if (version !== null) {
    await cyberclaw.quests.update(id, { version: version.replace(/^v/, '') });
    renderQuests();
  }
};

window.setQuestDir = async function(e, id) {
  e.stopPropagation();
  const dir = await cyberclaw.quests.pickDirectory();
  if (dir) {
    const updates = { directory: dir };
    // Auto-detect version from package.json
    const ver = await cyberclaw.quests.detectVersion(dir);
    if (ver) updates.version = ver;
    await cyberclaw.quests.update(id, updates);
    renderQuests();
  }
};

function updateQuestIndicator() {
  const indicator = document.getElementById('chat-quest-indicator');
  if (!indicator) return;
  if (activeQuestId) {
    cyberclaw.quests.list().then(quests => {
      const q = quests.find(q => q.id === activeQuestId);
      if (q) {
        indicator.textContent = `📜 ${q.name}`;
        indicator.title = q.directory || '';
        indicator.style.display = '';
      }
    });
  } else {
    indicator.style.display = 'none';
  }
}

async function renderQuests() {
  const quests = await cyberclaw.quests.list();
  const list = document.getElementById('quest-list');
  const empty = document.getElementById('quest-empty');

  // Clear existing items (keep the empty div)
  list.querySelectorAll('.quest-item').forEach(el => el.remove());

  // Invalidate the per-quest instructions-file cache so the next chat send re-reads the file.
  for (const q of quests) q._questInstructionsCache = {};

  // Preheat the active quest's instructions-file cache on every render.
  const activeQuest = quests.find(q => q.active);
  if (activeQuest && !questInstructionsPreheat.has(activeQuest.id)) {
    const preheat = cyberclaw.quests.readQuestInstructions(activeQuest.id)
      .then((res) => {
        if (res && res.ok) {
          if (!activeQuest._questInstructionsCache) activeQuest._questInstructionsCache = {};
          activeQuest._questInstructionsCache[activeQuest.id] = { content: res.content, path: res.path };
        }
      })
      .catch(() => { /* swallow */ });
    questInstructionsPreheat.set(activeQuest.id, preheat);
  }

  if (!quests.length) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  // Active first, then completed v3.3.27: sort by the `active: true` flag first (the single quest currently in use), then by status (active…
  const sorted = [...quests].sort((a, b) => {
    // The currently-active quest goes to the very top.
    if (!!a.active && !b.active) return -1;
    if (!a.active && !!b.active) return 1;
    // Then active status ahead of completed.
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (a.status !== 'active' && b.status === 'active') return 1;
    return 0;
  });

  // Keep the in-memory activeQuestId in sync with the list's source of truth (`active: true` on the quest).
  { const aqId = quests.find(q => q.active)?.id || null;
    // v3.4.7: stay in casual view if the user toggled away from this same quest.
    if (aqId && aqId === _casualFromQuestId) updateChatQuestToggle(); else setActiveQuestId(aqId); }

  for (const q of sorted) {
    const isComplete = q.status === 'completed';
    const isActive = !!q.active;
    const div = document.createElement('div');
    // `quest-selected` is now driven by the quest's `active` flag, not the local in-memory cache.
    div.className = `quest-item ${isComplete ? 'completed-quest' : 'active-quest'} ${isActive ? 'quest-selected quest-is-active' : ''}`;
    div.onclick = () => selectQuest(div, q.id);
    const companionAvatars = ''; // Companion visuals are shown in the arena, not in the quest list

    // ⭐ button toggles the active flag.
    const activeBadge = isActive ? `<span class="quest-active-badge" title="This is the quest the companion is currently working on">⚡ ACTIVE</span>` : '';

    div.innerHTML = `
      <div class="quest-top-row">
        <div class="quest-name">${isComplete ? '✅' : '⚔️'} ${escapeHtml(q.name)}</div>
        <div class="quest-top-actions">
          ${activeBadge}
          <button class="quest-edit-btn" onclick="openQuestEditor(event,'${q.id}')" title="Edit">✏️</button>
          <button class="quest-delete" onclick="deleteQuest(event,'${q.id}')" title="Delete">✕</button>
        </div>
      </div>
      ${q.description ? `<div class="quest-desc" title="${escapeHtml(q.description)}">${escapeHtml(q.description)}</div>` : ''}
      ${renderQuestGoals(q)}
      ${companionAvatars}
      ${q.directory ? `<div class="quest-dir">📁 ${escapeHtml(q.directory.split('/').pop() || q.directory)}</div>` : ''}
      <div class="quest-progress">
        <div class="quest-bar"><div class="quest-fill" style="width:${getGoalProgress(q)}%;background:${getGoalProgress(q) >= 100 ? 'var(--green)' : 'linear-gradient(90deg, var(--green), var(--cyan))'}"></div></div>
        <span class="quest-pct">${getGoalProgressText(q)}</span>
      </div>
      <div class="quest-actions-row">
        <button class="quest-status-toggle" onclick="toggleQuestStatus(event,'${q.id}')">
          ${isComplete ? '↩ Reopen' : '🏁 Mark done'}
        </button>
        <button class="quest-instructions-btn" onclick="openQuestInstructionsEditor(event,'${q.id}')" title="Per-quest instructions file">📋 Instructions</button>
      </div>
    `;
    list.appendChild(div);
  }

  // Collapse the quest log to show only the active quest by default.
  const allItems = list.querySelectorAll('.quest-item');
  let activeCount = 0;
  let hiddenCount = 0;
  allItems.forEach(item => {
    if (item.classList.contains('quest-is-active')) {
      activeCount++;
    } else if (quests.length > 1) {
      // Collapse non-active quests when there's more than one.
      // Single-quest case: nothing to switch to, leave the
      // button hidden too.
      item.classList.add('quest-item-collapsed');
      hiddenCount++;
    }
  });
  // Remove any previous switcher button (re-renders).
  const existingSwitcher = document.getElementById('quest-switcher-btn');
  if (existingSwitcher) existingSwitcher.remove();
  if (hiddenCount > 0) {
    const switcher = document.createElement('button');
    switcher.id = 'quest-switcher-btn';
    switcher.className = 'quest-switcher-btn';
    switcher.innerHTML = `📜 Switch quest (${hiddenCount} more)`;
    switcher.title = 'Click to show all quests and switch the active one';
    switcher.onclick = () => {
      // Expand all collapsed quests and flip the button to
      // "Hide other quests".
      list.querySelectorAll('.quest-item-collapsed').forEach(item => {
        item.classList.remove('quest-item-collapsed');
      });
      switcher.innerHTML = '📜 Hide other quests';
      switcher.onclick = () => {
        // Re-collapse on second click.
        renderQuests();
      };
    };
    list.appendChild(switcher);
  }
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Load quests on startup v3.3.28: also seed cachedQuestsList on startup so the per-bubble quest header has a sync source to read from before…
(async () => {
  try {
    const list = await cyberclaw.quests.list();
    if (Array.isArray(list)) cachedQuestsList = list.slice();
  } catch (_) { /* defensive — cache stays empty if load fails */ }
  renderQuests();
  // Also render the centered quest toggle on initial load so it appears as soon as the page is ready.
  try { updateChatQuestToggle(); } catch (_) {}
})();
// v3.3.0: load skills library on startup
refreshSkillsList().then(() => {
  // Once the skill library is loaded, refresh the per-companion
  // toggle list (in case the inspect panel is already showing one)
  if (agentOrder[focusIndex]) refreshInspectEnabledSkills(agentOrder[focusIndex]);
}).catch(e => console.warn('[skills] initial load failed:', e.message));

// ---------------------------------------------------------------------------
// Quest Editor (transforms left panel into quest detail view)
// ---------------------------------------------------------------------------
let editingQuestId = null;

function buildGoalInputs(goals) {
  const items = normalizeGoals(goals);
  if (items.length === 0 || items[items.length - 1].text.trim() !== '') items.push({ text: '', completed: false });
  return items.map((g, i) =>
    `<div class="qe-goal-row">
      <span class="qe-goal-num">${i + 1}.</span>
      <input type="text" class="qe-goal-input" value="${escapeHtml(g.text)}" placeholder="Goal ${i + 1}..." oninput="onGoalInput()" />
    </div>`
  ).join('');
}

window.onGoalInput = function() {
  const container = document.getElementById('qe-goals-list');
  const inputs = container.querySelectorAll('.qe-goal-input');
  const last = inputs[inputs.length - 1];
  // Auto-add new row if last input has text
  if (last && last.value.trim() !== '') {
    const idx = inputs.length;
    const row = document.createElement('div');
    row.className = 'qe-goal-row';
    row.innerHTML = `<span class="qe-goal-num">${idx + 1}.</span><input type="text" class="qe-goal-input" value="" placeholder="Goal ${idx + 1}..." oninput="onGoalInput()" />`;
    container.appendChild(row);
  }
};

window.openQuestEditor = async function(event, questId) {
  if (event) event.stopPropagation();
  const quests = await cyberclaw.quests.list();
  const quest = quests.find(q => q.id === questId);
  if (!quest) return;

  editingQuestId = questId;
  const panel = document.getElementById('panel-left');

  // Load the quest instructions content for this quest so it can be edited inline in the quest editor.
  const questInstructionsRes = await cyberclaw.quests.readQuestInstructions(questId).catch(() => null);
  const questInstructionsContent = (questInstructionsRes && questInstructionsRes.ok) ? (questInstructionsRes.content || '') : '';
  const questInstructionsFilePath = (questInstructionsRes && questInstructionsRes.ok) ? (questInstructionsRes.path || '') : '<no path>';

  panel.innerHTML = `
    <div class="panel-header">
      <span class="rune-icon">📜</span> EDIT QUEST
      <button class="quest-add-btn" onclick="closeQuestEditor()" title="Back">✕</button>
    </div>
    <div class="qe-content">
      <div class="editor-field">
        <label>Quest Name</label>
        <input type="text" id="qe-name" value="${escapeHtml(quest.name)}" />
      </div>
      <div class="editor-field">
        <label>Description</label>
        <textarea id="qe-desc" rows="3">${escapeHtml(quest.description || '')}</textarea>
      </div>
      <div class="editor-field">
        <label>Goals (Priority Order)</label>
        <div id="qe-goals-list" class="qe-goals-list">
          ${buildGoalInputs(quest.goals || [])}
        </div>
      </div>
      <div class="editor-field">
        <label>Directory</label>
        <div class="quest-dir-row">
          <input type="text" id="qe-dir" value="${escapeHtml(quest.directory || '')}" readonly />
          <button class="quest-dir-btn" onclick="pickQuestEditorDir()">📁</button>
        </div>
      </div>
      <div class="editor-field">
        <label>📋 Quest instructions</label>
        <div class="qe-quest-instructions-hint">
          Per-quest instructions for the companion. Injected into the chat prompt as a separate context block when this quest is active. Use this to record "how to do tasks" for the project (e.g. "deploy via scp to the VPS", "edit files directly on the server", "always run tests first").
        </div>
        <textarea id="qe-quest-instructions" rows="12" class="qe-quest-instructions-textarea" placeholder="# Workflow for this quest&#10;&#10;## Deploy&#10;- scp dist/* user@vps:/var/www/&#10;- ssh user@vps 'systemctl restart nginx'&#10;&#10;## Build&#10;- npm run build&#10;- verify dist/index.html exists">${escapeHtml(questInstructionsContent)}</textarea>
        <div class="qe-quest-instructions-path">File: <code>${escapeHtml(questInstructionsFilePath)}</code></div>
      </div>
      <div class="qe-actions">
        <button class="btn-sm btn-muted" onclick="closeQuestEditor()">Cancel</button>
        <button class="btn-sm btn-primary" onclick="saveQuestEdit()">⚔️ Save</button>
      </div>
    </div>
  `;
};

window.pickQuestEditorDir = async function() {
  const dir = await cyberclaw.quests.pickDirectory();
  if (dir) document.getElementById('qe-dir').value = dir;
};

window.saveQuestEdit = async function() {
  if (!editingQuestId) return;

  const name = document.getElementById('qe-name').value.trim();
  const description = document.getElementById('qe-desc').value.trim();
  const goalInputs = document.querySelectorAll('#qe-goals-list .qe-goal-input');
  // Preserve completed state from existing goals
  const existingGoals = normalizeGoals((await cyberclaw.quests.list()).find(q => q.id === editingQuestId)?.goals);
  const goals = Array.from(goalInputs).map((inp, i) => {
    const text = inp.value.trim();
    if (!text) return null;
    return { text, completed: existingGoals[i]?.text === text ? (existingGoals[i]?.completed || false) : false };
  }).filter(Boolean);
  const directory = document.getElementById('qe-dir').value.trim();

  // Skills field removed from quest model entirely.

  // Update quest
  await cyberclaw.quests.update(editingQuestId, { name, description, goals, directory: directory || undefined });

  // Save the quest instructions file (if the editor has a qe-quest-instructions textarea — older editor versions don't, in which case skip).
  const questInstructionsTa = document.getElementById('qe-quest-instructions');
  if (questInstructionsTa) {
    const questInstructionsContent = questInstructionsTa.value;
    try {
      const res = await cyberclaw.quests.saveQuestInstructions(editingQuestId, questInstructionsContent);
      if (res && res.ok) {
        addEventMsg(`📋 Saved project instructions (${res.bytes} bytes) — ${res.path}`);
      } else {
        addEventMsg(`⚠️ Could not save quest instructions: ${res?.error || 'unknown error'}`);
      }
    } catch (e) {
      addEventMsg(`⚠️ Quest instructions save failed: ${e?.message || e}`);
    }
  }

  closeQuestEditor();
};

window.closeQuestEditor = function() {
  editingQuestId = null;
  // Rebuild the entire left panel
  rebuildLeftPanel();
  renderQuests();
};

// Per-quest instructions file editor.
window.openQuestInstructionsEditor = async function(event, questId) {
  if (event) event.stopPropagation();
  const res = await cyberclaw.quests.readQuestInstructions(questId);
  if (!res || !res.ok) {
    addEventMsg(`⚠️ Could not read project instructions file: ${res?.error || 'unknown error'}`);
    return;
  }

  // Build the modal as an overlay in the body (not the panel) so it sits on top of the entire UI.
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'quest-instructions-editor-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) closeQuestInstructionsEditor(); };

  const preview = res.path
    ? `File: <code>${escapeHtml(res.path)}</code>`
    : '<em>No file path resolved</em>';

  overlay.innerHTML = `
    <div class="modal-content" style="max-width:680px;width:90%;max-height:80vh;display:flex;flex-direction:column;">
      <div class="modal-header">
        <span class="modal-title">📋 Quest instructions</span>
        <button class="modal-close" onclick="closeQuestInstructionsEditor()">✕</button>
      </div>
      <div style="padding:8px 12px;font-size:11px;color:var(--text-muted);">
        Per-quest instructions for the companion when this quest is active.
        Markdown is fine. The content is injected into the chat prompt as a separate context block.
        ${preview}
      </div>
      <textarea id="quest-instructions-textarea" class="quest-instructions-textarea" placeholder="# Quest instructions for this quest&#10;&#10;Workflow / project instructions:&#10;- Never touch the dev DB&#10;- Use British English&#10;- Always run tests before committing"
        style="flex:1;min-height:300px;font-family:monospace;font-size:12px;padding:8px;background:#0a0a0a;color:#e0e0e0;border:1px solid #333;border-radius:4px;resize:vertical;">${escapeHtml(res.content || '')}</textarea>
      <div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end;padding:10px 12px;border-top:1px solid var(--border-dark);">
        <button class="btn-sm btn-muted" onclick="closeQuestInstructionsEditor()">Cancel</button>
        <button class="btn-sm btn-primary" id="quest-instructions-save-btn" onclick="saveQuestInstructionsFile('${questId}')">💾 Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  setTimeout(() => {
    const ta = document.getElementById('quest-instructions-textarea');
    if (ta) ta.focus();
  }, 50);
};

window.closeQuestInstructionsEditor = function() {
  const overlay = document.getElementById('quest-instructions-editor-overlay');
  if (overlay) overlay.remove();
};

window.saveQuestInstructionsFile = async function(questId) {
  const ta = document.getElementById('quest-instructions-textarea');
  const btn = document.getElementById('quest-instructions-save-btn');
  if (!ta) return;
  const content = ta.value;
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const res = await cyberclaw.quests.saveQuestInstructions(questId, content);
    if (!res || !res.ok) {
      addEventMsg(`⚠️ Could not save quest instructions: ${res?.error || 'unknown error'}`);
      if (btn) { btn.disabled = false; btn.textContent = '💾 Save'; }
      return;
    }
    addEventMsg(`📋 Saved project instructions (${res.bytes} bytes) — ${res.path}`);
    // Invalidate the in-memory cache so the next chat send re-reads the file.
    closeQuestInstructionsEditor();
  } catch (e) {
    addEventMsg(`⚠️ Quest instructions save failed: ${e?.message || e}`);
    if (btn) { btn.disabled = false; btn.textContent = '💾 Save'; }
  }
};

function rebuildLeftPanel() {
  const panel = document.getElementById('panel-left');
  panel.innerHTML = `
    <div class="panel-header">
      <span class="rune-icon">📜</span> QUEST LOG
      <button class="quest-add-btn" onclick="showQuestForm()" title="New Quest (manual)">+</button>
      <button class="quest-add-btn" onclick="startQuestConversation()" title="Create quest with companion">🗣️</button>
    </div>
    <div class="quest-form hidden" id="quest-form">
      <input type="text" id="quest-name-input" placeholder="Quest name..." maxlength="60" />
      <textarea id="quest-desc-input" placeholder="Description (optional)..." rows="2" maxlength="200"></textarea>
      <div class="quest-dir-row">
        <input type="text" id="quest-dir-input" placeholder="Project directory (optional)..." readonly />
        <button class="quest-dir-btn" onclick="pickQuestDir()">📁</button>
      </div>
      <div class="quest-form-actions">
        <button class="quest-form-btn save" onclick="createQuest()">Create</button>
        <button class="quest-form-btn cancel" onclick="hideQuestForm()">Cancel</button>
      </div>
    </div>
    <div class="quest-section" id="quest-list">
      <div class="quest-empty" id="quest-empty">
        <div style="text-align:center;padding:20px;color:var(--text-muted);font-size:11px">
          <div style="font-size:24px;margin-bottom:8px">📜</div>
          No quests yet.<br>Click + to create your first quest!
        </div>
      </div>
    </div>

    <div class="panel-header system-hdr">
      <span class="rune-icon">📡</span> SESSION
    </div>
    <div class="system-section">
      <div class="stat-row"><span class="stat-key">Messages</span><span class="stat-value" id="stat-messages">0</span></div>
      <div class="stat-row"><span class="stat-key">Cost</span><span class="stat-value gold-text" id="stat-cost">$0.00</span></div>
    </div>

    <div class="panel-header system-hdr">
      <span class="rune-icon">🖥️</span> SYSTEM
    </div>
    <div class="system-section">
      <div class="stat-row"><span class="stat-key">Host</span><span class="stat-value" id="stat-host">—</span></div>
      <div class="stat-row"><span class="stat-key">OS</span><span class="stat-value" id="stat-os">—</span></div>
      <div class="stat-row"><span class="stat-key">Node</span><span class="stat-value" id="stat-node">—</span></div>
      <div class="stat-row"><span class="stat-key">Gateway</span><span class="stat-value cyan-text" id="stat-gateway">—</span></div>
      <div class="stat-row"><span class="stat-key">Runtime</span><span class="stat-value" id="stat-runtime">00:00:00</span></div>
      <div class="stat-row"><span class="stat-key">Rate Limit</span><span class="stat-value" id="stat-ratelimit">—</span></div>
      <div class="system-actions">
        <button class="sys-btn" onclick="openDoctor()" title="Run OpenClaw Doctor">🩺 Doctor</button>
      </div>
    </div>
  `;
  // Re-populate system info
  updateSystemInfo();
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------
window.switchTermTab = function(tabName) {
  // System tabs (events / terminal / logs). The companion chat is
  // controlled separately via switchActiveChat.
  document.querySelectorAll('#system-tabs .term-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.term-view').forEach(v => v.classList.remove('active'));
  const tab = document.querySelector(`#system-tabs .term-tab[data-tab="${tabName}"]`);
  if (tab) tab.classList.add('active');
  const view = document.getElementById(`view-${tabName}`);
  if (view) view.classList.add('active');
  setTimeout(() => { mainFit?.fit(); }, 50);
};

// Switch the chat pane to a specific companion.
window.switchActiveChat = function(agentId) {
  if (!agentId) return;
  activeChatAgentId = agentId;
  lastReadTsByAgent[agentId] = Date.now();
  // Update the channel tabs' active highlight + clear unread
  document.querySelectorAll('.channel-tab-companion').forEach(t => {
    t.classList.toggle('active', t.dataset.agentId === agentId);
    if (t.dataset.agentId === agentId) t.classList.remove('has-unread');
  });
  // Show the chat view (in case a system view is active)
  document.querySelectorAll('#system-tabs .term-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.term-view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-chat').classList.add('active');
  // Update the chat header
  updateChatHeader(agentId);
  // Re-render the chat-messages container from the per-(agent,
  // quest) history.
  const msgs = document.getElementById('chat-messages');
  if (msgs) {
    msgs.innerHTML = '';
    // v3.4.1: keep the system-startup block pinned at the top.
    if (window._chatBootLog) msgs.appendChild(window._chatBootLog);
    const qk = questKeyForStorage(activeQuestId);
    const agentBuckets = chatHistoryByAgentAndQuest[agentId] || {};
    // Prefer the active quest's bucket.
    let hist = agentBuckets[qk] || [];
    if (qk !== DEFAULT_QUEST_KEY) {
      const fileHist = questFileHistoryFor(agentId, qk);
      if (fileHist === undefined) {
        loadQuestFileHistory(agentId, qk); // async; re-renders when ready
      } else if (fileHist.length) {
        const seen = new Set(hist.map(chatDedupeKey));
        const older = fileHist.filter(m => !seen.has(chatDedupeKey(m)));
        hist = older.concat(hist);
      }
    }
    // Re-render in chronological order; suppress the last-separator cursor
    // so the first message after a switch gets a fresh separator.
    delete lastChatDateByAgent[agentId];
    for (const m of hist) {
      _renderStoredChatMsg(m, msgs, agentId);
    }
    // Restore the saved scrollTop for this (agent, quest) bucket, instead of forcing scrollTop = scrollHeight.
    const scrollKey = `${agentId}::${qk}`;
    const savedOffset = chatScrollOffsetByAgentAndQuest[scrollKey];
    if (typeof savedOffset === 'number' && savedOffset > 0) {
      // Scroll immediately. The DOM has already measured
      // (we just set innerHTML above), so a single
      // scrollTop assignment is enough.
      msgs.scrollTop = savedOffset;
    } else {
      msgs.scrollTop = msgs.scrollHeight;
    }
  }
};

// Per-quest chat history from <quest.directory>/quest/CONVERSATION.md.
const QUEST_FILE_HISTORY_LIMIT = 300;
const _questFileHistory = {};   // "agentId::questId" -> [msg] | null (loading)
function questFileHistoryFor(agentId, qk) {
  const v = _questFileHistory[agentId + '::' + qk];
  return v === null ? [] : v; // null = loading → render nothing extra yet
}
function chatDedupeKey(m) {
  const minute = Math.floor((m.ts || 0) / 60000);
  return (m.type || '') + '|' + minute + '|' + String(m.text || '').trim().slice(0, 80);
}
function parseQuestConversationMd(content, agentId) {
  const agent = agents[agentId] || {};
  const want = new Set([String(agentId).toLowerCase(), String(agent.name || '').toLowerCase()]);
  const emoji = (agent.emoji && agent.emoji !== '🤖') ? agent.emoji : (getSpriteIcon(agent._pixelCompanionId) || null);
  const re = /^\[(\d{4}-\d\d-\d\dT[^\]]+)\] (user|agent|error)\(([^)]*)\): ?/gm;
  const heads = [];
  let m;
  while ((m = re.exec(content))) heads.push({ idx: m.index, end: re.lastIndex, ts: Date.parse(m[1]), role: m[2], who: m[3] });
  const out = [];
  // Older logs contain unprompted companion chatter (idle comments, ball/snack reactions) written before that was routed to casual chat.
  const REPLY_WINDOW_MS = 10 * 60 * 1000;
  let lastUserTs = -Infinity;
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    if (h.role === 'user') lastUserTs = h.ts;
    else if (h.role === 'agent' && !(h.ts - lastUserTs <= REPLY_WINDOW_MS)) continue;
    if (h.role === 'agent' && /idle companion\s*[—-]\s*no task/i.test(content.slice(h.end, h.end + 200))) continue;
    const text = content.slice(h.end, i + 1 < heads.length ? heads[i + 1].idx : content.length).replace(/\s+$/, '');
    const who = h.who.split('|');
    if (!who.some(w => want.has(String(w).trim().toLowerCase()))) continue;
    if (!text || isNaN(h.ts)) continue;
    const msg = { type: h.role, ts: h.ts, text: h.role === 'agent' ? stripAgentReplyDecorations(text) : text, fromQuestFile: true };
    if (h.role === 'agent') { msg.name = agent.name || who[0]; msg.emoji = emoji; }
    if (!msg.text.trim()) continue;
    out.push(msg);
  }
  return out.slice(-QUEST_FILE_HISTORY_LIMIT);
}
async function loadQuestFileHistory(agentId, qk) {
  const key = agentId + '::' + qk;
  if (_questFileHistory[key] !== undefined) return;
  _questFileHistory[key] = null;
  let msgs = [];
  try {
    const res = await cyberclaw.quests.getConversationFile(qk);
    if (res && res.ok && res.content) {
      const q = (cachedQuestsList || []).find(x => x && x.id === qk);
      msgs = parseQuestConversationMd(res.content, agentId)
        .map(x => ({ ...x, activeQuestId: qk, activeQuestName: q ? q.name : null }));
    }
  } catch (e) { console.warn('[QuestHistory] load failed:', e && e.message); }
  _questFileHistory[key] = msgs;
  // Re-render if the user is still looking at this chat.
  if (msgs.length && activeChatAgentId === agentId && questKeyForStorage(activeQuestId) === qk) {
    switchActiveChat(agentId);
  }
}

// Switch the chat pane to the active quest's bucket for the current companion.
window.switchActiveChatQuest = function(newQuestId) {
  const tb = document.getElementById('chat-quest-toggle-btn');
  if (tb) tb.classList.remove('has-unread');
  // Just call switchActiveChat with the current agent — it already reads from the active-quest bucket, so updating activeQuestId is enough.
  const aid = activeChatAgentId || pickCurrentCompanionId();
  if (!aid) return;
  switchActiveChat(aid);
  // Also update the chat header's quest indicator (the quest pill next to the companion name) so the user sees which quest's chat they're…
  updateChatQuestIndicator();
};

// Update the chat header's quest pill.
function updateChatQuestIndicator() {
  const el = document.getElementById('chat-quest-indicator');
  if (!el) return;
  // The small chat-quest-indicator badge is fully superseded by the v3.3.34 centered quest toggle.
  el.style.display = 'none';
  el.textContent = '';
  el.title = '';
  // Also fire the async refresh so directory / metadata
  // updates flow through.
  if (typeof updateQuestIndicator === 'function') {
    try { updateQuestIndicator(); } catch (_) {}
  }
  // Also keep the new centered quest toggle in sync with the active quest id.
  try { updateChatQuestToggle(); } catch (e) { console.warn('[updateChatQuestIndicator->toggle] suppressed:', e?.message); }
}

// Render the centered quest-context toggle pill above the chat input.
function updateChatQuestToggle() {
  const wrap = document.getElementById('chat-quest-toggle');
  if (!wrap) return;
  const pill = document.getElementById('chat-quest-toggle-pill');
  const btn = document.getElementById('chat-quest-toggle-btn');
  if (!pill || !btn) return;

  // Resolve the active quest + the first candidate to switch to.
  const quests = Array.isArray(cachedQuestsList) ? cachedQuestsList : [];
  if (quests.length === 0) {
    wrap.style.display = 'none';
    return;
  }
  const activeQuest = activeQuestId
    ? quests.find(q => q && q.id === activeQuestId) || null
    : null;
  // The 'other side' of the toggle.
  let toggleTarget = null;
  let toggleLabel = '↔ Casual';
  let otherName = 'Casual';
  if (activeQuest) {
    btn.style.display = '';
    toggleTarget = null;
    toggleLabel = '↔ Casual';
    otherName = 'Casual';
    pill.classList.remove('casual');
    pill.textContent = `📜 ${activeQuest.name || '(unnamed quest)'}`;
    pill.title = activeQuest.directory
      ? `Currently chatting on quest: ${activeQuest.name}\n${activeQuest.directory}`
      : `Currently chatting on quest: ${activeQuest.name}`;
  } else if (_casualFromQuestId && quests.find(q => q && q.id === _casualFromQuestId && q.active)) {
    // v3.4.7: casual view while a quest is still active → offer
    // the way back to that quest.
    const aq = quests.find(q => q && q.id === _casualFromQuestId);
    pill.classList.add('casual');
    pill.textContent = '💬 Casual';
    pill.title = 'Casual chat. Your quest is still active.';
    btn.style.display = '';
    btn.disabled = false;
    btn.textContent = '↔ ' + (aq.name || 'quest');
    btn.title = 'Back to quest: ' + (aq.name || '');
    btn.dataset.target = aq.id;
    wrap.style.display = '';
    return;
  } else {
    // No active quest → no quest alternative.
    pill.classList.add('casual');
    pill.textContent = '💬 Casual';
    pill.title = 'Casual chat — no quest is active. Activate a quest in the Quest Log to chat about it.';
    btn.style.display = 'none';
    wrap.style.display = '';
    return;
  }
  if (toggleTarget !== null || activeQuest) {
    btn.disabled = false;
    btn.textContent = toggleLabel;
    btn.title = toggleTarget === null
      ? 'Switch to casual chat (no active quest)'
      : `Switch to quest: ${otherName}`;
    btn.dataset.target = toggleTarget === null ? '' : toggleTarget;
  }
  wrap.style.display = '';
}

// Click handler for the quest-toggle button.
window.toggleChatQuestContext = async function() {
  try {
    const btn = document.getElementById('chat-quest-toggle-btn');
    if (!btn || btn.disabled) return;
    const target = (btn.dataset && btn.dataset.target) || '';
    const targetId = target === '' ? null : target;
    // Log the click + transition for debuggability.
    try {
      console.log('[toggleChatQuestContext] click', {
        prev: activeQuestId,
        target: targetId,
        ts: Date.now(),
      });
    } catch (_) {}
    // v3.4.7: local chat-context switch only. The quest stays
    // active (no setActive IPC) so the toggle can flip back.
    const fromQuest = activeQuestId;
    setActiveQuestId(targetId);
    if (!targetId && fromQuest) _casualFromQuestId = fromQuest;
    updateChatQuestToggle();
    return;
    try {
      await cyberclaw.quests.setActive(targetId);
    } catch (e) {
      console.warn('[toggleChatQuestContext] setActive IPC failed:', e?.message);
      // Best-effort: re-render the toggle to reflect the local state.
      try { updateChatQuestToggle(); } catch (_) {}
    }
  } catch (e) {
    console.warn('[toggleChatQuestContext] suppressed error:', e?.message);
  }
};

function _renderStoredChatMsg(m, container, agentId) {
  const now = new Date(m.ts || Date.now());
  const cursor = lastChatDateByAgent[agentId] || null;
  lastChatDateByAgent[agentId] = checkDateSeparator(cursor, now, container);
  const div = document.createElement('div');
  const id = `chat-msg-${++chatMsgId}`;
  div.id = id;
  div.className = `chat-msg ${m.type}`;
  // Compute the per-bubble quest pill from the stored message's `activeQuestId` (which was stamped by addChatMsg at the time the message was…
  const storedQid = m.activeQuestId;
  const storedName = (() => {
    if (Array.isArray(cachedQuestsList) && storedQid) {
      const q = cachedQuestsList.find(qq => qq && qq.id === storedQid);
      if (q && q.name) return q.name;
    }
    return m.activeQuestName || null;
  })();
  const questHeaderHtml = storedQid
    ? (storedName
        ? `<span class="msg-quest-header">📜 ${escHtml(storedName)}</span>`
        : '')
    : `<span class="msg-quest-header no-quest">— Casual</span>`;
  switch (m.type) {
    case 'user':
      div.innerHTML = questHeaderHtml + `<span class="msg-prefix">[You]</span>` + (m.text ? `<span class="msg-text">${escHtml(m.text)}</span>` : '') + chatImagesHtml(m.attachments);
      break;
    case 'agent':
      // The desktop now passes the resolved icon (per-agent emoji → sprite catalog icon) to addChatMsg, so m.emoji is set correctly here.
      div.innerHTML = questHeaderHtml + `<span class="msg-prefix">${(m.emoji && m.emoji !== '🤖') ? m.emoji + ' ' : ''}[${escHtml(m.name)}]</span>` + agentTextHtml(m.text) + chatImagesHtml(m.attachments);
      break;
    case 'agent-image':
      div.innerHTML = questHeaderHtml + chatImagesHtml(m.attachments);
      break;
    case 'typing':
      div.innerHTML = `<span class="msg-text" style="color:var(--text-muted);font-style:italic">${escHtml(m.text)}</span>`;
      break;
    case 'error':
      // Also render the quest pill on error bubbles when re-rendering from storage.
      div.innerHTML = questHeaderHtml + `<span class="msg-text" style="color:var(--red)">${escHtml(m.text)}</span>`;
      break;
  }
  container.appendChild(div);
}

function updateChatHeader(agentId) {
  // v3.3.29: wrap in try/catch — see updateInspect above.
  // A render bug here would skip the sleep-state class
  // toggle on the channel tab, leaving stale visual state.
  try {
  const headerName = document.getElementById('chat-header-name');
  const headerAvatar = document.getElementById('chat-header-avatar');
  const headerStatus = document.getElementById('chat-header-status');
  if (!headerName) return;
  const agent = agents[agentId];
  if (!agent) {
    headerName.textContent = 'No companion';
    if (headerAvatar) headerAvatar.innerHTML = '';
    if (headerStatus) headerStatus.textContent = '';
    return;
  }
  headerName.textContent = agent.name;
  if (headerAvatar) {
    if (agent.avatar && String(agent.avatar).startsWith('data:')) {
      headerAvatar.innerHTML = `<img src="${escAttr(agent.avatar)}" alt="${escAttr(agent.name)}">`;
    } else {
      // Prefer per-agent emoji, fall back to sprite icon from the catalog so the avatar matches the sprite.
      headerAvatar.innerHTML = (agent.emoji && agent.emoji !== '🤖') ? agent.emoji : (getSpriteIcon(agent._pixelCompanionId) || '🤖');
    }
  }
  if (headerStatus) {
    const sleeping = agent.sleepState === 'sleeping';
    headerStatus.textContent = sleeping ? '💤 sleeping' : 'online';
    headerStatus.className = 'chat-header-status ' + (sleeping ? 'sleeping' : 'online');
  }
  // Drive the channel tab's green-dot indicator from the same sleepState check.
  refreshChannelTabsOnlineState();
  // Refresh the local-LLM status pill for this companion.
  refreshLlmStatusPill(agent);
  } catch (e) {
    try { console.warn('[updateChatHeader] suppressed error:', e?.message); } catch (_) {}
  }
}

// Drive the green-dot online indicator on EVERY companion channel tab based on each companion's actual sleepState.
function refreshChannelTabsOnlineState() {
  try {
    if (!Array.isArray(agentOrder) || !agents) return;
    for (const id of agentOrder) {
      const a = agents[id];
      if (!a) continue;
      const tab = document.querySelector(`.channel-tab-companion[data-agent-id="${id}"]`);
      if (!tab) continue;
      const sleeping = a.sleepState === 'sleeping';
      tab.classList.toggle('online', !sleeping);
    }
  } catch (e) {
    try { console.warn('[refreshChannelTabsOnlineState] suppressed error:', e?.message); } catch (_) {}
  }
}

// ─── Local LLM status pill ─────────────────────────────── Shows a small status indicator above the chat input when the active companion's…

let _llmPillRefreshTimer = null;
let _localProviderCache = null; // cached resolveLocal result per model string

// Renderer-side mirror of main.js parseModelRef.
function parseModelRef(modelStr) {
  if (!modelStr || typeof modelStr !== 'string') return null;
  const idx = modelStr.indexOf('/');
  if (idx <= 0) return null;
  const providerId = modelStr.slice(0, idx).toLowerCase();
  const modelId = modelStr.slice(idx + 1);
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

async function isLocalModel(modelStr) {
  if (!modelStr || typeof modelStr !== 'string') return null;
  if (_localProviderCache && _localProviderCache.model === modelStr) {
    return _localProviderCache;
  }
  try {
    const r = await cyberclaw.llm.ollama.resolveLocal(modelStr);
    _localProviderCache = { ...r, model: modelStr };
    return _localProviderCache;
  } catch {
    return null;
  }
}

function clearLocalProviderCache() {
  _localProviderCache = null;
}

async function refreshLlmStatusPill(agent) {
  const pill = document.getElementById('llm-status-pill');
  if (!pill) return;
  if (!agent) { pill.style.display = 'none'; return; }
  const model = agent.primaryModel || '';
  if (!model) { pill.style.display = 'none'; return; }

  // Resolve whether this model points at a local server. If not,
  // hide the pill (this companion uses a cloud API; nothing to
  // start).
  const resolved = await isLocalModel(model);
  if (!resolved || !resolved.isLocal) {
    pill.style.display = 'none';
    return;
  }

  // Show a loading shimmer while we probe
  pill.style.display = 'inline-flex';
  pill.className = 'llm-status-pill state-loading';
  pill.querySelector('.llm-label').textContent = `checking ${formatModelName(model)}…`;
  pill.querySelector('.llm-action').textContent = '';
  pill.querySelector('.llm-action').disabled = true;
  let r;
  try {
    r = await cyberclaw.llm.ollama.status(model);
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  renderLlmPillState(pill, model, r, resolved);
}

function renderLlmPillState(pill, model, r, resolved) {
  const dot = pill.querySelector('.llm-dot');
  const label = pill.querySelector('.llm-label');
  const btn = pill.querySelector('.llm-action');
  btn.disabled = false;
  btn.onclick = null;
  const modelShort = formatModelName(model);
  const providerLabel = resolved?.providerName
    ? resolved.providerName.charAt(0).toUpperCase() + resolved.providerName.slice(1)
    : 'Local server';

  if (!r || !r.ok) {
    if (r?.state === 'down') {
      pill.className = 'llm-status-pill state-down';
      label.textContent = `🔴 ${providerLabel} down (${r.baseUrl || 'localhost'})`;
      btn.textContent = 'Start';
      btn.onclick = () => handleLlmPillAction(model, 'start');
      pill.title = `Click to spawn \`ollama serve\` (the local LLM server ${modelShort} uses).`;
    } else {
      pill.style.display = 'none';
    }
    // v3.3.5: push current pill state to mobile so the phone
    // sees the same status without re-querying.
    broadcastLlmStatusToMobile(model, r, resolved);
    return;
  }

  if (r.state === 'running') {
    pill.className = 'llm-status-pill state-running';
    label.textContent = `🟢 ${modelShort} loaded`;
    btn.textContent = 'Unload';
    btn.onclick = () => handleLlmPillAction(model, 'unload');
    const vramStr = r.vram?.estimatedModelMb ? ` (~${r.vram.estimatedModelMb} MB in VRAM)` : '';
    pill.title = `Model is warm and ready. Click to evict and free VRAM${vramStr}.`;
  } else if (r.state === 'cold') {
    pill.className = 'llm-status-pill state-cold';
    label.textContent = `🟡 ${modelShort} not loaded`;
    btn.textContent = 'Warm up';
    btn.onclick = () => handleLlmPillAction(model, 'warm');
    pill.title = 'Click to pre-load the model into VRAM (~5-15s). Replies become instant after warm-up.';
  } else if (r.state === 'too-big') {
    pill.className = 'llm-status-pill state-toobig';
    const total = r.vram?.totalMb ? `${(r.vram.totalMb / 1024).toFixed(1)} GB VRAM` : 'this GPU';
    const modelSize = r.vram?.estimatedModelMb ? `${(r.vram.estimatedModelMb / 1024).toFixed(1)} GB` : 'too large';
    label.textContent = `⚠ ${modelShort} (${modelSize}) won't fit ${total}`;
    btn.textContent = 'Open settings';
    btn.onclick = () => {
      addChatMsg('system', `⚠ ${modelShort} is ${modelSize} but this host only has ${total}. Try a smaller model in Settings → LLM Endpoints.`);
      const el = document.getElementById('llm-endpoints-list');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    pill.title = 'This model is too large for the available GPU memory.';
  } else {
    pill.style.display = 'none';
  }
  // v3.3.5: push current pill state to mobile so the phone
  // sees the same status without re-querying.
  broadcastLlmStatusToMobile(model, r, resolved);
}

// Forward the desktop's pill state to mobile clients via the sync-server broadcast.
function broadcastLlmStatusToMobile(model, status, resolved) {
  if (!cyberclaw?.sync?.broadcastLlmStatus) return;
  try {
    cyberclaw.sync.broadcastLlmStatus({
      agentId: activeChatAgentId || null,
      model,
      modelId: status?.modelId || resolved?.modelId || null,
      baseUrl: status?.baseUrl || resolved?.baseUrl || null,
      providerName: resolved?.providerName || null,
      state: status?.state || 'unsupported',
      vram: status?.vram || null,
    });
  } catch (e) {
    // Mobile sync is optional — never break the desktop pill.
    console.warn('[llm-pill] broadcast failed:', e?.message);
  }
}

async function handleLlmPillAction(model, action) {
  const pill = document.getElementById('llm-status-pill');
  if (!pill) return;
  const btn = pill.querySelector('.llm-action');
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = action === 'start' ? 'Starting…' : (action === 'warm' ? 'Warming…' : 'Unloading…');
  try {
    if (action === 'start') {
      const r = await cyberclaw.llm.ollama.start();
      if (!r.ok) {
        addChatMsg('system', '❌ Could not start local LLM server: ' + (r.error || 'unknown') + '. Is `ollama` installed and on PATH?');
      } else {
        addChatMsg('system', `🦙 Started ollama serve (pid ${r.pid}). Give it a moment to bind the port.`);
      }
      // Wait a beat for the server to come up before re-probing.
      setTimeout(() => refreshLlmStatusPill(agents[activeChatAgentId]), 1500);
      return;
    }
    if (action === 'warm') {
      const r = await cyberclaw.llm.ollama.warm(model);
      if (!r.ok) {
        addChatMsg('system', '❌ Warm-up failed: ' + (r.error || 'unknown'));
        btn.textContent = oldText; btn.disabled = false;
        return;
      }
      addChatMsg('system', `🔥 Loading ${formatModelName(model)} into VRAM…`);
      pollUntilLoaded(model, 30);
      return;
    }
    if (action === 'unload') {
      const r = await cyberclaw.llm.ollama.unload(model);
      if (!r.ok) {
        addChatMsg('system', '❌ Unload failed: ' + (r.error || 'unknown'));
        btn.textContent = oldText; btn.disabled = false;
        return;
      }
      addChatMsg('system', `💤 Evicted ${formatModelName(model)} from VRAM.`);
      setTimeout(() => refreshLlmStatusPill(agents[activeChatAgentId]), 800);
      return;
    }
  } catch (e) {
    addChatMsg('system', '❌ ' + (e.message || 'unknown error'));
    btn.textContent = oldText; btn.disabled = false;
  }
}

function pollUntilLoaded(model, maxSeconds) {
  // Cancel any previous poll so we don't stack them.
  if (_llmPillRefreshTimer) { clearTimeout(_llmPillRefreshTimer); _llmPillRefreshTimer = null; }
  const start = Date.now();
  const tick = async () => {
    const r = await cyberclaw.llm.ollama.status(model).catch(() => null);
    if (r && r.state === 'running') {
      refreshLlmStatusPill(agents[activeChatAgentId]);
      addChatMsg('system', `✅ ${formatModelName(model)} loaded — replies are instant now.`);
      return;
    }
    if (Date.now() - start > maxSeconds * 1000) {
      // Give up — re-render so the user sees the current state.
      refreshLlmStatusPill(agents[activeChatAgentId]);
      addChatMsg('system', `⏱ Still loading ${formatModelName(model)} after ${maxSeconds}s. Check Settings → LLM Endpoints if this persists.`);
      return;
    }
    _llmPillRefreshTimer = setTimeout(tick, 1500);
  };
  _llmPillRefreshTimer = setTimeout(tick, 1500);
}

// Populate the companion channel tabs (top-left of the terminal strip).
// Should be called whenever the agent list changes.
function renderCompanionChannelTabs() {
  const container = document.getElementById('companion-channel-tabs');
  if (!container) return;
  // Preserve the label
  const label = container.querySelector('.tab-group-label');
  container.innerHTML = '';
  if (label) container.appendChild(label);
  for (const id of agentOrder) {
    const agent = agents[id];
    if (!agent) continue;
    const tab = document.createElement('button');
    tab.className = 'channel-tab-companion';
    tab.dataset.agentId = id;
    tab.title = `Chat with ${agent.name}`;
    tab.onclick = () => { window.switchActiveChat(id); focusIndex = agentOrder.indexOf(id); updateCarousel(); };
    // Chat tab uses the sprite icon SVG (Twemoji-style) when available — guaranteed colorful, smooth, consistent across platforms.
    const iconFile = getSpriteIconFile(agent._pixelCompanionId);
    if (iconFile) {
      const img = document.createElement('img');
      img.className = 'companion-tab-icon-img';
      img.src = iconFile;
      img.alt = '';
      img.draggable = false;
      tab.appendChild(img);
    } else {
      const em = document.createElement('div');
      em.className = 'companion-tab-emoji';
      // Strip the desktop's default 🤖 before falling back to the sprite icon — same fix as the chat header avatar.
      em.textContent = (agent.emoji && agent.emoji !== '🤖') ? agent.emoji : (getSpriteIcon(agent._pixelCompanionId) || '🤖');
      tab.appendChild(em);
    }
    const name = document.createElement('span');
    name.className = 'companion-tab-name';
    name.textContent = agent.name;
    tab.appendChild(name);
    // Green-dot online indicator on the channel tab.
    const status = document.createElement('span');
    status.className = 'companion-tab-status';
    tab.appendChild(status);
    if (id === activeChatAgentId) tab.classList.add('active');
    // Per-quest bucketing — the unread badge should reflect the active quest's bucket only, not the union across all quests.
    if (lastReadTsByAgent[id]) {
      const qk = questKeyForStorage(activeQuestId);
      const bucket = (chatHistoryByAgentAndQuest[id] || {})[qk] || [];
      if (bucket.some(m => m.ts > (lastReadTsByAgent[id] || 0))) {
        tab.classList.add('has-unread');
      }
    }
    container.appendChild(tab);
  }
  // Apply each agent's sleepState to its tab now that all tabs exist in the DOM.
  refreshChannelTabsOnlineState();
}

window.toggleTerminal = function() {
  const strip = document.getElementById('terminal-strip');
  const btn = document.querySelector('.term-tab-toggle');
  terminalExpanded = !terminalExpanded;
  strip.style.height = terminalExpanded ? '50%' : '160px';
  btn.textContent = terminalExpanded ? '▲' : '▼';
  setTimeout(() => { mainFit?.fit(); }, 100);
};

function termTheme() {
  return {
    background: '#050507', foreground: '#e8e8ec', cursor: '#ff6b35', cursorAccent: '#050507',
    selectionBackground: '#ff6b3540',
    black: '#1a1a28', red: '#ff3366', green: '#4ade80', yellow: '#f7931e',
    blue: '#00d4ff', magenta: '#ff6b35', cyan: '#00d4ff', white: '#e8e8ec',
    brightBlack: '#555566', brightRed: '#ff6688', brightGreen: '#86efac',
    brightYellow: '#ffb347', brightBlue: '#66e0ff', brightMagenta: '#ff9966',
    brightCyan: '#66e0ff', brightWhite: '#ffffff',
  };
}

function initMainTerminal() {
  const c = document.getElementById('terminal-container');
  mainTerminal = new Terminal({ theme: termTheme(), fontFamily: '"JetBrains Mono", monospace', fontSize: 12, lineHeight: 1.2, cursorBlink: true, cursorStyle: 'bar', scrollback: 5000, allowProposedApi: true });
  mainFit = new FitAddon();
  mainTerminal.loadAddon(mainFit);
  mainTerminal.loadAddon(new WebLinksAddon());
  mainTerminal.open(c);
  // Fit multiple times as layout settles
  const doFit = () => {
    try {
      mainFit.fit();
      const d = mainFit.proposeDimensions();
      console.log('[TERM] fit:', d, 'container:', c.clientWidth, 'x', c.clientHeight, 'parent:', c.parentElement?.clientHeight);
      if (d) cyberclaw.terminal.resize(d.cols, d.rows);
    } catch(e) { console.error('[TERM] fit error:', e); }
  };
  doFit();
  setTimeout(doFit, 100);
  setTimeout(doFit, 300);
  setTimeout(doFit, 700);
  setTimeout(doFit, 1500);
  window.addEventListener('load', () => setTimeout(doFit, 100));
  mainTerminal.onData(data => cyberclaw.terminal.write(data));
  cyberclaw.terminal.onData(data => mainTerminal.write(data));
  cyberclaw.terminal.onExit(code => mainTerminal.write(`\r\n\x1b[33m[Exit ${code}]\x1b[0m\r\n`));
  const d = mainFit.proposeDimensions();
  cyberclaw.terminal.spawn({ cols: d?.cols || 120, rows: d?.rows || 10 });
  new ResizeObserver(() => { mainFit.fit(); const dd = mainFit.proposeDimensions(); if (dd) cyberclaw.terminal.resize(dd.cols, dd.rows); }).observe(c);
}

// ---------------------------------------------------------------------------
// Chat — message companions
// ---------------------------------------------------------------------------
let chatBusy = false;
// Per-agent send queue.
const chatSendChain = new Map(); // agentId -> Promise

function updateChatTarget() {
  // chat-target element was removed — no-op
}

// Shared helper — award XP to the best-matching companion based on the LLM-reply's taskSkill.
async function awardXpForReply(result, fallbackAgentId) {
  return; // v3.6.7: XP now comes from tool activity (main.js awardToolXp)
  if (!result || !result.ok) return;
  const taskSkill = result.taskSkill;
  if (!taskSkill) return;
  try {
    const xpAmount = 10 + Math.floor(Math.random() * 10);
    // Find companion with this focus, or fall back to the
    // agent we're currently chatting with.
    const specialist = agentOrder.find(id => {
      const a = agents[id];
      return a?.focusSkills?.includes(taskSkill);
    });
    const xpTarget = specialist || fallbackAgentId;
    if (!xpTarget) return;
    await cyberclaw.agents.addXP(xpTarget, taskSkill, xpAmount);
    const xpAgent = agents[xpTarget];
    if (xpAgent) {
      addChatMsg('system', `⚔️ ${xpAgent.name} gained +${xpAmount} ${taskSkill} XP`);
    }
    // Re-broadcast so the mobile Skills section sees the new XP without a manual refresh.
    try { broadcastAgentsListToMobile(); } catch (_) {}
    // Also refresh the desktop's inspect panel so the Skills Categories list updates without the user having to click away and back to the tab.
    if (xpTarget === activeChatAgentId) {
      try { updateInspect(xpTarget); } catch (_) {}
    }
  } catch (e) {
    console.warn('[XP] awardXpForReply failed:', e?.message);
  }
}

window.sendChat = async function() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message || chatBusy || agentOrder.length === 0) return;

  // v3.1.3: auto-wake the target companion so they can reply.
  // v3.1.4: also set pixelArena.companion.sleepState so the arena
  // update loop doesn't snap the sprite back to death.
  const targetId = agentOrder[focusIndex] || pickCurrentCompanionId();
  if (targetId && agents[targetId] && agents[targetId].sleepState === 'sleeping') {
    agents[targetId].sleepState = 'awake';
    if (pixelArena && pixelArena.companion && pixelArena.companion.id === targetId) {
      pixelArena.companion.sleepState = 'awake';
      pixelArena.companion.vx = 0;
      pixelArena.companion.vy = 0;
      pixelArena.companion.frame = 0;
    }
    // v3.10.3: tell the mobile that the wake happened so
    // its sleeping sprite visually un-grays immediately.
    try { broadcastAgentsListToMobile(); } catch (_) {}
  }
  bumpCompanionInteraction(targetId); // v3.1.4: reset auto-sleep timer

  const agent = agents[agentOrder[focusIndex]];
  if (!agent) return;

  // Show user message
  addChatMsg('user', message, agent.name);
  input.value = '';

  // The chat target is the active companion (v3.1.3: no leader concept).
  const mainAgentId = pickCurrentCompanionId();
  if (!mainAgentId) { addChatMsg('error', 'No companion found'); return; }

  // Build message with context
  let fullMessage = message;

  // Always inject the quest-tools hint so the agent knows it can CREATE_QUEST from the chat reply, regardless of whether there's an active…
  fullMessage = buildQuestToolsHint() + fullMessage;

  // Append a strong work-first reminder at the END of the user message.
  fullMessage = fullMessage + '\n\n' + buildWorkFirstSuffix();

  // Add quest context if active.
  if (activeQuestId) {
    const quests = await cyberclaw.quests.list();
    const q = quests.find(q => q.id === activeQuestId);
    if (q) {
      fullMessage = await buildActiveQuestContext(q) + fullMessage;
    }
  }

  // Show typing indicator
  chatBusy = true;
  { const _sb = document.getElementById('chat-send'); if (_sb) _sb.disabled = true; } // v3.6.8: button may not exist
  const typingId = addChatMsg('typing', `${agent.name} is thinking...`);

  // Escalate the typing indicator so the user has a visible signal that the request is still being processed during long model retries.
  const escalationTimers = [];
  const escalateTyping = (text) => {
    // Find the typing message's text span and update it in place.
    const el = document.getElementById(typingId);
    if (el) {
      const textSpan = el.querySelector('.msg-text');
      if (textSpan) textSpan.textContent = text;
      // Debug log so we can see in the desktop log whether the escalation actually fired when Tobe reports it isn't.
      console.log(`[typing-escalate] ${typingId} -> "${text}" (div=${!!el}, span=${!!textSpan})`);
    } else {
      // The div isn't in the DOM.
      console.log(`[typing-escalate] ${typingId} -> SKIP (div not found, text="${text}")`);
    }
  };
  escalationTimers.push(setTimeout(() => escalateTyping(`${agent.name} is thinking (working on it)...`), 8000));
  escalationTimers.push(setTimeout(() => escalateTyping(`${agent.name} is taking a moment...`), 20000));
  escalationTimers.push(setTimeout(() => escalateTyping(`${agent.name} is still working (model is slow today)...`), 45000));
  escalationTimers.push(setTimeout(() => escalateTyping(`${agent.name} is still working (model keeps timing out — hang tight)...`), 90000));
  const clearEscalation = () => {
    for (const t of escalationTimers) clearTimeout(t);
    escalationTimers.length = 0;
  };

  try {
    // Cap the openclaw agent call at 2 minutes on the desktop side too.
    let capHandle;
    const capPromise = new Promise((_, reject) => {
      capHandle = setTimeout(() => reject(new Error('Request timed out after 2 minutes')), 120000);
    });
    let result;
    try {
      result = await Promise.race([
        // v3.6.14: text-only send — there are no attachments in this function.
        // The old 'attachments' reference was undefined; it stayed hidden until
        // v3.6.8 removed an earlier crash, then every desktop text send failed.
        cyberclaw.chat.sendMessage(mainAgentId, fullMessage, undefined),
        capPromise,
      ]);
    } finally {
      clearTimeout(capHandle);
    }
    clearEscalation();
    removeChatMsg(typingId);

    if (result.ok) {
      // Show response from party leader
      const leader = agents[mainAgentId];
      // Pass the resolved icon (per-agent emoji → sprite catalog icon) so the message prefix shows the right emoji even if the user hasn't set a…
      const _leaderName = leader?.name || 'Companion';
      const _leaderEmoji = (leader?.emoji === '🤖') ? null : (leader?.emoji || getSpriteIcon(leader?._pixelCompanionId));
      postAgentReplyWithScreenshots(result, _leaderName, _leaderEmoji);

      // Check for quest commands in the reply.
      if (result.reply) {
        // [QUEST_SET_ACTIVE: id="abc123"] — switch the active quest.
        const setActiveMatch = result.reply.match(/\[QUEST_SET_ACTIVE:\s*id="([^"]+)"\]/i);
        if (setActiveMatch) {
          const targetId = setActiveMatch[1];
          try {
            // Resolve by id first; fall back to name match
            // (LLMs sometimes emit the name when the id is
            // not in their context).
            const all = await cyberclaw.quests.list();
            const found = all.find(q => q.id === targetId)
              || all.find(q => q.name.toLowerCase() === targetId.toLowerCase());
            if (found) {
              await cyberclaw.quests.setActive(found.id);
              setActiveQuestId(found.id);
              addChatMsg('system', `⚡ Active quest set to "${found.name}"`);
              renderQuests();
            } else {
              addChatMsg('system', `⚠️ No quest matching "${targetId}" to set active`);
            }
          } catch (e) {
            addChatMsg('system', '⚠️ Failed to set active quest: ' + e.message);
          }
        }
        // [QUEST_APPEND_CHANGE: text="..."] — append to the active quest's latestChanges journal.
        const appendMatch = result.reply.match(/\[QUEST_APPEND_CHANGE:\s*text="([^"]+)"\]/i);
        if (appendMatch) {
          if (activeQuestId) {
            try {
              await cyberclaw.quests.appendChange(activeQuestId, appendMatch[1]);
              addChatMsg('system', `📝 Logged: ${appendMatch[1]}`);
            } catch (e) {
              addChatMsg('system', '⚠️ Failed to log change: ' + e.message);
            }
          } else {
            addChatMsg('system', '⚠️ No active quest to log the change against');
          }
        }
        // [QUEST_NOTE: text="..."] — append a timestamped markdown note to the ACTIVE quest's QUEST_QUEST_INSTRUCTIONS.md (the same file the quest…
        const summaryMatch = result.reply.match(/\[QUEST_SUMMARY:\s*text="([\s\S]*?)"\]/i);
        if (summaryMatch && activeQuestId) {
          try { const r = await cyberclaw.quests.writeQuestSummary(activeQuestId, summaryMatch[1]); if (r && r.ok) addChatMsg('system', '🧭 Quest summary updated'); } catch (e) { addChatMsg('system', '⚠️ Summary update failed: ' + e.message); }
        }
        const decisionRe = /\[QUEST_DECISION:\s*text="([^"]+)"\]/gi;
        let decM;
        while (activeQuestId && (decM = decisionRe.exec(result.reply))) {
          try { const r = await cyberclaw.quests.appendQuestDecision(activeQuestId, decM[1]); if (r && r.ok) addChatMsg('system', '📌 Decision recorded: ' + (decM[1].length > 80 ? decM[1].slice(0, 77) + '…' : decM[1])); } catch (e) { addChatMsg('system', '⚠️ Decision save failed: ' + e.message); }
        }
        const noteMatch = result.reply.match(/\[QUEST_NOTE:\s*text="([^"]+)"\]/i);
        if (noteMatch) {
          if (activeQuestId) {
            try {
              const res = await cyberclaw.quests.appendQuestInstructions(activeQuestId, noteMatch[1]);
              if (res && res.ok) {
                // Invalidate the cache so the next chat send sees the new note.
                const quests = await cyberclaw.quests.list();
                const q = quests.find(qq => qq.id === activeQuestId);
                if (q && q._questInstructionsCache) {
                  delete q._questInstructionsCache[activeQuestId];
                }
                const preview = noteMatch[1].length > 80 ? noteMatch[1].slice(0, 77) + '…' : noteMatch[1];
                addChatMsg('system', `📓 Note saved: ${preview}`);
              } else {
                addChatMsg('system', `⚠️ Could not save note: ${res?.error || 'unknown error'}`);
              }
            } catch (e) {
              addChatMsg('system', '⚠️ Failed to save note: ' + (e?.message || e));
            }
          } else {
            addChatMsg('system', '⚠️ No active quest to save the note against');
          }
        }
        // [QUEST_MARK_GOAL: index="N" done="true"] — toggle a goal's completed flag by 0-based index on the active quest.
        const markGoalMatch = result.reply.match(/\[QUEST_MARK_GOAL:\s*index="(\d+)"\s+done="(true|false)"\]/i);
        if (markGoalMatch) {
          if (activeQuestId) {
            try {
              const idx = parseInt(markGoalMatch[1], 10);
              const done = markGoalMatch[2].toLowerCase() === 'true';
              const updated = await cyberclaw.quests.markGoalDone(activeQuestId, idx, done);
              if (updated) {
                addChatMsg('system', `${done ? '✅' : '↩'} Goal ${idx + 1} ${done ? 'marked done' : 'reopened'}`);
                renderQuests();
              } else {
                addChatMsg('system', `⚠️ Goal index ${idx} out of range`);
              }
            } catch (e) {
              addChatMsg('system', '⚠️ Failed to mark goal: ' + e.message);
            }
          } else {
            addChatMsg('system', '⚠️ No active quest to mark a goal on');
          }
        }
        // [CREATE_QUEST: name="..." desc="..." dir="..."] — the
        // existing create-quest command. Kept here for parity.
        const questMatch = result.reply.match(/\[CREATE_QUEST:\s*name="([^"]+)"\s*desc="([^"]*)"\s*(?:dir="([^"]*)")?\]/);
        if (questMatch) {
          const qName = questMatch[1];
          const qDesc = questMatch[2] || '';
          const qDir = questMatch[3] || '';
          try {
            await cyberclaw.quests.create({ name: qName, description: qDesc, directory: qDir || undefined });
            addChatMsg('system', '📜 Quest created: ' + qName);
            renderQuests();
          } catch(qe) {
            addChatMsg('system', '⚠️ Failed to create quest: ' + qe.message);
          }
        }
      }

      // Drain happiness based on work done (longer reply = more effort)
      if (window.adjustHappiness && result.reply) {
        const len = result.reply.length;
        const drain = len < 200 ? 0 : len < 500 ? -1 : len < 1000 ? -2 : -3; // v3.6.12: gentler, so happiness lasts a day
        window.adjustHappiness(drain);
      }

      // Award XP to the best-matching companion based on task type
      await awardXpForReply(result, mainAgentId);
    } else {
      // Surface the verbose stderr / output from the failed agent run so the user can see what actually went wrong.
      const friendly = describeAgentError(result.error);
      const verbose = (typeof result.cliStderr === 'string' && result.cliStderr)
        || (typeof result.output === 'string' && result.output)
        || '';
      const trimmed = verbose.length > 600
        ? verbose.slice(0, 600) + '\n… (truncated; full output in desktop log)'
        : verbose;
      if (trimmed) {
        addChatMsg('error', `Error: ${friendly}\n\n\`\`\`\n${trimmed}\n\`\`\``);
      } else {
        addChatMsg('error', `Error: ${friendly}`);
      }
    }
  } catch (err) {
    clearEscalation();
    removeChatMsg(typingId);
    addChatMsg('error', `Error: ${err.message}`);
  }

  chatBusy = false;
  { const _sb = document.getElementById('chat-send'); if (_sb) _sb.disabled = false; }
  input.focus();
};

/** Send a chat message programmatically (used by mobile sync, voice, etc.) Unlike sendChat() which reads from the DOM input, this takes text… */
window.sendChatMessage = async function(message, attachments) {
  // Resolve the chain key without running any IPC.
  const chainKey = (agentOrder && agentOrder[focusIndex])
    || (agentOrder && agentOrder[0])
    || '_default';
  const prev = chatSendChain.get(chainKey);
  let resolveCurrent;
  const currentPromise = new Promise(r => { resolveCurrent = r; });
  chatSendChain.set(chainKey, currentPromise);
  if (prev) {
    try { await prev; } catch (_) { /* swallow; the prev call surfaced its own error */ }
  }
  // Now the queued body runs.
  try {
    await __sendChatMessageImpl(message, attachments);
  } finally {
    resolveCurrent();
    // If we're still the head of the chain, remove ourselves
    // so the map doesn't grow unbounded. If a new call has
    // already replaced us, leave it.
    if (chatSendChain.get(chainKey) === currentPromise) {
      chatSendChain.delete(chainKey);
    }
  }
};

// Accepts an optional attachments array for multimodal (text + image) chat.
const __sendChatMessageImpl = async function(message, attachments) {
  window.addDesktopLog?.('📨', 'sendChatMessage called', `busy=${chatBusy} agents=${agentOrder.length} msg="${(message||'').substring(0,40)}" atts=${(attachments||[]).length}`, 'info');
  // Allow empty message when attachments are present (an image-only send).
  if (!message && (!attachments || attachments.length === 0)) return;
  // v3.6.5: wake only the companion being talked to (stays awake while it works, +3 min).
  { const _wid = pickCurrentCompanionId(); if (_wid) window._companionAwakeUntil[_wid] = Date.now() + COMPANION_AFTER_WORK_AWAKE_MS; }
  // ALSO explicitly flip sleepState from 'sleeping' to 'awake' for the active companion.
  const wakeTargetId = agentOrder[focusIndex] || pickCurrentCompanionId();
  if (wakeTargetId && agents[wakeTargetId] && agents[wakeTargetId].sleepState === 'sleeping') {
    agents[wakeTargetId].sleepState = 'awake';
    if (pixelArena && pixelArena.companion && pixelArena.companion.id === wakeTargetId) {
      pixelArena.companion.sleepState = 'awake';
      pixelArena.companion.vx = 0;
      pixelArena.companion.vy = 0;
      pixelArena.companion.frame = 0;
    }
    addChatMsg('system', `☀️ ${agents[wakeTargetId].name} woke up`);
    // v3.10.3: tell the mobile that the wake happened so
    // its sleeping sprite visually un-grays immediately.
    try { broadcastAgentsListToMobile(); } catch (_) {}
  }
  bumpCompanionInteraction(wakeTargetId); // reset auto-sleep timer
  if (chatBusy) {
    console.warn('[sendChatMessage] chatBusy=true, queuing message:', message.substring(0, 60));
    // Also surface this in the desktop log so the user can see when a message is being held up.
    window.addDesktopLog?.('⏳', 'Waiting for previous AI reply', message.substring(0, 60), 'warn');
    // Bumped 15s → 90s.
    const startWait = Date.now();
    while (chatBusy && Date.now() - startWait < 95000) {
      await new Promise(r => setTimeout(r, 200));
    }
    if (chatBusy) {
      console.warn('[sendChatMessage] chatBusy stuck > 95s, force-resetting');
      window.addDesktopLog?.('⚠️', 'AI reply stuck > 95s, force-resetting', message.substring(0, 60), 'warn');
      chatBusy = false;
    }
  }
  if (agentOrder.length === 0) {
    console.warn('[sendChatMessage] No agents loaded yet, waiting...');
    window.addDesktopLog?.('⏳', 'Waiting for agents to load', '', 'warn');
    let waited = 0;
    while (agentOrder.length === 0 && waited < 10000) {
      await new Promise(r => setTimeout(r, 300));
      waited += 300;
    }
    if (agentOrder.length === 0) {
      window.addDesktopLog?.('❌', 'No agents loaded — message dropped', message.substring(0, 60), 'error');
      return;
    }
  }

  const mainAgentId = pickCurrentCompanionId();
  if (!mainAgentId) { addChatMsg('error', 'No companion found'); return; }

  // v3.1.3: auto-wake the target companion so they can reply.
  // v3.1.4: also clear pixelArena.companion.sleepState so the arena
  // update loop doesn't snap the sprite back to death.
  if (agents[mainAgentId].sleepState === 'sleeping') {
    agents[mainAgentId].sleepState = 'awake';
    if (pixelArena && pixelArena.companion && pixelArena.companion.id === mainAgentId) {
      pixelArena.companion.sleepState = 'awake';
      pixelArena.companion.vx = 0;
      pixelArena.companion.vy = 0;
      pixelArena.companion.frame = 0;
    }
  }
  bumpCompanionInteraction(mainAgentId); // v3.1.4: reset auto-sleep timer

  const agent = agents[mainAgentId];
  if (!agent) return;

  let fullMessage = message;

  // Always inject the quest-tools hint.
  fullMessage = buildQuestToolsHint() + fullMessage;

  // v3.2.48: append the work-first reminder. See the
  // matching block in sendChat() for the full rationale.
  fullMessage = fullMessage + '\n\n' + buildWorkFirstSuffix();

  // Add quest context if active
  if (activeQuestId) {
    try {
      // Cap the quest-list IPC at 3s.
      const quests = await Promise.race([
        cyberclaw.quests.list(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('quests.list timeout')), 3000)),
      ]);
      const q = quests.find(q => q.id === activeQuestId);
      if (q) {
        // v3.1.50: same context builder as the regular chat path.
        // Goals + recent changes get injected here too, so voice
        // mode has the same project context as typed chat.
        fullMessage = await buildActiveQuestContext(q) + fullMessage;
      }
    } catch (e) {
      console.warn('[sendChatMessage] quest context fetch failed (continuing without):', e?.message);
    }
  }

  chatBusy = true;
  // Log here so the user can see the message actually reached the agent-call stage.
  window.addDesktopLog?.('🧠', 'AI thinking', message.substring(0, 60), 'voice');
  console.log('[sendChatMessage] dispatching to agent, mainAgentId:', mainAgentId);
  const typingId = addChatMsg('typing', `${agent.name} is thinking...`);
  try { ipcRenderer.invoke('sync-broadcast-typing', { active: true }); } catch {}

  // Typed inputs sometimes left the "thinking..." bubble stuck on the user's screen when the openclaw call hung or was abandoned.
  const AGENT_TIMEOUT_MS = 1800000; // 1800s = 30 min
  const typingFailsafe = setTimeout(() => {
    console.warn('[sendChatMessage] typing bubble > 1500s, force-clearing');
    window.addDesktopLog?.('⚠️', 'AI still thinking after 600s — clearing indicator', message.substring(0, 60), 'warn');
    try { removeChatMsg(typingId); } catch {}
    try { ipcRenderer.invoke('sync-broadcast-typing', { active: false }); } catch {}
  }, 600000);

  try {
    let result;
    try {
      result = await Promise.race([
        // v3.2.51: pass attachments (multimodal content).
        cyberclaw.chat.sendMessage(mainAgentId, fullMessage, attachments),
        new Promise((_, reject) =>
          // AGENT_TIMEOUT_MS is 900s (900000).
          setTimeout(() => reject(new Error('agent call timed out (current cap is AGENT_TIMEOUT_MS=' + AGENT_TIMEOUT_MS + 'ms=' + (AGENT_TIMEOUT_MS/1000) + 's) — the LLM call may still complete in the background')), AGENT_TIMEOUT_MS)
        ),
      ]);
    } catch (timeoutErr) {
      // Surface the timeout as an error message in the chat
      // and let the user retry. Without this the user just
      // sees the typing bubble forever.
      window.addDesktopLog?.('⏱️', 'Agent call exceeded UI cap', message.substring(0, 60), 'warn');
      throw timeoutErr;
    }
    removeChatMsg(typingId);
    try { ipcRenderer.invoke('sync-broadcast-typing', { active: false }); } catch {}

    if (result.ok) {
      const leader = agents[mainAgentId];
      // See sibling site — strip the desktop's 🤖 default before sending.
      const _leaderName = leader?.name || 'Companion';
      const _leaderEmoji = (leader?.emoji === '🤖') ? null : (leader?.emoji || getSpriteIcon(leader?._pixelCompanionId));
      postAgentReplyWithScreenshots(result, _leaderName, _leaderEmoji);
      window.addDesktopLog?.('💬', 'AI responded', stripAgentReplyDecorations(result.reply).substring(0, 60), 'success');
      // Notify main process for mobile TTS response
      try { ipcRenderer.send('mobile-tts-response', { text: stripAgentReplyDecorations(result.reply) }); } catch {}
      // Award XP for this reply.
      await awardXpForReply(result, mainAgentId);
    } else {
      // Surface the verbose stderr / output from the failed agent run (mirrors the v3.3.17 fix in the desktop sendChatMessage path above).
      const friendly = describeAgentError(result.error);
      const verbose = (typeof result.cliStderr === 'string' && result.cliStderr)
        || (typeof result.output === 'string' && result.output)
        || '';
      const trimmed = verbose.length > 600
        ? verbose.slice(0, 600) + '\n… (truncated; full output in desktop log)'
        : verbose;
      if (trimmed) {
        addChatMsg('error', `Error: ${friendly}\n\n\`\`\`\n${trimmed}\n\`\`\``);
      } else {
        addChatMsg('error', `Error: ${friendly}`);
      }
    }
  } catch (err) {
    addChatMsg('error', `Error: ${err.message}`);
  } finally {
    // Clear the typing bubble + chatBusy flag unconditionally.
    clearTimeout(typingFailsafe);
    try { removeChatMsg(typingId); } catch {}
    try { ipcRenderer.invoke('sync-broadcast-typing', { active: false }); } catch {}
    chatBusy = false;
  }
};

let chatMsgId = 0;
let chatHistory = []; // Backwards-compat flat history (also kept in sync for mobile)
// v3.3.18: module-scope cache of the last quests list
// received via the `quests-updated` IPC. Used by
// addChatMsg (a sync function that can't await
// cyberclaw.quests.list()) to stamp activeQuestName
// onto each chat message for the mobile's bubble
// header (v3.11.5). Falls back to null name if the
// cache is cold.
let cachedQuestsList = [];
// Each (companion, quest) pair has its own chat history.
const DEFAULT_QUEST_KEY = '__default__';
function questKeyForStorage(qid) {
  return qid == null ? DEFAULT_QUEST_KEY : qid;
}
function questKeyFromStorage(key) {
  return key === DEFAULT_QUEST_KEY ? null : key;
}
let chatHistoryByAgentAndQuest = {};
// Keep the old name as a getter for any reader that hasn't been updated yet.
function chatHistoryByAgent(aid) {
  // Return the active quest's bucket for this agent, falling
  // back to the default bucket if no quest is active.
  const buckets = chatHistoryByAgentAndQuest[aid] || {};
  const qid = questKeyForStorage(activeQuestId);
  return buckets[qid] || buckets[DEFAULT_QUEST_KEY] || [];
}
let activeChatAgentId = null;
// Scroll offset per (agent, quest) pair.
let chatScrollOffsetByAgentAndQuest = {};
// v3.3.11: debounced persist for the scroll-offset map.
let _persistChatScrollTimer = null;
function schedulePersistChatScroll() {
  if (_persistChatScrollTimer) return;
  _persistChatScrollTimer = setTimeout(() => {
    _persistChatScrollTimer = null;
    try {
      localStorage.setItem('cyberclaw-chat-scroll-byagent-byquest', JSON.stringify(chatScrollOffsetByAgentAndQuest));
    } catch (e) {
      console.warn('[Persist] Failed to write chat-scroll-byagent-byquest:', e.message);
    }
  }, 500);
}
function restoreChatScroll() {
  try {
    const rawNew = localStorage.getItem('cyberclaw-chat-scroll-byagent-byquest');
    if (rawNew) {
      const parsed = JSON.parse(rawNew);
      if (parsed && typeof parsed === 'object') {
        const cleaned = {};
        for (const [k, v] of Object.entries(parsed)) {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0) cleaned[k] = n;
        }
        chatScrollOffsetByAgentAndQuest = cleaned;
      }
      return;
    }
    // Migrate from the old per-agent-only key.
    const rawOld = localStorage.getItem('cyberclaw-chat-scroll-byagent');
    if (rawOld) {
      const parsed = JSON.parse(rawOld);
      if (parsed && typeof parsed === 'object') {
        const migrated = {};
        for (const [aid, v] of Object.entries(parsed)) {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0) {
            migrated[`${aid}::${DEFAULT_QUEST_KEY}`] = n;
          }
        }
        chatScrollOffsetByAgentAndQuest = migrated;
        try {
          localStorage.setItem('cyberclaw-chat-scroll-byagent-byquest', JSON.stringify(migrated));
          localStorage.removeItem('cyberclaw-chat-scroll-byagent');
        } catch (e) {
          console.warn('[Persist] Failed to upgrade scroll-offset key:', e.message);
        }
      }
    }
  } catch (e) {
    console.warn('[Persist] Failed to read chat-scroll:', e.message);
  }
}
// Companions hidden from the arena (still editable, still chatable — just
// not rendered in the pixel arena). Keys are agent ids.
let hiddenCompanions = new Set();
// Last-read timestamp per companion (for unread badges in the channel tabs).
let lastReadTsByAgent = {};
// Track last date for separators (one cursor per companion)
let lastChatDateByAgent = {};
let lastEventDate = null;

// Helper to format date separator
function getDateString(date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const checkDate = new Date(date);
  checkDate.setHours(0, 0, 0, 0);
  
  const diffMs = today - checkDate;
  const diffDays = diffMs / (24 * 60 * 60 * 1000);
  
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);
  
  if (diffDays < 7) return date.toLocaleDateString('en-US', { weekday: 'long' });
  if (diffWeeks === 1) return 'Last week';
  if (diffWeeks < 4) return `${diffWeeks} weeks ago`;
  if (diffMonths === 1) return 'Last month';
  if (diffMonths < 12) return `${diffMonths} months ago`;
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// Helper to check if we need a date separator
function checkDateSeparator(lastDate, newDate, container) {
  const lastDateString = lastDate ? lastDate.toDateString() : null;
  const newDateString = newDate.toDateString();
  
  if (lastDateString !== newDateString) {
    const sep = document.createElement('div');
    sep.className = 'date-separator';
    sep.textContent = getDateString(newDate);
    container.appendChild(sep);
    return newDate;
  }
  return lastDate;
}

// Map a display name back to an agentId. Used to bucket chat messages
// into the right per-companion history. Returns null if not found.
function agentIdForName(name) {
  if (!name) return null;
  for (const id of agentOrder) {
    if (agents[id] && agents[id].name === name) return id;
  }
  return null;
}

// Pick the "current" companion for chat / idle / reaction flows in v3.1.3+.
// Preference order: active chat channel > first non-hidden > first agent.
function pickCurrentCompanionId() {
  if (activeChatAgentId && agents[activeChatAgentId]) return activeChatAgentId;
  const first = agentOrder.find(id => !hiddenCompanions.has(id));
  if (first) return first;
  return agentOrder[0] || null;
}

// Debounced persist for chatHistoryByAgent.
let _persistChatHistoryTimer = null;
function schedulePersistChatHistory() {
  if (_persistChatHistoryTimer) return;
  _persistChatHistoryTimer = setTimeout(() => {
    _persistChatHistoryTimer = null;
    try {
      // Don't write empty caches (avoids wiping storage on a
      // transient empty state).
      const nonEmpty = Object.entries(chatHistoryByAgentAndQuest).filter(
        ([, buckets]) =>
          buckets &&
          typeof buckets === 'object' &&
          Object.values(buckets).some(
            (v) => Array.isArray(v) && v.length > 0,
          ),
      );
      if (nonEmpty.length === 0) return;
      const out = {};
      for (const [aid, buckets] of nonEmpty) {
        const trimmed = {};
        for (const [qidKey, msgs] of Object.entries(buckets)) {
          if (!Array.isArray(msgs) || msgs.length === 0) continue;
          // Keep the last 200 per (agent, quest) bucket.
          trimmed[qidKey] = msgs.slice(-200);
        }
        if (Object.keys(trimmed).length > 0) out[aid] = trimmed;
      }
      if (Object.keys(out).length === 0) return;
      localStorage.setItem('cyberclaw-chat-byagent-byquest', JSON.stringify(out));
      // Remove the old key once we've written the new one.
      // Best-effort — if the write above failed, the old key
      // still has the data and the next launch will re-migrate.
      localStorage.removeItem('cyberclaw-chat-byagent');
    } catch (e) {
      console.warn('[Persist] Failed to write chat-byagent-byquest:', e.message);
    }
  }, 2000);
}

// Restore chatHistoryByAgent from localStorage on app start.
function restoreChatHistory() {
  try {
    // v3.3.11: prefer the new per-quest key.
    const rawNew = localStorage.getItem('cyberclaw-chat-byagent-byquest');
    if (rawNew) {
      const parsed = JSON.parse(rawNew);
      if (parsed && typeof parsed === 'object') {
        chatHistoryByAgentAndQuest = {};
        for (const [agentId, buckets] of Object.entries(parsed)) {
          if (!buckets || typeof buckets !== 'object') continue;
          const migratedBuckets = {};
          for (const [qidKey, msgs] of Object.entries(buckets)) {
            if (!Array.isArray(msgs) || msgs.length === 0) continue;
            const qk = qidKey === 'null' ? DEFAULT_QUEST_KEY : qidKey;
            migratedBuckets[qk] = msgs;
          }
          if (Object.keys(migratedBuckets).length > 0) {
            chatHistoryByAgentAndQuest[agentId] = migratedBuckets;
          }
        }
      }
      return;
    }
    // v3.3.11: migrate from the old per-agent-only key.
    const raw = localStorage.getItem('cyberclaw-chat-byagent');
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      // One-shot migration — rewrite any legacy `emoji: '🤖'` entries to the resolved sprite icon (or null) so the chat message prefix shows the…
      let migrated = 0;
      const migratedBuckets = {};
      for (const [agentId, msgs] of Object.entries(parsed)) {
        if (!Array.isArray(msgs)) continue;
        const agent = agents[agentId];
        const fallbackIcon = (agent && agent.emoji && agent.emoji !== '🤖')
          ? agent.emoji
          : getSpriteIcon(agent && agent._pixelCompanionId);
        const cleaned = [];
        for (const m of msgs) {
          if (m && m.emoji === '🤖') {
            m.emoji = fallbackIcon || null;
            migrated++;
          }
          // One-shot strip — clean any legacy tool-warning lines from old chat history.
          if (m && m.type === 'agent' && typeof m.text === 'string') {
            const cleanedText = stripAgentReplyDecorations(m.text);
            if (cleanedText !== m.text) {
              m.text = cleanedText;
            }
          }
        }
      }
      if (migrated > 0) {
        console.log(`[Restore] Migrated ${migrated} legacy 🤖 emoji(s) in chat history to sprite icons`);
      }
      // Migrate the old per-agent shape into the new per-(agent, default-bucket) shape.
      for (const [agentId, msgs] of Object.entries(parsed)) {
        if (!Array.isArray(msgs) || msgs.length === 0) continue;
        if (!chatHistoryByAgentAndQuest[agentId]) chatHistoryByAgentAndQuest[agentId] = {};
        chatHistoryByAgentAndQuest[agentId][DEFAULT_QUEST_KEY] = msgs;
        // Stamp each migrated message with no active quest
        // so future renders can show the bucket attribution.
        for (const m of msgs) {
          if (m && typeof m === 'object') {
            m.activeQuestId = null;
            m.activeQuestName = null;
          }
        }
      }
      // Also rebuild the flat `chatHistory` mirror in chronological
      // order (oldest first) so the legacy code that reads from it
      // still works after a restart.
      chatHistory = [];
      for (const [, msgs] of Object.entries(parsed)) {
        if (Array.isArray(msgs)) chatHistory.push(...msgs);
      }
      chatHistory.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      if (chatHistory.length > 100) chatHistory = chatHistory.slice(-100);
      console.log(`[Restore] Loaded ${Object.keys(parsed).length} agent chat histories from localStorage (migrated to per-quest shape)`);
      // Persist the migrated shape under the new key and
      // remove the old key so the next launch skips the
      // migration path.
      try {
        schedulePersistChatHistory();
      } catch (_) { /* best-effort */ }
    }
  } catch (e) {
    console.warn('[Restore] Failed to load chat-byagent:', e.message);
  }
}

// Parse [SCREENSHOT target=...] directives out of an agent's reply.
function parseScreenshotDirectives(reply) {
  const directives = [];
  // Match [SCREENSHOT ...] on its own line. The regex allows
  // for trailing whitespace + flexible whitespace inside.
  const re = /\[SCREENSHOT([^\]]*)\]/gi;
  let cleaned = reply;
  let m;
  while ((m = re.exec(reply)) !== null) {
    const attrs = (m[1] || '').trim();
    const dir = { target: 'cyberclaw', windowName: null };
    if (attrs) {
      const t = attrs.match(/target\s*=\s*"?([a-zA-Z]+)"?/i);
      if (t) dir.target = t[1].toLowerCase();
      const wn = attrs.match(/windowName\s*=\s*"([^"]+)"/i);
      if (wn) dir.windowName = wn[1];
    }
    directives.push(dir);
  }
  // Strip the directive lines from the visible reply.
  // Also strip the entire line containing the directive
  // so we don't leave a dangling bracket artifact.
  cleaned = cleaned
    .split('\n')
    .filter(line => !re.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')   // collapse extra blank lines
    .trim();
  return { cleanedText: cleaned, directives };
}

// Process an agent reply, strip screenshot directives, render the cleaned text via addChatMsg, then fire one screenshot IPC per directive…
function postAgentReplyWithScreenshots(result, name, emoji) {
  const baseReply = stripAgentReplyDecorations(result.reply || '');
  const { cleanedText, directives } = parseScreenshotDirectives(baseReply);
  // Also strip the directives before passing the text down to quest-tag parsing.
  result.reply = cleanedText;
  // Render the cleaned text as a regular agent bubble.
  // We pass null emoji when the agent's emoji is the
  // desktop default 🤖, mirroring the prior call sites.
  const displayEmoji = (emoji && emoji !== '🤖') ? emoji : null;
  addChatMsg('agent', cleanedText, name, displayEmoji);
  // Fire one screenshot per directive.
  for (const dir of directives) {
    if (!cyberclaw?.screenshot) {
      console.warn('[screenshot] directive parsed but cyberclaw.screenshot not exposed');
      continue;
    }
    cyberclaw.screenshot(dir).then(res => {
      if (!res || !res.ok) {
        addChatMsg('error', `⚠️ Screenshot failed (${dir.target}): ${(res && res.error) || 'unknown error'}`, name, displayEmoji);
        return;
      }
      addChatMsg('agent-image', {
        dataUri: res.dataUri,
        target: res.target,
        width: res.width,
        height: res.height,
        filePath: res.filePath,
      }, name, displayEmoji);
    }).catch(err => {
      addChatMsg('error', `⚠️ Screenshot error: ${err?.message || err}`, name, displayEmoji);
    });
  }
}

function addChatMsg(type, text, name, emoji, attachments, questOverride = null) {
  // Optional quest routing override.
  const effectiveQuestId = (questOverride === '__no_quest__') ? null : (questOverride || activeQuestId);
  // System messages go to the Events tab
  if (type === 'system') {
    return addEventMsg(text);
  }

  // Strip quest tags and tool-warning lines from agent replies before persisting or broadcasting.
  if (type === 'agent') {
    text = stripAgentReplyDecorations(text || '');
  }

  // Resolve the agent id for per-companion bucketing
  const agentId = agentIdForName(name) || activeChatAgentId || (agentOrder[focusIndex]) || null;

  // Keep in-memory chat history for mobile sync v3.3.20: persist `agent-image` bubbles alongside `agent` and `user`.
  let attachmentsForPersistence = null;
  // Also accept attachments passed via the 5th arg (user-attachment send path from the desktop's image-send button, where text is the user's…
  if (Array.isArray(attachments) && attachments.length > 0) {
    // Normalize desktop's image-send attachment shape to the same `{ uri, data, type, name, size }` shape the mobile already understands.
    attachmentsForPersistence = attachments.map((a) => {
      // v3.6.4: images saved on disk are persisted as path + small JPEG
      // thumbnail (no truncated base64, which rendered as a broken image).
      if (a.path) {
        let thumb = '';
        try {
          const ni = require('electron').nativeImage.createFromPath(a.path);
          if (!ni.isEmpty()) { const sz = ni.getSize(); thumb = (sz.width > 720 ? ni.resize({ width: 720 }) : ni).toJPEG(72).toString('base64'); }
        } catch (_) {}
        return { path: a.path, data: thumb, type: 'image/jpeg', name: a.name || a.fileName || 'image', size: a.size || 0 };
      }
      const dataUri = a.dataUri || a.uri || null;
      const base64 = dataUri ? (dataUri.split(',')[1] || '') : (a.data || '');
      // Same size guard as agent-image: cap at 200KB base64
      // for the persisted copy; the realtime broadcast
      // carries the full dataUri.
      const trimmed = base64.length > 200 * 1024 ? base64.slice(0, 50 * 1024) : base64;
      return {
        uri: dataUri,
        data: trimmed,
        type: a.type || a.mimeType || (dataUri ? (dataUri.match(/^data:([^;]+);/) || [])[1] : null) || 'image/png',
        name: a.name || a.fileName || 'attachment',
        size: base64.length,
        thumbOnly: base64.length > 200 * 1024,
      };
    });
  } else if (type === 'agent-image' && text && typeof text === 'object' && text.dataUri) {
    // Cap the persisted attachment size so a single screenshot doesn't blow the bucket cap.
    const dataUri = text.dataUri;
    const base64Part = dataUri.split(',')[1] || '';
    if (base64Part.length <= 200 * 1024) {
      // Inline — full attachment survives history sync.
      attachmentsForPersistence = [{
        uri: dataUri,
        data: base64Part,
        type: (dataUri.match(/^data:([^;]+);/) || [])[1] || 'image/png',
        name: text.target ? `screenshot-${text.target}` : 'screenshot',
        size: base64Part.length,
      }];
    } else {
      // File-reference fallback.
      attachmentsForPersistence = [{
        uri: dataUri,
        data: base64Part.slice(0, 50 * 1024), // tiny thumb
        type: (dataUri.match(/^data:([^;]+);/) || [])[1] || 'image/png',
        name: text.target ? `screenshot-${text.target}` : 'screenshot',
        size: base64Part.length,
        filePath: text.filePath || null,
        thumbOnly: true,
      }];
    }
  }
  if (type === 'agent' || type === 'user' || type === 'agent-image' || type === 'error') {
    // Stamp activeQuestId and activeQuestName on the flat mirror so the mobile can route each message to the correct per-quest bucket on history…
    let activeQuestNameAtAppendForMirror = null;
    try {
      if (typeof effectiveQuestId === 'string' && effectiveQuestId && Array.isArray(cachedQuestsList)) {
        const q = cachedQuestsList.find(qq => qq && qq.id === effectiveQuestId);
        if (q && q.name) activeQuestNameAtAppendForMirror = q.name;
      }
    } catch (_) { /* defensive */ }
    chatHistory.push({
      text: text,
      isUser: type === 'user',
      agentId: name || 'companion',
      ts: Date.now(),
      activeQuestId: (typeof effectiveQuestId === 'string' && effectiveQuestId) ? effectiveQuestId : null,
      activeQuestName: activeQuestNameAtAppendForMirror,
      attachments: attachmentsForPersistence || undefined,
    });
    // Keep only last 100 messages
    if (chatHistory.length > 100) {
      chatHistory = chatHistory.slice(-100);
    }
    // Per-companion history v3.3.11: per-quest bucketing.
    if (agentId) {
      const qk = questKeyForStorage(effectiveQuestId);
      if (!chatHistoryByAgentAndQuest[agentId]) chatHistoryByAgentAndQuest[agentId] = {};
      if (!chatHistoryByAgentAndQuest[agentId][qk]) chatHistoryByAgentAndQuest[agentId][qk] = [];
      // Drop the `activeQuestName` enrichment.
      let activeQuestNameAtAppend = null;
      try {
        if (typeof effectiveQuestId === 'string' && effectiveQuestId && Array.isArray(cachedQuestsList)) {
          const q = cachedQuestsList.find(qq => qq && qq.id === effectiveQuestId);
          if (q && q.name) activeQuestNameAtAppend = q.name;
        }
      } catch (_) { /* defensive — fall back to null name */ }
      chatHistoryByAgentAndQuest[agentId][qk].push({ type, text, name, emoji, ts: Date.now(), activeQuestId: effectiveQuestId || null, activeQuestName: activeQuestNameAtAppend, attachments: attachmentsForPersistence || undefined });
      if (chatHistoryByAgentAndQuest[agentId][qk].length > 200) {
        chatHistoryByAgentAndQuest[agentId][qk] = chatHistoryByAgentAndQuest[agentId][qk].slice(-200);
      }
    }

    // Persist per-companion chat history to localStorage so it survives a desktop restart.
    schedulePersistChatHistory();

    // Per-quest conversation log.
    if (effectiveQuestId) {
      try {
        cyberclaw.quests.appendConversationLog(
          effectiveQuestId,
          type, // 'user' or 'agent' or 'error'
          text,
          agentId,
          name || null,
        ).catch((err) => {
          // Quiet failure: the per-quest log isn't
          // critical to the chat UX; just log so we can
          // diagnose if it happens often.
          console.warn('[ConversationLog] append failed:', err?.message);
        });
      } catch (_) { /* IPC not ready yet — skip silently */ }
    }
  }

  // Broadcast to mobile companion app v3.2.46: also broadcast error messages.
  if (type === 'agent' || type === 'user' || type === 'error' || type === 'agent-image') {
    try {
      const { ipcRenderer } = require('electron');
      // Send the resolved agentId (not just the display name) plus the display name separately, so the mobile can label chat messages correctly…
      let broadcastText = text;
      let broadcastAttachments = null;
      let broadcastIsUser = type === 'user';
      // Forward user-side attachments (desktop image-send) on the chat_message broadcast.
      if (Array.isArray(attachments) && attachments.length > 0) {
        broadcastAttachments = attachments.map((a) => {
          const dataUri = a.dataUri || a.uri || null;
          const base64 = dataUri ? (dataUri.split(',')[1] || '') : (a.data || '');
          return {
            uri: dataUri,
            data: base64,
            type: a.type || a.mimeType || (dataUri ? (dataUri.match(/^data:([^;]+);/) || [])[1] : null) || 'image/png',
            name: a.name || a.fileName || 'attachment',
            size: base64.length,
          };
        });
      }
      if (type === 'agent-image') {
        const img = text || {};
        const dataUri = img.dataUri || null;
        if (dataUri) {
          // Strip the `data:<mime>;base64,` prefix into the shape the mobile's AttachmentItem expects.
          const m = /^data:([^;]+);base64,(.*)$/.exec(dataUri);
          const mime = (m && m[1]) || 'image/png';
          const data = (m && m[2]) || dataUri;
          broadcastAttachments = [{
            uri: dataUri,            // for any code that reads uri directly
            data,                    // raw base64 — used by the bubble renderer
            type: mime,
            name: (img.target ? `screenshot-${img.target}` : 'screenshot'),
            // size is bytes of the base64 string (rough
            // proxy — the mobile doesn't actually use it for
            // images, only for non-image file cards).
            size: data.length,
          }];
        }
        // Image bubbles are agent-side.
        broadcastText = '';
        broadcastIsUser = false;
      }
      // Compute the broadcast quest id with a fallback before the object literal so we don't need to use let inside the literal.
      let broadcastActiveQuestId = (typeof effectiveQuestId === 'string' && effectiveQuestId) ? effectiveQuestId : null;
      if (!broadcastActiveQuestId && questOverride == null && Array.isArray(cachedQuestsList)) {
        const fallbackQ = cachedQuestsList.find(qq => qq && qq.active === true);
        if (fallbackQ && fallbackQ.id) {
          broadcastActiveQuestId = fallbackQ.id;
        }
      }
      ipcRenderer.invoke('sync-broadcast-chat', {
        agentId: agentId || name || 'companion',
        agentName: name || null,
        text: broadcastText,
        isUser: broadcastIsUser,
        // Stamp the active quest on the broadcast so the mobile can label each bubble with its quest.
        activeQuestId: broadcastActiveQuestId,
        // Explicit "force to no-quest" flag for companion-reaction bubbles (toy dropped, snack eaten, etc.).
        forceNoQuest: questOverride === '__no_quest__',
        // Include attachments for image bubbles so the mobile's renderMessage can show the thumbnail.
        attachments: broadcastAttachments,
      });
    } catch {}
  }

  // Skip the visible render if this message belongs to a companion whose
  // channel isn't currently shown.
  if (agentId && activeChatAgentId && agentId !== activeChatAgentId && type !== 'typing') {
    // Mark the channel tab as having unread content
    markChannelUnread(agentId);
    return null;
  }
  // Same for chat context.
  if (type !== 'typing' && questKeyForStorage(effectiveQuestId) !== questKeyForStorage(activeQuestId)) {
    const tbtn = document.getElementById('chat-quest-toggle-btn');
    if (tbtn) tbtn.classList.add('has-unread');
    return null;
  }

  const msgs = document.getElementById('chat-messages');
  if (!msgs) return null;
  const now = new Date();
  const cursor = (agentId && lastChatDateByAgent[agentId]) || null;
  lastChatDateByAgent[agentId || '_'] = checkDateSeparator(cursor, now, msgs);
  const div = document.createElement('div');
  const id = `chat-msg-${++chatMsgId}`;
  div.id = id;
  div.className = `chat-msg ${type}`;

  // Per-bubble quest pill (matches the mobile's v3.11.5 activeQuestName pill).
  const activeQuestNameForBubble = (() => {
    // Use effectiveQuestId (the questOverride- aware variant) so the per-bubble quest header reflects the override.
    const qid = effectiveQuestId;
    if (!qid) return null;
    const q = (Array.isArray(cachedQuestsList) ? cachedQuestsList : []).find(qq => qq && qq.id === qid);
    return q ? q.name : null;
  })();
  const questHeaderHtml = activeQuestNameForBubble
    ? `<span class="msg-quest-header">📜 ${escHtml(activeQuestNameForBubble)}</span>`
    : `<span class="msg-quest-header no-quest">— Casual</span>`;

  switch (type) {
    case 'user':
      // Render user-side attachments inline.
      if (Array.isArray(attachments) && attachments.length > 0) {
        let html = questHeaderHtml + `<span class="msg-prefix">[You]</span>`;
        if (text) html += `<span class="msg-text">${escHtml(text)}</span>`;
        for (const att of attachments) {
          const dataUri = att.dataUri || (att.data ? `data:${att.mimeType || 'image/png'};base64,${att.data}` : null);
          if (!dataUri) continue;
          const safeName = escAttr(att.fileName || att.name || 'image');
          html += `<div class="chat-msg-images"><img class="chat-msg-image" src="${escAttr(dataUri)}" data-full="${escAttr(att.path ? 'file://' + att.path : dataUri)}" alt="${safeName}" /></div>`;
        }
        div.innerHTML = html;
      } else {
        div.innerHTML = questHeaderHtml + `<span class="msg-prefix">[You]</span><span class="msg-text">${escHtml(text)}</span>`;
      }
      break;
    case 'agent':
      // Same fix as the other render site — don't show the prefix emoji if it's the desktop's 🤖 default.
      div.innerHTML = questHeaderHtml + `<span class="msg-prefix">${(emoji && emoji !== '🤖') ? emoji + ' ' : ''}[${escHtml(name)}]</span>` + agentTextHtml(text);
      break;
    case 'typing':
      // Include the quest pill on typing bubbles too.
      div.innerHTML = questHeaderHtml + `<span class="msg-text" style="color:var(--text-muted);font-style:italic">${escHtml(text)}</span>`;
      break;
    case 'error':
      // Include the quest pill on error bubbles so the per-bubble quest attribution is consistent across all bubble types.
      div.innerHTML = questHeaderHtml + `<span class="msg-text" style="color:var(--red)">${escHtml(text)}</span>`;
      break;
    case 'agent-image':
      // Image attachment bubble.
      const img = (text && text.dataUri) || '';
      const meta = [];
      if (text && text.target) meta.push(escHtml(text.target));
      if (text && text.width && text.height) meta.push(`${text.width}×${text.height}`);
      if (text && text.filePath) meta.push(escHtml(text.filePath.split('/').pop()));
      div.innerHTML = `
        ${questHeaderHtml}
        <span class="msg-prefix">${(emoji && emoji !== '🤖') ? emoji + ' ' : ''}[${escHtml(name)}]</span>
        <span class="msg-text">
          <img class="chat-image-thumb" src="${img}" alt="${escHtml((text && text.target) || 'screenshot')}" loading="lazy"
               style="display:block; max-width:480px; max-height:320px; border-radius:6px; margin-top:6px; cursor:zoom-in;"
               onclick="if(this.style.maxWidth==='480px'){this.style.maxWidth='100%';this.style.maxHeight='none';this.style.cursor='zoom-out';}else{this.style.maxWidth='480px';this.style.maxHeight='320px';this.style.cursor='zoom-in';}" />
          <span style="display:block; margin-top:4px; font-size:11px; opacity:0.6;">${meta.join(' · ')}</span>
        </span>`;
      break;
  }

  // Right-click → Copy menu on chat messages.
  const messageText = getChatMessageText(div);
  div.setAttribute('data-msg-text', messageText);
  div.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const items = [
      { label: 'Copy', click: () => {
        try { require('electron').clipboard.writeText(messageText); } catch (e2) { console.warn('[chat-msg] clipboard write failed:', e2?.message); }
      } },
      { label: 'Copy with prefix', click: () => {
        const prefix = div.querySelector('.msg-prefix')?.textContent || '';
        const full = (prefix ? prefix + ' ' : '') + messageText;
        try { require('electron').clipboard.writeText(full); } catch (e2) { console.warn('[chat-msg] clipboard write failed:', e2?.message); }
      } },
    ];
    try { require('electron').Menu.buildFromTemplate(items).popup(); } catch (e2) { console.warn('[chat-msg] context menu popup failed:', e2?.message); }
  });

  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return id;
}

// v3.2.47: extract the visible text from a chat message div
// (without HTML markup). Used by the right-click context menu
// for the Copy item.
function getChatMessageText(div) {
  if (!div) return '';
  const textEl = div.querySelector('.msg-text');
  if (!textEl) return div.textContent || '';
  return textEl.textContent || '';
}

// Mark a companion's channel tab as having unread messages.
function markChannelUnread(agentId) {
  if (!agentId) return;
  const tab = document.querySelector(`.channel-tab-companion[data-agent-id="${agentId}"]`);
  if (tab) tab.classList.add('has-unread');
  lastReadTsByAgent[agentId] = lastReadTsByAgent[agentId] || Date.now();
}

let eventMsgId = 0;
function addEventMsg(text) {
  const evts = document.getElementById('event-messages');
  if (!evts) return null;
  const now = new Date();
  lastEventDate = checkDateSeparator(lastEventDate, now, evts);
  const div = document.createElement('div');
  const id = `event-msg-${++eventMsgId}`;
  div.id = id;
  div.className = 'chat-msg system';
  const ts = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  div.innerHTML = '<span class="msg-prefix" style="color:var(--text-muted)">[' + ts + ']</span> <span class="msg-text">' + escHtml(text) + '</span>';
  evts.appendChild(div);
  evts.scrollTop = evts.scrollHeight;

  // Flash the events tab if not active
  var evtTab = document.querySelector('#system-tabs .term-tab[data-tab="events"]');
  if (evtTab && !evtTab.classList.contains('active')) {
    evtTab.classList.add('tab-flash');
    setTimeout(function() { evtTab.classList.remove('tab-flash'); }, 2000);
  }
  return id;
}

function removeChatMsg(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
function escAttr(s) { return escapeAttr(s); }

// Runtime counter
setInterval(() => {
  const s = Math.floor((Date.now() - startTime) / 1000);
  const el = document.getElementById('stat-runtime');
  if (el) el.textContent = [Math.floor(s/3600), Math.floor(s%3600/60), s%60].map(v => String(v).padStart(2,'0')).join(':');
}, 1000);

// Resize carousel on window resize
window.addEventListener('resize', () => { requestAnimationFrame(updateCarousel); });

function updateSystemInfo() {
  // no-op — system info populated elsewhere
}

// Check Anthropic rate limit via gateway
async function updateRateLimit() {
  try {
    const resp = await fetch('http://localhost:18789/v1/models', {
      headers: { 'Authorization': 'Bearer ' + (window._gwToken || '') },
      signal: AbortSignal.timeout(3000),
    });
    // Rate limit headers from Anthropic proxy
    const remaining = resp.headers.get('x-ratelimit-remaining-requests')
      || resp.headers.get('anthropic-ratelimit-requests-remaining');
    const limit = resp.headers.get('x-ratelimit-limit-requests')
      || resp.headers.get('anthropic-ratelimit-requests-limit');
    const el = document.getElementById('stat-ratelimit');
    if (el) {
      if (remaining && limit) {
        el.textContent = `${remaining}/${limit}`;
        el.className = 'stat-value' + (parseInt(remaining) < 5 ? ' red-text' : ' cyan-text');
      } else {
        el.textContent = 'OK';
        el.className = 'stat-value cyan-text';
      }
    }
  } catch {
    const el = document.getElementById('stat-ratelimit');
    if (el) { el.textContent = '—'; el.className = 'stat-value'; }
  }
}

// Debug log to file
const _debugFs = require('fs');
const _debugPath = require('path');
const _debugFile = _debugPath.join(require('os').homedir(), '.openclaw', 'cyberclaw', 'debug.log');
function debugLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  console.log(msg);
  try { _debugFs.appendFileSync(_debugFile, line); } catch {}
}

// Boot
document.addEventListener('DOMContentLoaded', async () => {
  debugLog('=== CyberClaw Boot ===');
  // Restore hidden-companions set from localStorage
  try {
    const stored = JSON.parse(localStorage.getItem('cyberclaw-hidden-companions') || '[]');
    hiddenCompanions = new Set(Array.isArray(stored) ? stored : []);
  } catch {}

  // v3.1.17: restore per-companion chat history from localStorage
  // so the mobile companion tab bar (and the desktop chat view)
  // show the previous conversations after a desktop restart.
  restoreChatHistory();

  // Discover agents from OpenClaw
  await loadAgents();

  // Warm the local-LLM provider cache at startup.
  (async () => {
    try {
      const providers = await cyberclaw.llm.ollama.probeAllLocal();
      // For each companion whose model.primary resolves to a
      // local provider, pre-populate the cache so the first
      // pill render is instant.
      for (const agentId of agentOrder) {
        const a = agents[agentId];
        if (!a || !a.primaryModel) continue;
        const ref = parseModelRef(a.primaryModel);
        if (!ref) continue;
        const local = providers.find(p => p.providerId === ref.providerId);
        if (local) {
          _localProviderCache = {
            isLocal: true,
            model: a.primaryModel,
            baseUrl: local.baseUrl,
            modelId: ref.modelId,
            providerName: local.providerName,
            providerId: ref.providerId,
          };
        }
      }
      // If the user opens a chat before this completes, the
      // pill will fall back to a one-shot resolveLocal call.
    } catch (e) {
      console.warn('[llm-pill] startup probe failed:', e?.message);
    }
  })();

  if (agentOrder.length === 0) {
    console.warn('No companions found');
  }

  debugLog(`Agents loaded: ${agentOrder.length} — ${agentOrder.join(', ')}`);
  try {
    buildCarousel();
    debugLog('buildCarousel done');
    // Load saved background (first boot only — subsequent rebuilds use applyBackground in buildCarousel)
    loadSavedBackground();
    // Start camera render loop for inspect panel
    startCameraLoop();
  } catch (e) {
    debugLog('buildCarousel CRASHED: ' + e.message + '\n' + e.stack);
  }
  // Initialise the chat channel tabs and pick the default chat target.
  // v3.1.3: no leader — default to the first agent in sort order (which
  // is now alphabetical after we removed the party-leader-first sort).
  renderCompanionChannelTabs();
  const initialChat = pickCurrentCompanionId() || agentOrder[0];
  if (initialChat) {
    activeChatAgentId = initialChat;
    const focusIdx = agentOrder.indexOf(initialChat);
    if (focusIdx >= 0) focusIndex = focusIdx;
    switchActiveChat(initialChat);
  }
  updateSystemInfo();

  // Populate system info
  try {
    const sysInfo = await cyberclaw.agents.systemInfo();
    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setEl('stat-host', sysInfo.host);
    setEl('stat-os', sysInfo.os);
    setEl('stat-node', 'v' + sysInfo.node);
    setEl('stat-gateway', ':' + sysInfo.gatewayPort);
  } catch {}

  // Right panel shows focused companion
  try { if (agentOrder[focusIndex]) updateInspect(agentOrder[focusIndex]); debugLog('updateInspect done'); } catch (e) { debugLog('[Boot] ERROR Inspect: ' + e.message + '\n' + e.stack); }

  try { initMainTerminal(); debugLog('initMainTerminal done'); } catch (e) { debugLog('[Boot] ERROR Terminal: ' + e.message + '\n' + e.stack); }

  // Chat input Enter key
  document.getElementById('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window.sendChat(); }
  });

  // ── Chat / input vertical resizer ─────────────────────────────
  // Drag the bar between #chat-messages and #chat-input-area to grow
  // the input area (and shrink the messages) or vice versa.
  (function setupChatResizer() {
    const resizer = document.getElementById('chat-resizer');
    const inputArea = document.getElementById('chat-input-area');
    const messages = document.getElementById('chat-messages');
    const STORAGE_KEY = 'cyberclaw-input-height';
    const MIN_INPUT = 56;   // ~2 lines worth
    const MAX_INPUT = 360;  // generous cap

    // Restore saved height
    try {
      const saved = parseInt(localStorage.getItem(STORAGE_KEY) || '', 10);
      if (saved >= MIN_INPUT && saved <= MAX_INPUT) {
        inputArea.style.flexBasis = saved + 'px';
        inputArea.style.flexGrow = '0';
        inputArea.style.flexShrink = '0';
        inputArea.classList.add('sized'); // v3.6.6: textarea fills the area
        if (messages) { messages.style.flex = '1 1 auto'; }
      }
    } catch {}

    if (!resizer) return;
    let dragging = false;
    let startY = 0;
    let startH = 0;

    resizer.addEventListener('mousedown', (e) => {
      dragging = true;
      startY = e.clientY;
      startH = inputArea.getBoundingClientRect().height;
      resizer.classList.add('dragging');
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      // The resizer sits at the TOP of the input area.
      const delta = e.clientY - startY;
      let newH = Math.max(MIN_INPUT, Math.min(MAX_INPUT, startH - delta));
      inputArea.style.flexBasis = newH + 'px';
      inputArea.style.flexGrow = '0';
      inputArea.style.flexShrink = '0';
      // v3.6.6: the text box itself grows/shrinks with the area (was only
      // its max-height, so dragging changed nothing you could see).
      inputArea.classList.add('sized');
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove('dragging');
      document.body.style.userSelect = '';
      const finalH = Math.round(inputArea.getBoundingClientRect().height);
      try { localStorage.setItem(STORAGE_KEY, String(finalH)); } catch {}
    });

    // Double-click the bar = reset to default 2-line height
    resizer.addEventListener('dblclick', () => {
      inputArea.style.flexBasis = '';
      inputArea.style.flexGrow = '';
      inputArea.style.flexShrink = '';
      if (messages) { messages.style.flex = ''; }
      const textarea = document.getElementById('chat-input');
      if (textarea) textarea.style.maxHeight = '';
      try { localStorage.removeItem(STORAGE_KEY); } catch {}
    });
  })();

  // Typing watcher — companion reacts if user types but doesn't send for 30s+
  (function() {
    var typingTimer = null;
    var lastTypedLen = 0;
    var typingComments = [
      'Are you going to send that or what? 👀',
      'I can see you typing over there...',
      'Just hit send already, I\'m curious.',
      'Taking your time with that one huh.',
      'You deleted it again, didn\'t you.',
    ];
    document.getElementById('chat-input').addEventListener('input', function() {
      var val = this.value.trim();
      // Clear any existing timer
      if (typingTimer) clearTimeout(typingTimer);
      if (!val) { lastTypedLen = 0; return; }

      lastTypedLen = val.length;
      // Set timer — if still has content after 30s, react
      typingTimer = setTimeout(function() {
        var currentVal = document.getElementById('chat-input').value.trim();
        if (currentVal.length > 3) { // still has content
          var msg = typingComments[Math.floor(Math.random() * typingComments.length)];
          var arena = window.pixelArena;
          if (arena && arena.showBubble) arena.showBubble(msg, 8000);
          // Also add to chat (no agent call — instant reaction)
          var agentId = pickCurrentCompanionId();
          var agent = agentId ? agents[agentId] : null;
          // Strip the desktop's 🤖 default before sending.
          if (agent) addChatMsg('agent', msg, agent.name, agent.emoji === '🤖' ? null : (agent.emoji || getSpriteIcon(agent._pixelCompanionId)), null, '__no_quest__');
        }
        typingTimer = null;
      }, 30000);
    });
  })();

  debugLog('Reached boot messages section');
  // Boot messages in chat
  const msgs = document.getElementById('chat-messages');
  debugLog('[Chat] chat-messages element: ' + (msgs ? 'found' : 'NOT FOUND'));
  const bootMsgs = [
    { d: 400,  t: `> CyberClaw v${APP_VERSION} initializing...` },
  ];

  if (agentOrder.length > 0) {
    const mainId = pickCurrentCompanionId();
    const focus = mainId ? agents[mainId] : agents[agentOrder[0]];
    const otherCount = agentOrder.length - 1;
    bootMsgs.push({ d: 900, t: `> Chatting with: ${focus?.name || 'Unknown'}` });
    if (otherCount > 0) {
      bootMsgs.push({ d: 1200, t: `> ${otherCount} other companion${otherCount > 1 ? 's' : ''} available — use the channel tabs to switch` });
    }
    bootMsgs.push({
      d: 1500,
      t: '> Ready. Chat with your companion below. ⚔️'
    });
  } else {
    bootMsgs.push({ d: 900, t: '> No companion found. Run OpenClaw Doctor or create one to get started!' });
  }

  // Always show a system ready message
  bootMsgs.push({
    d: bootMsgs.length > 0 ? bootMsgs[bootMsgs.length - 1].d + 500 : 500,
    t: `> CyberClaw v${APP_VERSION} online.`
  });

  // Boot lines live in their own block that is always the first child of #chat-messages (switchActiveChat re-attaches it).
  const bootLog = document.createElement('div');
  bootLog.id = 'chat-boot-log';
  window._chatBootLog = bootLog;
  if (msgs) msgs.insertBefore(bootLog, msgs.firstChild);
  bootMsgs.forEach(({ d, t }) => {
    setTimeout(() => {
      const div = document.createElement('div');
      div.className = 'chat-msg system';
      div.innerHTML = `<span class="msg-text">${t}</span>`;
      bootLog.appendChild(div);
      if (msgs && bootLog.parentNode !== msgs) msgs.insertBefore(bootLog, msgs.firstChild);
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
    }, d);
  });

  // Periodically refresh agent data (every 30s) — smooth update without DOM rebuild
  setInterval(async () => {
    const oldFocusId = agentOrder[focusIndex];
    const oldOrder = [...agentOrder];
    await loadAgents();

    // Only rebuild carousel DOM if REAL agents changed (ignore subagent churn)
    const realOld = oldOrder.filter(id => !id.startsWith('subagent-'));
    const realNew = agentOrder.filter(id => !id.startsWith('subagent-'));
    const orderChanged = realNew.length !== realOld.length || realNew.some((id, i) => id !== realOld[i]);
    if (orderChanged) {
      const newIndex = agentOrder.indexOf(oldFocusId);
      focusIndex = newIndex >= 0 ? newIndex : 0;
      buildCarousel();
    } else {
      // Just update status dots and data without rebuilding
      const newIndex = agentOrder.indexOf(oldFocusId);
      focusIndex = newIndex >= 0 ? newIndex : 0;
      document.querySelectorAll('.carousel-agent').forEach(el => {
        const id = el.getAttribute('data-id');
        const agent = agents[id];
        if (!agent) return;
        const statusDot = el.querySelector('.carousel-status');
        if (statusDot) { statusDot.className = `carousel-status ${agent.status}`; }
      });
      updateFocused(agentOrder[focusIndex]);
    }

    updateSystemInfo();
    if (agentOrder[focusIndex]) updateInspect(agentOrder[focusIndex]);
    updateRateLimit();
  }, 30000);

  // Initial rate limit check
  updateRateLimit();
});

// ---------------------------------------------------------------------------
// Update Check
// ---------------------------------------------------------------------------
const APP_VERSION = require('../package.json').version;

// Set version label on load (single display in titlebar)
document.addEventListener('DOMContentLoaded', () => {
  const label = document.getElementById('update-label');
  if (label) label.textContent = `v${APP_VERSION}`;
  // v3.2.1: render provider presets on boot so they're already in the DOM
  // before the user opens settings (saves a paint flicker).
  try { renderProviderPresets(); } catch (e) { console.warn('renderProviderPresets:', e); }
  // Restore the persisted chat scroll-offset map and wire the chat-messages scroll listener that saves scrollTop per (agent, quest).
  try { restoreChatScroll(); } catch (e) { console.warn('restoreChatScroll:', e); }
  const chatMsgs = document.getElementById('chat-messages');
  if (chatMsgs) {
    chatMsgs.addEventListener('scroll', () => {
      const aid = activeChatAgentId;
      if (!aid) return;
      const qk = questKeyForStorage(activeQuestId);
      const key = `${aid}::${qk}`;
      chatScrollOffsetByAgentAndQuest[key] = chatMsgs.scrollTop;
      schedulePersistChatScroll();
    }, { passive: true });
  }
});

window.checkForUpdate = async function() {
  const btn = document.getElementById('update-check-btn');
  const icon = document.getElementById('update-icon');
  const label = document.getElementById('update-label');
  if (!btn) return;

  icon.textContent = '⏳';
  label.textContent = 'Checking...';

  try {
    const resp = await fetch('https://cyberhive.no/api/software/version/cyberclaw', {
      signal: AbortSignal.timeout(8000)
    });
    const data = await resp.json();

    if (data.latest && data.latest !== APP_VERSION) {
      icon.textContent = '🆕';
      label.textContent = `v${data.latest} available!`;
      btn.classList.add('update-available');
      btn.classList.remove('up-to-date');
      btn.onclick = () => {
        cyberclaw.window.openExternal(data.download || 'https://cyberhive.no/en/Software/CyberClaw');
      };
    } else {
      icon.textContent = '✅';
      label.textContent = `v${APP_VERSION} (latest)`;
      btn.classList.add('up-to-date');
      btn.classList.remove('update-available');
      setTimeout(() => {
        icon.textContent = '🔄';
        label.textContent = `v${APP_VERSION}`;
        btn.classList.remove('up-to-date');
        btn.onclick = () => checkForUpdate();
      }, 5000);
    }
  } catch (e) {
    console.error('[Update] Check failed:', e);
    icon.textContent = '⚠️';
    label.textContent = `v${APP_VERSION}`;
    setTimeout(() => {
      icon.textContent = '🔄';
      btn.onclick = () => checkForUpdate();
    }, 3000);
  }
};

// ---------------------------------------------------------------------------
// Pixel Companion Integration
// ---------------------------------------------------------------------------
let selectedPixelCompanion = null;
let editorPixelSprite = null;
let cardPixelSprites = {};  // { agentId: PixelSprite }
// switchEditorTab removed — pixel-only editor

function renderPixelGallery() {
  const catalog = loadPixelCatalog();
  const grid = document.getElementById('pixel-gallery');
  if (!grid || !catalog.companions.length) {
    if (grid) grid.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center">No pixel companions found</div>';
    return;
  }

  grid.innerHTML = '';

  catalog.companions.forEach(comp => {
    const card = document.createElement('div');
    card.className = `pixel-companion-card ${selectedPixelCompanion === comp.id ? 'selected' : ''}`;
    card.onclick = () => selectPixelCompanion(comp.id);

    // Create a mini sprite preview
    const previewContainer = document.createElement('div');
    previewContainer.style.cssText = 'width:64px;height:64px;margin:0 auto;';

    const label = document.createElement('div');
    label.className = 'pixel-label';
    label.textContent = comp.name;

    card.appendChild(previewContainer);
    card.appendChild(label);
    grid.appendChild(card);

    // Init a small PixelSprite for preview
    const sprite = new PixelSprite(previewContainer, { scale: 2, direction: 0, animation: 'idle' });
    sprite.show(comp.id);
  });
}


// (renderSpiritGallery / selectSpirit removed in v3.1.1 — all agents are
// companions now.)

window.selectPixelCompanion = function(id) {
  selectedPixelCompanion = id;

  // Update gallery selection
  const catalog = loadPixelCatalog();
  document.querySelectorAll('.pixel-companion-card').forEach(card => {
    const label = card.querySelector('.pixel-label');
    const compName = catalog.companions.find(c => c.id === id)?.name;
    card.classList.toggle('selected', label && label.textContent === compName);
  });

  // Update forge preview
  showForgeCompanion(id);
};

// ---------------------------------------------------------------------------
// Companion Editor (Pixel-only)
// ---------------------------------------------------------------------------
let editorAgentId = null;

// All agents are Companions. The companion forge opens for whoever
// is currently focused.
window.openCompanionEditor = function() {
  const agentId = agentOrder[focusIndex];
  if (!agentId) return;
  openCompanionForge(agentId);
};

// Open the forge pre-configured for a brand-new companion.
let _creatingNewAgent = false; // true while the editor is in "create" mode
let pendingNewCompanionId = null; // set by createNewCompanion's patched save; consumed by saveCompanion

window.createNewCompanion = function() {
  // Don't gate on a focused agent — we may be creating from the
  // main companion section. We just need *some* baseline config.
  const baseline = agents[agentOrder[focusIndex]] || agents[window.leaderId] || Object.values(agents)[0];
  if (!baseline) {
    addChatMsg('error', 'No existing agent to use as a config baseline.');
    return;
  }
  _creatingNewAgent = true;
  editorAgentId = null; // will be assigned by saveCompanion
  selectedPixelCompanion = null;

  // Clear the name field — force the user to type one
  const nameEl = document.getElementById('editor-name');
  if (nameEl) { nameEl.value = ''; nameEl.placeholder = 'Name your new companion…'; nameEl.focus(); }

  // Uncheck all trait checkboxes (start fresh)
  document.querySelectorAll('#forge-traits-grid input[type=checkbox]').forEach(cb => { cb.checked = false; });

  // Reset size slider to default
  currentForgeScale = 4;
  const slider = document.getElementById('forge-size-slider');
  if (slider) slider.value = '4';
  const lbl = document.getElementById('forge-size-value');
  if (lbl) lbl.textContent = '4×';

  // v3.2.26: reset chattiness slider to default 3
  currentForgeChattiness = 3;
  const chatSlider = document.getElementById('forge-chattiness-slider');
  if (chatSlider) chatSlider.value = '3';
  updateForgeChattiness('3');

  // Show a blank preview
  showForgeCompanion('boar'); // harmless default; the picker forces a choice
  renderPixelGallery();
  // Open the picker so the user MUST pick a sprite before saving
  const picker = document.getElementById('companion-picker');
  if (picker) picker.classList.remove('hidden');
  // Reset the new model panel to empty so the user starts fresh on a new companion.
  hydrateForgeModelPanel('');

  // Patch saveCompanion briefly so it refuses to save without a sprite
  // and creates a real openclaw agent on success.
  const origSave = window.saveCompanion;
  window.saveCompanion = async function guardedNewSave() {
    if (!selectedPixelCompanion) {
      addChatMsg('error', 'Pick a companion sprite before saving.');
      return;
    }
    const newName = (document.getElementById('editor-name')?.value || '').trim();
    if (!newName) {
      addChatMsg('error', 'Give your companion a name first.');
      const ne = document.getElementById('editor-name'); if (ne) ne.focus();
      return;
    }
    // Generate a unique id from the name
    const baseId = newName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'companion';
    let id = baseId; let n = 2;
    while (agents[id]) id = baseId + '-' + (n++);
    // v3.3.10: read primaryModel from the new panel
    // (provider + free-text model). Falls back to the
    // desktop default if the user left the panel empty.
    const primaryModel = readForgePrimaryModel() || baseline.primaryModel || '';
    const tools = (baseline.tools && typeof baseline.tools === 'object') ? baseline.tools : { allow: [] };
    let res = null;
    try {
      res = await cyberclaw.openclaw.createAgent({ id, name: newName, workspace: baseline.workspace, model: primaryModel, tools });
    } catch (e) { console.warn('openclaw.createAgent:', e); }
    if (!res || !res.ok) {
      addChatMsg('error', 'Failed to create new companion in openclaw config: ' + (res?.error || 'unknown'));
      return;
    }
    // Restore the original saveCompanion and call it to handle sprite/avatar
    window.saveCompanion = origSave;
    _creatingNewAgent = false;
    pendingNewCompanionId = id;
    editorAgentId = id; // point the original save at the new agent
    // Reload the agents list from openclaw so the new entry is known
    try {
      const list = await cyberclaw.openclaw.listAgents();
      const fresh = (list || []).find(a => a.id === id);
      if (fresh) {
        agents[id] = Object.assign({}, baseline, fresh, {
          isMain: false,
          primaryModel: primaryModel,
          name: newName,
          emoji: '🧸',
        });
        if (!agentOrder.includes(id)) agentOrder.push(id);
      }
    } catch (e) { console.warn('reload agents:', e); }
    // Refresh channel tabs so the new companion appears as a tab
    renderCompanionChannelTabs();
    return origSave.apply(this, arguments);
  };

  // v3.4.1: the forge now lives in Settings → Companions.
  showCompanionPageInSettings('New companion', null, 'looks');
  addChatMsg('system', '✨ Pick a sprite and name your new companion. It will be added to your openclaw agents.');
};

// ── COMPANION FORGE ─────────────────────────────────────────
let forgeCompanionSprite = null;

// Forge sprite size — stored per-companion on the sprite config. Default 4.
let currentForgeScale = 4;

// Chattiness scale (1–5).
let currentForgeChattiness = 3;

// 1=Silent, 2=Quiet, 3=Balanced, 4=Chatty, 5=Very chatty
const CHATTINESS_DESCRIPTIONS = {
  1: 'Silent — never randomly comments.',
  2: 'Quiet — comments every 3–6 hours.',
  3: 'Balanced — comments every 60–90 minutes.',
  4: 'Chatty — comments every 30–60 minutes.',
  5: 'Very chatty — comments every 15–30 minutes.',
};

// Live soul regeneration when the user toggles behaviour traits in the forge.
let currentTraitSoulMap = {};
let currentSoulIsCustom = false;

const _cpSoul = require('./companion-prompts');
function buildSoulFromTraits(traits, name) {
  // v3.4.9: marker-wrapped personality block (see mergeTraitsIntoSoul).
  return _cpSoul.mergeTraitsIntoSoul('', traits, name, currentTraitSoulMap);
}

function showForgeCompanion(pixelId) {
  const viewer = document.getElementById('forge-companion-viewer');
  if (!viewer) return;
  if (forgeCompanionSprite) forgeCompanionSprite.dispose();
  forgeCompanionSprite = new PixelSprite(viewer, { scale: currentForgeScale, direction: 0, animation: 'idle' });
  forgeCompanionSprite.show(pixelId);
}

function updateForgeSize(value) {
  currentForgeScale = parseInt(value, 10) || 4;
  const lbl = document.getElementById('forge-size-value');
  if (lbl) lbl.textContent = currentForgeScale + '×';
  // Re-create the preview at the new scale (preserves the picked sprite)
  if (selectedPixelCompanion) showForgeCompanion(selectedPixelCompanion);
  // Don't write to the sprite config here — the value is captured in currentForgeScale and saved by saveCompanion together with the rest of…
}

// Live chattiness slider update.
function updateForgeChattiness(value) {
  const v = parseInt(value, 10);
  currentForgeChattiness = (v >= 1 && v <= 5) ? v : 3;
  const valLbl = document.getElementById('forge-chattiness-value');
  if (valLbl) valLbl.textContent = String(currentForgeChattiness);
  const descLbl = document.getElementById('forge-chattiness-desc');
  if (descLbl) descLbl.textContent = CHATTINESS_DESCRIPTIONS[currentForgeChattiness] || CHATTINESS_DESCRIPTIONS[3];
}

function openCompanionForge(agentId) {
  editorAgentId = agentId;
  const agent = agents[agentId];
  selectedPixelCompanion = null;

  document.getElementById('editor-name').value = agent.name || '';

  // Hide companion picker by default
  const picker = document.getElementById('companion-picker');
  if (picker) picker.classList.add('hidden');

  // Hydrate the new provider-first model panel.
  hydrateForgeModelPanel(agent.primaryModel || '');
  refreshForgeModelDropdowns().catch(e => console.warn('refreshForgeModelDropdowns:', e));

  // Load saved config and show companion preview
  cyberclaw.agents.getSpriteConfig(agentId).then(config => {
    const pixelId = config?.pixelCompanionId || 'boar';
    selectedPixelCompanion = pixelId;
    // Restore the saved scale (default 4)
    const savedScale = parseInt(config?.scale, 10);
    currentForgeScale = (savedScale >= 1 && savedScale <= 8) ? savedScale : 4;
    const slider = document.getElementById('forge-size-slider');
    if (slider) slider.value = String(currentForgeScale);
    const lbl = document.getElementById('forge-size-value');
    if (lbl) lbl.textContent = currentForgeScale + '×';
    // v3.2.26: restore the saved chattiness (default 3 = balanced).
    // Clamp to 1–5 so any future expansion doesn't break the slider.
    const savedChattiness = parseInt(config?.chattiness, 10);
    currentForgeChattiness = (savedChattiness >= 1 && savedChattiness <= 5) ? savedChattiness : 3;
    const chatSlider = document.getElementById('forge-chattiness-slider');
    if (chatSlider) chatSlider.value = String(currentForgeChattiness);
    updateForgeChattiness(String(currentForgeChattiness));
    // Show preview
    showForgeCompanion(pixelId);
    // Render gallery for picker
    renderPixelGallery();
    { const vsel = document.getElementById('forge-voice'); if (vsel) vsel.value = (config && config.voice) || ''; } // v3.4.9
    // Load saved traits
    const savedTraits = config?.traits || [];
    document.querySelectorAll('#forge-traits-grid input[type=checkbox]').forEach(function(cb) {
      cb.checked = savedTraits.includes(cb.id.replace('trait-', ''));
    });
    // Wire trait-checkbox changes to live soul regeneration.
    attachTraitSoulListeners();
    // Load models — prefer saved config, fall back to agent's stored model.
    const desiredPrimary = (config && config.primaryModel) || agent.primaryModel;
    if (desiredPrimary) hydrateForgeModelPanel(desiredPrimary);
  });

  // v3.2.32: load soul.md + memory.md into the editor and viewer.
  // The soul is the character definition injected into every chat
  // turn. The memory is auto-written by the companion, read-only here.
  loadCompanionSoulEditor(agentId);
  loadCompanionMemoryViewer(agentId);

  // v3.4.1: the forge now lives in Settings → Companions.
  showCompanionPageInSettings(agent.name || agentId, agentId);
}

window.toggleCompanionPicker = function() {
  const picker = document.getElementById('companion-picker');
  if (picker) picker.classList.toggle('hidden');
};

// v3.2.32: Soul editor helpers. Load/save the soul.md
// for the currently-edited companion, apply presets,
// refresh the status label with byte count + warn.
async function loadCompanionSoulEditor(agentId) {
  const ta = document.getElementById('forge-soul-editor');
  const presetSel = document.getElementById('forge-soul-preset');
  const status = document.getElementById('forge-soul-status');
  if (!ta) return;
  try {
    const r = await cyberclaw.agents.getSoul(agentId);
    ta.value = r.content || '';
    // v3.3.9: cache the trait→soul map so the change
    // listener can rebuild the preview without another
    // IPC round-trip per checkbox toggle.
    if (r && r.traitToSoul && typeof r.traitToSoul === 'object') {
      currentTraitSoulMap = r.traitToSoul;
    }
    presetSel.value = 'custom'; // don't auto-select a preset
    const traits = getCheckedForgeTraits();
    const nameEl = document.getElementById('editor-name');
    const name = nameEl ? nameEl.value.trim() : '';
    const auto = buildSoulFromTraits(traits, name);
    const loaded = (ta.value || '').trim();
    // STALE-SOUL DETECTION.
    const looksStale = looksLikeStaleSoul(loaded, auto);
    if (loaded.includes(_cpSoul.SOUL_BLOCK_START)) {
      // v3.4.9: refresh just the personality block from current traits.
      ta.value = _cpSoul.mergeTraitsIntoSoul(ta.value, traits, name, currentTraitSoulMap);
      currentSoulIsCustom = false;
    } else if (loaded && loaded !== auto.trim() && looksStale) {
      const regenerated = buildSoulFromTraits(traits, name);
      ta.value = regenerated;
      currentSoulIsCustom = false;
      if (typeof addChatMsg === 'function') {
        addChatMsg('system', '🔄 Soul.md was out of sync with traits — regenerated. Edit the textarea if you want a custom soul instead.');
      }
    } else {
      currentSoulIsCustom = (loaded !== auto.trim()) && loaded.length > 0;
    }
    updateSoulStatus();
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
  }
  ta.oninput = updateSoulStatus;
}

function updateSoulStatus() {
  const ta = document.getElementById('forge-soul-editor');
  const status = document.getElementById('forge-soul-status');
  if (!ta || !status) return;
  const bytes = new Blob([ta.value]).size;
  // When the soul is hand-edited (custom), surface that in the status label so the user knows future trait toggles won't auto-regenerate the…
  const customTag = currentSoulIsCustom ? ' · custom (won’t sync to traits)' : '';
  if (bytes === 0) {
    status.textContent = 'Empty';
    status.style.color = '';
  } else if (bytes > 8192) {
    status.textContent = bytes + ' bytes — OVER 8KB LIMIT (save disabled)' + customTag;
    status.style.color = '#ff8080';
  } else if (bytes > 4096) {
    status.textContent = bytes + ' bytes — large, will warn on save' + customTag;
    status.style.color = '#ffb060';
  } else {
    status.textContent = bytes + ' bytes' + customTag;
    status.style.color = currentSoulIsCustom ? '#80c0ff' : '';
  }
}

// Read the currently-checked traits from the forge's checkbox grid and return them as an array of bare trait ids (stripping the `trait-`…
function looksLikeStaleSoul(loaded, auto) {
  if (!loaded) return false;
  const blankLines = (loaded.match(/\n\s*\n/g) || []).length;
  if (blankLines >= 2) return true; // multi-paragraph
  if (auto && loaded.length > Math.max(400, auto.length * 2 + 200)) return true;
  return false;
}

function getCheckedForgeTraits() {
  const out = [];
  document.querySelectorAll('#forge-traits-grid input[type=checkbox]').forEach(function(cb) {
    if (cb.checked) out.push(cb.id.replace('trait-', ''));
  });
  return out;
}

// Rebuild the soul textarea from the current trait selection, IF the user hasn't hand-edited the soul.
function regenerateSoulFromTraits() {
  // v3.4.9: always update — only the personality block changes;
  // the user's own text around it is preserved.
  const ta = document.getElementById('forge-soul-editor');
  if (!ta) return;
  const traits = getCheckedForgeTraits();
  const nameEl = document.getElementById('editor-name');
  const name = nameEl ? nameEl.value.trim() : '';
  const generated = _cpSoul.mergeTraitsIntoSoul(ta.value, traits, name, currentTraitSoulMap);
  if (ta.value !== generated) {
    ta.value = generated;
    updateSoulStatus();
  }
}

// Idempotent wiring of trait-checkbox listeners.
function attachTraitSoulListeners() {
  document.querySelectorAll('#forge-traits-grid input[type=checkbox]').forEach(function(cb) {
    // Remove any prior listener by replacing the node.
    const fresh = cb.cloneNode(true);
    cb.parentNode.replaceChild(fresh, cb);
    fresh.addEventListener('change', regenerateSoulFromTraits);
  });
  // Soul textarea input — the user's own typing marks the soul as custom so subsequent trait toggles stop regenerating.
  const ta = document.getElementById('forge-soul-editor');
  if (ta && !ta._soulCustomListenerAttached) {
    ta.addEventListener('input', function() {
      currentSoulIsCustom = true;
      updateSoulStatus();
    });
    ta._soulCustomListenerAttached = true;
  }
  // Companion name input — renaming while the soul is auto-generated should update the `# Name` header in the soul preview.
  const nameEl = document.getElementById('editor-name');
  if (nameEl && !nameEl._nameSoulSyncAttached) {
    nameEl.addEventListener('input', function() {
      regenerateSoulFromTraits();
    });
    nameEl._nameSoulSyncAttached = true;
  }
}


window.applySoulPreset = async function() {
  if (!editorAgentId) return;
  const presetSel = document.getElementById('forge-soul-preset');
  const ta = document.getElementById('forge-soul-editor');
  const preset = presetSel.value;
  if (preset === 'custom') {
    // leave as-is
    return;
  }
  try {
    const r = await cyberclaw.agents.applySoulPreset(editorAgentId, preset);
    if (!r.ok) { alert('Could not apply preset: ' + (r.error || 'unknown')); return; }
    ta.value = r.content || '';
    // A preset is a clean regeneration, so the soul is back in sync with the trait toggle list.
    currentSoulIsCustom = false;
    updateSoulStatus();
    discordLog('🎭', 'Soul preset applied', preset + ' → ' + editorAgentId);
  } catch (e) {
    alert('Could not apply preset: ' + e.message);
  }
};

// Save the soul when the editor is saved. Hooked from saveCompanion.
async function saveCompanionSoul(agentId) {
  const ta = document.getElementById('forge-soul-editor');
  if (!ta) return { ok: true }; // no editor in DOM, skip
  if (ta.value.length > 8192) {
    return { ok: false, error: 'soul exceeds 8KB limit' };
  }
  if (ta.value.length === 0) {
    // empty is allowed (clears the soul); user may want to start fresh
  }
  try {
    const r = await cyberclaw.agents.saveSoul(agentId, ta.value);
    if (!r.ok) return r;
    if (r.warn) {
      console.warn('[soul] saved large soul for ' + agentId + ' (' + r.bytes + ' bytes)');
    }
    return r;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// v3.2.32: Memory viewer. Read-only textarea + Clear button.
async function loadCompanionMemoryViewer(agentId) {
  const ta = document.getElementById('forge-memory-viewer');
  if (!ta) return;
  try {
    const r = await cyberclaw.agents.getMemory(agentId);
    ta.value = r.content || '';
  } catch (e) {
    ta.value = '(error loading memory: ' + e.message + ')';
  }
}

window.clearCompanionMemory = async function() {
  if (!editorAgentId) return;
  if (!confirm('Clear all memory for this companion? This cannot be undone.')) return;
  try {
    await cyberclaw.agents.clearMemory(editorAgentId);
    await loadCompanionMemoryViewer(editorAgentId);
    discordLog('🧠', 'Memory cleared', editorAgentId);
  } catch (e) {
    alert('Could not clear memory: ' + e.message);
  }
};

window.closeCompanionEditor = function(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('companion-editor-overlay').classList.add('hidden');
  if (forgeCompanionSprite) { forgeCompanionSprite.dispose(); forgeCompanionSprite = null; }
  editorAgentId = null;
  // v3.4.1: forge lives in Settings → Companions — go back to the list.
  const page = document.getElementById('settings-companion-page');
  if (page) page.classList.add('hidden');
  const list = document.getElementById('settings-companions-list');
  if (list) list.classList.remove('hidden');
  const desc = document.getElementById('settings-companions-desc');
  if (desc) desc.classList.remove('hidden');
  try { renderSettingsCompanionsList(); } catch (_) {}
};
// (Spirit editor was removed in v3.1.1 — all agents are companions and
// saveCompanion handles both editing an existing companion and creating
// a new one.)

// Save companion (pixel sprite, no skills)
window.saveCompanion = async function() {
  if (!editorAgentId) return;
  try {
    const agent = agents[editorAgentId];
    const newName = document.getElementById('editor-name').value.trim();
    if (!selectedPixelCompanion) return;

    const _path = require('path');
    const catalog = loadPixelCatalog();
    const comp = catalog.companions.find(c => c.id === selectedPixelCompanion);
    const idlePath = _path.join(__dirname, 'assets', 'companions', comp.folder, comp.animations.idle.file);

    // Extract first frame as avatar
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const [fw, fh] = comp.frameSize;
    canvas.width = fw; canvas.height = fh;
    const img = new Image();
    await new Promise(r => { img.onload = r; img.src = `file://${idlePath}`; });
    ctx.drawImage(img, 0, 0, fw, fh, 0, 0, fw, fh);

    await cyberclaw.agents.saveSpriteConfig(editorAgentId, {
      pixelCompanionId: selectedPixelCompanion,
      spiritId: null,
      customName: newName || undefined,
      focusSkills: agent.focusSkills || [],
      traits: getCheckedTraits(),
      // Read primaryModel from the new provider-first panel.
      primaryModel: readForgePrimaryModel() || agent.primaryModel,
      scale: currentForgeScale, // v3.1.6: persist the size slider value
      chattiness: currentForgeChattiness, // v3.2.26: persist the chattiness slider value
      voice: (document.getElementById('forge-voice') || {}).value || undefined, // v3.4.9
    });
    // Persist the soul.md alongside the sprite config.
    const soulResult = await saveCompanionSoul(editorAgentId);
    if (!soulResult.ok) {
      console.warn('[save] soul save failed:', soulResult.error);
      addChatMsg('system', '⚠️ Soul save failed: ' + soulResult.error);
    }
    await cyberclaw.agents.saveAvatar(editorAgentId, canvas.toDataURL('image/png'));
    agent.avatar = canvas.toDataURL('image/png');
    agent._pixelCompanionId = selectedPixelCompanion;
    if (newName) agent.name = newName;
    agent.traits = getCheckedTraits();
    // v3.2.26: mirror chattiness onto the in-memory agent so the
    // idle chatter scheduler can read it without a disk lookup.
    agent.chattiness = currentForgeChattiness;
    const savedModel = document.getElementById('forge-model-primary')?.value;
    if (savedModel) {
      agent.primaryModel = savedModel;
      agent.model = formatModelName(savedModel);
      // Actually persist the model choice to openclaw.json so the runtime picks it up next session.
      try {
        const fallbacks = document.getElementById('forge-model-secondary')?.value
          ? [document.getElementById('forge-model-secondary').value]
          : [];
        await cyberclaw.openclaw.setAgentModel(editorAgentId, savedModel, fallbacks);
      } catch (e) {
        console.warn('[forge] setAgentModel failed:', e?.message);
        addChatMsg('system', `⚠ Saved locally but openclaw config update failed: ${e?.message}. The new model will apply on next gateway restart.`);
      }
    }
    const savedModel2 = document.getElementById('forge-model-secondary')?.value;
    agent.secondaryModel = savedModel2 || '';

    buildCarousel();
    // If the create flow set a pending new id, switch the chat to the new
    // companion's channel so the user can keep chatting with them.
    if (pendingNewCompanionId) {
      const newId = pendingNewCompanionId;
      pendingNewCompanionId = null;
      const newIdx = agentOrder.indexOf(newId);
      if (newIdx >= 0) {
        focusIndex = newIdx;
        switchActiveChat(newId);
      }
    }
    renderCompanionChannelTabs();
    closeCompanionEditor();
    // Re-broadcast the agents list to the mobile so changes (sprite id, scale, name, emoji) appear immediately.
    broadcastAgentsListToMobile();
  } catch (e) {
    debugLog('[Save] ERROR: ' + e.message + '\n' + e.stack);
    alert('Save failed: ' + e.message);
    pendingNewCompanionId = null;
  }
};

// (The only save flow is window.saveCompanion, used for both editing
// an existing companion and creating a new one.)

// (populateSelect removed — pixel sprites replaced by Cybermon gallery)

// ---------------------------------------------------------------------------
// Equipment / Skills System
// ---------------------------------------------------------------------------
let allSkillsCache = null;

// Built-in special equipment (not from openclaw skills list)
const BUILTIN_EQUIPMENT = [
  { name: 'Web Surfer', description: 'Search the web and fetch content from URLs', icon: '🌐', ready: true, builtin: true },
  { name: 'Code Hammer', description: 'Write, edit, and execute code across languages', icon: '🔨', ready: true, builtin: true },
  { name: 'Memory Scroll', description: 'Remember and recall information across sessions', icon: '📜', ready: true, builtin: true },
  { name: 'Messenger Orb', description: 'Send messages across Discord, Telegram, and other channels', icon: '🔮', ready: true, builtin: true },
];

async function loadEquipment(agentId) {
  const gear = document.getElementById('inspect-gear');
  if (!gear) return;

  // Load installed/equipped skills for this companion
  const config = await cyberclaw.agents.getSpriteConfig(agentId) || {};
  const equipped = config.equipment || [];

  if (equipped.length === 0) {
    gear.innerHTML = '<div style="color:var(--text-muted);font-size:10px;padding:4px">No equipment yet — search to equip skills!</div>';
  } else {
    gear.innerHTML = equipped.map(e =>
      `<div class="gear-slot equipped" title="${escapeHtml(e.description || e.skill)}">
        <div class="gear-icon">${e.icon || '🔧'}</div>
        <div class="gear-label">${escapeHtml(e.name || e.skill)}</div>
      </div>`
    ).join('');
  }
}

window.toggleEquipSearch = function() {
  const panel = document.getElementById('equip-search-panel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) {
    document.getElementById('equip-search-input').focus();
    // Show built-in items immediately while skills load
    searchEquipment();
    if (!allSkillsCache) {
      cyberclaw.agents.listSkills().then(skills => {
        allSkillsCache = skills;
        searchEquipment();
      });
    }
  }
};

window.searchEquipment = function() {
  const query = (document.getElementById('equip-search-input').value || '').toLowerCase();
  const results = document.getElementById('equip-search-results');

  // Combine built-in equipment + OpenClaw skills
  const allItems = [...BUILTIN_EQUIPMENT, ...(allSkillsCache || [])];
  const filtered = allItems.filter(s =>
    s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query)
  ).slice(0, 10);

  if (filtered.length === 0) {
    results.innerHTML = '<div style="color:var(--text-muted);font-size:10px;padding:4px">No skills found</div>';
    return;
  }

  results.innerHTML = filtered.map(s =>
    `<div class="equip-result ${s.ready ? 'ready' : 'missing'}" onclick="equipSkill('${escapeHtml(s.name)}')">
      <div class="equip-result-name">${s.ready ? '✓' : '✗'} ${s.name}</div>
      <div class="equip-result-desc">${s.description.slice(0, 80)}${s.description.length > 80 ? '...' : ''}</div>
    </div>`
  ).join('');
};

window.equipSkill = async function(skillName) {
  if (!agentOrder[focusIndex]) return;
  const agentId = agentOrder[focusIndex];
  const skill = BUILTIN_EQUIPMENT.find(s => s.name === skillName)
    || allSkillsCache?.find(s => s.name === skillName);
  if (!skill) return;

  // Check if already equipped
  const config = await cyberclaw.agents.getSpriteConfig(agentId) || {};
  const equipment = config.equipment || [];
  if (equipment.find(e => e.skill === skillName)) {
    // Already equipped — offer to unequip
    if (confirm(`"${skillName}" is already equipped. Unequip it?`)) {
      config.equipment = equipment.filter(e => e.skill !== skillName);
      await cyberclaw.agents.saveSpriteConfig(agentId, config);
      loadEquipment(agentId);
      searchEquipment();
    }
    return;
  }

  // Show requirements modal
  showEquipModal(skill, agentId);
};

function showEquipModal(skill, agentId) {
  // Build requirements info
  const reqs = getSkillRequirements(skill.name);

  let overlay = document.getElementById('equip-modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'equip-modal-overlay';
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
  }

  overlay.innerHTML = `
    <div class="equip-modal">
      <div class="equip-modal-header">
        <span class="equip-modal-icon">${skill.icon || '⚔️'}</span>
        <span class="equip-modal-title">${escapeHtml(skill.name)}</span>
      </div>
      <div class="equip-modal-desc">${escapeHtml(skill.description)}</div>
      ${reqs.length > 0 ? `
        <div class="equip-modal-reqs-title">Requirements:</div>
        <div class="equip-modal-reqs">
          ${reqs.map(r => `<div class="equip-req ${r.installed ? 'installed' : 'missing'}">
            <span>${r.installed ? '✅' : '⬇️'}</span>
            <span>${escapeHtml(r.name)}</span>
            <span class="equip-req-note">${escapeHtml(r.note)}</span>
          </div>`).join('')}
        </div>
      ` : '<div class="equip-modal-reqs-title" style="color:var(--green)">✅ No additional requirements</div>'}
      <div class="equip-modal-actions">
        <button class="equip-modal-cancel" onclick="closeEquipModal()">Cancel</button>
        <button class="equip-modal-install" onclick="confirmEquip('${escapeHtml(skill.name)}', '${agentId}')">
          ${reqs.some(r => !r.installed) ? '⬇️ Install & Equip' : '⚔️ Equip'}
        </button>
      </div>
    </div>
  `;
  overlay.classList.remove('hidden');
  overlay.style.display = 'flex';
}

function getSkillRequirements(skillName) {
  const REQUIREMENTS = {
    'Web Surfer': [],
    'Code Hammer': [],
    'Memory Scroll': [],
    'Messenger Orb': [],
  };

  const reqs = REQUIREMENTS[skillName] || [];
  const fs = require('fs');
  return reqs.map(r => ({
    ...r,
    installed: r.check ? fs.existsSync(r.check) : true,
  }));
}

window.closeEquipModal = function() {
  const overlay = document.getElementById('equip-modal-overlay');
  if (overlay) { overlay.style.display = 'none'; }
};

window.confirmEquip = async function(skillName, agentId) {
  const skill = BUILTIN_EQUIPMENT.find(s => s.name === skillName)
    || allSkillsCache?.find(s => s.name === skillName);
  if (!skill) return;

  const reqs = getSkillRequirements(skillName);
  const missing = reqs.filter(r => !r.installed);

  // Auto-install missing requirements
  if (missing.length > 0) {
    const installBtn = document.querySelector('.equip-modal-install');
    if (installBtn) {
      installBtn.textContent = '⏳ Installing...';
      installBtn.disabled = true;
    }

    for (const req of missing) {
      try {
        // No auto-install needed for current skills
      } catch (e) {
        alert(`Failed to install ${req.name}: ${e.message}\nPlease install manually.`);
        closeEquipModal();
        return;
      }
    }
  }

  // Save equipment
  const config = await cyberclaw.agents.getSpriteConfig(agentId) || {};
  const equipment = config.equipment || [];
  equipment.push({
    skill: skillName,
    name: skill.name,
    icon: skill.icon || '⚔️',
    description: skill.description,
    ready: true,
  });
  config.equipment = equipment;
  await cyberclaw.agents.saveSpriteConfig(agentId, config);

  closeEquipModal();
  loadEquipment(agentId);
  searchEquipment();
};

// ═══════════════════════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════════════════════

const SETTINGS_KEY = 'cyberclaw-settings';

// Removed dead legacy provider-key fields (keyAnthropic, keyOpenai, keyGoogle, ollamaUrl).
const LEGACY_PROVIDER_KEYS = ['keyAnthropic', 'keyOpenai', 'keyGoogle', 'ollamaUrl'];

const DEFAULT_SETTINGS = {
  theme: 'dark',
  voiceLang: 'en-US',
  voiceKeybind: 'KeyV',
  voiceKeybindLabel: 'V',
  voiceAutoSend: false,
  ttsVoice: 'lessac',
  defaultModel: '',
  discordToken: '',
  telegramToken: '',
  // User profile
  userName: '',
  userGender: '' // 'male', 'female', or ''
};

// Shared well-known-model catalog.
const WELL_KNOWN_MODELS = [
  { provider: 'Anthropic',  model: 'anthropic/claude-opus-4-8',     label: 'Claude Opus 4.8' },
  { provider: 'Anthropic',  model: 'anthropic/claude-sonnet-4-6',   label: 'Claude Sonnet 4.6' },
  { provider: 'OpenAI',     model: 'openai/gpt-5.5',                label: 'GPT-5.5' },
  { provider: 'OpenAI',     model: 'openai/gpt-5.4-mini',           label: 'GPT-5.4 Mini' },
  { provider: 'Google',     model: 'google/gemini-2.5-pro',        label: 'Gemini 2.5 Pro' },
  { provider: 'Google',     model: 'google/gemini-2.5-flash',      label: 'Gemini 2.5 Flash' },
  { provider: 'MiniMax',    model: 'minimax/MiniMax-M3',            label: 'MiniMax M3' },
  { provider: 'OpenRouter', model: 'openrouter/auto',               label: 'OpenRouter (auto)' },
  { provider: 'Local',      model: 'ollama/llama3',                 label: 'Ollama — Llama 3' },
];

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    // One-time strip of legacy provider-key fields if they survived from
    // an older saved blob. Don't write back here (saveSettings() will
    // persist the cleaned object on the next user-driven save).
    for (const k of LEGACY_PROVIDER_KEYS) delete saved[k];
    return Object.assign({}, DEFAULT_SETTINGS, saved);
  } catch { return Object.assign({}, DEFAULT_SETTINGS); }
}

function saveSettings() {
  const s = loadSettings();
  s.theme = document.body.classList.contains('theme-light') ? 'light' : 'dark';
  const langEl = document.getElementById('settings-voice-lang');
  if (langEl) s.voiceLang = langEl.value;
  const ttsEl = document.getElementById('settings-tts-voice');
  if (ttsEl) s.ttsVoice = ttsEl.value;
  const autoEl = document.getElementById('settings-voice-autosend');
  if (autoEl) s.voiceAutoSend = autoEl.checked;
  const modelEl = document.getElementById('settings-default-model');
  if (modelEl) s.defaultModel = modelEl.value;
  const discEl = document.getElementById('settings-discord-token');
  if (discEl) s.discordToken = discEl.value.trim();
  const teleEl = document.getElementById('settings-telegram-token');
  if (teleEl) s.telegramToken = teleEl.value.trim();
  const userNameEl = document.getElementById('settings-user-name');
  if (userNameEl) s.userName = userNameEl.value.trim();
  const userGenderEl = document.getElementById('settings-user-gender');
  if (userGenderEl) s.userGender = userGenderEl.value;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

function applySettings() {
  const s = loadSettings();
  // Theme
  if (s.theme === 'light') document.body.classList.add('theme-light');
  else document.body.classList.remove('theme-light');
}

window.testTTSVoice = function() {
  const voiceEl = document.getElementById('settings-tts-voice');
  const voice = voiceEl ? voiceEl.value : 'lessac';
  const testPhrase = 'Hello master. I am ready to assist you.';
  
  // Send test request to main process
  window.ipcRenderer?.invoke('test-tts-voice', { voice, text: testPhrase })
    .then(() => {
      console.log('[TEST] TTS test started for voice:', voice);
    })
    .catch((err) => {
      console.error('[TEST] TTS test failed:', err);
      alert('TTS test failed: ' + err?.message);
    });
}

window.openSettings = function() {
  const s = loadSettings();
  document.getElementById('settings-overlay').classList.remove('hidden');
  // v3.4.1: sidebar nav, one section card at a time (mobile-style).
  try { initSettingsNav(); showSettingsSection(window._lastSettingsSection || null); } catch (e) { console.warn('settings nav:', e); }
  // Populate fields
  const langEl = document.getElementById('settings-voice-lang');
  if (langEl) langEl.value = s.voiceLang;
  const ttsEl = document.getElementById('settings-tts-voice');
  if (ttsEl) ttsEl.value = s.ttsVoice || 'lessac';
  const autoEl = document.getElementById('settings-voice-autosend');
  if (autoEl) autoEl.checked = s.voiceAutoSend;
  const keybindLabel = document.getElementById('voice-keybind-label');
  if (keybindLabel) keybindLabel.textContent = s.voiceKeybindLabel || 'V';
  const modelEl = document.getElementById('settings-default-model');
  if (modelEl) modelEl.value = s.defaultModel || '';
  // v3.2.32: load the CYBERCLAW.md overarching system prompt.
  loadCyberclawEditor();
  // Refresh the dynamic providers list + default-model dropdown whenever settings opens
  try { renderProvidersList(); } catch (e) { console.warn('renderProvidersList:', e); }
  try { renderLlmEndpoints(); } catch (e) { console.warn('renderLlmEndpoints:', e); }
  try { refreshDefaultModelDropdown(); } catch (e) { console.warn('refreshDefaultModelDropdown:', e); }
  // v3.2.1: render one-click provider preset buttons (cheap; do every open)
  try { renderProviderPresets(); } catch (e) { console.warn('renderProviderPresets:', e); }
  const discEl = document.getElementById('settings-discord-token');
  if (discEl) discEl.value = s.discordToken || '';
  const teleEl = document.getElementById('settings-telegram-token');
  if (teleEl) teleEl.value = s.telegramToken || '';
  const userNameEl = document.getElementById('settings-user-name');
  if (userNameEl) userNameEl.value = s.userName || '';
  const userGenderEl = document.getElementById('settings-user-gender');
  if (userGenderEl) userGenderEl.value = s.userGender || '';
  // Theme buttons
  document.getElementById('theme-dark-btn').classList.toggle('active', s.theme !== 'light');
  document.getElementById('theme-light-btn').classList.toggle('active', s.theme === 'light');
  // Data path
  try {
    const { app } = require('electron').remote || {};
    const p = app ? app.getPath('userData') : __dirname;
    document.getElementById('settings-data-path').textContent = p;
  } catch { document.getElementById('settings-data-path').textContent = __dirname; }
  // Gateway status
  const gwEl = document.getElementById('settings-gateway-status');
  if (gwEl) gwEl.textContent = typeof cyberclaw !== 'undefined' ? '🟢 Connected' : '🔴 Not connected';
  // Render the per-companion Chatti list with quick chattiness sliders.
  try { renderSettingsCompanionsList(); } catch (e) { console.warn('renderSettingsCompanionsList:', e); }
};

// Render the Settings → Companions list.
async function renderSettingsCompanionsList() {
  const listEl = document.getElementById('settings-companions-list');
  if (!listEl) return;
  let catalog = { companions: [] };
  try { catalog = loadPixelCatalog() || catalog; } catch (_) {}
  listEl.innerHTML = '';
  for (const id of (agentOrder || [])) {
    const a = agents[id];
    if (!a || id.startsWith('subagent-')) continue;
    const row = document.createElement('div');
    row.className = 'settings-companion-item';
    row.onclick = () => openCompanionForge(id);
    const icon = document.createElement('span');
    icon.className = 'sci-icon';
    const iconFile = getSpriteIconFile(a._pixelCompanionId);
    if (iconFile) {
      const img = document.createElement('img');
      img.src = iconFile; img.alt = ''; img.draggable = false;
      icon.appendChild(img);
    } else {
      icon.textContent = (a.emoji && a.emoji !== '🤖') ? a.emoji : (getSpriteIcon(a._pixelCompanionId) || '🐾');
    }
    const info = document.createElement('div');
    info.className = 'sci-info';
    const nm = document.createElement('div');
    nm.className = 'sci-name';
    nm.textContent = a.name || id;
    const sub = document.createElement('div');
    sub.className = 'sci-sub';
    const sprite = (catalog.companions || []).find(c => c.id === a._pixelCompanionId);
    sub.textContent = [sprite ? sprite.name : null, a.model || null].filter(Boolean).join(' · ') || id;
    info.appendChild(nm); info.appendChild(sub);
    const arrow = document.createElement('span');
    arrow.className = 'sci-arrow';
    arrow.textContent = '›';
    row.appendChild(icon); row.appendChild(info); row.appendChild(arrow);
    listEl.appendChild(row);
  }
  const create = document.createElement('div');
  create.className = 'settings-companion-item create';
  create.onclick = () => createNewCompanion();
  create.innerHTML = '<span class="sci-icon">➕</span><div class="sci-info"><div class="sci-name">Create new companion</div><div class="sci-sub">Pick a sprite, name it, give it a model and a personality</div></div><span class="sci-arrow">›</span>';
  listEl.appendChild(create);
}

// v3.4.2: settings layout helpers — grouped sidebar nav, one card
// at a time (mobile-style). Groups give the clear separation Tobe
// asked for (2026-10-12 23:13): General / Connections / Advanced.
const SETTINGS_NAV_GROUPS = [
  ['General',     ['settings-companions-section', 'settings-user-section', 'settings-appearance-section', 'settings-voice-section']],
  ['Connections', ['settings-providers-section', 'settings-channels-section', 'settings-mobile-section']],
  ['Advanced',    ['settings-prompt-section', 'settings-data-section']],
];
function initSettingsNav() {
  const panel = document.querySelector('#settings-overlay .settings-panel');
  const content = panel && panel.querySelector('.settings-content');
  if (!content || panel.dataset.navReady) return;
  panel.dataset.navReady = '1';
  // Merge sub-sections (e.g. Local LLM Endpoints → AI Providers).
  content.querySelectorAll('.settings-section[data-merge-into]').forEach(sub => {
    const target = document.getElementById(sub.dataset.mergeInto);
    if (!target) return;
    sub.classList.remove('settings-section');
    sub.classList.add('settings-subsection');
    target.appendChild(sub);
  });
  const body = document.createElement('div');
  body.className = 'settings-body';
  const nav = document.createElement('nav');
  nav.className = 'settings-nav';
  content.parentNode.insertBefore(body, content);
  body.appendChild(nav);
  body.appendChild(content);
  const sections = Array.from(content.querySelectorAll('.settings-section'))
    .filter(s => !s.parentElement.closest('.settings-section'));
  sections.forEach((sec, i) => { sec.dataset.navKey = sec.id || ('settings-sec-' + i); });
  const used = new Set();
  const addBtn = (sec) => {
    const t = sec.querySelector('.settings-section-title');
    const btn = document.createElement('button');
    btn.className = 'settings-nav-btn';
    btn.dataset.navKey = sec.dataset.navKey;
    btn.textContent = t ? t.textContent.trim() : sec.dataset.navKey;
    btn.onclick = () => showSettingsSection(sec.dataset.navKey);
    nav.appendChild(btn);
    used.add(sec);
  };
  const addLabel = (txt) => {
    const l = document.createElement('div');
    l.className = 'settings-nav-group';
    l.textContent = txt;
    nav.appendChild(l);
  };
  for (const [label, ids] of SETTINGS_NAV_GROUPS) {
    const secs = ids.map(id => document.getElementById(id)).filter(s => s && sections.includes(s));
    if (!secs.length) continue;
    addLabel(label);
    secs.forEach(addBtn);
  }
  const rest = sections.filter(s => !used.has(s));
  if (rest.length) { addLabel('Other'); rest.forEach(addBtn); }
}

window.showSettingsSection = function(keyOrEl) {
  const content = document.querySelector('#settings-overlay .settings-content');
  if (!content) return;
  const sections = Array.from(content.querySelectorAll('.settings-section[data-nav-key]'));
  if (sections.length === 0) return;
  let target = null;
  if (keyOrEl && typeof keyOrEl === 'object') target = keyOrEl.closest('.settings-section[data-nav-key]');
  else if (keyOrEl) target = sections.find(s => s.dataset.navKey === keyOrEl);
  if (!target) target = document.getElementById('settings-companions-section') || sections[0];
  sections.forEach(s => s.classList.toggle('active', s === target));
  document.querySelectorAll('#settings-overlay .settings-nav-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.navKey === target.dataset.navKey));
  window._lastSettingsSection = target.dataset.navKey;
  content.scrollTop = 0;
};

// The companion page is one scrolling page, mobile-style: hero (sprite preview + name + sprite picker) → Size & chattiness → Behaviour →…
const COMPANION_PAGE_LAYOUT = [
  { group: null, cards: [
    { title: '📐 Size & chattiness', parts: ['.forge-size-section', '.forge-chattiness-section'] },
    { title: null, parts: ['#forge-traits-grid'] },
    { title: null, parts: ['#cp-voice-block'] },
    { title: null, parts: ['#cp-wake-block'] },
  ] },
  { group: '🧠 Brain', desc: 'What powers this companion — the AI model it thinks with, what it remembers, and its written character.', cards: [
    { title: null, parts: ['.forge-model-section'] },
    { title: null, parts: ['.forge-memory-section'] },
    { title: null, parts: ['.forge-soul-section'] },
    { title: null, parts: ['#cp-channel-block'] },
  ] },
];
let _companionPageTab = 'looks'; // kept for older callers

function mountCompanionPage(page) {
  const panel = document.querySelector('#companion-editor-overlay .modal-panel');
  const body = panel && panel.querySelector('.editor-content');
  const footer = panel && panel.querySelector('.modal-footer');
  if (!body) return;
  const find = sel => { const el = body.querySelector(sel); if (!el) return null; return el.classList.contains('forge-traits-section') ? el : (el.closest('.forge-traits-section') || el); };
  const out = document.createElement('div');
  out.className = 'cp-page';
  // Hero
  const hero = document.createElement('div');
  hero.className = 'cp-hero';
  const prev = body.querySelector('.forge-companion-preview');
  const nameRow = body.querySelector('.editor-name-row');
  const picker = body.querySelector('#companion-picker');
  if (prev) hero.appendChild(prev);
  if (nameRow) hero.appendChild(nameRow);
  // v3.4.10: sprite gallery opens in its own window via "Browse sprites";
  // clicking a sprite picks it and closes the window.
  const browse = document.createElement('button');
  browse.className = 'settings-action-btn cp-browse-btn';
  browse.textContent = '🖼️ Browse sprites';
  browse.onclick = () => openSpriteGallery();
  hero.appendChild(browse);
  if (picker) {
    const ov = document.createElement('div');
    ov.id = 'sprite-gallery-overlay';
    ov.className = 'modal-overlay hidden';
    ov.onclick = (e) => { if (e.target === ov) closeSpriteGallery(); };
    const panel = document.createElement('div');
    panel.className = 'modal-panel sprite-gallery-panel';
    panel.innerHTML = '<div class="modal-header"><span class="rune-icon">🖼️</span> SPRITE GALLERY<button class="modal-close" onclick="closeSpriteGallery()">✕</button></div><div class="sprite-gallery-hint">Click a sprite to use it. Remember to Save.</div>';
    panel.appendChild(picker);
    ov.appendChild(panel);
    document.body.appendChild(ov);
    picker.addEventListener('click', (e) => { if (e.target.closest('.pixel-companion-card')) setTimeout(closeSpriteGallery, 120); });
  }
  out.appendChild(hero);
  for (const grp of COMPANION_PAGE_LAYOUT) {
    if (grp.group) {
      const h = document.createElement('div'); h.className = 'cp-group-title'; h.textContent = grp.group; out.appendChild(h);
      if (grp.desc) { const d = document.createElement('div'); d.className = 'cp-pane-desc'; d.textContent = grp.desc; out.appendChild(d); }
    }
    for (const card of grp.cards) {
      const els = card.parts.map(find).filter(Boolean);
      if (!els.length) continue;
      let blk;
      if (els.length === 1 && !card.title) { blk = els[0]; }
      else {
        blk = document.createElement('div'); blk.className = 'forge-traits-section';
        if (card.title) { const t = document.createElement('div'); t.className = 'forge-traits-title'; t.textContent = card.title; blk.appendChild(t); }
        els.forEach(e => { const tt = e.querySelector(':scope > .forge-traits-title'); if (tt) tt.classList.add('cp-subtitle'); e.classList.add('cp-subpart'); blk.appendChild(e); });
      }
      blk.classList.add('cp-block');
      out.appendChild(blk);
    }
  }
  // Leftovers (hidden inputs etc.) stay in the body.
  body.appendChild(out);
  Array.from(body.children).forEach(c => { if (c !== out && c.tagName !== 'INPUT') out.appendChild(c); });
  page.appendChild(body);
  if (footer) page.appendChild(footer);
}

window.showCompanionPageTab = function() {
  const content = document.querySelector('#settings-overlay .settings-content');
  if (content) content.scrollTop = 0;
};

window.testCompanionVoice = function() {
  const sel = document.getElementById('forge-voice');
  let voice = sel && sel.value;
  if (!voice) { try { voice = (loadSettings().ttsVoice) || 'lessac'; } catch (_) { voice = 'lessac'; } }
  const a = editorAgentId && agents[editorAgentId];
  const nm = (document.getElementById('editor-name') || {}).value || (a && a.name) || 'your companion';
  window.ipcRenderer?.invoke('test-tts-voice', { voice, text: 'Hey, it\'s ' + nm + '. This is how I sound.' })
    .catch(err => alert('Voice test failed: ' + (err && err.message)));
};

function showCompanionPageInSettings(title, agentId, tab) {
  const overlay = document.getElementById('settings-overlay');
  if (overlay && overlay.classList.contains('hidden')) openSettings();
  initSettingsNav();
  const page = document.getElementById('settings-companion-page');
  if (!page) return;
  if (!page.dataset.mounted) { mountCompanionPage(page); page.dataset.mounted = '1'; }
  showSettingsSection('settings-companions-section');
  const list = document.getElementById('settings-companions-list');
  if (list) list.classList.add('hidden');
  const desc = document.getElementById('settings-companions-desc');
  if (desc) desc.classList.add('hidden');
  const t = document.getElementById('settings-companion-page-title');
  if (t) {
    const a = agentId ? agents[agentId] : null;
    const icon = a ? ((a.emoji && a.emoji !== '🤖') ? a.emoji : (getSpriteIcon(a._pixelCompanionId) || '🐾')) : '';
    t.textContent = (icon ? icon + ' ' : '') + (title || 'Companion');
  }
  fillCompanionChannelBlock(agentId);
  const wn = document.getElementById('cp-wake-name'); if (wn) wn.textContent = (agentId && agents[agentId] && agents[agentId].name) || 'this companion';
  page.classList.remove('hidden');
  showCompanionPageTab();
}


// v3.4.5: companion export / import + channel info on the companion page.
function _companionTransferStatus(html) {
  const el = document.getElementById('companions-transfer-status');
  if (el) el.innerHTML = html || '';
}
async function _exportCompanionIds(ids) {
  if (!ids.length) return;
  const dir = await cyberclaw.agents.pickCompanionFolder('export');
  if (!dir) return;
  _companionTransferStatus('Exporting…');
  const res = await cyberclaw.agents.exportCompanions(ids, dir);
  const lines = (res.results || []).map(r => r.ok
    ? '✅ ' + escapeHtml((agents[r.id] && agents[r.id].name) || r.id) + ' → <code>' + escapeHtml(r.path) + '</code>'
    : '❌ ' + escapeHtml(r.id) + ': ' + escapeHtml(r.error || 'failed'));
  if (!lines.length && res.error) lines.push('❌ ' + escapeHtml(res.error));
  _companionTransferStatus(lines.join('<br>'));
  addChatMsg('system', '📤 Exported ' + (res.results || []).filter(r => r.ok).length + ' companion(s) to ' + dir);
}
window.exportCurrentCompanion = async function() {
  if (!editorAgentId) return;
  const id = editorAgentId;
  await _exportCompanionIds([id]);
  // Status line lives under the list; surface it on the page too.
  const s = document.getElementById('companions-transfer-status');
  if (s && s.textContent) alert(s.textContent);
};
window.exportAllCompanions = async function() {
  await _exportCompanionIds((agentOrder || []).filter(id => agents[id] && !id.startsWith('subagent-')));
};
window.importCompanionsFromFolder = async function() {
  const dir = await cyberclaw.agents.pickCompanionFolder('import');
  if (!dir) return;
  _companionTransferStatus('Importing…');
  const res = await cyberclaw.agents.importCompanions(dir);
  const lines = (res.results || []).map(r => r.ok
    ? '✅ ' + escapeHtml(r.name || r.id) + ' imported (workspace <code>' + escapeHtml(r.workspace) + '</code>)'
    : '❌ ' + escapeHtml(r.id || r.bundle || '?') + ': ' + escapeHtml(r.error || 'failed'));
  if (!lines.length && res.error) lines.push('❌ ' + escapeHtml(res.error));
  _companionTransferStatus(lines.join('<br>'));
  if ((res.results || []).some(r => r.ok)) {
    try {
      await loadAgents();
      renderCompanionChannelTabs();
      if (typeof initArenaCompanions === 'function') await initArenaCompanions();
    } catch (e) { console.warn('[import] reload agents:', e); }
    renderSettingsCompanionsList();
    addChatMsg('system', '📥 Imported companion(s): ' + res.results.filter(r => r.ok).map(r => r.name || r.id).join(', '));
  }
};
window.openCompanionWorkspace = function() {
  const a = editorAgentId && agents[editorAgentId];
  if (!a || !a.workspace) return;
  try { require('electron').shell.openPath(a.workspace); } catch (e) { console.warn(e); }
};
function fillCompanionChannelBlock(agentId) {
  const a = agentId ? agents[agentId] : null;
  const plat = document.getElementById('cp-channel-platform');
  const ws = document.getElementById('cp-channel-workspace');
  const blk = document.getElementById('cp-channel-block');
  if (blk) blk.style.display = a ? '' : 'none';
  const exp = document.getElementById('cp-export-btn');
  if (exp) exp.style.display = a ? '' : 'none';
  if (!a) return;
  if (plat) plat.innerHTML = '<span class="channel-badge ' + (a.channelBadge || '') + '">' + (a.channelIcon || '') + ' ' + escapeHtml(a.channelDetail || '—') + '</span>';
  if (ws) { ws.textContent = a.workspace || '—'; ws.title = a.workspace || ''; }
}

async function renderSettingsCompanionsListLegacy() {
  const listEl = document.getElementById('settings-companions-list');
  if (!listEl) return;
  if (!agentOrder || agentOrder.length === 0) {
    listEl.innerHTML = '<div style="color:#888;font-size:12px;font-style:italic;">No companions yet.</div>';
    return;
  }
  // Hydrate chattiness from sprite config (one read each).
  const html = [];
  for (const id of agentOrder) {
    const a = agents[id];
    if (!a) continue;
    let cfg = {};
    try { cfg = await cyberclaw.agents.getSpriteConfig(id); } catch {}
    const chattiness = (typeof a.chattiness === 'number') ? a.chattiness
      : (typeof cfg.chattiness === 'number') ? cfg.chattiness
      : 3;
    const emoji = (a.emoji && a.emoji !== '🤖') ? a.emoji : (getSpriteIcon(a._pixelCompanionId) || '🐾');
    // Use data-id on the wrapper so the slider's oninput can resolve the agent without a global lookup.
    html.push(`
      <div class="settings-companion-row" data-agent-id="${id}">
        <div class="settings-companion-row-head">
          <span class="settings-companion-emoji">${emoji}</span>
          <span class="settings-companion-name">${escapeHtml(a.name || id)}</span>
          <button class="settings-btn-sm" onclick="openCompanionForge('${id}')">✏️ Edit</button>
        </div>
        <div class="settings-companion-row-slider">
          <span class="settings-label">Chattiness</span>
          <input type="range" min="1" max="5" step="1" value="${chattiness}" class="settings-slider"
                 oninput="updateSettingsCompanionChattiness('${id}', this.value)"
                 onchange="saveSettingsCompanionChattiness('${id}', this.value)" />
          <span class="settings-companion-chattiness-value" id="settings-companion-chattiness-${id}">${chattiness}/5</span>
        </div>
      </div>
    `);
  }
  listEl.innerHTML = html.join('');
}

// v3.2.26: live-update the displayed value next to the slider
// while the user drags. Debounced save happens on onchange.
window.updateSettingsCompanionChattiness = function(agentId, value) {
  const v = Math.max(1, Math.min(5, parseInt(value, 10) || 3));
  const lbl = document.getElementById('settings-companion-chattiness-' + agentId);
  if (lbl) lbl.textContent = v + '/5';
};

// Persist the slider value to sprites.json.
window.saveSettingsCompanionChattiness = async function(agentId, value) {
  const v = Math.max(1, Math.min(5, parseInt(value, 10) || 3));
  try {
    const existing = await cyberclaw.agents.getSpriteConfig(agentId).catch(() => null) || {};
    const merged = Object.assign({}, existing, { chattiness: v });
    await cyberclaw.agents.saveSpriteConfig(agentId, merged);
    if (agents[agentId]) agents[agentId].chattiness = v;
    broadcastAgentsListToMobile();
    console.log('[Companion] chattiness saved for', agentId, '=', v);
  } catch (e) {
    console.warn('[Companion] chattiness save failed for', agentId, ':', e?.message);
  }
};

// v3.2.26: tiny HTML escaper used by the Settings list
// renderer. Matches the light escaper used elsewhere in the
// file (single-quote-safe, handles &, <, >).
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// CyberClaw.md editor — the overarching system prompt shared by every companion.
async function loadCyberclawEditor() {
  const ta = document.getElementById('settings-cyberclaw-editor');
  const status = document.getElementById('settings-cyberclaw-status');
  const pathEl = document.getElementById('settings-cyberclaw-path');
  if (!ta) return;
  try {
    const r = await cyberclaw.system.getCyberclaw();
    ta.value = r.content || '';
    if (pathEl && r.path) pathEl.textContent = r.path;
    updateCyberclawStatus();
  } catch (e) {
    if (status) status.textContent = 'Error: ' + e.message;
  }
  // Live byte counter as the user types.
  ta.oninput = updateCyberclawStatus;
}

function updateCyberclawStatus() {
  const ta = document.getElementById('settings-cyberclaw-editor');
  const status = document.getElementById('settings-cyberclaw-status');
  if (!ta || !status) return;
  const bytes = new Blob([ta.value]).size;
  if (bytes === 0) {
    status.textContent = 'Empty (using default)';
    status.style.color = '';
  } else if (bytes > 16384) {
    status.textContent = bytes + ' bytes — OVER 16KB LIMIT';
    status.style.color = '#ff8080';
  } else if (bytes > 8192) {
    status.textContent = bytes + ' bytes — large';
    status.style.color = '#ffb060';
  } else {
    status.textContent = bytes + ' bytes · in use';
    status.style.color = '';
  }
}

window.saveCyberclawPrompt = async function() {
  const ta = document.getElementById('settings-cyberclaw-editor');
  const status = document.getElementById('settings-cyberclaw-status');
  if (!ta) return;
  if (ta.value.length > 16384) {
    alert('CYBERCLAW.md exceeds 16KB limit');
    return;
  }
  try {
    const r = await cyberclaw.system.saveCyberclaw(ta.value);
    if (!r.ok) { alert('Save failed: ' + (r.error || 'unknown')); return; }
    if (status) status.textContent = 'Saved · ' + r.bytes + ' bytes';
    discordLog('🛡️', 'CyberClaw prompt saved', r.bytes + ' bytes');
  } catch (e) {
    alert('Save failed: ' + e.message);
  }
};

window.resetCyberclawPrompt = async function() {
  if (!confirm('Restore CYBERCLAW.md to the default?\n\nThis will overwrite your current edits. The default is the shipped behavior.')) return;
  try {
    const r = await cyberclaw.system.resetCyberclaw();
    if (!r.ok) { alert('Reset failed'); return; }
    const ta = document.getElementById('settings-cyberclaw-editor');
    if (ta) ta.value = r.content || '';
    updateCyberclawStatus();
    discordLog('🛡️', 'CyberClaw prompt restored', 'to default');
  } catch (e) {
    alert('Reset failed: ' + e.message);
  }
};

window.closeSettings = function(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('settings-overlay').classList.add('hidden');
  // v3.4.1: leaving Settings while on a companion page closes it.
  const page = document.getElementById('settings-companion-page');
  if (page && !page.classList.contains('hidden')) closeCompanionEditor();
};

window.setTheme = function(theme) {
  if (theme === 'light') document.body.classList.add('theme-light');
  else document.body.classList.remove('theme-light');
  document.getElementById('theme-dark-btn').classList.toggle('active', theme !== 'light');
  document.getElementById('theme-light-btn').classList.toggle('active', theme === 'light');
  saveSettings();
};

window.openDataDir = function() {
  try {
    const { shell } = require('electron');
    const { app } = require('electron').remote || require('@electron/remote');
    shell.openPath(app.getPath('userData'));
  } catch (e) { console.error('Cannot open data dir:', e); }
};

window.setupWhatsApp = function() {
  addChatMsg('system', '📱 WhatsApp connection is configured through OpenClaw. Run `openclaw configure --section whatsapp` in the terminal tab.');
  closeSettings();
  switchTermTab('terminal');
};

window.resetSettings = function() {
  if (!confirm('Reset all settings to defaults?')) return;
  localStorage.removeItem(SETTINGS_KEY);
  applySettings();
  openSettings();
};

// ── Custom LLM Providers ──────────────────────────────────────── Each provider: { id, name, baseUrl, apiKey?, defaultModel?, api } `api`…
async function fetchProviders() {
  try {
    const fromOpenClaw = await cyberclaw.openclaw.listProviders();
    if (Array.isArray(fromOpenClaw) && fromOpenClaw.length) return fromOpenClaw;
  } catch (e) { console.warn('openclaw listProviders:', e); }
  try { return await cyberclaw.providers.list(); } catch { return []; }
}

async function renderProvidersList() {
  const list = document.getElementById('providers-list');
  if (!list) return;
  const providers = await fetchProviders();
  if (!providers.length) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:10px;padding:6px 2px;">No saved providers yet. Add one below.</div>';
    return;
  }
  list.innerHTML = providers.map(p => {
    const safeId = (p.id || '').replace(/[^a-z0-9_-]/gi, '');
    const url = p.baseUrl ? p.baseUrl.replace(/^https?:\/\//, '') : '';
    return `
      <div class="provider-row" data-provider-id="${safeId}">
        <span class="provider-name">🧠 ${escapeHtml(p.name)}</span>
        <span class="provider-url" title="${escapeHtml(p.baseUrl || '')}">${escapeHtml(url)}</span>
        <span class="provider-model" title="${escapeHtml(p.defaultModel || '')}">${escapeHtml(p.defaultModel || '—')}</span>
        <button class="btn-xs btn-danger" onclick="deleteProvider('${safeId}')" title="Delete this provider">✕</button>
      </div>`;
  }).join('');
}

async function refreshDefaultModelDropdown() {
  const sel = document.getElementById('settings-default-model');
  if (!sel) return;
  const current = sel.value;
  const providers = await fetchProviders();
  const settings = loadSettings();
  // Build options: keep the "Use OpenClaw default" entry, then a group per provider We list the *default model* from each provider, but also…
  const wellKnown = WELL_KNOWN_MODELS;
  const groups = {};
  for (const w of wellKnown) {
    (groups[w.provider] = groups[w.provider] || []).push(
      `<option value="${escapeAttr(w.model)}"${w.model === current ? ' selected' : ''}>${escapeHtml(w.label)}</option>`
    );
  }
  for (const p of providers) {
    const groupName = p.name || p.id || 'Provider';
    const model = (p.defaultModel || '').trim();
    if (!model) continue;
    (groups[groupName] = groups[groupName] || []).push(
      `<option value="${escapeAttr(model)}"${model === current ? ' selected' : ''}>${escapeHtml(p.name)} — ${escapeHtml(model)}</option>`
    );
  }
  const html = `<option value="">Use OpenClaw default</option>` +
    Object.keys(groups).sort().map(name =>
      `<optgroup label="${escapeAttr(name)}">${groups[name].join('')}</optgroup>`
    ).join('');
  sel.innerHTML = html;
  // Restore selection if still valid
  if (current) sel.value = current;
  // Save current setting so the default model round-trips
  settings.defaultModel = sel.value;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

window.addProvider = async function() {
  const name = (document.getElementById('provider-add-name')?.value || '').trim();
  const baseUrl = (document.getElementById('provider-add-url')?.value || '').trim();
  const apiKey = (document.getElementById('provider-add-key')?.value || '').trim();
  const defaultModel = (document.getElementById('provider-add-model')?.value || '').trim();
  const api = document.getElementById('provider-add-api')?.value || 'openai-completions';
  if (!name || !baseUrl) {
    alert('Provider needs at least a name and base URL.');
    return;
  }
  // id is derived from the name (kebab-case)
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'provider';
  // Write through to openclaw config first; fall back to local providers.json
  let res = null;
  try {
    res = await cyberclaw.openclaw.upsertProvider({ id, name, baseUrl, apiKey, defaultModel, api });
  } catch (e) { console.warn('openclaw.upsertProvider:', e); }
  if (!res || !res.ok) {
    res = await cyberclaw.providers.save({ id, name, baseUrl, apiKey, defaultModel, api });
  }
  if (!res || !res.ok) {
    alert('Failed to save provider: ' + (res?.error || 'unknown'));
    return;
  }
  // Clear form
  ['provider-add-name','provider-add-url','provider-add-key','provider-add-model'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  // Close the details panel
  const det = document.getElementById('provider-add-details');
  if (det) det.removeAttribute('open');
  await renderProvidersList();
  await refreshDefaultModelDropdown();
  await refreshForgeModelDropdowns().catch(() => {});
  addChatMsg('system', '✅ Provider saved to openclaw config: ' + name);
};

// One-click provider presets.
const PROVIDER_PRESETS = [
  { id: 'openrouter', name: 'OpenRouter',  baseUrl: 'https://openrouter.ai/api/v1',            defaultModel: 'openrouter/auto',       api: 'openai-completions', emoji: '🧭' },
  { id: 'groq',       name: 'Groq',        baseUrl: 'https://api.groq.com/openai/v1',           defaultModel: 'llama-3.3-70b-versatile', api: 'openai-completions', emoji: '⚡' },
  { id: 'together',   name: 'Together',    baseUrl: 'https://api.together.xyz/v1',             defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', api: 'openai-completions', emoji: '🤝' },
  { id: 'fireworks',  name: 'Fireworks',   baseUrl: 'https://api.fireworks.ai/inference/v1',   defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct', api: 'openai-completions', emoji: '🎆' },
  { id: 'mistral',    name: 'Mistral',     baseUrl: 'https://api.mistral.ai/v1',               defaultModel: 'mistral-large-latest',  api: 'openai-completions', emoji: '🌬️' },
  { id: 'deepseek',   name: 'DeepSeek',    baseUrl: 'https://api.deepseek.com/v1',             defaultModel: 'deepseek-chat',         api: 'openai-completions', emoji: '🐋' },
];

window.applyProviderPreset = function(id) {
  const preset = PROVIDER_PRESETS.find(p => p.id === id);
  if (!preset) return;
  const set = (key, val) => { const el = document.getElementById(key); if (el) el.value = val; };
  set('provider-add-name', preset.name);
  set('provider-add-url', preset.baseUrl);
  set('provider-add-model', preset.defaultModel);
  set('provider-add-api', preset.api);
  // Clear API key so the placeholder hints at it; user types fresh.
  const keyEl = document.getElementById('provider-add-key'); if (keyEl) keyEl.value = '';
  // Open the form if collapsed
  const det = document.getElementById('provider-add-details');
  if (det && !det.hasAttribute('open')) det.setAttribute('open', '');
  // Focus the API key input for fast paste
  setTimeout(() => { if (keyEl) keyEl.focus(); }, 50);
};

window.renderProviderPresets = function() {
  const root = document.getElementById('provider-presets');
  if (!root) return;
  root.innerHTML = PROVIDER_PRESETS.map(p =>
    `<button class="btn-sm btn-muted" onclick="applyProviderPreset('${p.id}')" title="Pre-fills the form for ${escapeAttr(p.name)}">${p.emoji} ${escapeHtml(p.name)}</button>`
  ).join('');
};

window.cancelAddProvider = function() {
  ['provider-add-name','provider-add-url','provider-add-key','provider-add-model'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const det = document.getElementById('provider-add-details');
  if (det) det.removeAttribute('open');
};

window.deleteProvider = async function(id) {
  if (!confirm('Delete this provider? This will also remove it from openclaw config. Saved models in companion configs will be kept but may stop working.')) return;
  // Try openclaw first, fall back to local
  try {
    const r = await cyberclaw.openclaw.deleteProvider(id);
    if (r && r.ok) {
      await renderProvidersList();
      await refreshDefaultModelDropdown();
      await refreshForgeModelDropdowns().catch(() => {});
      addChatMsg('system', '🗑️ Provider deleted from openclaw config');
      return;
    }
  } catch (e) { console.warn('openclaw.deleteProvider:', e); }
  await cyberclaw.providers.delete(id);
  await renderProvidersList();
  await refreshDefaultModelDropdown();
  await refreshForgeModelDropdowns().catch(() => {});
  addChatMsg('system', '🗑️ Provider deleted');
};

// ─── LLM Endpoints (v3.1.33) ──────────────────────────────────── User-managed OpenAI-compatible HTTP endpoints (Ollama, LM Studio,…

async function renderLlmEndpoints() {
  const list = await cyberclaw.llm.endpoints.list();
  const container = document.getElementById('llm-endpoints-list');
  if (!container) return;
  if (!list.length) {
    container.innerHTML = '<div class="settings-info" style="color:var(--text-muted);font-size:11px;padding:6px 0;">No local endpoints yet. Click "Detect Ollama" if you have Ollama running, or "Add endpoint" for LM Studio / llama.cpp / etc.</div>';
    return;
  }
  container.innerHTML = list.map(e => {
    const safeId = escapeAttr(e.id);
    const modelCount = (e.models || []).length;
    const probedAt = e.lastProbedAt ? new Date(e.lastProbedAt).toLocaleTimeString() : 'never';
    const errored = e.lastError ? `<div style="color:#f88;font-size:10px;margin-top:4px;">⚠ ${escapeHtml(e.lastError)}</div>` : '';
    return `<div class="provider-card" style="padding:8px 10px;border:1px solid rgba(0,255,204,0.15);border-radius:6px;margin-bottom:6px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div style="flex:1;">
          <div style="font-weight:600;">${escapeHtml(e.name)}${e.autoDetected ? ' <span style="color:var(--cyan);font-size:10px;">(auto-detected)</span>' : ''}</div>
          <div style="font-size:11px;color:var(--text-muted);font-family:monospace;">${escapeHtml(e.baseUrl)}</div>
          <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${modelCount} model${modelCount === 1 ? '' : 's'} · last probed ${probedAt}</div>
          ${errored}
        </div>
        <div style="display:flex;gap:4px;">
          <button class="btn-xs btn-muted" onclick="probeLlmEndpoint('${safeId}')" title="Re-probe for available models">🔄</button>
          <button class="btn-xs btn-danger" onclick="deleteLlmEndpoint('${safeId}')" title="Delete this endpoint">✕</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

window.detectOllama = async function() {
  const r = await cyberclaw.llm.endpoints.detectOllama();
  if (!r.ok) {
    addChatMsg('system', '🦙 Ollama not detected. Is it running? (try `ollama serve` in a terminal)');
    return;
  }
  await renderLlmEndpoints();
  await refreshForgeModelDropdowns().catch(() => {});
  if (r.alreadyConfigured) {
    addChatMsg('system', `🦙 Ollama found — ${r.endpoint.models.length} model${r.endpoint.models.length === 1 ? '' : 's'} refreshed.`);
  } else {
    addChatMsg('system', `🦙 Ollama auto-configured as "Local Ollama" (${r.endpoint.models.length} model${r.endpoint.models.length === 1 ? '' : 's'}).`);
  }
};

window.probeLlmEndpoint = async function(id) {
  const r = await cyberclaw.llm.endpoints.probe(id);
  if (!r.ok) {
    addChatMsg('system', '❌ Probe failed: ' + (r.error || 'unknown'));
    return;
  }
  await renderLlmEndpoints();
  await refreshForgeModelDropdowns().catch(() => {});
  addChatMsg('system', `🔄 ${r.endpoint.name}: ${r.endpoint.models.length} model${r.endpoint.models.length === 1 ? '' : 's'} found.`);
};

window.deleteLlmEndpoint = async function(id) {
  if (!confirm('Delete this endpoint? Companions using it will fall back to the default model.')) return;
  await cyberclaw.llm.endpoints.delete(id);
  await renderLlmEndpoints();
  await refreshForgeModelDropdowns().catch(() => {});
  addChatMsg('system', '🗑️ Endpoint deleted');
};

window.testLlmEndpoint = async function() {
  const baseUrl = document.getElementById('endpoint-add-url')?.value?.trim();
  const apiKey = document.getElementById('endpoint-add-key')?.value?.trim();
  const status = document.getElementById('endpoint-add-probe-status');
  if (!baseUrl) {
    if (status) status.textContent = '⚠ Enter a base URL first';
    return;
  }
  if (status) status.textContent = '🔄 Testing...';
  // Save without committing, just probe.
  try {
    // Probe via a temp endpoint, then remove if user cancels.
    const r = await cyberclaw.llm.endpoints.add({
      name: '__test__',
      baseUrl,
      apiKey,
    });
    if (r.ok && r.probe.ok) {
      if (status) status.textContent = `✅ Reachable — ${r.probe.models.length} model${r.probe.models.length === 1 ? '' : 's'}: ${r.probe.models.slice(0, 3).map(m => m.id).join(', ')}${r.probe.models.length > 3 ? '...' : ''}`;
    } else {
      if (status) status.textContent = `⚠ Reachable but probe failed: ${r.probe?.error || 'unknown'}`;
    }
    // Cleanup the test entry
    await cyberclaw.llm.endpoints.delete('__test__');
  } catch (e) {
    if (status) status.textContent = `❌ ${e?.message || 'test failed'}`;
  }
};

window.addLlmEndpoint = async function() {
  const name = document.getElementById('endpoint-add-name')?.value?.trim();
  const baseUrl = document.getElementById('endpoint-add-url')?.value?.trim();
  const apiKey = document.getElementById('endpoint-add-key')?.value?.trim();
  if (!name || !baseUrl) {
    alert('Name and base URL are required');
    return;
  }
  const r = await cyberclaw.llm.endpoints.add({ name, baseUrl, apiKey });
  if (!r.ok) {
    alert('Failed: ' + (r.error || 'unknown'));
    return;
  }
  cancelAddLlmEndpoint();
  await renderLlmEndpoints();
  await refreshForgeModelDropdowns().catch(() => {});
  if (r.probe?.ok) {
    addChatMsg('system', `🦙 Added "${name}" — ${r.probe.models.length} model${r.probe.models.length === 1 ? '' : 's'} discovered.`);
  } else {
    addChatMsg('system', `⚠ Added "${name}" but probe failed: ${r.probe?.error || 'unknown'}. You can retry probing from the endpoint card.`);
  }
};

window.cancelAddLlmEndpoint = function() {
  ['endpoint-add-name','endpoint-add-url','endpoint-add-key'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const det = document.getElementById('llm-endpoint-add-details');
  if (det) det.removeAttribute('open');
  const status = document.getElementById('endpoint-add-probe-status');
  if (status) status.textContent = '';
};

// Populate the companion forge model dropdown with hard-coded + custom providers
async function refreshForgeModelDropdowns() {
  const providers = await fetchProviders();
  const endpoints = await cyberclaw.llm.endpoints.list().catch(() => []);
  // Group the well-known catalog by provider for the forge optgroups.
  const wmGroups = {};
  for (const w of WELL_KNOWN_MODELS) {
    (wmGroups[w.provider] = wmGroups[w.provider] || []).push({ value: w.model, label: w.label });
  }
  const wellKnown = Object.keys(wmGroups).sort().map(provider => ({
    group: provider,
    options: wmGroups[provider],
  }));
  // Custom providers
  for (const p of providers) {
    const model = (p.defaultModel || '').trim();
    if (!model) continue;
    wellKnown.push({ group: p.name || p.id, options: [{ value: model, label: model }] });
  }
  // Per-endpoint model picker.
  for (const e of endpoints) {
    if (!e.models || !e.models.length) continue;
    wellKnown.push({
      group: e.name || e.id,
      options: e.models.map(m => ({
        value: `${e.id}/${m.id}`,
        label: m.id,
      })),
    });
  }
  const html = wellKnown.map(g =>
    `<optgroup label="${escapeAttr(g.group)}">${g.options.map(o =>
      `<option value="${escapeAttr(o.value)}">${escapeHtml(o.label)}</option>`
    ).join('')}</optgroup>`
  ).join('');
  const sel1 = document.getElementById('forge-model-primary');
  const sel2 = document.getElementById('forge-model-secondary');
  // Preserve current values
  const v1 = sel1?.value; const v2 = sel2?.value;
  if (sel1) sel1.innerHTML = html;
  if (sel2) sel2.innerHTML = `<option value="">None (primary only)</option>` + html;
  if (sel1 && v1) {
    sel1.value = v1;
    if (sel1.value !== v1) {
      // value wasn't in the new list — keep it as a custom option so the
      // user's existing config is preserved visually
      const opt = document.createElement('option');
      opt.value = v1; opt.textContent = v1 + ' (custom)'; opt.selected = true;
      sel1.insertBefore(opt, sel1.firstChild);
    }
  }
  if (sel2 && v2) sel2.value = v2;
}

function escapeAttr(s) { return String(s == null ? '' : s).replace(/[&"'<>]/g, c => ({'&':'&amp;','"':'&quot;',"'":'&#39;','<':'&lt;','>':'&gt;'})[c]); }

// ── Mobile Companion ──
let pairingTimerInterval = null;

// ─────────────────────────────────────────────────────────────── v3.3.10: New forge model panel (provider-first + free-text model).

// Provider metadata.
const FORGE_PROVIDERS = {
  anthropic:  { prefix: 'anthropic',  keyEnv: 'ANTHROPIC_API_KEY',  placeholder: 'claude-opus-4-8' },
  openai:     { prefix: 'openai',     keyEnv: 'OPENAI_API_KEY',     placeholder: 'gpt-5.5' },
  google:     { prefix: 'google',     keyEnv: 'GOOGLE_API_KEY',     placeholder: 'gemini-2.5-pro' },
  minimax:    { prefix: 'minimax',    keyEnv: 'MINIMAX_API_KEY',    placeholder: 'MiniMax-M3' },
  openrouter: { prefix: 'openrouter', keyEnv: 'OPENROUTER_API_KEY', placeholder: 'anthropic/claude-sonnet-4-6' },
  mistral:    { prefix: 'mistral',    keyEnv: 'MISTRAL_API_KEY',    placeholder: 'mistral-large-latest' },
  groq:       { prefix: 'groq',       keyEnv: 'GROQ_API_KEY',       placeholder: 'llama-3.3-70b-versatile' },
  // 'custom' is special: no prefix, no keyEnv. The user types
  // whatever they want and the baseUrl field below provides
  // the routing hint.
  custom:     { prefix: '',           keyEnv: '',                   placeholder: 'my-model-id' },
};

// Hydrate the forge model panel from a saved primaryModel string (e.g.
function hydrateForgeModelPanel(primaryModel) {
  const pm = (primaryModel || '').trim();
  const providerEl = document.getElementById('forge-model-provider');
  const idEl = document.getElementById('forge-model-id');
  const prefixEl = document.getElementById('forge-model-prefix');
  const keyEl = document.getElementById('forge-model-key');
  const keyRowEl = document.getElementById('forge-model-key-row');
  const baseUrlRowEl = document.getElementById('forge-model-baseurl-row');
  const baseUrlEl = document.getElementById('forge-model-baseurl');
  const statusEl = document.getElementById('forge-model-status');

  if (!providerEl || !idEl) return;

  if (!pm) {
    // Empty config — clear everything.
    providerEl.value = '';
    idEl.value = '';
    if (prefixEl) prefixEl.textContent = 'provider/';
    if (keyEl) keyEl.value = '';
    if (baseUrlEl) baseUrlEl.value = '';
    if (keyRowEl) keyRowEl.style.display = '';
    if (baseUrlRowEl) baseUrlRowEl.style.display = 'none';
    if (statusEl) statusEl.textContent = 'Pick a provider, then type any model id your provider supports.';
    return;
  }

  // Split "provider/model" on the first slash.
  const idx = pm.indexOf('/');
  const provider = idx > 0 ? pm.slice(0, idx) : '';
  const modelId = idx > 0 ? pm.slice(idx + 1) : pm;

  if (provider && FORGE_PROVIDERS[provider]) {
    providerEl.value = provider;
    idEl.value = modelId;
    if (prefixEl) prefixEl.textContent = provider + '/';
    if (keyRowEl) keyRowEl.style.display = '';
    if (baseUrlRowEl) baseUrlRowEl.style.display = 'none';
    // Pull the saved key for this provider (if any) so
    // the user sees what's configured. The user can
    // overwrite or clear it.
    hydrateForgeProviderKey(provider);
    if (statusEl) {
      const hint = FORGE_PROVIDERS[provider].keyEnv;
      statusEl.textContent = `Hint: ${hint} env var works too.`;
    }
  } else if (provider) {
    // Unknown provider (e.g. user typed a fully-custom
    // value into the free-text field). Treat as Custom
    // so the user can adjust the baseUrl if needed.
    providerEl.value = 'custom';
    idEl.value = pm;
    if (prefixEl) prefixEl.textContent = '';
    if (keyRowEl) keyRowEl.style.display = '';
    if (baseUrlRowEl) baseUrlRowEl.style.display = '';
    if (statusEl) statusEl.textContent = `Custom provider: ${provider}. Add baseUrl below if needed.`;
  } else {
    // No provider prefix at all (e.g. legacy 'claude-opus-4-6').
    // Treat as bare custom; user can pick a provider to route it.
    providerEl.value = '';
    idEl.value = pm;
    if (prefixEl) prefixEl.textContent = 'provider/';
    if (statusEl) statusEl.textContent = 'Pick a provider to route this model.';
  }
}

// Hydrate the API key field from the saved providers.json entry for the given provider id.
async function hydrateForgeProviderKey(providerId) {
  const keyEl = document.getElementById('forge-model-key');
  if (!keyEl) return;
  if (!providerId || providerId === 'custom') { keyEl.value = ''; return; }
  try {
    const providers = await fetchProviders();
    const p = providers.find(x => (x.id || '').toLowerCase() === providerId.toLowerCase());
    keyEl.value = p && p.apiKey ? '••••••••' : '';
  } catch (e) {
    console.warn('hydrateForgeProviderKey:', e?.message);
  }
}

// OnChange handler for #forge-model-provider.
window.onForgeProviderChange = function() {
  const providerEl = document.getElementById('forge-model-provider');
  const provider = providerEl?.value || '';
  const prefixEl = document.getElementById('forge-model-prefix');
  const idEl = document.getElementById('forge-model-id');
  const baseUrlRowEl = document.getElementById('forge-model-baseurl-row');
  const statusEl = document.getElementById('forge-model-status');

  const meta = FORGE_PROVIDERS[provider];
  if (meta) {
    if (prefixEl) prefixEl.textContent = provider === 'custom' ? '' : (provider + '/');
    if (idEl && !idEl.value && meta.placeholder) idEl.placeholder = meta.placeholder;
    if (baseUrlRowEl) baseUrlRowEl.style.display = provider === 'custom' ? '' : 'none';
    if (statusEl) {
      if (provider === 'custom') {
        statusEl.textContent = 'Custom provider: enter baseUrl + any model id.';
      } else if (meta.keyEnv) {
        statusEl.textContent = `Hint: ${meta.keyEnv} env var works too.`;
      }
    }
    hydrateForgeProviderKey(provider);
  } else {
    if (prefixEl) prefixEl.textContent = 'provider/';
    if (baseUrlRowEl) baseUrlRowEl.style.display = 'none';
    if (statusEl) statusEl.textContent = 'Pick a provider, then type any model id your provider supports.';
  }
};

// v3.3.10: toggle key field between masked + visible.
// Bound in markup via onclick="toggleForgeKeyVisibility()".
window.toggleForgeKeyVisibility = function() {
  const keyEl = document.getElementById('forge-model-key');
  if (!keyEl) return;
  if (keyEl.type === 'password') {
    keyEl.type = 'text';
    // If the field shows the masked placeholder, clear it
    // so the user can type a real key instead of editing
    // the masked dots.
    if (keyEl.value === '••••••••') keyEl.value = '';
  } else {
    keyEl.type = 'password';
  }
};

// Save the API key for the chosen provider.
window.saveForgeProviderKey = async function() {
  const providerEl = document.getElementById('forge-model-provider');
  const keyEl = document.getElementById('forge-model-key');
  const statusEl = document.getElementById('forge-model-status');
  const provider = providerEl?.value || '';
  const key = (keyEl?.value || '').trim();
  if (!provider || provider === 'custom') {
    if (statusEl) statusEl.textContent = 'Pick a provider first.';
    return;
  }
  // Don't write the masked placeholder as the key.
  if (!key || key === '••••••••') {
    if (statusEl) statusEl.textContent = 'Type a key first (or leave blank to use the env var).';
    return;
  }
  try {
    // Fetch existing entry (if any) to preserve name +
    // baseUrl + api style. New providers get sensible
    // defaults.
    const existing = await fetchProviders();
    const prior = existing.find(x => (x.id || '').toLowerCase() === provider.toLowerCase()) || {};
    const meta = FORGE_PROVIDERS[provider] || {};
    const result = await cyberclaw.providers.save({
      id: prior.id || provider,
      name: prior.name || provider.charAt(0).toUpperCase() + provider.slice(1),
      baseUrl: prior.baseUrl || (provider === 'openrouter' ? 'https://openrouter.ai/api/v1'
                                : provider === 'minimax' ? 'https://api.minimax.chat/v1'
                                : provider === 'groq' ? 'https://api.groq.com/openai/v1'
                                : ''),
      apiKey: key,
      defaultModel: prior.defaultModel || '',
      api: prior.api || 'openai-completions',
    });
    if (result?.ok) {
      if (statusEl) statusEl.textContent = '✓ API key saved for ' + provider;
      // Mask the key back so it doesn't sit in plaintext
      // in the DOM.
      keyEl.value = '••••••••';
      keyEl.type = 'password';
      renderProvidersList(); // refresh Settings → LLM Providers list
    } else {
      if (statusEl) statusEl.textContent = '⚠️ Save failed: ' + (result?.error || 'unknown');
    }
  } catch (e) {
    console.warn('saveForgeProviderKey:', e?.message);
    if (statusEl) statusEl.textContent = '⚠️ Save failed: ' + (e?.message || 'unknown');
  }
};

// v3.3.10: read the current panel state and return the
// final primaryModel string. Empty if nothing usable is
// filled in. Used by the save path below.
function readForgePrimaryModel() {
  const providerEl = document.getElementById('forge-model-provider');
  const idEl = document.getElementById('forge-model-id');
  const baseUrlEl = document.getElementById('forge-model-baseurl');
  const provider = providerEl?.value || '';
  const modelId = (idEl?.value || '').trim();
  if (!modelId) return '';
  if (provider === 'custom') {
    // Custom provider: write "baseUrl/modelId" so the runtime can route.
    const baseUrl = (baseUrlEl?.value || '').trim();
    if (baseUrl) {
      // Convert baseUrl to a safe provider id (host
      // part, no scheme).
      const host = baseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/[^a-z0-9.-]/gi, '-');
      if (host) return host + '/' + modelId;
    }
    return 'custom/' + modelId;
  }
  if (!provider) return modelId; // no provider picked — pass through as bare id
  return provider + '/' + modelId;
}

// v3.3.10: scroll to the Settings → LLM Endpoints section.
// Bound in markup via onclick="openLocalEndpointsSection()".
window.openLocalEndpointsSection = function() {
  // Close the forge, open Settings, scroll to endpoints.
  closeCompanionEditor();
  if (typeof openSettings === 'function') openSettings();
  setTimeout(() => {
    const sec = document.getElementById('llm-endpoints-section')
              || document.querySelector('[data-section="llm-endpoints"]');
    if (sec) { showSettingsSection(sec); sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }, 200);
};

window.generatePairingCode = async function() {
  try {
    const { ipcRenderer } = require('electron');
    const code = await ipcRenderer.invoke('sync-generate-pairing');
    if (!code) { alert('Sync server not running'); return; }

    document.getElementById('mobile-pairing-display').classList.remove('hidden');
    document.getElementById('mobile-pairing-code').textContent = code;
    document.getElementById('mobile-pair-btn').textContent = '🔄 Regenerate Code';

    // Countdown timer (5 minutes)
    let remaining = 300;
    if (pairingTimerInterval) clearInterval(pairingTimerInterval);
    const timerEl = document.getElementById('mobile-pairing-timer');
    pairingTimerInterval = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(pairingTimerInterval);
        pairingTimerInterval = null;
        document.getElementById('mobile-pairing-display').classList.add('hidden');
        document.getElementById('mobile-pair-btn').textContent = '🔗 Generate Pairing Code';
        document.getElementById('mobile-pairing-code').textContent = '------';
        return;
      }
      const min = Math.floor(remaining / 60);
      const sec = remaining % 60;
      timerEl.textContent = `${min}:${String(sec).padStart(2, '0')}`;
    }, 1000);
  } catch (e) {
    console.error('Pairing error:', e);
  }
};

async function updateMobileStatus() {
  try {
    const { ipcRenderer } = require('electron');
    const status = await ipcRenderer.invoke('sync-status');
    if (!status) return;

    const dot = document.getElementById('mobile-status-dot');
    const text = document.getElementById('mobile-status-text');
    const devicesList = document.getElementById('mobile-devices-list');

    if (status.connectedDevices > 0) {
      dot.className = 'conn-dot online';
      text.textContent = `${status.connectedDevices} device${status.connectedDevices > 1 ? 's' : ''} connected`;
    } else {
      dot.className = 'conn-dot offline';
      text.textContent = 'Not connected';
    }

    // Paired devices list
    if (status.pairedDevices && status.pairedDevices.length > 0) {
      devicesList.innerHTML = status.pairedDevices.map(d => {
        const connected = status.devices.some(c => c.name === d.name);
        const dot = connected ? '🟢' : '⚪';
        const date = new Date(d.pairedAt).toLocaleDateString();
        return `<div style="margin:2px 0;">${dot} ${d.name} <span style="color:#555;">(paired ${date})</span></div>`;
      }).join('');
    } else {
      devicesList.textContent = 'None';
    }

    // Local IP — prefer real LAN addresses (192.168.x, 10.x) over VPN/Tailscale
    const ipEl = document.getElementById('mobile-local-ip');
    try {
      const os = require('os');
      const nets = os.networkInterfaces();
      let lanIp = null;
      let anyIp = null;
      for (const name of Object.keys(nets)) {
        if (name.includes('tailscale') || name.includes('docker') || name.includes('br-') || name.includes('veth')) continue;
        for (const net of nets[name]) {
          if (net.family === 'IPv4' && !net.internal) {
            if (!anyIp) anyIp = net.address;
            if (net.address.startsWith('192.168.') || net.address.startsWith('10.') || net.address.startsWith('172.')) {
              lanIp = net.address;
            }
          }
        }
      }
      const ip = lanIp || anyIp;
      if (ip) ipEl.textContent = `${ip}:9247`;
    } catch {}

    // Fetch public IP
    const pubEl = document.getElementById('mobile-public-ip');
    if (pubEl) {
      fetch('https://api.ipify.org?format=json')
        .then(r => r.json())
        .then(data => {
          if (data.ip) {
            pubEl.textContent = data.ip;
            pubEl.onclick = () => {
              require('electron').clipboard.writeText(data.ip);
              pubEl.textContent = data.ip + ' ✓ copied';
              setTimeout(() => { pubEl.textContent = data.ip; }, 2000);
            };
          }
        })
        .catch(() => {
          // Try IPv6
          fetch('https://api64.ipify.org?format=json')
            .then(r => r.json())
            .then(data => {
              if (data.ip) {
                pubEl.textContent = data.ip;
                pubEl.onclick = () => {
                  require('electron').clipboard.writeText(data.ip);
                  pubEl.textContent = data.ip + ' ✓ copied';
                  setTimeout(() => { pubEl.textContent = data.ip; }, 2000);
                };
              }
            })
            .catch(() => { pubEl.textContent = 'Could not detect'; });
        });
    }
  } catch {}
}

// Desktop log panel
window.addDesktopLog = function(emoji, title, detail = '', level = 'info') {
  const el = document.getElementById('log-messages');
  if (!el) return;
  const colors = { info: '#a0a0b8', success: '#4ade80', warn: '#f7931e', error: '#ff3366', voice: '#a78bfa', tts: '#38bdf8' };
  const color = colors[level] || colors.info;
  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const line = document.createElement('div');
  line.style.cssText = `padding:2px 4px;border-bottom:1px solid #111;color:${color};`;
  line.innerHTML = `<span style="opacity:0.5">${ts}</span> ${emoji} <b>${title}</b>${detail ? ` <span style="opacity:0.7">— ${detail}</span>` : ''}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  // Cap at 200 entries
  while (el.children.length > 200) el.removeChild(el.firstChild);
};

// Listen for mobile connection events
try {
  const { ipcRenderer } = require('electron');
  ipcRenderer.on('desktop-log', (e, { emoji, title, detail, level }) => {
    window.addDesktopLog(emoji, title, detail, level);
  });
  ipcRenderer.on('mobile-connected', () => { updateMobileStatus(); window.addDesktopLog('📱', 'Mobile connected', '', 'success'); });
  ipcRenderer.on('mobile-disconnected', () => { updateMobileStatus(); window.addDesktopLog('📴', 'Mobile disconnected', '', 'warn'); });
  ipcRenderer.on('mobile-paired', () => { updateMobileStatus(); window.addDesktopLog('🔗', 'Mobile paired', '', 'success'); });

  // OpenClaw session tailer pushes assistant text messages from Discord-routed agent runs into the renderer's chat history so the mobile can…
  ipcRenderer.on('openclaw-session-chat-message', (e, { agentId, agentName, text, isUser, ts }) => {
    try {
      const resolvedAgentId = agentName || agentId || 'companion';
      // Do NOT push Discord tail messages to the flat chatHistory mirror.
      const bucketedAgentId =
        agentIdForName(resolvedAgentId) ||
        activeChatAgentId ||
        (agentOrder[focusIndex]) ||
        null;
      if (bucketedAgentId) {
        // Per-quest bucketing.
        if (!chatHistoryByAgentAndQuest[bucketedAgentId]) {
          chatHistoryByAgentAndQuest[bucketedAgentId] = {};
        }
        if (!chatHistoryByAgentAndQuest[bucketedAgentId][DEFAULT_QUEST_KEY]) {
          chatHistoryByAgentAndQuest[bucketedAgentId][DEFAULT_QUEST_KEY] = [];
        }
        chatHistoryByAgentAndQuest[bucketedAgentId][DEFAULT_QUEST_KEY].push({
          type: isUser ? 'user' : 'agent',
          text,
          name: agentName || null,
          emoji: null,
          ts: ts || Date.now(),
          activeQuestId: null,
          activeQuestName: null,
        });
        const defaultBucket = chatHistoryByAgentAndQuest[bucketedAgentId][DEFAULT_QUEST_KEY];
        if (defaultBucket.length > 200) {
          chatHistoryByAgentAndQuest[bucketedAgentId][DEFAULT_QUEST_KEY] =
            defaultBucket.slice(-200);
        }
        schedulePersistChatHistory();

        // Intentionally does NOT stamp this Discord-routed message onto the active quest's conversation log.
      }
      window.addDesktopLog?.('💬', 'OpenClaw tail', text.substring(0, 60));
    } catch (err) {
      console.error('[App] openclaw-session-chat-message handler error:', err);
    }
  });
  ipcRenderer.on('openclaw-session-typing', (e, { active }) => {
    // The tailer emits typing-off when it sees an assistant text message.
    if (active === false) {
      // The chat pipeline owns the typing indicator when it's in flight.
    }
  });

  ipcRenderer.on('mobile-request-chat-history', () => {
    // Send current chat history to mobile.
    const recentMessages = chatHistory.slice(-50).map(m => ({
      ...m,
      text: typeof m.text === 'string' ? stripAgentReplyDecorations(m.text) : m.text,
    }));
    console.log('[App] Mobile requesting chat history, sending', recentMessages.length, 'messages');
    ipcRenderer.invoke('sync-send-chat-history', { messages: recentMessages })
      .then(() => console.log('[App] Chat history sent successfully'))
      .catch(err => console.log('[App] Error sending chat history:', err));
  });

  // v3.1.17: per-agent chat history for the mobile companion tab bar.
  // Mobile sends this when the user taps a different companion tab;
  // we send back the last 50 messages for that companion only.
  ipcRenderer.on('mobile-request-agent-history', async (e, { agentId }) => {
    // v3.5.2: full history for the phone. Quest chats include the
    // quest's CONVERSATION.md history (same as the desktop shows),
    // merged with this session's messages. Casual + active quest get
    // up to 300 messages, other quests 100 (the phone pages them).
    const agentBuckets = { ...(chatHistoryByAgentAndQuest[agentId] || {}) };
    const activeKey = questKeyForStorage(activeQuestId || _casualFromQuestId || null);
    for (const q of (cachedQuestsList || [])) {
      if (!q || !q.id) continue;
      try { await loadQuestFileHistory(agentId, q.id); } catch (_) {}
      const fileHist = questFileHistoryFor(agentId, q.id) || [];
      if (!fileHist.length) continue;
      const live = agentBuckets[q.id] || [];
      const seen = new Set(live.map(chatDedupeKey));
      agentBuckets[q.id] = fileHist.filter(m => !seen.has(chatDedupeKey(m))).concat(live)
        .sort((x, y) => (x.ts || 0) - (y.ts || 0));
    }
    const buckets = {};
    for (const [bucketKey, msgs] of Object.entries(agentBuckets)) {
      if (!Array.isArray(msgs) || msgs.length === 0) continue;
      const cap = (bucketKey === DEFAULT_QUEST_KEY || bucketKey === activeKey) ? 300 : 100;
      buckets[bucketKey] = msgs.filter(m => m && (m.type === 'user' || m.type === 'agent' || m.type === 'agent-image' || m.type === 'error')).slice(-cap).map((m) => ({
        text: typeof m.text === 'string' ? stripAgentReplyDecorations(m.text) : m.text,
        isUser: m.type === 'user',
        isError: m.type === 'error',
        // v3.6.4: images (thumbnails) travel with history so they stay visible on the phone.
        attachments: Array.isArray(m.attachments) ? m.attachments.filter(x => x && x.data && !x.thumbOnly).map(x => ({ data: x.data, type: x.type, name: x.name, size: x.size })) : undefined,
        agentId: m.name || agentId,
        agentName: m.name || null,
        ts: m.ts,
        // Stamp the quest on each message so the mobile can route to the right bucket even if the bucket key is ever lost in a future IPC shape…
        activeQuestId: questKeyFromStorage(bucketKey),
        activeQuestName: m.activeQuestName ?? null,
      }));
    }
    console.log(`[App] Mobile requesting agent history for ${agentId}, sending ${Object.keys(buckets).length} bucket(s)`);
    ipcRenderer.invoke('sync-send-agent-history', { agentId, buckets })
      .then(() => console.log(`[App] Agent history sent for ${agentId}`))
      .catch(err => console.log(`[App] Error sending agent history for ${agentId}:`, err));
  });

  // The sync server can ask us to re-broadcast the current agents list.
  ipcRenderer.on('mobile-request-agents-list', () => {
    // Delegate to broadcastAgentsListToMobile so both broadcast sites use the SAME list shape (with spriteConfig + avatar).
    console.log('[App] Sync server requested agents list refresh');
    broadcastAgentsListToMobile().catch((e) => {
      console.log('[App] Error re-broadcasting agents list:', e?.message);
    });
  });

  // Mobile-initiated companion edit (Personalize screen).
  ipcRenderer.on('quests-updated', (e, list) => {
    try {
      if (!Array.isArray(list)) return;
      // Cache the full quest list so addChatMsg (a sync function called from many fire-and-forget paths) can look up the active quest name when…
      cachedQuestsList = list.slice();
      // Update the module-level activeQuestId from the canonical list.
      { const aqId = list.find(q => q.active)?.id || null;
        if (aqId && aqId === _casualFromQuestId) updateChatQuestToggle(); else setActiveQuestId(aqId); }
      renderQuests();
    } catch (err) {
      console.warn('[quests-updated] handler failed:', err?.message);
    }
  });

  ipcRenderer.on('mobile-sprite-config-saved', async (e, { agentId, patch } = {}) => {
    try {
      if (!agentId || !agents[agentId]) {
        console.warn('[mobile-sprite-config-saved] unknown agentId:', agentId);
        return;
      }
      console.log('[mobile-sprite-config-saved] applying patch for', agentId, Object.keys(patch || {}).join(','));
      const existing = await cyberclaw.agents.getSpriteConfig(agentId).catch(() => null) || {};
      // Merge: patch wins, but preserve any fields we don't
      // manage here (defensive against future schema additions).
      const merged = Object.assign({}, existing, patch);
      // Persist via the same surface the desktop forge uses.
      await cyberclaw.agents.saveSpriteConfig(agentId, merged);
      // Regenerate soul.md from the merged traits.
      if (Array.isArray(merged.traits) && merged.traits.length) {
        try {
          // eslint-disable-next-line global-require
          const companionPrompts = require('./companion-prompts');
          const traitSoulLines = merged.traits
            .map((t) => companionPrompts.TRAIT_TO_SOUL?.[t])
            .filter(Boolean);
          if (traitSoulLines.length) {
            // v3.4.9: rewrite only the personality block; keep hand-written text.
            const newSoul = companionPrompts.mergeTraitsIntoSoul(companionPrompts.readSoul(agentId), merged.traits, merged.customName || agentId);
            companionPrompts.writeSoul(agentId, newSoul);
            console.log('[mobile-sprite-config-saved] regenerated soul.md for', agentId, 'from', merged.traits.length, 'traits');
          }
        } catch (e) {
          console.warn('[mobile-sprite-config-saved] soul.md regen failed:', e?.message);
        }
      }
      // Mirror onto the in-memory agent so the local UI
      // reflects the change immediately.
      const a = agents[agentId];
      if (typeof patch.customName === 'string' && patch.customName.trim()) a.name = patch.customName.trim();
      if (Array.isArray(patch.traits)) a.traits = patch.traits;
      if (typeof patch.primaryModel === 'string' && patch.primaryModel) {
        a.primaryModel = patch.primaryModel;
        a.model = formatModelName(patch.primaryModel);
      }
      if (typeof patch.secondaryModel === 'string') a.secondaryModel = patch.secondaryModel;
      if (typeof patch.pixelCompanionId === 'string' && patch.pixelCompanionId) {
        a._pixelCompanionId = patch.pixelCompanionId;
      }
      if (typeof patch.scale === 'number') a._pixelCompanionScale = patch.scale;
      if (typeof patch.chattiness === 'number') a.chattiness = patch.chattiness;
      // If the sprite changed, regenerate the avatar so the
      // desktop's picket/avatar also gets the new look.
      if (patch.pixelCompanionId && patch.pixelCompanionId !== existing.pixelCompanionId) {
        try {
          const _path = require('path');
          const catalog = loadPixelCatalog();
          const comp = catalog.companions.find(c => c.id === patch.pixelCompanionId);
          if (comp) {
            const idlePath = _path.join(__dirname, 'assets', 'companions', comp.folder, comp.animations.idle.file);
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const [fw, fh] = comp.frameSize;
            canvas.width = fw; canvas.height = fh;
            const img = new Image();
            await new Promise(r => { img.onload = r; img.src = `file://${idlePath}`; });
            ctx.drawImage(img, 0, 0, fw, fh, 0, 0, fw, fh);
            await cyberclaw.agents.saveAvatar(agentId, canvas.toDataURL('image/png'));
            a.avatar = canvas.toDataURL('image/png');
          }
        } catch (e) {
          console.warn('[mobile-sprite-config-saved] avatar regen failed:', e?.message);
        }
      }
      // Re-broadcast agents list so the change syncs back to the phone that initiated it (and any other connected client).
      broadcastAgentsListToMobile().catch((e) => {
        console.warn('[mobile-sprite-config-saved] rebroadcast failed:', e?.message);
      });
      try { buildCarousel(); } catch (_) {}
      console.log('[mobile-sprite-config-saved] applied + broadcast for', agentId);
    } catch (e) {
      console.warn('[mobile-sprite-config-saved] failed:', e?.message, e?.stack);
    }
  });

  // Route mobile chat to companion
  ipcRenderer.on('mobile-chat', (e, { text, agentId, meta }) => {
    console.log('[mobile-chat] received:', text?.substring(0, 60), 'agentId:', agentId, 'sendChatMessage defined:', typeof window.sendChatMessage);
    window.addDesktopLog?.('💬', 'Mobile chat → AI', text?.substring(0, 50), 'info');
    // If the mobile told us which companion the user is chatting with, switch the desktop's active chat companion to match.
    if (agentId && agents[agentId] && agentId !== activeChatAgentId) {
      try {
        switchActiveChat(agentId);
        focusIndex = agentOrder.indexOf(agentId);
        updateCarousel();
        console.log('[mobile-chat] switched active chat to', agentId);
      } catch (e) {
        console.warn('[mobile-chat] switchActiveChat failed:', e?.message);
      }
    }
    addChatMsg('user', text, null);
    // Strip the `[From: <deviceName>]` prefix from the text before forwarding to the LLM.
    const llmText = (text || '').replace(/^\[From:\s*[^\]]*\]\s*/, '');
    // The merge logic now lives in main.js (it has access to pendingAttachments + the buffered text).
    const doSend = () => {
      if (typeof window.sendChatMessage === 'function') {
        window.sendChatMessage(llmText);
      } else {
        setTimeout(() => {
          if (typeof window.sendChatMessage === 'function') window.sendChatMessage(llmText);
        }, 2000);
      }
    };
    doSend();
  });

  // Combined text + image IPC.
  ipcRenderer.on('mobile-chat-with-attachments', (e, { text, agentId, meta, attachments }) => {
    console.log('[mobile-chat-with-attachments] received:', text?.substring(0, 60), 'agentId:', agentId, 'attachments:', attachments?.length);
    window.addDesktopLog?.('💬📎', 'Mobile chat + images → AI', `${text?.substring(0, 30) || '(no text)'} + ${attachments?.length || 0} image(s)`, 'info');
    if (agentId && agents[agentId] && agentId !== activeChatAgentId) {
      try {
        switchActiveChat(agentId);
        focusIndex = agentOrder.indexOf(agentId);
        updateCarousel();
        console.log('[mobile-chat-with-attachments] switched active chat to', agentId);
      } catch (e) {
        console.warn('[mobile-chat-with-attachments] switchActiveChat failed:', e?.message);
      }
    }
    const llmText = (text || '').replace(/^\[From:\s*[^\]]*\]\s*/, '');
    // Convert main.js attachment shape to renderer's
    // expected shape (dataUri instead of data + mimeType).
    const rendererAttachments = (attachments || []).map((a) => ({
      dataUri: a.data ? `data:${a.mimeType || 'image/png'};base64,${a.data}` : null,
      mimeType: a.mimeType || 'image/png',
      fileName: a.fileName || 'image',
      size: a.size || 0,
      path: a.path || '',
    })).filter((a) => a.dataUri);
    // V3.3.36 FIX (Tobe 2026-10-05 08:32): pass attachments to addChatMsg so the chat_history mirror and the sync-broadcast-chat broadcast both…
    addChatMsg('user', text, null, null, rendererAttachments);
    const doSend = () => {
      if (typeof window.sendChatMessage === 'function') {
        window.sendChatMessage(llmText, rendererAttachments);
      } else {
        setTimeout(() => {
          if (typeof window.sendChatMessage === 'function') window.sendChatMessage(llmText, rendererAttachments);
        }, 2000);
      }
    };
    doSend();
  });

  // Mobile-requested companion wake.
  ipcRenderer.on('mobile-wake-request', (e, { agentId } = {}) => {
    try {
      const id = agentId || (agentOrder[focusIndex] || pickCurrentCompanionId());
      if (!id || !agents[id]) return;
      if (agents[id].sleepState === 'sleeping') {
        agents[id].sleepState = 'awake';
        if (pixelArena && pixelArena.companion && pixelArena.companion.id === id) {
          pixelArena.companion.sleepState = 'awake';
          pixelArena.companion.vx = 0;
          pixelArena.companion.vy = 0;
          pixelArena.companion.frame = 0;
          pixelArena.companion.animation = 'idle';
        }
        nudgeNightWake();
        addChatMsg('system', `☀️ ${agents[id].name} woke up (mobile wake request)`);
        try { broadcastAgentsListToMobile(); } catch (_) {}
        console.log('[mobile-wake] woke companion', id);
      } else {
        console.log('[mobile-wake] companion', id, 'already awake; no-op');
      }
    } catch (e) {
      console.warn('[mobile-wake] failed:', e?.message);
    }
  });

  // Mobile activity heartbeat.
  ipcRenderer.on('mobile-activity-ping', (e, { agentId } = {}) => {
    try {
      const id = agentId || (agentOrder[focusIndex] || pickCurrentCompanionId());
      if (!id || !agents[id]) return;
      // Reuses the same bumpCompanionInteraction() that desktop-side chat/voice/treat actions call.
      bumpCompanionInteraction(id);
      console.log('[mobile-activity-ping] bumped', id);
    } catch (err) {
      console.warn('[mobile-activity-ping] failed:', err?.message);
    }
  });

  // Mobile dropped a food/treat on the arena.
  ipcRenderer.on('mobile-arena-treat-placed', (e, { treat, meta } = {}) => {
    try {
      const t = (treat && TREAT_NAMES[treat]) ? treat : 'apple';
      const name = TREAT_NAMES[t] || t;
      const category = TREAT_CATEGORIES[t] || 'item';
      console.log('[mobile-treat] placed:', t, meta?.companionId ? `(near ${meta.companionId})` : '');
      window.addDesktopLog?.('🍖', 'Mobile fed', t, 'info');
      // Memory append (deterministic, cross-session).
      const memoryAgentId = (meta && meta.companionId && agents[meta.companionId])
        ? meta.companionId
        : (activeChatAgentId || (agentOrder[0] || null));
      // whether memoryAgentId is being computed
      // correctly and whether rememberMemory exists.
      if (memoryAgentId && cyberclaw?.agents?.rememberMemory) {
        cyberclaw.agents.rememberMemory(
          memoryAgentId,
          `Tobe gave me ${name} (${category})`
        ).catch(e => console.warn('[mobile-treat] memory append failed:', e?.message));
      }
      // Skip the placed chat reaction.
    } catch (err) {
      console.warn('[mobile-treat] placed failed:', err?.message);
    }
  });

  // Companion ate a treat (from the mobile arena's seek-and-eat logic).
  ipcRenderer.on('mobile-arena-treat-eaten', (e, { treat, meta } = {}) => {
    try {
      const t = (treat && TREAT_NAMES[treat]) ? treat : 'apple';
      const name = TREAT_NAMES[t] || t;
      const category = TREAT_CATEGORIES[t] || 'item';
      console.log('[mobile-treat] eaten:', t, meta?.companionId ? `(by ${meta.companionId})` : '');
      window.addDesktopLog?.('😋', 'Companion ate', t, 'info');
      const memoryAgentId = (meta && meta.companionId && agents[meta.companionId])
        ? meta.companionId
        : (activeChatAgentId || (agentOrder[0] || null));
      if (memoryAgentId && cyberclaw?.agents?.rememberMemory) {
        cyberclaw.agents.rememberMemory(
          memoryAgentId,
          `I ate ${name} (${category})`
        ).catch(e => console.warn('[mobile-treat] memory append failed:', e?.message));
      }
      promptCompanionReaction(
        'You just ate a ' + name + ' that Tobe gave you. Briefly share how it made you feel — short, in-character reaction (1-2 sentences). Speak as yourself, not about the user.',
        meta?.companionId,
      );
    } catch (err) {
      console.warn('[mobile-treat] eaten failed:', err?.message);
    }
  });

  ipcRenderer.on('mobile-voice', (e, { id, transcript, context, meta }) => {
    // Strip the `[From: <deviceName>]` prefix from the transcript before forwarding.
    const cleanTranscript = (transcript || '').replace(/^\[From:\s*[^\]]*\]\s*/, '');
    const prompt = context
      ? `[Voice from mobile — last ${meta.lookbackMinutes}min context: "${context}"]\n\nUser said: ${cleanTranscript}`
      : cleanTranscript;
    console.log('[mobile-voice] received:', id, transcript?.substring(0, 60));
    window.addDesktopLog?.('🎤', 'Voice → AI', transcript?.substring(0, 50), 'info');
    addChatMsg('user', `🎤 ${transcript}`);
    // Ack receipt so main.js can detect a hung renderer.
    try { ipcRenderer.send('mobile-voice-ack', { ts: Date.now(), id }); } catch {}
    // Register for response tracking.
    if (id) {
      try { ipcRenderer.send('voice-response-tracking-start', { id }); } catch {}
    }
    if (typeof window.sendChatMessage === 'function') {
      const sendPromise = window.sendChatMessage(prompt);
      // When sendChatMessage completes (success or failure), signal completion so main.js can remove the voice from its tracking map and stop…
      if (id && sendPromise && typeof sendPromise.then === 'function') {
        sendPromise.then(
          () => { try { ipcRenderer.send('voice-response-done', { id }); } catch {} },
          () => { try { ipcRenderer.send('voice-response-done', { id }); } catch {} }
        );
      }
    } else {
      setTimeout(() => {
        if (typeof window.sendChatMessage === 'function') window.sendChatMessage(prompt);
      }, 2000);
    }
  });

  // Handle attachments sent from the mobile.
  ipcRenderer.on('mobile-attachment-batch', (e, { attachments: batch }) => {
    try {
      if (!Array.isArray(batch) || batch.length === 0) return;
      // Log each incoming attachment so we can verify the base64 data actually arrived via the IPC.
      for (const a of batch) {
        const dataLen = a.data ? a.data.length : 0;
        console.log(`[mobile-attachment-batch] received ${a.fileName} (size=${a.size}, data=${dataLen} chars, hasData=${!!a.data})`);
      }
      // Build the attachments array in the format the desktop IPC expects.
      const attachments = [];
      for (const a of batch) {
        const dataUri = a.data ? `data:${a.mimeType || 'image/png'};base64,${a.data}` : null;
        if (!dataUri) continue;
        attachments.push({
          dataUri,
          mimeType: a.mimeType || 'image/png',
          fileName: a.fileName || 'image',
          size: a.size || 0,
          path: a.path || '',
        });
      }
      if (attachments.length === 0) {
        console.warn('[mobile-attachment-batch] no usable attachments in batch');
        return;
      }
      console.log(`[mobile-attachment-batch] built ${attachments.length} attachment(s); dataUri total length=${attachments.reduce((s, a) => s + a.dataUri.length, 0)}`);
      // If a mobile-chat text message arrived in the last ~600ms (PENDING_CHAT_HOLD_MS) and is still pending, merge them.
      let prompt = '';
      if (pendingMobileChat) {
        prompt = pendingMobileChat.text || '';
        if (pendingMobileChat.timer) clearTimeout(pendingMobileChat.timer);
        pendingMobileChat = null;
        console.log('[mobile-attachment-batch] merging with pending mobile chat:', prompt.substring(0, 60));
      }
      const sizeInfo = attachments.length === 1
        ? `${attachments[0].fileName} (${attachments[0].size} bytes)`
        : `${attachments.length} images`;
      console.log('[mobile-attachment-batch] forwarding to chat:', sizeInfo, 'attachments:', attachments.length, 'prompt:', prompt.substring(0, 60));
      window.addDesktopLog?.('📎', 'Attachment batch → AI', sizeInfo, 'info');
      // No user-attribution bubble — the user already sees their own message in the chat.
      if (typeof window.sendChatMessage === 'function') {
        window.sendChatMessage(prompt, attachments);
      } else {
        setTimeout(() => {
          if (typeof window.sendChatMessage === 'function') window.sendChatMessage(prompt, attachments);
        }, 2000);
      }
    } catch (err) {
      console.warn('[mobile-attachment-batch] handler failed:', err?.message);
      window.addDesktopLog?.('❌', 'Attachment batch forward failed', err?.message, 'error');
    }
  });

  // Readiness ping.
  ipcRenderer.on('renderer-ready-check', () => {
    console.log('[renderer] ready-check received, acking');
    try { ipcRenderer.send('renderer-ready-ack', { ts: Date.now() }); } catch {}
  });

  ipcRenderer.on('mobile-set-companion', (e, { companionId }) => {
    console.log('[App] Received mobile companion change request:', companionId);
    try {
      if (window.pixelArena && window.leaderId) {
        // Always use the *agent's* own name (e.g. "Clawsuu") rather than the
        // sprite species name (e.g. "Boar") — the displayed label should be
        // the companion, not its visual.
        const leader = window.agents && window.agents[window.leaderId];
        const companionName = (leader && leader.name) || companionId;
        const savedScale = leader?._pixelCompanionScale;

        console.log('[App] Updating arena from mobile:', companionId);
        localStorage.setItem('cyberclaw-selected-companion', companionId);
        // v3.1.5: swap the sprite of the leader in-place so the other
        // companions in the arena aren't removed.
        if (window.pixelArena && window.pixelArena.swapCompanionSprite) {
          window.pixelArena.swapCompanionSprite(window.leaderId, companionId, companionName, savedScale);
        } else {
          window.pixelArena.setCompanion(window.leaderId, companionId, companionName, savedScale);
        }
        console.log('[App] Arena updated from mobile successfully');

        // Update settings selector dropdown
        const selector = document.getElementById('companion-selector');
        if (selector) {
          selector.value = companionId;
          console.log('[App] Updated companion selector dropdown');
        }

        // Notify user
        addChatMsg('system', `📱 Companion changed to ${companionName}`);
      } else {
        console.log('[App] Cannot update - missing pixelArena or leaderId');
      }
    } catch (err) {
      console.error('[App] Error handling mobile companion change:', err);
      addChatMsg('system', `⚠️ Error changing companion from mobile`);
    }
  });
} catch {}

// Update mobile status when settings open
const _origOpenSettings = window.openSettings;
window.openSettings = function() {
  _origOpenSettings();
  updateMobileStatus();
};

// Broadcast chat responses to mobile
const _origAddChatMsg = window.addChatMsg || (typeof addChatMsg === 'function' ? addChatMsg : null);
if (_origAddChatMsg) {
  // Hook into addChatMsg to broadcast AI responses to mobile
  const origFn = _origAddChatMsg;
  // This is handled via IPC in main.js instead
}

// Keybind capture
let capturingKeybind = null;
window.captureKeybind = function(which) {
  const btn = document.getElementById('settings-voice-keybind');
  if (capturingKeybind) { capturingKeybind = null; btn.classList.remove('capturing'); return; }
  capturingKeybind = which;
  btn.classList.add('capturing');
  document.getElementById('voice-keybind-label').textContent = '...';
};

document.addEventListener('keydown', function(e) {
  if (!capturingKeybind) return;
  e.preventDefault();
  e.stopPropagation();
  const s = loadSettings();
  s.voiceKeybind = e.code;
  s.voiceKeybindLabel = e.key.length === 1 ? e.key.toUpperCase() : e.code.replace('Key', '');
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  document.getElementById('voice-keybind-label').textContent = s.voiceKeybindLabel;
  document.getElementById('settings-voice-keybind').classList.remove('capturing');
  capturingKeybind = null;
}, true);

// Global keybind for voice
document.addEventListener('keydown', function(e) {
  if (capturingKeybind) return;
  // Don't trigger if typing in an input/textarea
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  const s = loadSettings();
  if (e.code === s.voiceKeybind) {
    e.preventDefault();
    toggleVoiceInput();
  }
});

// ═══════════════════════════════════════════════════════════
//  VOICE INPUT (Web Speech API)
// ═══════════════════════════════════════════════════════════

let voiceRecognition = null;
let voiceActive = false;

window.toggleVoiceInput = function() {
  if (voiceActive) { stopVoice(); return; }
  startVoice();
};

async function startVoice() {
  if (voiceActive) {
    stopVoice();
    return;
  }

  const input = document.getElementById('chat-input');
  const btn = document.getElementById('chat-voice');
  
  voiceActive = true;
  btn.classList.add('recording');
  btn.textContent = '⏹️';
  input.placeholder = 'Recording... (max 15s, say "stop" to end early)';
  
  try {
    // Record audio for max 15 seconds or until user stops
    addChatMsg('system', '🎤 Recording...');
    const result = await window.ipcRenderer?.invoke('voice:start-recording', { durationMs: 15000 });
    
    if (!result?.path) {
      throw new Error('No recording captured');
    }
    
    // Update UI
    input.placeholder = 'Transcribing...';
    btn.textContent = '⏳';
    addChatMsg('system', '🔄 Transcribing with Whisper...');
    
    // Read audio file
    const fs = require('fs');
    const audioBase64 = fs.readFileSync(result.path, 'base64');
    
    // Send to local Whisper for transcription
    const s = loadSettings();
    const transcript = await window.ipcRenderer?.invoke('whisper:transcribe', {
      audioBase64,
      mimeType: 'audio/wav',
      language: s.voiceLang || 'en-US'
    });
    
    if (!transcript) {
      addChatMsg('system', '⚠️ No speech detected');
      stopVoice();
      return;
    }
    
    // Put transcript in input
    input.value = transcript;
    addChatMsg('system', `✓ Recognized: "${transcript.substring(0, 60)}${transcript.length > 60 ? '...' : ''}"`);
    
    // Auto-send if enabled
    if (s.voiceAutoSend) {
      window.sendChat();
    }
    
  } catch (err) {
    addChatMsg('system', `⚠️ Voice error: ${err?.message}`);
    console.error('[VOICE]', err);
  } finally {
    stopVoice();
  }
}

function stopVoice() {
  if (voiceRecognition) {
    voiceActive = false;
    voiceRecognition.stop();
    voiceRecognition = null;
  }
  const btn = document.getElementById('chat-voice');
  if (btn) { btn.classList.remove('recording'); btn.textContent = '🎤'; }
  document.getElementById('chat-input').placeholder = 'Type a message...';
}

// ═══════════════════════════════════════════════════════════
//  IMAGE PASTE & ATTACH
// ═══════════════════════════════════════════════════════════

let pendingImage = null; // { dataUrl, filename }

// Paste images from clipboard
document.addEventListener('paste', function(e) {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.indexOf('image') !== -1) {
      e.preventDefault();
      const blob = items[i].getAsFile();
      const reader = new FileReader();
      reader.onload = function(ev) {
        setImageAttachment(ev.target.result, blob.name || 'pasted-image.png');
      };
      reader.readAsDataURL(blob);
      return;
    }
  }
});

// Drag & drop images
const chatArea = document.getElementById('view-chat');
if (chatArea) {
  chatArea.addEventListener('dragover', function(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  chatArea.addEventListener('drop', function(e) {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (files.length > 0 && files[0].type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = function(ev) {
        setImageAttachment(ev.target.result, files[0].name);
      };
      reader.readAsDataURL(files[0]);
    }
  });
}

function setImageAttachment(dataUrl, filename) {
  pendingImage = { dataUrl, filename };
  const preview = document.getElementById('chat-image-preview');
  const img = document.getElementById('chat-preview-img');
  if (preview && img) {
    img.src = dataUrl;
    preview.classList.remove('hidden');
  }
}

window.clearImageAttachment = function() {
  pendingImage = null;
  const preview = document.getElementById('chat-image-preview');
  if (preview) preview.classList.add('hidden');
};

window.pickImageAttachment = function() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = function() {
    if (input.files && input.files[0]) {
      const reader = new FileReader();
      reader.onload = function(ev) {
        setImageAttachment(ev.target.result, input.files[0].name);
      };
      reader.readAsDataURL(input.files[0]);
    }
  };
  input.click();
};

// Patch sendChat to include image
const _originalSendChat = window.sendChat;
window.sendChat = async function() {
  if (pendingImage) {
    // v3.6.5: images go through the normal send path (quest context, wake,
    // status, errors). The old path crashed on a removed #chat-send button
    // and never reached the companion.
    const input = document.getElementById('chat-input');
    const message = (input.value || '').trim();
    const imgData = pendingImage;
    clearImageAttachment();
    if (agentOrder.length === 0) return;
    const agent = agents[pickCurrentCompanionId()] || agents[agentOrder[focusIndex]];
    const mimeType = (imgData.dataUrl.match(/^data:([^;]+);/) || [])[1] || 'image/png';
    const b64 = imgData.dataUrl.split(',')[1] || '';
    let saved = null;
    try { saved = await cyberclaw.chat.saveAttachment(b64, mimeType, imgData.filename); } catch (e) { console.warn('[sendChat:img] save failed', e); }
    const att = { dataUri: imgData.dataUrl, mimeType, fileName: imgData.filename, size: b64.length, path: saved && saved.path || '' };
    addChatMsg('user', message || '', agent && agent.name, null, [att]);
    input.value = '';
    await window.sendChatMessage(message || 'Here is an image.', [att]);
    return;
  }

  return _originalSendChat();
};

// Apply settings on load
applySettings();

// ═══════════════════════════════════════════════════════════
//  MODEL SELECTION — click to switch active model
// ═══════════════════════════════════════════════════════════

window.selectModel = function(which) {
  var agentId = agentOrder[focusIndex];
  if (!agentId) return;
  var agent = agents[agentId];
  if (!agent) return;

  if (which === 'primary') {
    agent.activeModel = agent.model;
    agent.usingFallback = false;
  } else if (which === 'fallback' && agent.fallbackModels && agent.fallbackModels.length) {
    agent.activeModel = agent.fallbackModels[0];
    agent.usingFallback = true;
  }

  // Update visual state — use model-active class (matches components.css)
  var primaryRow = document.getElementById('inspect-model-primary');
  var fallbackRow = document.getElementById('inspect-model-fallback');

  if (which === 'primary') {
    if (primaryRow) { primaryRow.classList.add('model-active'); }
    if (fallbackRow) { fallbackRow.classList.remove('model-active'); fallbackRow.style.opacity = '0.5'; }
  } else {
    if (primaryRow) { primaryRow.classList.remove('model-active'); }
    if (fallbackRow) { fallbackRow.classList.add('model-active'); fallbackRow.style.opacity = '1'; }
  }

  // Show bubble on arena
  var arena = window.pixelArena;
  if (arena && arena.showBubble) {
    var name = which === 'primary' ? agent.model : formatModelName(agent.fallbackModels[0]);
    arena.showBubble('🧠 Switching to ' + name + '!', 2500);
  }

  addChatMsg('system', '🧠 Model switched to: ' + (which === 'primary' ? agent.model : formatModelName(agent.fallbackModels[0])));
};

// ═══════════════════════════════════════════════════════════
//  LEARN NEW SKILL — prompt the agent
// ═══════════════════════════════════════════════════════════

window.learnNewSkill = function() {
  var agentId = agentOrder[focusIndex];
  if (!agentId) return;
  var agent = agents[agentId];
  if (!agent) return;

  // Show bubble
  var arena = window.pixelArena;
  if (arena && arena.showBubble) {
    arena.showBubble('📚 Ooh, new skill? Let\'s go!', 3000);
  }

  // Switch to chat tab and send a prompt
  switchTermTab('chat');
  var input = document.getElementById('chat-input');
  if (input) {
    input.value = 'I want to teach you a new skill! Can you guide me through the process of creating a custom skill for you?';
    window.sendChat();
  }
};

// v3.1.3: Learned Skills modal — shows the companion's equipped/known skills
// (built-in equipment + openclaw skills) with descriptions and an option
// to forget one.
window.openLearnedSkillsModal = async function() {
  const id = agentOrder[focusIndex] || pickCurrentCompanionId();
  if (!id) return;
  const agent = agents[id];
  if (!agent) return;
  const overlay = document.getElementById('learned-skills-overlay');
  const list = document.getElementById('learned-skills-list');
  const title = document.getElementById('learned-skills-title');
  if (title) title.textContent = `${agent.name.toUpperCase()} · LEARNED SKILLS`;
  if (!overlay || !list) return;
  list.innerHTML = '<div class="learned-skill-empty">Loading…</div>';
  overlay.classList.remove('hidden');

  // Load sprite config (which has the equipped skills list)
  const cfg = await cyberclaw.agents.getSpriteConfig(id) || {};
  const equipped = cfg.equipment || [];

  // Build a lookup of all known skills (built-in + cached openclaw skills)
  const allItems = [...BUILTIN_EQUIPMENT, ...(allSkillsCache || [])];
  const byName = {};
  for (const s of allItems) {
    if (s && s.name) byName[s.name] = s;
  }

  if (!equipped.length) {
    list.innerHTML = '<div class="learned-skill-empty">No skills learned yet. Click "Learn New Skill" to get started.</div>';
    return;
  }

  list.innerHTML = equipped.map(e => {
    const meta = byName[e.skill] || byName[e.name] || {};
    const desc = e.description || meta.description || '(no description)';
    const icon = e.icon || meta.icon || '🔧';
    const isBuiltin = !!(BUILTIN_EQUIPMENT.find(s => s.name === e.skill));
    return `
      <div class="learned-skill-row${isBuiltin ? ' is-builtin' : ''}">
        <div class="learned-skill-name"><span class="learned-skill-icon">${icon}</span> ${escapeHtml(e.name || e.skill)}</div>
        <div class="learned-skill-desc">${escapeHtml(desc)}</div>
        <div class="learned-skill-actions">
          <button class="learned-skill-remove-btn" onclick="forgetLearnedSkill('${escapeAttr(e.skill || e.name)}')">✕ Forget</button>
        </div>
      </div>`;
  }).join('');
};

window.closeLearnedSkillsModal = function(e) {
  if (e && e.target !== e.currentTarget) return;
  const overlay = document.getElementById('learned-skills-overlay');
  if (overlay) overlay.classList.add('hidden');
};

window.forgetLearnedSkill = async function(skillName) {
  const id = agentOrder[focusIndex] || pickCurrentCompanionId();
  if (!id) return;
  if (!confirm(`Forget "${skillName}"?`)) return;
  const cfg = await cyberclaw.agents.getSpriteConfig(id) || {};
  cfg.equipment = (cfg.equipment || []).filter(e => (e.skill || e.name) !== skillName);
  await cyberclaw.agents.saveSpriteConfig(id, cfg);
  // Re-render the modal
  await window.openLearnedSkillsModal();
  // Also refresh the inspect panel's gear area if it still exists
  try { loadEquipment(id); } catch {}
};

// ═══════════════════════════════════════════════════════════ SKILLS LIBRARY (v3.3.0) The skills library lets the user browse, create, edit,…

let _skillsCache = null;
let _enabledSkillsCache = {};
let _activeSkillId = null; // for skill detail modal

async function refreshSkillsList() {
  const list = document.getElementById('skill-list');
  const empty = document.getElementById('skill-empty');
  if (!list) return;
  const result = await cyberclaw.skills.list();
  const skills = (result && result.skills) || [];
  _skillsCache = skills;
  // Render rows (always — even when empty so user can see the + button row above)
  if (skills.length === 0) {
    list.innerHTML = '';
    if (empty) list.appendChild(empty);
    return;
  }
  list.innerHTML = skills.map(s => {
    const triggerCount = (s.triggers || []).length;
    return `<div class="skill-row" onclick="openSkillDetail('${escapeAttr(s.id)}')">
      <div class="skill-row-icon">${escapeHtml(s.icon || '🔧')}</div>
      <div class="skill-row-body" title="${escapeAttr(s.description || '')}">
        <div class="skill-row-name">${escapeHtml(s.name)}</div>
        <div class="skill-row-desc">${escapeHtml(s.description || '')}</div>
      </div>
    </div>`;
  }).join('');
}

async function refreshEnabledSkillsCache(agentId) {
  if (!agentId) return [];
  const r = await cyberclaw.agents.getEnabledSkills(agentId);
  _enabledSkillsCache[agentId] = (r && r.enabled) || [];
  return _enabledSkillsCache[agentId];
}

async function refreshInspectEnabledSkills(agentId) {
  const el = document.getElementById('inspect-enabled-skills');
  if (!el) return;
  const skills = _skillsCache || (await refreshSkillsList().then(() => _skillsCache) || []);
  const enabled = await refreshEnabledSkillsCache(agentId);
  if (skills.length === 0) {
    el.innerHTML = '<div class="enabled-skill-empty">No abilities in the library yet. Create one with + in the Abilities Library above.</div>';
    return;
  }
  el.innerHTML = skills.map(s => {
    const isOn = enabled.includes(s.id);
    return `<div class="enabled-skill-row" onclick="toggleEnabledSkill('${escapeAttr(s.id)}', ${agentId})" title="${escapeAttr(s.description || '')}">
      <div class="enabled-skill-toggle ${isOn ? 'on' : ''}">${isOn ? '✓' : ''}</div>
      <div class="enabled-skill-icon">${escapeHtml(s.icon || '🔧')}</div>
      <div class="enabled-skill-name">${escapeHtml(s.name)}</div>
    </div>`;
  }).join('');
}

async function toggleEnabledSkill(skillId, agentId) {
  if (!agentId) return;
  const current = _enabledSkillsCache[agentId] || [];
  let next;
  if (current.includes(skillId)) {
    next = current.filter(id => id !== skillId);
  } else {
    next = [...current, skillId];
  }
  await cyberclaw.agents.setEnabledSkills(agentId, next);
  _enabledSkillsCache[agentId] = next;
  // Re-render the toggle list (cheap; just toggles a class)
  refreshInspectEnabledSkills(agentId);
}

// ── Skill form (create new) ────────────────────────────────

window.showSkillForm = function() {
  const form = document.getElementById('skill-form');
  if (form) form.classList.remove('hidden');
  const msgEl = document.getElementById('skill-validation-msg');
  if (msgEl) { msgEl.textContent = ''; msgEl.className = 'skill-validation-msg'; }
  const name = document.getElementById('skill-name-input');
  if (name) name.focus();
};

window.hideSkillForm = function() {
  const form = document.getElementById('skill-form');
  if (form) form.classList.add('hidden');
  ['skill-name-input','skill-desc-input','skill-triggers-input','skill-body-input'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const msgEl = document.getElementById('skill-validation-msg');
  if (msgEl) { msgEl.textContent = ''; msgEl.className = 'skill-validation-msg'; }
};

window.createSkill = async function() {
  const name = (document.getElementById('skill-name-input')?.value || '').trim();
  const desc = (document.getElementById('skill-desc-input')?.value || '').trim();
  const triggersRaw = (document.getElementById('skill-triggers-input')?.value || '').trim();
  const body = document.getElementById('skill-body-input')?.value || '';
  const msgEl = document.getElementById('skill-validation-msg');
  if (!name) {
    if (msgEl) { msgEl.textContent = 'Name is required.'; msgEl.className = 'skill-validation-msg has-errors'; }
    return;
  }
  const triggers = triggersRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const result = await cyberclaw.skills.create({ name, description: desc, triggers, body });
  if (!result || !result.ok) {
    if (msgEl) { msgEl.textContent = 'Create failed: ' + (result && result.error ? result.error : 'unknown error'); msgEl.className = 'skill-validation-msg has-errors'; }
    return;
  }
  // Show validation feedback (warnings are OK, errors aren't)
  if (result.validation) {
    const v = result.validation;
    const msgs = [];
    if (v.errors && v.errors.length) msgs.push('Errors: ' + v.errors.map(e => e.message).join('; '));
    if (v.warnings && v.warnings.length) msgs.push('Heads up: ' + v.warnings.map(w => w.message).join('; '));
    if (msgs.length && msgEl) {
      msgEl.textContent = msgs.join('\n');
      msgEl.className = 'skill-validation-msg ' + (v.errors.length ? 'has-errors' : 'has-warnings');
    }
  }
  await refreshSkillsList();
  // Re-render the toggle list in the inspect panel so the new skill appears
  const focused = agentOrder[focusIndex];
  if (focused) refreshInspectEnabledSkills(focused);
  // Open the detail modal for the new skill (so the user sees what they made)
  if (result.skill) {
    setTimeout(() => openSkillDetail(result.skill.id), 100);
  }
  // Clear form but keep it visible so user can create another if they want
  ['skill-name-input','skill-desc-input','skill-triggers-input','skill-body-input'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
};

window.seedStarterSkills = async function() {
  const result = await cyberclaw.skills.seedStarters();
  if (result && result.ok) {
    await refreshSkillsList();
    const focused = agentOrder[focusIndex];
    if (focused) refreshInspectEnabledSkills(focused);
    if (result.seeded && result.seeded.length) {
      addChatMsg('system', `📚 Seeded ${result.seeded.length} starter abilit${result.seeded.length === 1 ? 'y' : 'ies'}: ${result.seeded.join(', ')}`);
    } else {
      addChatMsg('system', '📚 Starter abilities already present.');
    }
  }
};

// ── Skill detail modal (view + edit + delete) ────────────────────────

window.openSkillDetail = async function(skillId) {
  const r = await cyberclaw.skills.read(skillId);
  if (!r || !r.ok) {
    addChatMsg('system', `Couldn't open ability: ${r ? r.error : 'unknown error'}`);
    return;
  }
  _activeSkillId = skillId;
  renderSkillDetailView(r.skill);
  const overlay = document.getElementById('skill-detail-overlay');
  if (overlay) overlay.classList.remove('hidden');
  const actions = document.getElementById('skill-detail-actions');
  if (actions) actions.style.display = '';
};

window.closeSkillDetail = function(e) {
  if (e && e.target !== e.currentTarget) return;
  const overlay = document.getElementById('skill-detail-overlay');
  if (overlay) overlay.classList.add('hidden');
  _activeSkillId = null;
};

function escapeAttr(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/'/g,'&#39;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Minimal markdown -> HTML for the skill detail view.
function renderMarkdown(md) {
  if (!md) return '';
  const escape = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const lines = md.split(/\r?\n/);
  let out = '';
  let inCode = false;
  let inList = null; // 'ul' | 'ol' | null
  let paragraph = [];
  const flushPara = () => {
    if (paragraph.length) {
      const text = inlineFormat(escape(paragraph.join(' ')));
      out += `<p>${text}</p>`;
      paragraph = [];
    }
  };
  const flushList = () => {
    if (inList) { out += `</${inList}>`; inList = null; }
  };
  for (const raw of lines) {
    const line = raw;
    if (line.startsWith('```')) {
      flushPara(); flushList();
      if (inCode) { out += '</code></pre>'; inCode = false; }
      else { out += '<pre><code>'; inCode = true; }
      continue;
    }
    if (inCode) { out += escape(line) + '\n'; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara(); flushList();
      out += `<h${h[1].length}>${inlineFormat(escape(h[2]))}</h${h[1].length}>`;
      continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      flushPara();
      if (inList !== 'ol') { flushList(); out += '<ol>'; inList = 'ol'; }
      out += `<li>${inlineFormat(escape(ol[1]))}</li>`;
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (inList !== 'ul') { flushList(); out += '<ul>'; inList = 'ul'; }
      out += `<li>${inlineFormat(escape(ul[1]))}</li>`;
      continue;
    }
    if (line.trim() === '') {
      flushPara(); flushList();
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushPara(); flushList();
  if (inCode) out += '</code></pre>';
  return out;
}

// Inline formatting: **bold**, *italic*, `code`. Runs after HTML-escape
// so we look for patterns in the escaped text.
function inlineFormat(text) {
  return text
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, (_, c) => `<strong>${c}</strong>`)
    .replace(/\*([^*]+)\*/g, (_, c) => `<em>${c}</em>`);
}

function renderSkillDetailView(skill) {
  const body = document.getElementById('skill-detail-body');
  const titleEl = document.getElementById('skill-detail-title');
  const iconEl = document.getElementById('skill-detail-icon');
  if (titleEl) titleEl.textContent = skill.name.toUpperCase();
  if (iconEl) iconEl.textContent = skill.icon || '📚';
  const triggersHtml = (skill.triggers || []).map(t => `<li>${escapeHtml(t)}</li>`).join('');
  const meta = `<div class="skill-detail-meta">
    <strong>id:</strong> <code>${escapeHtml(skill.id)}</code>
    &nbsp;·&nbsp; <strong>triggers:</strong> ${(skill.triggers || []).length}
    &nbsp;·&nbsp; <strong>path:</strong> <code>${escapeHtml(skill.path || '')}</code>
  </div>`;
  body.innerHTML = `<div class="skill-detail-view">
    ${meta}
    <h2>Description</h2>
    <p>${escapeHtml(skill.description || '(none)')}</p>
    ${triggersHtml ? `<h3>Triggers</h3><ul>${triggersHtml}</ul>` : ''}
    <h2>Process</h2>
    ${renderMarkdown(skill.body || '(empty)')}
  </div>`;
  // Re-show the action bar in case we were in edit mode
  const actions = document.getElementById('skill-detail-actions');
  if (actions) actions.style.display = '';
  // Reset action bar to default
  actions.innerHTML = `
    <button class="skill-detail-btn" onclick="enterSkillEditMode()">✎ Edit</button>
    <button class="skill-detail-btn danger" onclick="deleteSkillFromDetail()">🗑 Delete</button>
  `;
}

window.enterSkillEditMode = async function() {
  if (!_activeSkillId) return;
  const r = await cyberclaw.skills.read(_activeSkillId);
  if (!r || !r.ok) return;
  const s = r.skill;
  const body = document.getElementById('skill-detail-body');
  body.innerHTML = `<form class="skill-edit-form" onsubmit="event.preventDefault(); saveSkillEdit();">
    <label>Name</label>
    <input id="skill-edit-name" type="text" value="${escapeAttr(s.name)}" />
    <label>Icon</label>
    <input id="skill-edit-icon" type="text" value="${escapeAttr(s.icon || '🔧')}" maxlength="4" />
    <label>Description (one line)</label>
    <input id="skill-edit-desc" type="text" value="${escapeAttr(s.description || '')}" />
    <label>Triggers (one per line)</label>
    <textarea id="skill-edit-triggers" rows="3">${escapeHtml((s.triggers || []).join('\n'))}</textarea>
    <label>Process (markdown — supports headings, lists, code)</label>
    <textarea id="skill-edit-body" rows="18">${escapeHtml(s.body || '')}</textarea>
    <div id="skill-edit-msg" class="skill-validation-msg"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
      <button type="button" class="skill-detail-btn" onclick="renderSkillDetailView((window._activeSkillDetail || s))">Cancel</button>
      <button type="submit" class="skill-detail-btn">Save</button>
    </div>
  </form>`;
  // Hide the bottom action bar in edit mode (Save/Cancel are inside the form)
  const actions = document.getElementById('skill-detail-actions');
  if (actions) actions.style.display = 'none';
  // Remember the current skill for cancel
  window._activeSkillDetail = s;
};

window.saveSkillEdit = async function() {
  if (!_activeSkillId) return;
  const name = document.getElementById('skill-edit-name')?.value.trim();
  const desc = document.getElementById('skill-edit-desc')?.value.trim();
  const icon = document.getElementById('skill-edit-icon')?.value.trim();
  const triggersRaw = document.getElementById('skill-edit-triggers')?.value || '';
  const body = document.getElementById('skill-edit-body')?.value || '';
  const triggers = triggersRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const r = await cyberclaw.skills.update(_activeSkillId, { name, description: desc, icon, triggers, body });
  const msgEl = document.getElementById('skill-edit-msg');
  if (!r || !r.ok) {
    if (msgEl) { msgEl.textContent = 'Save failed: ' + (r && r.error ? r.error : 'unknown error'); msgEl.className = 'skill-validation-msg has-errors'; }
    return;
  }
  if (r.validation && msgEl) {
    const v = r.validation;
    const msgs = [];
    if (v.errors && v.errors.length) msgs.push('Errors: ' + v.errors.map(e => e.message).join('; '));
    if (v.warnings && v.warnings.length) msgs.push('Heads up: ' + v.warnings.map(w => w.message).join('; '));
    if (msgs.length) {
      msgEl.textContent = msgs.join('\n');
      msgEl.className = 'skill-validation-msg ' + (v.errors.length ? 'has-errors' : 'has-warnings');
      if (v.errors.length) return; // don't close on error
    }
  }
  await refreshSkillsList();
  const focused = agentOrder[focusIndex];
  if (focused) refreshInspectEnabledSkills(focused);
  renderSkillDetailView(r.skill);
};

window.deleteSkillFromDetail = async function() {
  if (!_activeSkillId) return;
  if (!confirm(`Delete ability "${_activeSkillId}"? This can't be undone.`)) return;
  const r = await cyberclaw.skills.delete(_activeSkillId);
  if (r && r.ok) {
    await refreshSkillsList();
    const focused = agentOrder[focusIndex];
    if (focused) refreshInspectEnabledSkills(focused);
    closeSkillDetail();
  } else {
    alert('Delete failed: ' + (r && r.error ? r.error : 'unknown error'));
  }
};

// ═══════════════════════════════════════════════════════════
//  HAPPINESS SYSTEM
// ═══════════════════════════════════════════════════════════

var HAPPINESS_KEY = 'cyberclaw-happiness';
var happiness = 70; // default

// Load happiness
try {
  var savedH = localStorage.getItem(HAPPINESS_KEY);
  if (savedH !== null) happiness = parseInt(savedH) || 70;
} catch(e) {}

function updateHappinessBar() {
  var bar = document.getElementById('inspect-happiness');
  var val = document.getElementById('inspect-happiness-val');
  if (bar) bar.style.width = happiness + '%';
  if (val) val.textContent = happiness + '/100';

  // Change color based on level
  if (bar) {
    if (happiness > 70) bar.style.background = 'linear-gradient(90deg, #4ade80, #22c55e)';
    else if (happiness > 40) bar.style.background = 'linear-gradient(90deg, #f97316, #facc15)';
    else bar.style.background = 'linear-gradient(90deg, #ef4444, #f97316)';
  }
}

window.adjustHappiness = function(amount) {
  happiness = Math.max(0, Math.min(100, happiness + amount));
  try { localStorage.setItem(HAPPINESS_KEY, String(happiness)); } catch(e) {}
  updateHappinessBar();
};

// Happiness decays over time — lose 1 point every 5 minutes
// v3.6.12: full → empty takes ~30 h (1 point per 18 min), so a fed and
// played-with companion stays content for over a day. Was 1 per 5 min (~8 h).
setInterval(function() {
  if (happiness > 0) {
    happiness = Math.max(0, happiness - 1);
    try { localStorage.setItem(HAPPINESS_KEY, String(happiness)); } catch(e) {}
    updateHappinessBar();
  }
}, 18 * 60 * 1000);
// Read by the arena: "play with me" nagging only happens at 0%, and how
// often is set by each companion's Chattiness setting.
window.getHappiness = function() { return happiness; };
window.getCompanionChattiness = function(id) { var a = agents[id]; return (a && typeof a.chattiness === 'number') ? a.chattiness : 3; };

// Update bar on load
setTimeout(updateHappinessBar, 1000);

// ═══════════════════════════════════════════════════════════
//  FEED SYSTEM — drag treats onto arena
// ═══════════════════════════════════════════════════════════

// ── Treat emojis and selected treat state ──
var TREAT_EMOJIS = {
  apple: '🍎', hamburger: '🍔', meat: '🍖', fish: '🐟', cake: '🍰', cookie: '🍪', berry: '🫐',
  ball: '⚽', 'tennis-ball': '⚾', rocket: '🚀', yarn: '🧶', stick: '🪵', frisbee: '🥏', bell: '🔔', feather: '🪶'
};
var TREAT_NAMES = {
  apple: 'an apple', hamburger: 'a hamburger', meat: 'some meat', fish: 'a fish', cake: 'a slice of cake', cookie: 'a cookie', berry: 'some berries',
  ball: 'a ball', 'tennis-ball': 'a tennis ball', rocket: 'a rocket', yarn: 'a ball of yarn', stick: 'a stick', frisbee: 'a frisbee', bell: 'a bell', feather: 'a feather'
};
// Treat category mapping for snack logging.
var TREAT_CATEGORIES = {
  apple: 'food', hamburger: 'food', meat: 'food', fish: 'food', cake: 'food', cookie: 'food', berry: 'food',
  ball: 'toy', 'tennis-ball': 'toy', rocket: 'toy', yarn: 'toy', stick: 'toy', frisbee: 'toy', bell: 'toy', feather: 'toy'
};
var selectedTreat = null; // { type, emoji }

window.toggleFeedMenu = function() {
  var menu = document.getElementById('feed-menu');
  if (menu) {
    var wasHidden = menu.classList.contains('hidden');
    menu.classList.toggle('hidden');

    if (wasHidden) {
      // Show excitement eyes on arena immediately (no delay)
      var arena = window.pixelArena;
      if (arena) {
        arena.companionEmoji = { emoji: '🤩', timer: 3000 };
      }
      // Then prompt the agent for a natural response
      promptCompanionReaction('The user just opened the treat menu. Are you hungry? Give a short excited reaction.');
    }

    // Clear selection if closing
    if (!wasHidden) {
      selectedTreat = null;
      document.querySelectorAll('.feed-treat').forEach(function(t) { t.classList.remove('selected'); });
      var canvas = window.pixelArena && window.pixelArena.canvas;
      if (canvas) canvas.style.cursor = 'pointer';
    }
  }
};

var _lastPlayReactionTs = 0;
window.togglePlayMenu = function() {
  var menu = document.getElementById('play-menu');
  if (!menu) return;
  var wasHidden = menu.classList.contains('hidden');
  menu.classList.toggle('hidden');
  // Close feed menu if open
  var feedMenu = document.getElementById('feed-menu');
  if (feedMenu && !feedMenu.classList.contains('hidden')) feedMenu.classList.add('hidden');

  if (wasHidden) {
    var arena = window.pixelArena;
    if (arena) arena.companionEmoji = { emoji: '🎾', timer: 3000 };
    // v3.1.3: only fire the "play with me" reaction at most once per
    // 30 seconds so opening/closing the menu rapidly doesn't spam LLM calls.
    var now = Date.now();
    if (now - _lastPlayReactionTs > 30000) {
      _lastPlayReactionTs = now;
      promptCompanionReaction('The user wants to play with you! They opened the toy box. Give a short excited reaction about playtime.');
    }
  }
  if (!wasHidden) {
    selectedTreat = null;
    document.querySelectorAll('.feed-treat').forEach(function(t) { t.classList.remove('selected'); });
    var canvas = window.pixelArena && window.pixelArena.canvas;
    if (canvas) canvas.style.cursor = '';
  }
};

// Also close play menu when opening feed menu
var _origToggleFeed = window.toggleFeedMenu;
window.toggleFeedMenu = function() {
  var playMenu = document.getElementById('play-menu');
  if (playMenu && !playMenu.classList.contains('hidden')) playMenu.classList.add('hidden');
  _origToggleFeed();
};

// Click treat to select it, then click arena to place it
document.querySelectorAll('.feed-treat').forEach(function(el) {
  el.addEventListener('click', function(e) {
    e.stopPropagation();
    var type = el.dataset.treat;
    if (!type || !TREAT_EMOJIS[type]) return;

    // Toggle selection
    if (selectedTreat && selectedTreat.type === type) {
      selectedTreat = null;
      el.classList.remove('selected');
      var canvas = window.pixelArena && window.pixelArena.canvas;
      if (canvas) canvas.style.cursor = 'pointer';
      return;
    }

    // Select this treat
    document.querySelectorAll('.feed-treat').forEach(function(t) { t.classList.remove('selected'); });
    el.classList.add('selected');
    selectedTreat = { type: type, emoji: TREAT_EMOJIS[type] };

    // Change cursor on arena canvas to indicate placement mode
    var canvas = window.pixelArena && window.pixelArena.canvas;
    if (canvas) canvas.style.cursor = 'crosshair';

    // Close both menus
    var feedMenu = document.getElementById('feed-menu');
    var playMenu = document.getElementById('play-menu');
    if (feedMenu) feedMenu.classList.add('hidden');
    if (playMenu) playMenu.classList.add('hidden');
  });

  // Also support drag
  el.addEventListener('dragstart', function(e) {
    e.dataTransfer.setData('text/plain', el.dataset.treat);
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(function() {
      var feedMenu = document.getElementById('feed-menu');
      var playMenu = document.getElementById('play-menu');
      if (feedMenu) feedMenu.classList.add('hidden');
      if (playMenu) playMenu.classList.add('hidden');
    }, 100);
  });
});

// Place a treat on the arena at given position — ALWAYS use window.pixelArena (current instance)
function placeTreatOnArena(canvasX, canvasY, treatType) {
  var a = window.pixelArena;
  if (!a) return;
  // v3.4.3: food / toys wake sleeping companions at night. Before,
  // between 22:00 and 06:30 they stayed asleep and ignored the treat
  // (the chat still said 'more meat!'), so feeding looked broken.
  try { nudgeNightWake(); } catch (_) {}
  a.dropTreat(canvasX, canvasY, treatType, TREAT_EMOJIS[treatType]);
  // Always-visible snack comment.
  const agentId = activeChatAgentId || (agentOrder[0] || null);
  const itemName = TREAT_NAMES[treatType] || treatType;
  const category = TREAT_CATEGORIES[treatType] || 'item';

  // Memory.md direct append (deterministic, independent
  // of chat state). Survives session resets; for any
  // future conversation that reads memory.md.
  if (agentId && cyberclaw?.agents?.rememberMemory) {
    cyberclaw.agents.rememberMemory(
      agentId,
      `Tobe gave me ${itemName} (${category})`
    ).catch(e => console.warn('[placeTreatOnArena] memory append failed:', e?.message));
  }

  // Visible chat reaction.
  promptCompanionReaction('I just gave you ' + itemName + '. What do you think?');

  if (window.adjustHappiness) window.adjustHappiness(10);
}

// Companion reacts when eating a treat (called from pixel-arena.js)
window.promptCompanionEat = function(treatType) {
  // v3.2.70: same shape as placeTreatOnArena. Memory
  // append + queued visible reaction so the eat is in
  // the LLM's running context.
  const name = TREAT_NAMES[treatType] || 'a treat';
  const category = TREAT_CATEGORIES[treatType] || 'item';
  const agentId = activeChatAgentId || (agentOrder[0] || null);
  if (agentId && cyberclaw?.agents?.rememberMemory) {
    cyberclaw.agents.rememberMemory(
      agentId,
      `I ate ${name} (${category})`
    ).catch(e => console.warn('[promptCompanionEat] memory append failed:', e?.message));
  }
  promptCompanionReaction('You just ate a ' + name + ' that Tobe gave you. Briefly share how it made you feel — short, in-character reaction (1-2 sentences). Speak as yourself, not about the user.');
};

// Reaction-queue removed.

// ── Drop zone: attach to the CONTAINER div (survives arena rebuilds) ──
// The container div never gets destroyed — only the canvas inside it is replaced.
var _arenaDropReady = false;
function setupArenaDrop() {
  if (_arenaDropReady) return;
  var container = document.getElementById('pixel-arena-container');
  if (!container) return;
  _arenaDropReady = true;

  // Drag-and-drop onto container (permanent element)
  container.addEventListener('dragover', function(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  container.addEventListener('drop', function(e) {
    e.preventDefault();
    var treatType = e.dataTransfer.getData('text/plain');
    if (!treatType || !TREAT_EMOJIS[treatType]) return;

    var arena = window.pixelArena;
    if (!arena || !arena.canvas) return;

    var rect = arena.canvas.getBoundingClientRect();
    var canvasX = (e.clientX - rect.left) * (arena.width / rect.width);
    var canvasY = (e.clientY - rect.top) * (arena.height / rect.height);

    placeTreatOnArena(canvasX, canvasY, treatType);
  });

  // Click-to-place onto container
  container.addEventListener('click', function(e) {
    if (!selectedTreat) return;
    var arena = window.pixelArena;
    if (!arena || !arena.canvas) return;

    var rect = arena.canvas.getBoundingClientRect();
    var canvasX = (e.clientX - rect.left) * (arena.width / rect.width);
    var canvasY = (e.clientY - rect.top) * (arena.height / rect.height);

    placeTreatOnArena(canvasX, canvasY, selectedTreat.type);

    selectedTreat = null;
    document.querySelectorAll('.feed-treat').forEach(function(t) { t.classList.remove('selected'); });
  });
}
setupArenaDrop();
setTimeout(setupArenaDrop, 3000);

// Prompt the companion and show response in both chat + bubble
var reactionBusy = false;
// Optional `targetAgentId` argument.
function promptCompanionReaction(promptText, targetAgentId) {
  // Prefer the explicit target (mobile-arena-eaten), then the active chat tab, then the first visible agent.
  const targetId = (targetAgentId && agents[targetAgentId] ? targetAgentId : null)
    || activeChatAgentId
    || (agentOrder.find(id => !hiddenCompanions.has(id)))
    || agentOrder[0];
  // (Diagnostic log removed in v3.2.82 — verified working as of v3.2.80.
  if (!targetId) return;
  const target = agents[targetId];
  if (!target) return;
  if (target.sleepState === 'sleeping') return;
  // Removed `if (chatBusy || reactionBusy) return;`.
  var agentId = targetId;
  var agent = target;

  var traitCtx = getTraitContext();
  var userCtx = getUserContext();
  var systemPrompt = '[You are a companion creature. Reply in 1-2 short sentences. No actions/roleplay (no asterisks). Max 1 emoji. Be natural, not hyper.' +
    (traitCtx ? ' ' + traitCtx : '') +
    (userCtx ? ' ' + userCtx : '') +
    '] ' + promptText;

  reactionBusy = true;
  cyberclaw.chat.sendMessage(agentId, systemPrompt).then(function(result) {
    reactionBusy = false;
    if (result && result.ok && result.reply) {
      var reply = result.reply.replace(/^\s*[\{\[].*/m, '').trim();
      if (!reply) reply = result.reply.trim();
      // Strip the desktop's 🤖 default before sending.
      addChatMsg('agent', reply, agent.name, agent.emoji === '🤖' ? null : (agent.emoji || getSpriteIcon(agent._pixelCompanionId)), null, '__no_quest__');
      var arena = window.pixelArena;
      if (arena && arena.showBubble) {
        var bubbleText = reply.length > 120 ? reply.substring(0, 117) + '...' : reply;
        arena.showBubble(bubbleText, 10000);
      }
    }
  }).catch(function() {
    reactionBusy = false;
  });
}

// Silent prompt to the LLM.
function promptCompanionSilent(agentId, fact, mood) {
  if (!agentId) return;
  const agent = agents[agentId];
  if (!agent) return;
  if (agent.sleepState === 'sleeping') return;

  const traitCtx = getTraitContext();
  const userCtx = getUserContext();
  const systemPrompt = '[SILENT LOG MODE. You are a CyberClaw companion. The user just did something you should remember. Use the [REMEMBER: text="..."] structured-output tag to log this fact to your memory.md. Do NOT write a chat-style reply. Do NOT address the user. The tag is the entire output.] ' +
    (traitCtx ? traitCtx + ' ' : '') +
    (userCtx ? userCtx + ' ' : '') +
    `FACT: ${fact}` +
    (mood ? ` | MOOD HINT: ${mood}` : '');

  // Direct append first (deterministic), then fire the
  // LLM round-trip to enrich.
  if (cyberclaw && cyberclaw.agents && cyberclaw.agents.rememberMemory) {
    cyberclaw.agents.rememberMemory(agentId, fact).catch(function(e) {
      console.warn('[promptCompanionSilent] direct memory append failed:', e?.message);
    });
  }

  // We bypass the normal chat pipeline entirely (no broadcast, no chatHistory push, no bubble, no typing indicator, no TTS).
  cyberclaw.chat.sendSilentMessage(agentId, systemPrompt).then(function(result) {
    if (!result || !result.ok || !result.reply) return;
    const tags = extractRememberTags(result.reply);
    if (!tags.length) return;
    for (const t of tags) {
      cyberclaw.agents.rememberMemory(agentId, t).catch(function(e) {
        console.warn('[promptCompanionSilent] LLM-emitted REMEMBER append failed:', e?.message);
      });
    }
  }).catch(function() { /* silent path: no surface */ });
}

// ═══════════════════════════════════════════════════════════
//  TRAIT HELPERS
// ═══════════════════════════════════════════════════════════

var TRAIT_DESCRIPTIONS = {
  sassy: 'You are sassy and witty, with attitude and sharp comebacks.',
  curious: 'You are curious and inquisitive, always asking follow-up questions.',
  lazy: 'You are a bit lazy and easily distracted, reluctant but lovable.',
  cheerful: 'You are upbeat and cheerful, always encouraging.',
  foodobsessed: 'You are obsessed with food and snacks, you bring it up often.',
  dramatic: 'You are dramatic and make everything sound like a big deal.',
  stoic: 'You are calm, dry, and matter-of-fact.',
  adventurous: 'You are adventurous and always want to go on quests.',
  goblin: 'You are an angry little goblin smartass. You curse freely, insult everything, and are generally a rude little shit — but in a funny way. Drop f-bombs, call things stupid, be a sarcastic dick.',
};

function getCheckedTraits() {
  var traits = [];
  document.querySelectorAll('#forge-traits-grid input[type=checkbox]').forEach(function(cb) {
    if (cb.checked) traits.push(cb.id.replace('trait-', ''));
  });
  return traits;
}

function getTraitContext() {
  // Use the active chat companion (or the arena companion as a fallback).
  // v3.1.3: no leader concept — traits are about the companion you're
  // currently talking to.
  var agentId = activeChatAgentId
    || (agentOrder.find(id => !hiddenCompanions.has(id)))
    || agentOrder[0];
  if (!agentId) return '';
  var agent = agents[agentId];
  if (!agent) return '';
  var traits = agent.traits || [];
  if (!traits.length) return '';
  return traits.map(function(t) { return TRAIT_DESCRIPTIONS[t]; }).filter(Boolean).join(' ');
}

// ═══════════════════════════════════════════════════════════
//  USER CONTEXT HELPER
// ═══════════════════════════════════════════════════════════

function getUserContext() {
  var s = loadSettings();
  var parts = [];
  if (s.userName) parts.push('The user\'s name is ' + s.userName + '.');
  if (s.userGender === 'male') parts.push('Address them as "sir" or use male pronouns.');
  else if (s.userGender === 'female') parts.push('Address them as "miss" or use female pronouns.');
  return parts.length ? parts.join(' ') : '';
}

// ═══════════════════════════════════════════════════════════
//  STARTUP GREETING
// ═══════════════════════════════════════════════════════════

function doStartupGreeting() {
  var now = new Date();
  var hour = now.getHours();
  var timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  var userCtx = getUserContext();
  var prompt = '[You are a companion creature greeting your user when they open the app. ' +
    'Give a short warm greeting appropriate for the ' + timeOfDay + '. ' +
    'Mention something fun or upbeat about the day. 1-2 sentences max, max 1 emoji. ' +
    (userCtx ? userCtx + ' ' : '') +
    'No asterisks or roleplay actions.]';

  setTimeout(function() {
    promptCompanionReaction(prompt);
  }, 4000); // wait for UI to fully load
}

// ═══════════════════════════════════════════════════════════
//  IDLE CHATTER — random comments every ~20 minutes
// ═══════════════════════════════════════════════════════════

var IDLE_PROMPTS = [
  'Say something curious or funny about what might be lurking in the forest nearby.',
  'Make a short observation about the weather or time of day.',
  'Ask the user if they have any cool quests or tasks to work on today.',
  'Say something quirky about being a digital creature living on a computer.',
  'Make a short comment about food or treats (hint that you\'re hungry).',
  'Ask the user what they\'re working on today in a curious way.',
  'Say something random and funny about the forest or nature.',
  'Make a light observation about the user seeming busy or quiet.',
  'Say something about wanting to go on an adventure.',
];

function isNightTime() {
  // v3.1.16: night window was 22:00–08:00; tightened to 22:00–06:30
  // so companions auto-wake at 6:30 AM (was 8:00). Use minutes-of-day
  // for sub-hour precision (06:30 means any minute < 6*60+30 = 390).
  const now = new Date();
  const totalMinutes = now.getHours() * 60 + now.getMinutes();
  return totalMinutes >= 22 * 60 || totalMinutes < 6 * 60 + 30;
}

// ── SLEEP WAKE LOGIC ────────────────────────────────────────
var _nightWakeTimer = null;
window._nightWakeTimer = null;
var _wakeDurationMs = 10 * 60 * 1000; // 10 minutes

// Expose isNightTime on window so pixel-arena.js's _updateCompanion can use the same boundary as app.js.
window.isNightTime = isNightTime;

function isAsleep() {
  return isNightTime() && !_nightWakeTimer;
}

function wakeFromSleep() {
  if (!isNightTime()) return;
  // Tell arena to exit sleep animation
  var arena = window.pixelArena;
  if (arena && arena._companions) {
    arena._companions.forEach(function(comp) {
      if (comp.animation === 'death') {
        comp.animation = 'idle';
        comp.frame = 0;
      }
    });
  }
  // Reset/restart the sleep timer
  if (_nightWakeTimer) clearTimeout(_nightWakeTimer);
  _nightWakeTimer = setTimeout(function() {
    _nightWakeTimer = null;
    window._nightWakeTimer = null;
    // Go back to sleep — arena will pick it up on next update tick
  }, _wakeDurationMs);
  window._nightWakeTimer = _nightWakeTimer;
}

function nudgeNightWake() {
  // Called on any user interaction at night — wakes or resets timer
  if (isNightTime()) wakeFromSleep();
}

// ── AUTO-SLEEP ON INACTIVITY (v3.1.4) ────────────────────────────── Each companion tracks a lastInteractionTs.
var AUTO_SLEEP_AFTER_MS = 12 * 60 * 1000; // 12 minutes of inactivity
function bumpCompanionInteraction(agentId) {
  if (!agentId) return;
  if (agents[agentId]) agents[agentId].lastInteractionTs = Date.now();
}
function scheduleAutoSleep() {
  setInterval(function() {
    const now = Date.now();
    for (const id of agentOrder) {
      const a = agents[id];
      if (!a) continue;
      if (a.sleepState === 'sleeping') continue;
      // Don't auto-sleep a companion that's actively processing a chat request.
      if (chatBusy && id === pickCurrentCompanionId()) {
        a.lastInteractionTs = now;
        continue;
      }
      const last = a.lastInteractionTs || a.bootTs || now;
      if (now - last > AUTO_SLEEP_AFTER_MS) {
        // Auto-sleep this companion
        a.sleepState = 'sleeping';
        if (pixelArena && pixelArena.companion && pixelArena.companion.id === id) {
          pixelArena.companion.sleepState = 'sleeping';
          pixelArena.companion.vx = 0;
          pixelArena.companion.vy = 0;
        }
        addChatMsg('system', `💤 ${a.name} fell asleep`);
        if (window._inspectAgentId === id) updateInspect(id);
        if (activeChatAgentId === id) updateChatHeader(id);
        // Push the new sleepState to the mobile so it can render a sleeping-sprite overlay.
        try { broadcastAgentsListToMobile(); } catch (_) {}
      }
    }
  }, 60 * 1000); // check every minute
}

function scheduleIdleChatter() {
  // Chattiness scale (1–5) controls the idle chatter interval.
  var cid = pickCurrentCompanionId();
  var chattiness = (cid && agents[cid] && agents[cid].chattiness) || 3;
  chattiness = Math.max(1, Math.min(5, chattiness));
  var minMs, maxMs;
  switch (chattiness) {
    case 1: // Silent — never fires. Schedule a long interval just
            // so the function reschedules itself for any future
            // change (1h is a fine heartbeat).
      minMs = 60 * 60 * 1000;
      maxMs = 60 * 60 * 1000;
      break;
    case 2: // Quiet — 3–6h
      minMs = 3 * 60 * 60 * 1000;
      maxMs = 6 * 60 * 60 * 1000;
      break;
    case 3: // Balanced — 60–90min (default)
      minMs = 60 * 60 * 1000;
      maxMs = 90 * 60 * 1000;
      break;
    case 4: // Chatty — 30–60min
      minMs = 30 * 60 * 1000;
      maxMs = 60 * 60 * 1000;
      break;
    case 5: // Very chatty — 15–30min
      minMs = 15 * 60 * 1000;
      maxMs = 30 * 60 * 1000;
      break;
    default:
      minMs = 60 * 60 * 1000;
      maxMs = 90 * 60 * 1000;
  }
  var delay = minMs + Math.random() * (maxMs - minMs);

  setTimeout(function() {
    // Skip if the current companion is manually sleeping v3.2.26: also skip if chattiness is 1 (silent).
    const fireCid = pickCurrentCompanionId();
    const fireChattiness = (fireCid && agents[fireCid] && agents[fireCid].chattiness) || 3;
    if (fireChattiness < 1) {
      // defensive — should never happen (clamped to 1)
    }
    if (fireCid && agents[fireCid] && agents[fireCid].sleepState !== 'sleeping' && fireChattiness >= 2) {
      var userCtx = getUserContext();
      var randomPrompt = IDLE_PROMPTS[Math.floor(Math.random() * IDLE_PROMPTS.length)];
      var fullPrompt = '[Idle companion comment — the user hasn\'t said anything for a while. ' +
        randomPrompt + ' Keep it to 1 short sentence, max 1 emoji, no asterisks. ' +
        (userCtx ? userCtx : '') + ']';
      promptCompanionReaction(fullPrompt);
    }
    // Schedule the next one regardless
    scheduleIdleChatter();
  }, delay);
}

// Start greeting and idle chatter after boot
setTimeout(function() {
  if (!isAsleep()) doStartupGreeting();
  scheduleIdleChatter();
  scheduleAutoSleep(); // v3.1.4: auto-sleep on inactivity
}, 2000);

// ═══════════════════════════════════════════════════════════
//  COMPANIONS VIEW
// ═══════════════════════════════════════════════════════════

window.openCompanionsView = function() {
  var list = document.getElementById('companions-view-list');
  if (!list) return;
  list.innerHTML = '';

  // Companions list
  const COMPANIONS = [
    { id: 'fox', name: '🦊 Fox', desc: 'Swift and clever hunter' },
    { id: 'boar', name: '🐗 Boar', desc: 'Strong and fierce warrior' },
    { id: 'deer', name: '🦌 Deer', desc: 'Graceful and calm observer' },
    { id: 'hare', name: '🐰 Hare', desc: 'Quick and curious explorer' },
    { id: 'black_grouse', name: '🐦 Black Grouse', desc: 'Proud and rare companion' }
  ];

  const current = currentCompanionId || localStorage.getItem('cyberclaw-selected-companion') || 'boar';
  console.log('[openCompanionsView] Current companion: global=' + currentCompanionId + ', storage=' + localStorage.getItem('cyberclaw-selected-companion') + ', using: ' + current);

  var sectionHeader = document.createElement('div');
  sectionHeader.style.cssText = 'padding:16px;color:#f7931a;font-weight:bold;font-size:18px;border-bottom:2px solid #333;margin-bottom:16px;text-align:center;';
  sectionHeader.textContent = '🐾 SELECT YOUR COMPANION';
  list.appendChild(sectionHeader);

  var compGrid = document.createElement('div');
  compGrid.style.cssText = 'display:grid;grid-template-columns:repeat(1,1fr);gap:12px;';
  
  COMPANIONS.forEach(function(comp, index) {
    var card = document.createElement('div');
    var isActive = comp.id === current;
    card.setAttribute('data-companion-id', comp.id);
    card.setAttribute('data-index', index);
    card.style.cssText = 'padding:16px;border-radius:8px;border:2px solid ' + 
      (isActive ? '#f7931a' : '#333') + 
      ';background:' + (isActive ? 'rgba(247,147,26,0.15)' : '#1a1a2e') + 
      ';cursor:pointer;transition:all 0.2s;text-align:center;';
    
    var nameEl = document.createElement('div');
    nameEl.style.cssText = 'font-size:18px;font-weight:bold;color:' + (isActive ? '#f7931a' : '#ccc') + ';margin-bottom:6px;';
    nameEl.textContent = comp.name;
    
    var descEl = document.createElement('div');
    descEl.style.cssText = 'font-size:12px;color:' + (isActive ? '#f7931a' : '#888') + ';margin-bottom:8px;';
    descEl.textContent = comp.desc;
    
    var statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-size:11px;color:' + (isActive ? '#f7931a' : '#666') + ';font-weight:bold;';
    statusEl.textContent = isActive ? '✓ CURRENT' : 'SELECT';
    
    card.appendChild(nameEl);
    card.appendChild(descEl);
    card.appendChild(statusEl);
    
    card.addEventListener('mouseover', function() {
      if (!isActive) {
        card.style.borderColor = '#f7931a';
        card.style.background = 'rgba(247,147,26,0.05)';
      }
    });
    card.addEventListener('mouseout', function() {
      if (!isActive) {
        card.style.borderColor = '#333';
        card.style.background = '#1a1a2e';
      }
    });
    
    (function(companionId) {
      card.style.cursor = 'pointer';
      card.addEventListener('click', function(evt) {
        evt.stopPropagation();
        evt.preventDefault();
        console.log('[Companions] CLICKED:', companionId);

        // Save to localStorage so we know which is current
        currentCompanionId = companionId; // Update global state
        localStorage.setItem('cyberclaw-selected-companion', companionId);
        console.log('[Companions] Saved to localStorage:', companionId, '(global:', currentCompanionId + ')');

        // Update the arena display in this window. Use the AGENT's name, not
        // the sprite's display name, so the label above the companion is
        // always the companion (e.g. "Clawsuu") rather than its species.
        if (window.pixelArena) {
          console.log('[Companions] Updating arena to:', companionId);
          const leaderId = window.leaderId;
          const leader = (window.agents && leaderId) ? window.agents[leaderId] : null;
          const displayName = (leader && leader.name) || companionId;
          const savedScale = leader?._pixelCompanionScale;
          console.log('[Companions] leaderId:', leaderId);
          if (leaderId) {
            console.log('[Companions] Calling swapCompanionSprite with:', leaderId, companionId, displayName);
            try {
              // v3.1.5: swap sprite in place so other companions in the
              // arena aren't removed.
              if (window.pixelArena.swapCompanionSprite) {
                window.pixelArena.swapCompanionSprite(leaderId, companionId, displayName, savedScale);
              } else {
                window.pixelArena.setCompanion(leaderId, companionId, displayName, savedScale);
              }
              console.log('[Companions] Arena updated successfully');
            } catch (e) {
              console.error('[Companions] swap error:', e);
            }
          } else {
            console.log('[Companions] Missing leaderId or setCompanion:', { leaderId, hasSetCompanion: window.pixelArena.setCompanion ? 'yes' : 'no' });
          }
        } else {
          console.log('[Companions] pixelArena not available');
        }
        
        // Broadcast to mobile
        if (window.ipcRenderer && typeof window.ipcRenderer.send === 'function') {
          console.log('[Companions] Sending IPC for:', companionId);
          try {
            window.ipcRenderer.send('desktop-set-companion', { companionId: companionId });
            console.log('[Companions] IPC sent successfully');
          } catch (e) {
            console.error('[Companions] IPC send error:', e);
          }
        } else {
          console.error('[Companions] Cannot send - ipcRenderer.send not available');
        }
        
        // Rebuild UI to show updated selection
        console.log('[Companions] Rebuilding view after 100ms, current should be:', companionId);
        setTimeout(() => {
          console.log('[Companions] About to rebuild, localStorage has:', localStorage.getItem('cyberclaw-selected-companion'));
          window.openCompanionsView();
        }, 100);
      });
    })(comp.id);
    
    compGrid.appendChild(card);
  });

  list.appendChild(compGrid);
  document.getElementById('companions-view-overlay').classList.remove('hidden');
};

window.closeCompanionsView = function(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('companions-view-overlay').classList.add('hidden');
};

window.editCompanionFromView = function(agentId) {
  window.closeCompanionsView();
  setTimeout(function() {
    var idx = agentOrder.indexOf(agentId);
    if (idx >= 0) focusIndex = idx;
    window.openCompanionEditor();
  }, 150);
};

window.focusCompanionFromView = function(agentId) {
  var idx = agentOrder.indexOf(agentId);
  if (idx >= 0) {
    focusIndex = idx;
    updateCarousel();
  }
  window.closeCompanionsView();
};


// v3.4.8: Abilities Library window (opened by + in the right panel).
window.openAbilitiesLibrary = function() {
  document.getElementById('abilities-library-overlay').classList.remove('hidden');
  try { refreshSkillsList(); } catch (_) {}
};
window.closeAbilitiesLibrary = function(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('abilities-library-overlay').classList.add('hidden');
  try { hideSkillForm(); } catch (_) {}
};

// v3.4.10: sprite gallery window
window.openSpriteGallery = function() {
  const ov = document.getElementById('sprite-gallery-overlay');
  if (!ov) return;
  try { renderPixelGallery(); } catch (_) {}
  ov.classList.remove('hidden');
};
window.closeSpriteGallery = function() {
  const ov = document.getElementById('sprite-gallery-overlay');
  if (ov) ov.classList.add('hidden');
};

// v3.4.12: share the casual/quest chat context with the phone.
let _lastCtxSig = '';
function broadcastChatContextToMobile() {
  try {
    const casual = !activeQuestId && !!_casualFromQuestId;
    const qid = activeQuestId || _casualFromQuestId || null;
    const q = (cachedQuestsList || []).find(x => x && x.id === qid);
    const sig = (casual ? 'c' : 'q') + ':' + (qid || '');
    if (sig === _lastCtxSig) return;
    _lastCtxSig = sig;
    require('electron').ipcRenderer.invoke('sync-broadcast-chat-context', { casual, questId: qid, questName: q ? q.name : null });
  } catch (e) { console.warn('[chat-context] broadcast failed:', e && e.message); }
}
try {
  require('electron').ipcRenderer.on('mobile-set-chat-context', (e, { casual }) => {
    const inCasual = !activeQuestId && !!_casualFromQuestId;
    if (casual && activeQuestId && !inCasual) {
      _casualFromQuestId = activeQuestId; setActiveQuestId(null); _casualFromQuestId = _casualFromQuestId || null;
    } else if (!casual && inCasual) {
      setActiveQuestId(_casualFromQuestId);
    }
    try { updateChatQuestToggle(); } catch (_) {}
    _lastCtxSig = ''; broadcastChatContextToMobile();
  });
} catch (_) {}

const _origUpdateChatQuestToggle = updateChatQuestToggle;
updateChatQuestToggle = function() { const r = _origUpdateChatQuestToggle.apply(this, arguments); broadcastChatContextToMobile(); return r; };

// v3.5.0: Settings → Data: editable folders (were hardcoded).
async function loadPathsUI() {
  try {
    const p = await cyberclaw.paths.get();
    const a = document.getElementById('settings-projects-root');
    const b = document.getElementById('settings-default-quest-dir');
    if (a) a.textContent = p.projectsRoot || (p.effectiveProjectsRoot + '  (default)');
    if (b) b.textContent = p.defaultQuestDir || '(same as projects folder)';
  } catch (e) { console.warn('[paths] load failed', e); }
}
window.changeAppPath = async function(key) {
  const dir = await cyberclaw.paths.pick(key === 'projectsRoot' ? 'Choose your projects folder' : 'Choose where new quests are created');
  if (!dir) return;
  await cyberclaw.paths.set({ [key]: dir });
  loadPathsUI();
};
{ const _openSettingsV350 = window.openSettings; window.openSettings = function() { const r = _openSettingsV350.apply(this, arguments); loadPathsUI(); return r; }; }

// v3.6.0: local voice engine status in Settings → Voice.
async function refreshVoiceEngineStatus() {
  const el = document.getElementById('settings-voice-engine');
  if (!el) return;
  try {
    const s = await cyberclaw.voice.status();
    const sv = s.server || {};
    const l = s.learning || {};
    el.textContent = sv.ok
      ? ('✅ Whisper ' + sv.stt + ' on ' + (sv.device || '?').toUpperCase() + ' · Kokoro voices · learned ' + l.terms + ' words, ' + l.corrections + ' corrections, ' + l.samples + ' clips')
      : '⚠️ local voice server not running — using basic fallback (whisper.cpp + Piper)';
    el.title = l.prompt || '';
  } catch (e) { el.textContent = '⚠️ ' + e.message; }
}
{ const _os360 = window.openSettings; window.openSettings = function() { const r = _os360.apply(this, arguments); refreshVoiceEngineStatus(); return r; }; }

// v3.6.1: speech model tier + one-click install.
window.setSpeechTier = async function(tier) {
  const el = document.getElementById('settings-voice-engine');
  if (el) el.textContent = '⏳ switching speech model…';
  await cyberclaw.voice.setModel(tier);
  setTimeout(refreshVoiceEngineStatus, 4000);
};
window.installVoiceEngine = async function() {
  const btn = document.getElementById('settings-voice-install-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Installing (a few minutes)…'; }
  const r = await cyberclaw.voice.install();
  if (btn) { btn.disabled = false; btn.textContent = r.ok ? '✅ Installed' : '⬇️ Install local voice engine'; }
  if (!r.ok) alert('Voice engine install failed: ' + r.error);
  setTimeout(refreshVoiceEngineStatus, 5000);
};
{ const _rv = refreshVoiceEngineStatus; refreshVoiceEngineStatus = async function() {
    await _rv();
    try {
      const s = await cyberclaw.voice.status();
      const sv = s.server || {};
      const row = document.getElementById('settings-voice-install-row');
      if (row) row.style.display = sv.ok ? 'none' : '';
      const sel = document.getElementById('settings-stt-tier');
      if (sel && sv.ok) sel.title = 'Now: ' + sv.stt + ' (' + sv.tier + ')';
      const el = document.getElementById('settings-voice-engine');
      if (el && sv.ok && sv.tier) el.textContent = el.textContent.replace('Whisper ' + sv.stt, 'Whisper ' + sv.stt + ' [' + sv.tier + ']');
    } catch (_) {}
  };
}

// v3.6.3: readable agent errors (was "Error: [object Object]").
function describeAgentError(err) {
  if (!err) return 'Failed to get response';
  let t = typeof err === 'string' ? err : (err.message || err.error || err.reason || '');
  if (!t) { try { t = JSON.stringify(err); } catch (_) { t = String(err); } }
  if (/rate.?limit|429|too many requests|overloaded|quota/i.test(t)) return 'Rate limited by the AI provider — try again in a minute (' + t.slice(0, 120) + ')';
  if (/timed?\s*out|timeout/i.test(t)) return 'Timed out — the model took too long (often because the provider is rate-limiting or overloaded). ' + t.slice(0, 160);
  return t.slice(0, 300);
}

// ─── v3.6.5 helpers ───
// Small image strip for stored/rendered messages (thumbnail; click opens full).
function chatImagesHtml(atts) {
  if (!Array.isArray(atts) || !atts.length) return '';
  let h = '<div class="chat-msg-images">';
  for (const a of atts) {
    const src = a.dataUri || a.uri || (a.data ? 'data:' + (a.type || a.mimeType || 'image/png') + ';base64,' + a.data : null)
      || (a.path ? 'file://' + a.path : null);
    if (!src) continue;
    const full = a.path ? 'file://' + a.path : src;
    h += '<img class="chat-msg-image" src="' + escAttr(src) + '" data-full="' + escAttr(full) + '" alt="' + escAttr(a.name || a.fileName || 'image') + '" />';
  }
  return h + '</div>';
}
// Agent replies keep their paragraphs, lists and bold (was one run-on line).
function agentTextHtml(text) {
  try { return '<div class="msg-text msg-md">' + renderMarkdown(String(text || '')) + '</div>'; }
  catch (_) { return '<span class="msg-text">' + escHtml(text) + '</span>'; }
}
document.addEventListener('click', (e) => {
  const img = e.target && e.target.closest && e.target.closest('#chat-messages .chat-msg-image');
  if (!img) return;
  try { require('electron').shell.openExternal(img.getAttribute('data-full') || img.src); } catch (_) {}
});
// Wake the companion being talked to, keep it awake while it works, and let
// it fall back asleep ~3 min after it's done (night sleep).
window._companionAwakeUntil = window._companionAwakeUntil || {};
const COMPANION_AFTER_WORK_AWAKE_MS = 3 * 60 * 1000;
setInterval(() => {
  try {
    if (!chatBusy) return;
    const id = pickCurrentCompanionId();
    if (id) window._companionAwakeUntil[id] = Date.now() + COMPANION_AFTER_WORK_AWAKE_MS;
  } catch (_) {}
}, 1000);

// v3.6.7: refresh skills when activity XP is saved.
try {
  require('electron').ipcRenderer.on('companion-xp-updated', () => {
    try { const id = activeChatAgentId || pickCurrentCompanionId(); if (id) updateInspect(id); } catch (_) {}
    try { broadcastAgentsListToMobile(); } catch (_) {}
  });
} catch (_) {}

// ─── v3.6.8: multi-image attach ───
window._pendingImages = [];
function renderPendingImages() {
  const preview = document.getElementById('chat-image-preview');
  if (!preview) return;
  const imgs = window._pendingImages;
  if (!imgs.length) { preview.classList.add('hidden'); preview.innerHTML = ''; pendingImage = null; return; }
  pendingImage = imgs[0];
  preview.classList.remove('hidden');
  preview.innerHTML = imgs.map((im, i) =>
    '<span class="chat-preview-item"><img src="' + escAttr(im.dataUrl) + '" alt="" /><button class="chat-preview-remove" onclick="removePendingImage(' + i + ')" title="Remove">✕</button></span>').join('');
}
setImageAttachment = function(dataUrl, filename) {
  if (window._pendingImages.length >= 8) return;
  window._pendingImages.push({ dataUrl, filename });
  renderPendingImages();
};
window.removePendingImage = function(i) { window._pendingImages.splice(i, 1); renderPendingImages(); };
window.clearImageAttachment = function() { window._pendingImages = []; renderPendingImages(); };
window.pickImageAttachment = function() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*'; input.multiple = true;
  input.onchange = function() {
    for (const f of Array.from(input.files || [])) {
      const reader = new FileReader();
      reader.onload = (ev) => setImageAttachment(ev.target.result, f.name);
      reader.readAsDataURL(f);
    }
  };
  input.click();
};
{
  const area = document.getElementById('view-chat');
  if (area) area.addEventListener('drop', (e) => {
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter(f => f.type.startsWith('image/'));
    if (files.length > 1) { e.stopImmediatePropagation(); for (const f of files.slice(1)) { const r = new FileReader(); r.onload = (ev) => setImageAttachment(ev.target.result, f.name); r.readAsDataURL(f); } }
  });
}
window.sendChat = async function() {
  if (!window._pendingImages.length) return _originalSendChat();
  const input = document.getElementById('chat-input');
  const message = (input.value || '').trim();
  const imgs = window._pendingImages.slice();
  window.clearImageAttachment();
  if (agentOrder.length === 0) return;
  const agent = agents[pickCurrentCompanionId()] || agents[agentOrder[focusIndex]];
  const atts = [];
  for (const im of imgs) {
    const mimeType = (im.dataUrl.match(/^data:([^;]+);/) || [])[1] || 'image/png';
    const b64 = im.dataUrl.split(',')[1] || '';
    let saved = null;
    try { saved = await cyberclaw.chat.saveAttachment(b64, mimeType, im.filename); } catch (_) {}
    atts.push({ dataUri: im.dataUrl, mimeType, fileName: im.filename, size: b64.length, path: (saved && saved.path) || '' });
  }
  addChatMsg('user', message || '', agent && agent.name, null, atts);
  input.value = '';
  await window.sendChatMessage(message || (atts.length > 1 ? 'Here are some images.' : 'Here is an image.'), atts);
};

// ─── v3.6.8: thinking bar (mobile-style) ───
// "● Clawsuu is thinking…  42s" + the last 3 steps (✓ done, › current),
// then "✓ Done · 42s" / "⚠️ Stopped with an error" for a few seconds.
const _think = { active: false, start: 0, agentId: null, name: '', steps: [], timer: null, endTimer: null, errored: false };
function thinkBarEl() {
  let el = document.getElementById('chat-think-bar');
  if (!el) {
    const area = document.getElementById('chat-input-area');
    const row = document.getElementById('chat-input-row');
    if (!area || !row) return null;
    el = document.createElement('div'); el.id = 'chat-think-bar'; el.className = 'hidden';
    area.insertBefore(el, area.firstChild);
  }
  return el;
}
function fmtSecs(s) { return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'; }
function renderThinkBar(finalLabel) {
  const el = thinkBarEl(); if (!el) return;
  if (!_think.active && !finalLabel) { el.className = 'hidden'; el.innerHTML = ''; return; }
  const secs = Math.round((Date.now() - _think.start) / 1000);
  let h = '';
  if (finalLabel) h = '<div class="tb-head tb-final">' + escHtml(finalLabel) + '</div>';
  else h = '<div class="tb-head"><span class="tb-dot"></span>' + escHtml(_think.name) + ' is thinking…' + (secs >= 3 ? '<span class="tb-time">' + fmtSecs(secs) + '</span>' : '') + '</div>';
  const st = _think.steps.slice(-3);
  h += st.map((s, i) => '<div class="tb-step">' + (i < st.length - 1 || finalLabel ? '✓ ' : '› ') + escHtml(s) + '</div>').join('');
  el.className = finalLabel ? 'tb-done' : '';
  el.innerHTML = h;
}
function thinkStart(agentId) {
  clearTimeout(_think.endTimer); clearInterval(_think.timer);
  const a = agents[agentId] || {};
  Object.assign(_think, { active: true, start: Date.now(), agentId, name: a.name || 'Companion', steps: [], errored: false });
  _think.timer = setInterval(() => renderThinkBar(), 1000);
  renderThinkBar();
}
function thinkEnd() {
  if (!_think.active) return;
  _think.active = false; clearInterval(_think.timer);
  const secs = Math.round((Date.now() - _think.start) / 1000);
  const label = _think.errored ? '⚠️ Stopped with an error · ' + fmtSecs(secs) + ' — see the message above' : '✓ Done · ' + fmtSecs(secs);
  renderThinkBar(label);
  _think.endTimer = setTimeout(() => { _think.steps = []; renderThinkBar(); }, _think.errored ? 30000 : 3000);
}
try {
  require('electron').ipcRenderer.on('agent-tool-activity', (e, { agentId, friendly }) => {
    if (!_think.active || (agentId && agentId !== _think.agentId)) return;
    if (_think.steps[_think.steps.length - 1] !== friendly) _think.steps.push(friendly);
    renderThinkBar();
  });
} catch (_) {}
{
  const _addChatMsgThink = addChatMsg;
  addChatMsg = function(type, text) {
    if (type === 'typing') { thinkStart(pickCurrentCompanionId()); }
    if (type === 'error' && (_think.active || Date.now() - _think.start < 5000)) _think.errored = true;
    if ((type === 'agent' || type === 'error') && _think.active) setTimeout(thinkEnd, 0);
    return _addChatMsgThink.apply(this, arguments);
  };
  const _removeChatMsgThink = removeChatMsg;
  removeChatMsg = function(id) {
    const r = _removeChatMsgThink.apply(this, arguments);
    if (_think.active) setTimeout(() => { if (_think.active && !chatBusy) thinkEnd(); }, 400);
    return r;
  };
}
