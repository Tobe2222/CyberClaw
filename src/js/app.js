/* ============================================================
   CyberClaw — Main application logic
   ============================================================ */

const { Terminal } = require('xterm');
const path = require('path');

// Pixel arena instance (shared 2D scene)
let pixelArena = null;
let currentCompanionId = 'boar'; // Track current companion globally
const { FitAddon } = require('xterm-addon-fit');
const { WebLinksAddon } = require('xterm-addon-web-links');

// ---------------------------------------------------------------------------
// Model name formatting
// ---------------------------------------------------------------------------

// Lookup the catalog `icon` for a given pixel sprite id. Returns
// null if the sprite isn't in the catalog or has no icon field.
// Used to send a per-sprite emoji to the mobile so the wake
// trainer picker (and chat tabs) can show a consistent icon per
// companion. The mobile falls back to its own lookup or to
// '🐾' / '🤖' when this is null.
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

// v3.1.26: returns the relative path to the sprite icon SVG
// (Twemoji-style). Used where we want a guaranteed colorful,
// smooth icon at any size, independent of the system emoji
// font. Falls back to null if the sprite has no iconFile.
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

// v3.1.29: returns the iconFile contents as a base64 data URI
// so the mobile (React Native) can render it via <Image source={{ uri: dataUri }}>.
// React Native's Image component doesn't resolve relative file
// paths from a broadcast payload, but it DOES render data URIs
// reliably. The SVG is tiny (<3KB) so the base64 overhead is
// negligible.

// v3.2.28: convert an avatar value to a data URI suitable for
// the mobile. The desktop stores a.avatar as either a file
// path (read from IDENTITY.md's Avatar: field, or the
// assets/avatars/ fallback at boot) OR as a base64 data URI
// (set after saveAvatar in the desktop forge). React Native's
// <Image> cannot resolve file paths from a broadcast payload,
// so the broadcast must always be a data URI.
//
// Strategy: if it already starts with "data:" we pass it
// through; otherwise treat it as a file path and read +
// base64-encode it. Cached at module scope (one read per
// agent) so the 60s broadcast doesn't re-read the file each
// tick.
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
    // PNG signature sniff. If the file is something else
    // (e.g. JPEG, WebP), use the matching data URI prefix.
    // Default to image/png since the avatar is rendered
    // through canvas.toDataURL('image/png') in the forge.
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
  // Pretty-print common models
  const pretty = {
    'claude-opus-4-6': 'Claude Opus 4',
    'claude-sonnet-4-6': 'Claude Sonnet 4',
    'claude-3-5-sonnet-20241022': 'Claude 3.5 Sonnet',
    'claude-3-5-haiku-20241022': 'Claude 3.5 Haiku',
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

async function loadAgents() {
  try {
    const result = await cyberclaw.agents.discover();
    if (!result || !result.agents || result.agents.length === 0) {
      console.warn('No agents discovered, using fallback');
      return;
    }

    agentOrder = [];
    agents = {};

    // Filter out unbound agents with no workspace (like "main")
    const filtered = result.agents.filter(a => {
      if (a.channel !== 'None') return true; // has a binding
      if (a.workspace && a.workspace !== '~/workspace' && a.workspace !== '/home/humpsuu/workspace') return true;
      return false; // unbound + default workspace = skip
    });

    // Sort: by name. (v3.1.3 removed the "party leader" concept — all
    // agents are treated equally. The arena shows the first non-hidden
    // companion, or whatever the user selects via the carousel / chat
    // channel tabs.)
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
          // v3.1.28: set _pixelCompanionId at load time so the chat
          // tab icon lookup (which reads agent._pixelCompanionId)
          // works even if initArenaCompanions hasn't run yet OR if
          // a later code path replaces the agent object. Without
          // this, the chat tab falls back to agent.emoji (which
          // is often "🤖" from older defaults) instead of the
          // sprite's catalog icon.
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

  // v3.1.5: every non-hidden companion is rendered in the arena. The
  // pixelArena spreads them horizontally based on count. The active
  // chat companion (if visible) is added first so it gets the center slot.
  // v3.1.18: cap at 6 visible companions. The desktop UI wasn't
  // designed for a long horizontal scroll bar of 20+ sprites; if
  // the user has more, only the first 6 (in arena order, with the
  // active chat companion first) are rendered. Hidden companions
  // don't count toward the cap. The remaining companions stay
  // selectable via the agent list / channel tabs but don't get a
  // sprite on the arena canvas.
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

  broadcastAgentsListToMobile();
}

// v3.1.20: factored out so saveCompanion (and other code that
// mutates the agent list) can re-broadcast the mobile list
// without duplicating the visibleOrder construction. The
// mobile list is what the mobile arena uses to render
// companions, so any change to the desktop's agent list
// (sprite id, scale, name, emoji) needs to push a fresh
// list to all connected mobiles immediately — otherwise
// the mobile won't see the change until the next 60s
// periodic sync. Earlier this only ran on init/reconnect,
// which is why changing a companion's size in the forge
// didn't update the mobile until up to 60s later.
// v3.2.27: now async. We need to await the sprite config
// read for each agent so the broadcast can include the
// full per-companion sprite config (traits, scale,
// chattiness, pixelCompanionId, models). The mobile's
// Personalize screen was rendering defaults (empty
// traits) because the agents_list broadcast didn't carry
// the sprite config — the mobile would only know what the
// user just SAVED, not what was already set on the
// desktop. Tobe's v3.10.94 feedback: "i still dont get
// the current settings. If you see the behaviours, none
// of them are selected, even tho they are on the
// desktop. The settings should be consistent between
// desktop and phone."
//
// Each sprite config is ~200 bytes JSON; reading 6 of
// them in parallel takes ~1ms (disk cache hit on second
// call). Awaiting in a map() is fine — the Promise.all
// pattern keeps the broadcast latency at one disk read,
// not six.
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
      // v3.2.27: read the full sprite config so the mobile
      // can hydrate its Personalize screen with the same
      // values the desktop has. cyberclaw.agents.getSpriteConfig
      // reads from sprites.json (cached on second call).
      // Errors are swallowed: a missing/corrupt file is
      // treated as "no config" and the mobile falls back
      // to its own defaults.
      let spriteConfig = null;
      try {
        spriteConfig = await cyberclaw.agents.getSpriteConfig(id);
      } catch (_) { /* ignore */ }
      return {
        id: a.id,
        name: a.name,
        sprite: a._pixelCompanionId || null,
        scale: a._pixelCompanionScale || null,
        // v3.1.30: distinguish "user explicitly set an emoji"
        // from "no user-set emoji, fell back to the desktop's
        // 🤖 default". The desktop stores a.emoji = a.emoji ||
        // '🤖' in its agents dict (so its own UI can render a
        // robot when nothing else applies), but for the mobile
        // broadcast we want the sprite catalog icon to be the
        // fallback, not the desktop's default. Treat the 🤖
        // default as "not set" and let the mobile's own chain
        // (emoji → icon → 🐾) decide.
        emoji: a.emoji === '🤖' ? null : (a.emoji || null),
        // v3.1.30: the sprite catalog icon is a separate
        // concept from the user's per-agent emoji override. A
        // cat-person wants 🦊 as the sprite icon and 😺 as their
        // custom emoji; we shouldn't conflate them. Send the
        // sprite icon independently of the per-agent emoji so
        // the mobile can compose them in its own chain.
        icon: getSpriteIcon(a._pixelCompanionId) || null,
        // v3.1.26: also send iconFile for the Twemoji SVG so
        // the mobile can render the bundled SVG instead of
        // relying on the system emoji font.
        iconFile: getSpriteIconFile(a._pixelCompanionId),
        // v3.1.29: also send the SVG as a base64 data URI so
        // React Native's <Image> can render it without needing
        // to resolve a relative file path from the broadcast.
        iconDataUri: getSpriteIconDataUri(a._pixelCompanionId),
        // v3.2.27: the actual pixel-art sprite (not the
        // Twemoji SVG). This is the first frame of the
        // idle animation, the same PNG that shows in the
        // arena + the chat tab icon + the desktop forge
        // preview. Tobe's v3.10.94 feedback: the mobile
        // preview was rendering the catalog emoji, not the
        // pixel sprite. Sending the avatar data URL
        // (5–11KB per sprite) lets the mobile render the
        // same art. Null if no avatar yet (legacy companion
        // or saveAvatar hasn't run).
        //
        // v3.2.28: convert file paths to data URIs at
        // broadcast time. At boot the desktop loads
        // a.avatar from IDENTITY.md (which holds a file
        // path, not a data URL) or the assets/avatars/
        // fallback. The mobile can't render a file path
        // from a broadcast payload — getAvatarDataUri
        // reads the file, base64-encodes it, and caches by
        // mtime so the 60s broadcast is fast.
        avatar: getAvatarDataUri(a.avatar),
        // v3.10.3: include sleepState so the mobile arena can
        // render a sleeping-sprite visual (CSS grayscale +
        // dim) when the desktop considers the companion
        // sleeping. Without this the mobile stays awake-looking
        // even when the desktop sprite is dozing, breaking the
        // "they sleep on the phone" expectation Tobe has. The
        // mobile also sends `mobile-wake-agent` IPC to flip
        // this back when the user speaks to a sleeping
        // companion, triggering a re-broadcast via
        // broadcastAgentsListToMobile() below.
        sleepState: a.sleepState || 'awake',
        // v3.2.26: chattiness scale (1–5). Mobile Personalize
        // screen uses this to render the slider's current value
        // without a separate request. Default 3 if the
        // companion has no chattiness set yet (legacy
        // sprite-config without the field).
        chattiness: typeof a.chattiness === 'number' ? a.chattiness : 3,
        // v3.2.27: the full sprite config (traits, scale,
        // pixelCompanionId, models, customName, focusSkills).
        // The mobile hydrates the Personalize screen from
        // this so the user sees the same selections the
        // desktop has, not defaults. Null if no config.
        spriteConfig: spriteConfig || null,
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
  { id: 'forest', label: 'Dark Forest', file: 'pixel_landscape_2.png', horizon: 0.55, season: 'autumn', vibe: 'a dark mysterious forest, feels like autumn' },
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
      // v3.1.21: prefer per-agent emoji, fall back to sprite icon
      // from the catalog so the avatar matches the sprite.
      // v3.10.65: strip the desktop's default 🤖 before falling
      // back to the sprite icon — same pattern as the chat
      // header, channel tabs, and broadcast paths. Without this,
      // agents without an explicit emoji show a robot instead of
      // their companion sprite in the carousel.
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

// Apply the current hiddenCompanions set to the pixelArena. v3.1.5:
// each hidden companion is removed from the arena; each newly-visible
// companion is added. The set is also persisted to localStorage so
// the choice survives a reload.
async function applyCompanionVisibility() {
  if (!pixelArena) return;
  // Remove companions that are now hidden
  for (const c of [...pixelArena.companions]) {
    if (hiddenCompanions.has(c.id)) pixelArena.removeCompanion(c.id);
  }
  // Add companions that are now visible
  // v3.1.18: cap the arena at 6. The active chat companion (if
  // visible and not hidden) is always included; the rest are
  // taken in `agentOrder` order until we hit the cap. If a
  // companion is unhidden beyond the cap, we just skip the add
  // (the user can still chat with them — they're just not
  // rendered in the arena).
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

// v3.1.3: manual sleep / wake toggle for the currently-focused companion.
// The button text and sprite animation both reflect the new state. When
// the user sends a chat message, sendChat() auto-wakes the target so the
// companion can reply.
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
    // v3.1.16: nudge the night-wake timer too. Without this, if it's
    // currently night time (22:00–06:30) the arena's _updateCompanion
    // computes `timeBasedSleep = isNight && !_nightWakeTimer` as true
    // and the sprite stays in the 'death' pose even though the manual
    // sleepState is awake. nudgeNightWake() is a no-op during the day
    // and idempotent at night (it just resets the existing timer), so
    // calling it from a wake click is always safe.
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
    const allSkillDefs = [
      { name: 'Coding', icon: '💻' },
      { name: 'Writing', icon: '✍️' },
      { name: 'Design', icon: '🎨' },
      { name: 'Analysis', icon: '📊' },
      { name: 'Strategy', icon: '🗺️' },
      { name: 'Research', icon: '🔍' },
      { name: 'Communication', icon: '💬' },
      { name: 'Game', icon: '🎮' },
      { name: 'General', icon: '✨' },
    ];
    
    const displaySkills = allSkillDefs;
    
    const skills = stats.skills || {};
    if (displaySkills.length === 0) {
      skillsEl.innerHTML = '<div style="color:var(--text-muted);font-size:9px;padding:2px">No specializations assigned</div>';
    } else {
      skillsEl.innerHTML = displaySkills.map(s => {
        const sk = skills[s.name] || { level: 1, xp: 0 };
        const xpNeeded = Math.floor(100 * Math.pow(1.5, sk.level - 1));
        const pct = Math.min(100, (sk.xp / xpNeeded) * 100);
        return `<div class="rs-skill-row">
          <span class="rs-skill-icon">${s.icon}</span>
          <span class="rs-skill-name">${s.name}</span>
          <span class="rs-skill-level">${sk.level}</span>
          <div class="rs-skill-bar"><div class="rs-skill-fill" style="width:${pct}%"></div></div>
        </div>`;
      }).join('');
    }
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

// ---------------------------------------------------------------------------
// Quest Management
// ---------------------------------------------------------------------------
// v3.1.50: `activeQuestId` is now derived from the quest list's
// `active: true` flag (set in main.js's IPC handler and persisted
// to disk). It used to be an in-memory variable only, which meant
// the selection was lost on desktop restart. The variable is still
// kept as a local cache so the chat-context builder doesn't have
// to round-trip to disk on every message; it's updated whenever
// the quest list is rendered or the IPC bridge returns a fresh
// active quest.
let activeQuestId = null;
// v3.2.41: pre-warm the quest-instructions cache when a
// quest becomes active. The cache is populated inside
// buildActiveQuestContext (sync function) by a
// fire-and-forget read — which means the FIRST chat send
// after a quest switch has no instructions file in
// context. Tobe hit this on 2026-08-02: switched to
// CYBERHIVE_WEBSITE V3, sent "do it", and the companion
// replied "you didn't unlock shit" because it didn't see
// the instructions file. The user did see the file (the
// quest editor showed it), and they had to nudge the
// companion to look again.
//
// The preheat is a module-level map of `questId -> promise`
// that selectQuest() populates right after setActive
// succeeds. buildActiveQuestContext awaits the promise
// if it's still pending, so the cache is always warm by
// the time the LLM sees the context.
const questInstructionsPreheat = new Map();
// Helper: pull the current active quest id from the quest list
// without going through disk. Falls back to the in-memory cache
// if the list is empty.
function getActiveQuestId(quests) {
  const found = quests?.find(q => q.active);
  if (found) activeQuestId = found.id;
  return activeQuestId;
}
// v3.1.50: build the chat context for the active quest. Used by
// both the regular chat (line ~1700) and the voice-mode chat
// (line ~1848) to inject a single, consistent prompt prefix
// that tells the LLM which quest is the working one and what
// progress has been made on it.
//
// Shape (one bracketed block, prefixed to the user's message):
//   [Active Quest: "<name>" — <description> | Project dir: <dir>
//    | Incomplete goals: <goal1>; <goal2>; ...
//    | Recent changes: <text1> (<time-ago>); <text2> (<time-ago>); ...]
//
// Goals listed are INCOMPLETE ones only (completed ones aren't
// useful for the LLM to act on). If all goals are done we
// mention that explicitly so the LLM knows the quest is wrapped
// up.
//
// Recent changes is the last 5 entries from latestChanges,
// formatted as "<text> (<time-ago>)". Time-ago is relative to
// now (e.g. "2h ago", "3d ago") — easier for the LLM to reason
// about than absolute timestamps, and the absolute timestamp is
// still available in the quest JSON if the LLM wants to look
// it up.
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
  // v3.1.50: teach the agent about the quest-edit tags when
  // there's an active quest. The hint is one short clause so
  // it doesn't bloat the context window. The LLM picks up the
  // tag shape from prior uses in the conversation; the hint
  // here just reminds it that the tools are available.
  // v3.2.21: added CREATE_QUEST to the list. Without it, the
  // agent has no in-context hint that creating a new quest is
  // possible from a chat reply, so when the user says "create
  // a quest called X" the agent falls back to scheduling a
  // cron job or guessing at IPC paths. Tobe hit this on
  // 2026-07-23: "[CREATE_QUEST: ...]" tag was supported by
  // the parser but never advertised to the agent. Same
  // CREATE_QUEST tag is now also injected unconditionally in
  // sendChatMessage() via buildQuestToolsHint() so the agent
  // sees it even when there's no active quest.
  ctx += ` | Tools: [CREATE_QUEST: name="..." desc="..." dir="optional/path"] [QUEST_APPEND_CHANGE: text="..."] [QUEST_NOTE: text="..."] [QUEST_MARK_GOAL: index="N" done="true|false"] [QUEST_SET_ACTIVE: id="<id-or-name>"]`;
  ctx += `] `;

  // v3.2.30: per-quest instructions file. The companion reads
  // <quest.directory>/QUEST_INSTRUCTIONS.md (or
  // ~/.openclaw/cyberclaw/quests/<id>/QUEST_INSTRUCTIONS.md if no
  // directory) on every chat send and injects its contents
  // as a separate context block. This is the place to write
  // project-specific instructions ("on this quest, never
  // touch the dev DB", "use British English", "always check
  // the build before committing") that the LLM should
  // follow while working on this quest.
  //
  // Cached at module scope so the read-on-every-send isn't
  // a real cost. The cache invalidates on saveQuestInstructions (the
  // renderer's quest editor calls cyberclaw.quests.saveQuestInstructions
  // then clears the cache here).
  if (!quest._questInstructionsCache) quest._questInstructionsCache = {};
  const cached = quest._questInstructionsCache[quest.id];
  if (cached !== undefined) {
    if (cached.content) {
      ctx += `\n[Quest instructions at ${cached.path}]\n${cached.content}\n[/Quest instructions] `;
    }
  } else {
    // v3.2.41: buildActiveQuestContext is now async so we
    // can await the read. The first send after a quest
    // switch waits for the file read (microseconds — the
    // IPC is fast and the file is small). The preheat
    // promise seeded by selectQuest() resolves to the same
    // file content, so if the preheat finished first we
    // skip the second IPC entirely.
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

  return ctx;
}

// v3.2.21: standalone quest-tools hint. Always injected in
// chat messages (regardless of whether there's an active
// quest) so the agent knows it can create new quests from
// the chat reply. Without this, the only hint is inside
// buildActiveQuestContext() which only fires when there's
// an active quest — so a user asking "create a new quest
// called X" on a fresh workspace would get no in-context
// hint that CREATE_QUEST exists, and the agent would fall
// back to scheduling a cron or hallucinating IPC paths.
// Tobe hit this on 2026-07-23 ("@Clawsuu any idea why the
// companion could not create a new quest?").
//
// Keep this list in sync with the tag parsers in
// result.reply parsing blocks below (search for
// "QUEST_SET_ACTIVE" / "QUEST_APPEND_CHANGE" / "QUEST_NOTE" /
// "QUEST_MARK_GOAL" / "CREATE_QUEST"). The hint is one
// short clause to minimize context-window bloat.
function buildQuestToolsHint() {
  return '[Quest tools available — emit these tags in your reply when applicable: [CREATE_QUEST: name="..." desc="..." dir="optional/path"] to create a new quest, [QUEST_APPEND_CHANGE: text="..."] to log a change to the active quest, [QUEST_NOTE: text="..."] to leave a note for yourself in the active quest\'s instructions file (project-specific knowledge that future turns should see), [QUEST_MARK_GOAL: index="N" done="true|false"] to toggle a goal on the active quest, [QUEST_SET_ACTIVE: id="<id-or-name>"] to switch the active quest. Tags are parsed by the desktop on every reply and the action is performed immediately.] ';
}
// v3.2.36: strip any quest-tool tags from a reply before
// showing it in the chat. The tag parsers run on the
// ORIGINAL `result.reply` and still execute the side
// effect (logged change, marked goal, switched quest,
// created quest) — this only hides the LLM-facing
// markup from the user-visible bubble.
//
// Tobe's 2026-07-29 complaint: "why does it say the
// quest append thing? i dont want that."
// (The full `[QUEST_APPEND_CHANGE: text="..."] Helpful
// human reply` had the tag showing inline in the chat
// bubble, with the helpful reply right after it.)
//
// The strip also kills the buildQuestToolsHint() string
// (the "Quest tools available — emit these tags..." line
// that the hint occasionally re-emits) and any other
// bracketed tag that LOOKS like a quest tool, so the
// bubble stays clean.
function stripQuestTags(reply) {
  if (!reply) return reply;
  return reply
    // Each tag form. Match the [TAG_NAME: ...] chunk up
    // to the closing "]". The tag parsers below still run
    // on the unmodified reply.
    .replace(/\[CREATE_QUEST:[^\]]*\]/g, '')
    .replace(/\[QUEST_APPEND_CHANGE:[^\]]*\]/g, '')
    .replace(/\[QUEST_NOTE:[^\]]*\]/g, '')
    .replace(/\[QUEST_MARK_GOAL:[^\]]*\]/g, '')
    .replace(/\[QUEST_SET_ACTIVE:[^\]]*\]/g, '')
    // The full hint string the LLM occasionally echoes back.
    .replace(/\[Quest tools available[^\]]*\]/g, '')
    // Collapse leftover blank lines so a tag-alone line
    // doesn't leave a double blank behind.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
// Helper: pull the current active quest id from the quest list
// without going through disk. Falls back to the in-memory cache
// if the list is empty.
function getActiveQuestId(quests) {
  const found = quests?.find(q => q.active);
  if (found) activeQuestId = found.id;
  return activeQuestId;
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
  await cyberclaw.quests.create({ name, description: desc, directory: dir || undefined });
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

// v3.1.50: toggle a quest as the active (working) one. Persists
// the choice to disk via the IPC bridge (main.js enforces
// exactly-one-active invariant and broadcasts the updated list to
// connected mobiles). The visual `quest-selected` class is still
// applied locally for instant feedback, but the source of truth
// is the `active: true` flag on the quest object — re-read on
// every renderQuests() to stay in sync.
window.selectQuest = async function(el, questId) {
  const wasSelected = el.classList.contains('quest-selected');
  // Optimistic local update for instant feedback.
  document.querySelectorAll('.quest-item').forEach(q => q.classList.remove('quest-selected'));
  if (wasSelected) {
    // Deselect — clear active on all
    el.classList.remove('quest-selected');
    activeQuestId = null;
    try { await cyberclaw.quests.setActive(null); } catch (e) { console.warn('[Quests] setActive(null) failed:', e?.message); }
  } else {
    el.classList.add('quest-selected');
    activeQuestId = questId;
    try { await cyberclaw.quests.setActive(questId); } catch (e) { console.warn('[Quests] setActive failed:', e?.message); }
    // v3.2.41: pre-warm the quest-instructions cache so the
    // first chat send after a quest switch sees the file
    // content. buildActiveQuestContext awaits the preheat
    // promise if it's still pending. The preheat kicks off
    // a single readQuestInstructions IPC; the next call
    // finds the cache already populated and doesn't
    // double-read. If a preheat from a previous quest
    // selection is still in-flight, cancel it (delete)
    // — stale data is worse than no data.
    const existing = questInstructionsPreheat.get(questId);
    if (!existing) {
      const preheat = cyberclaw.quests.readQuestInstructions(questId)
        .then((res) => {
          // Stash into the quest's cache. We don't have a
          // direct handle to the quest object here, but the
          // list is small and we'll find it in the next
          // renderQuests(); meanwhile, when the chat send
          // happens, buildActiveQuestContext looks it up
          // by quest.id on the quest object passed in.
          // The cleanest place to store the in-flight result
          // is the preheat map itself — buildActiveQuestContext
          // can await the preheat and then re-read the cache.
          // The store-on-cache happens INSIDE buildActiveQuestContext
          // after awaiting the preheat.
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

  // v3.2.30: invalidate the per-quest instructions-file cache so
  // the next chat send re-reads the file. (The cache is on
  // the quest object in buildActiveQuestContext, but the
  // quest reference is local to the function — we don't
  // have a stable handle here. Walk the cached promise
  // resolvers instead by clearing a module-level map. We
  // set quest._questInstructionsCache = {} per-call inside
  // buildActiveQuestContext, but that map persists across
  // calls because quest is a stable reference from the
  // cached list. So we just set it on every renderQuests.)
  for (const q of quests) q._questInstructionsCache = {};

  // v3.2.41: preheat the active quest's instructions-file
  // cache on every render. selectQuest() also preheats,
  // but renderQuests() fires on desktop restart, mobile
  // sync, and various save events — all of which might
  // be the first time the user opens the chat after
  // the active quest was set elsewhere. The preheat
  // is idempotent (a no-op if it's already pending).
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

  // Active first, then completed
  const sorted = [...quests].sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (a.status !== 'active' && b.status === 'active') return 1;
    return 0;
  });

  // v3.1.50: keep the in-memory activeQuestId in sync with the
  // list's source of truth (`active: true` on the quest). The
  // variable is also kept for the chat-context builder so it
  // doesn't have to scan the list on every message.
  activeQuestId = quests.find(q => q.active)?.id || null;

  for (const q of sorted) {
    const isComplete = q.status === 'completed';
    const isActive = !!q.active;
    const div = document.createElement('div');
    // v3.1.50: `quest-selected` is now driven by the quest's
    // `active` flag, not the local in-memory cache. The class
    // itself still applies the same visual (cyan border + orange
    // tint) — the v3.1.50 CSS changes add a thicker gold border
    // + ⭐ button + ACTIVE badge on top of that, so the marker
    // is impossible to miss.
    div.className = `quest-item ${isComplete ? 'completed-quest' : 'active-quest'} ${isActive ? 'quest-selected quest-is-active' : ''}`;
    div.onclick = () => selectQuest(div, q.id);
    const companionAvatars = ''; // Companion visuals are shown in the arena, not in the quest list

    // v3.1.50: ⭐ button toggles the active flag. Filled star
    // when active, outline when not. Tapping the button DOESN'T
    // propagate to the card's onclick (we stopPropagation in
    // the inline onclick). The button replaces the "tap the card"
    // flow that v3.1.50 is deprecating in favor of an explicit
    // affordance.
    const starBtn = `<button class="quest-star-btn ${isActive ? 'is-active' : ''}" onclick="event.stopPropagation(); selectQuest(this.closest('.quest-item'), '${q.id}')" title="${isActive ? 'Active quest — tap to deactivate' : 'Set as active quest'}">${isActive ? '⭐' : '☆'}</button>`;
    const activeBadge = isActive ? `<span class="quest-active-badge" title="This is the quest the companion is currently working on">⚡ ACTIVE</span>` : '';

    div.innerHTML = `
      <div class="quest-top-row">
        <div class="quest-name">${isComplete ? '✅' : '⚔️'} ${escapeHtml(q.name)}</div>
        <div class="quest-top-actions">
          ${activeBadge}
          ${starBtn}
          <button class="quest-edit-btn" onclick="openQuestEditor(event,'${q.id}')" title="Edit">✏️</button>
          <button class="quest-delete" onclick="deleteQuest(event,'${q.id}')" title="Delete">✕</button>
        </div>
      </div>
      ${q.description ? `<div class="quest-desc">${escapeHtml(q.description)}</div>` : ''}
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
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Load quests on startup
renderQuests();

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

  // v3.2.33: load the quest instructions content for this
  // quest so it can be edited inline in the quest editor.
  // The file path is <quest.directory>/QUEST_INSTRUCTIONS.md if
  // a directory is set, else
  // ~/.openclaw/cyberclaw/quests/<id>/QUEST_INSTRUCTIONS.md.
  // We render a monospace textarea (full width, 12 lines)
  // directly in the editor. Save writes the file via
  // cyberclaw.quests.saveQuestInstructions. Tobe's v3.10.98
  // feedback: "Add such a file creation and edit into the
  // quest editor. It should be deployed into the
  // project/quest directory for that quest." The file
  // path is shown below the textarea so the user can
  // verify it lives in the expected directory.
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

  // v3.1.95: skills field removed from quest model entirely.
  // Existing quests with `skills` in their JSON keep the field
  // for backward-compat but the editor no longer surfaces it
  // and the IPC payload no longer sets it. Goal completion
  // routes XP to the companion's global skills dict on the
  // desktop side via the existing companion-stats logic.

  // Update quest
  await cyberclaw.quests.update(editingQuestId, { name, description, goals, directory: directory || undefined });

  // v3.2.31: save the quest instructions file (if the editor has
  // a qe-quest-instructions textarea — older editor versions
  // don't, in which case skip). The save is fire-
  // and-forget; we close the editor regardless of
  // success/failure. A save error is logged to the
  // events panel.
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

// v3.2.33: per-quest instructions file editor. Opens a small
// modal with a textarea bound to the quest's QUEST_INSTRUCTIONS.md
// (default: <quest.directory>/QUEST_INSTRUCTIONS.md, or
// ~/.openclaw/cyberclaw/quests/<id>/QUEST_INSTRUCTIONS.md if no
// directory). The file content is injected into the chat
// prompt as a per-quest "behavior" context block, so the
// LLM sees project-specific instructions before generating
// a reply. Save writes the file and invalidates the cache
// in buildActiveQuestContext so the next chat send picks up
// the new content.
window.openQuestInstructionsEditor = async function(event, questId) {
  if (event) event.stopPropagation();
  const res = await cyberclaw.quests.readQuestInstructions(questId);
  if (!res || !res.ok) {
    addEventMsg(`⚠️ Could not read project instructions file: ${res?.error || 'unknown error'}`);
    return;
  }

  // v3.2.30: build the modal as an overlay in the
  // body (not the panel) so it sits on top of the
  // entire UI. The desktop's quest panel is in the
  // left column, but a textarea + save/cancel buttons
  // need a fair amount of vertical space — the overlay
  // model keeps it readable regardless of where the
  // user is.
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
    // Invalidate the in-memory cache so the next chat send
    // re-reads the file. We do this on the cached quest
    // object in buildActiveQuestContext; renderQuests()
    // also clears the cache, so the next renderQuests (on
    // any other quest change) will pick up fresh.
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

// Switch the chat pane to a specific companion. Re-renders that companion's
// history into the chat-messages container and updates the channel tabs.
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
  // Re-render the chat-messages container from the per-agent history
  const msgs = document.getElementById('chat-messages');
  if (msgs) {
    msgs.innerHTML = '';
    const hist = chatHistoryByAgent[agentId] || [];
    // Re-render in chronological order; suppress the last-separator cursor
    // so the first message after a switch gets a fresh separator.
    delete lastChatDateByAgent[agentId];
    for (const m of hist) {
      _renderStoredChatMsg(m, msgs, agentId);
    }
    msgs.scrollTop = msgs.scrollHeight;
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
  switch (m.type) {
    case 'user':
      div.innerHTML = `<span class="msg-prefix">[You]</span><span class="msg-text">${escHtml(m.text)}</span>`;
      break;
    case 'agent':
      // v3.1.21: the desktop now passes the resolved icon
      // (per-agent emoji → sprite catalog icon) to addChatMsg,
      // so m.emoji is set correctly here. Old messages persisted
      // before this version will fall back to 🤖.
      // v3.1.96: treat the desktop's default 🤖 the same as
      // "no emoji set" — show just [name] without the prefix
      // emoji. Otherwise the mobile's chat history (which was
      // broadcast earlier) shows a stray robot next to every
      // message from agents without an explicit emoji.
      div.innerHTML = `<span class="msg-prefix">${(m.emoji && m.emoji !== '🤖') ? m.emoji + ' ' : ''}[${escHtml(m.name)}]</span><span class="msg-text">${escHtml(m.text)}</span>`;
      break;
    case 'typing':
      div.innerHTML = `<span class="msg-text" style="color:var(--text-muted);font-style:italic">${escHtml(m.text)}</span>`;
      break;
    case 'error':
      div.innerHTML = `<span class="msg-text" style="color:var(--red)">${escHtml(m.text)}</span>`;
      break;
  }
  container.appendChild(div);
}

function updateChatHeader(agentId) {
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
      // v3.1.21: prefer per-agent emoji, fall back to sprite icon
      // from the catalog so the avatar matches the sprite.
      // v3.10.65: strip the desktop's default 🤖 before falling
      // back — agents without an explicit emoji would otherwise
      // show a robot in the chat header instead of their
      // companion sprite.
      headerAvatar.innerHTML = (agent.emoji && agent.emoji !== '🤖') ? agent.emoji : (getSpriteIcon(agent._pixelCompanionId) || '🤖');
    }
  }
  if (headerStatus) {
    const sleeping = agent.sleepState === 'sleeping';
    headerStatus.textContent = sleeping ? '💤 sleeping' : 'online';
    headerStatus.className = 'chat-header-status ' + (sleeping ? 'sleeping' : 'online');
  }
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
    // v3.1.26: chat tab uses the sprite icon SVG (Twemoji-style)
    // when available — guaranteed colorful, smooth, consistent
    // across platforms. Falls back to per-agent emoji text, then
    // to 🤖. The avatar PNG is no longer used here (it was removed
    // in v3.1.23 because at chat-tab size the 32x32 pixel-art PNG
    // didn't read well).
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
      // v3.10.65: strip the desktop's default 🤖 before falling
      // back to the sprite icon — same fix as the chat header
      // avatar. Without this, channel tabs for agents without an
      // explicit emoji show a robot instead of their companion
      // sprite.
      em.textContent = (agent.emoji && agent.emoji !== '🤖') ? agent.emoji : (getSpriteIcon(agent._pixelCompanionId) || '🤖');
      tab.appendChild(em);
    }
    const name = document.createElement('span');
    name.className = 'companion-tab-name';
    name.textContent = agent.name;
    tab.appendChild(name);
    if (id === activeChatAgentId) tab.classList.add('active');
    if (lastReadTsByAgent[id] && (chatHistoryByAgent[id] || []).some(m => m.ts > (lastReadTsByAgent[id] || 0))) {
      tab.classList.add('has-unread');
    }
    container.appendChild(tab);
  }
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
// v3.2.45: per-agent send queue. chatBusy was a single
// boolean, which meant if the user sent message A and then
// message B before A's LLM call finished, the B call would
// wait for chatBusy to clear, but once cleared B's IPC
// would run in parallel with A's. Two openclaw-agent
// processes sharing the same session log = lost replies.
// Tobe 2026-08-02 18:49: 'I have to ask whether its done
// or not, then he tells me he has done them and asks if I
// have not seen hes replies.' The lie was real: the agent
// HAD done the work in the first call, the second call's
// LLM saw the prior tool calls in the shared session log
// and answered "yeah I finished" — but the user never saw
// the first call's actual reply, only the second call's
// meta-reply.
//
// The fix: per-agent promise chain. Each call awaits the
// previous call's promise, so calls are strictly
// serialized per agent. The user sees one reply per
// message they sent, in order.
const chatSendChain = new Map(); // agentId -> Promise

function updateChatTarget() {
  // chat-target element was removed — no-op
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

  // v3.2.21: always inject the quest-tools hint so the agent
  // knows it can CREATE_QUEST from the chat reply, regardless
  // of whether there's an active quest. See buildQuestToolsHint
  // for the full rationale.
  fullMessage = buildQuestToolsHint() + fullMessage;

  // Add quest context if active. v3.1.50: use the new
  // buildActiveQuestContext helper which adds goals + recent
  // changes to the context, so the LLM has memory of what it
  // did on this quest and what's left to do.
  if (activeQuestId) {
    const quests = await cyberclaw.quests.list();
    const q = quests.find(q => q.id === activeQuestId);
    if (q) {
      fullMessage = await buildActiveQuestContext(q) + fullMessage;
    }
  }

  // Show typing indicator
  chatBusy = true;
  document.getElementById('chat-send').disabled = true;
  const typingId = addChatMsg('typing', `${agent.name} is thinking...`);

  // v3.2.28: escalate the typing indicator so the user
  // has a visible signal that the request is still
  // being processed during long model retries. The
  // openclaw agent internally retries on transient
  // failures (model timeout → 2min cooldown → retry),
  // and the user used to see "is thinking..." for the
  // entire retry window (could be 15+ minutes if the
  // model is misbehaving). Tobe's v3.10.96 feedback:
  // "And it still just says clawsuu is thinking, not
  // executing etc." Now we step through messages at
  // 8s, 20s, 45s, and 90s so the user sees progress.
  // The timers are cleared on the result/catch so the
  // escalation can't continue past the response.
  const escalationTimers = [];
  const escalateTyping = (text) => {
    // Find the typing message's text span and update
    // it in place. addChatMsg sets the div's `id` to
    // `chat-msg-{N}` where N is the typed return value
    // (we capture that as `typingId`). We then select by
    // that id and update the .msg-text child's text.
    //
    // v3.2.29 fix: previous code (v3.2.28) used
    // `[data-msg-id="${typingId}"]`, but addChatMsg sets
    // the div's `id` attribute, not a data-* attribute.
    // The selector matched nothing and the escalation
    // silently failed — the typing message stayed at
    // "is thinking..." for the full request duration.
    // Tobe's v3.10.97 feedback: "It still only says
    // thinking." Now we use the correct id selector.
    const el = document.getElementById(typingId);
    if (el) {
      const textSpan = el.querySelector('.msg-text');
      if (textSpan) textSpan.textContent = text;
      // v3.2.30: debug log so we can see in the desktop
      // log whether the escalation actually fired when
      // Tobe reports it isn't. Without this, "I see
      // 'is thinking' for 2 minutes" is impossible to
      // distinguish from "the timers fired but the
      // text update missed" vs "the message div was
      // removed by a tab switch".
      console.log(`[typing-escalate] ${typingId} -> "${text}" (div=${!!el}, span=${!!textSpan})`);
    } else {
      // v3.2.30: the div isn't in the DOM. Either the
      // message was already removed (response arrived
      // early), the user switched tabs (the active
      // agent's chat was re-rendered and the typing
      // div was dropped), or the typing was skipped
      // because the agent's channel isn't the active
      // one. Log so we can tell from the log.
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
    // v3.2.28: cap the openclaw agent call at 2 minutes
    // on the desktop side too. The openclaw CLI internally
    // retries with a 2min cooldown each — if the model
    // is misbehaving, the user used to wait 15-20min
    // before getting any signal. The desktop's exec
    // timeout is already 120s but the openclaw agent
    // stays alive across internal retries, so the
    // timeout never fires. Promise.race with a
    // setTimeout-rejected promise caps the total wait
    // here. On cap, we surface "the request is taking
    // too long, but you can wait or cancel" and the
    // openclaw agent keeps running in the background.
    let capHandle;
    const capPromise = new Promise((_, reject) => {
      capHandle = setTimeout(() => reject(new Error('Request timed out after 2 minutes')), 120000);
    });
    let result;
    try {
      result = await Promise.race([
        cyberclaw.chat.sendMessage(mainAgentId, fullMessage),
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
      // v3.1.21: pass the resolved icon (per-agent emoji → sprite
      // catalog icon) so the message prefix shows the right emoji
      // even if the user hasn't set a custom emoji on the agent.
      // v3.1.96: strip the desktop's 🤖 default so the mobile's
      // chat history doesn't get a stray robot next to every
      // message from agents without an explicit emoji.
      addChatMsg('agent', stripQuestTags(result.reply), leader?.name || 'Companion', leader?.emoji === '🤖' ? null : (leader?.emoji || getSpriteIcon(leader?._pixelCompanionId)));

      // Check for quest commands in the reply. v3.1.50: the agent
// can read + edit quests via structured-output tags. Three new
// commands: [QUEST_SET_ACTIVE: id="..."] (switch the working
// quest), [QUEST_APPEND_CHANGE: text="..."] (log a change to
// the active quest's journal), [QUEST_MARK_GOAL: index="N" done="true|false"]
// (toggle a goal on the active quest). All commands act on the
// currently-active quest EXCEPT set_active, which carries its
// own id. We use i (case-insensitive) so the LLM has a bit of
// flexibility in how it emits the tags.
      if (result.reply) {
        // [QUEST_SET_ACTIVE: id="abc123"] — switch the active
        // quest. The LLM emits this when the user starts a
        // conversation about a different project. We require an
        // id; if the LLM passes the quest name instead, we try
        // to resolve it as a fallback.
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
              activeQuestId = found.id;
              addChatMsg('system', `⚡ Active quest set to "${found.name}"`);
              renderQuests();
            } else {
              addChatMsg('system', `⚠️ No quest matching "${targetId}" to set active`);
            }
          } catch (e) {
            addChatMsg('system', '⚠️ Failed to set active quest: ' + e.message);
          }
        }
        // [QUEST_APPEND_CHANGE: text="..."] — append to the
        // active quest's latestChanges journal. The LLM uses
        // this after a meaningful step (e.g. "set up DNS A
        // record") so future turns have a memory of what it
        // did on this quest. No-op if there's no active quest.
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
        // [QUEST_NOTE: text="..."] — append a timestamped
        // markdown note to the ACTIVE quest's
        // QUEST_QUEST_INSTRUCTIONS.md (the same file the
        // quest editor shows under "Quest instructions").
        // The companion uses this to leave notes for itself
        // (SSH paths, deploy commands, "don't touch this
        // file", etc.) so future turns AND future sessions
        // have a memory of project-specific knowledge.
        // Tobe's 2026-08-02 15:45 ask: "as it works within
        // the quests it should leave notes for itself, and
        // update key info in the quest instructions for
        // itself, how to do things etc."
        //
        // The IPC handler appends under a "## Companion
        // notes" section. We invalidate the in-memory
        // cache here so the next chat send sees the new
        // note in the context block.
        const noteMatch = result.reply.match(/\[QUEST_NOTE:\s*text="([^"]+)"\]/i);
        if (noteMatch) {
          if (activeQuestId) {
            try {
              const res = await cyberclaw.quests.appendQuestInstructions(activeQuestId, noteMatch[1]);
              if (res && res.ok) {
                // Invalidate the cache so the next chat
                // send sees the new note. We do this by
                // clearing the cache on the quest object
                // — the next renderQuests() call will
                // also clear it (it does on every
                // render). The cache map is keyed by
                // quest id, so we just delete the entry.
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
        // [QUEST_MARK_GOAL: index="N" done="true"] — toggle a
        // goal's completed flag by 0-based index on the active
        // quest. The LLM emits this when it finishes a step
        // it had previously broken out as a goal.
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
        const drain = len < 200 ? -2 : len < 500 ? -4 : len < 1000 ? -6 : -10;
        window.adjustHappiness(drain);
      }

      // Award XP to the best-matching companion based on task type
      const taskSkill = result.taskSkill;
      if (taskSkill) {
        const xpAmount = 10 + Math.floor(Math.random() * 10);
        // Find companion with this focus, or fall back to party leader
        const specialist = agentOrder.find(id => {
          const a = agents[id];
          return a?.focusSkills?.includes(taskSkill);
        });
        const xpTarget = specialist || mainAgentId;
        await cyberclaw.agents.addXP(xpTarget, taskSkill, xpAmount);
        const xpAgent = agents[xpTarget];
        if (xpAgent) {
          addChatMsg('system', `⚔️ ${xpAgent.name} gained +${xpAmount} ${taskSkill} XP`);
        }
      }
    } else {
      addChatMsg('error', `Error: ${result.error || 'Failed to get response'}`);
    }
  } catch (err) {
    clearEscalation();
    removeChatMsg(typingId);
    addChatMsg('error', `Error: ${err.message}`);
  }

  chatBusy = false;
  document.getElementById('chat-send').disabled = false;
  input.focus();
};

/**
 * Send a chat message programmatically (used by mobile sync, voice, etc.)
 * Unlike sendChat() which reads from the DOM input, this takes text directly.
 *
 * v3.2.45: serialize per agent via chatSendChain. Without
 * this, two messages sent in quick succession would each
 * run their own openclaw-agent process in parallel, sharing
 * one session log. The first process's final assistant text
 * was never broadcast — only the second process's reply
 * (which always lied "yeah I already did that" because it
 * saw the first's tool calls in the log) was visible. Tobe
 * 2026-08-02 18:49.
 *
 * The wrapper awaits the previous call's chain promise for
 * this agent before starting its own work. Different agents
 * can still run in parallel.
 */
window.sendChatMessage = async function(message) {
  // Resolve the chain key without running any IPC. We use
  // the same selection logic as the body (agentOrder[focusIndex]
  // → first agent → null) but without side effects. If we
  // pre-pick wrong and the body later picks a different
  // agent, the worst case is that the wait is wrong by one
  // turn (the call still runs; just not serialized with
  // the right prior call). For Tobe's case (one active
  // agent) this is fine.
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
  // Now the queued body runs. Wrap the original function
  // body in a try/finally so the chain promise always
  // resolves, even on error.
  try {
    await __sendChatMessageImpl(message);
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

const __sendChatMessageImpl = async function(message) {
  window.addDesktopLog?.('📨', 'sendChatMessage called', `busy=${chatBusy} agents=${agentOrder.length} msg="${(message||'').substring(0,40)}"`, 'info');
  if (!message) return;
  // Wake companion if sleeping
  nudgeNightWake();
  // v3.10.3: ALSO explicitly flip sleepState from 'sleeping'
  // to 'awake' for the active companion. sendChat() does this
  // for DOM-typed input; sendChatMessage() (the IPC caller
  // from the mobile and the voice_transcript handler) needs
  // the same handling. Without it, the user can chat with a
  // sleeping companion and the reply lands fine, but the
  // sprite stays in 'death' pose until something else nudges
  // the night-wake timer — looks broken from the user's POV.
  // Mirror the same logic as sendChat() exactly so behavior
  // is consistent regardless of who initiates the message.
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
    // v3.2.36: also surface this in the desktop log so the
    // user can see when a message is being held up. The
    // mobile user often sees "clawsuu not answering" with
    // no clue that the previous request is still in
    // flight. The reasoning was the same in v3.2.28 (the
    // 2-min cap) — make the wait visible.
    window.addDesktopLog?.('⏳', 'Waiting for previous AI reply', message.substring(0, 60), 'warn');
    // v3.2.45: bumped 15s → 90s. The previous 15s cap was
    // a UX safety net for hung requests, but the actual
    // IPC timeout in main.js is 90s. A complex tool-use
    // task (like "edit 7 files" — Tobe's 2026-08-02 18:49
    // "make hive control look cyber" request) can easily
    // take 30-60s. Cutting it off at 15s and force-resetting
    // chatBusy let the second user message ("Hello?")
    // interrupt the first, which fired a SECOND
    // openclaw-agent process. The first process's reply
    // (or lack thereof) was effectively lost — the user
    // only saw the second process's reply, which (because
    // it shared the same session log) was a lie ("yeah I
    // finished the cleanup") even though the work WAS
    // done, just never reported.
    //
    // The right cap is the IPC's own 90s. If the first
    // process doesn't return within 90s, the IPC will
    // also time out and clean up. We mirror that. The
    // hard ceiling is 95s to give the IPC a few seconds
    // to clean up before we declare it stuck.
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

  // v3.2.21: always inject the quest-tools hint. See
  // buildQuestToolsHint for the full rationale. Mirror of the
  // sendChat() injection above so voice/mobile/typed paths
  // all see the available quest tags.
  fullMessage = buildQuestToolsHint() + fullMessage;

  // Add quest context if active
  if (activeQuestId) {
    try {
      // v3.2.36: cap the quest-list IPC at 3s. Tobe hit
      // "Why wont you answer?" on 2026-07-29 — the log
      // showed the message reached `sendChatMessage`,
      // reached the chatBusy queue, was force-reset, but
      // then no `AI thinking` log ever appeared. The most
      // likely culprit is the IPC `cyberclaw.quests.list()`
      // hanging: the `await` blocks indefinitely if the
      // renderer is wedged, and the existing `try/catch`
      // only catches throws, not hangs. With a 3s timeout
      // we either get the data or we proceed without it,
      // and the chat reply goes through either way.
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
  // v3.2.36: log here so the user can see the message
  // actually reached the agent-call stage. Pre-this log,
  // a hang in `cyberclaw.quests.list()` (line ~2540) would
  // look identical to a hang in the openclaw agent call
  // itself, because no log line appeared between the
  // chatBusy reset and the agent response. With both
  // stage markers visible, future "why wont you answer"
  // reports can pinpoint which stage is stuck.
  window.addDesktopLog?.('🧠', 'AI thinking', message.substring(0, 60), 'voice');
  console.log('[sendChatMessage] dispatching to agent, mainAgentId:', mainAgentId);
  const typingId = addChatMsg('typing', `${agent.name} is thinking...`);
  try { ipcRenderer.invoke('sync-broadcast-typing', { active: true }); } catch {}

  // v3.2.37: typed inputs sometimes left the "thinking..."
  // bubble stuck on the user's screen when the openclaw
  // call hung or was abandoned. With `try { ... } catch`,
  // only thrown errors trigger the cleanup path. A silent
  // hang / abandoned promise / unexpected code path would
  // leave the typing indicator showing forever. The
  // `finally` block makes the cleanup unconditional; the
  // additional 110-second `setTimeout` is the
  // failsafe-in-failsafe for the case where even the
  // `finally` doesn't run (e.g. the renderer's JS thread
  // is wedged — at that point the indicator is the least
  // of our problems, but we don't want a permanently-
  // stuck "thinking" bubble in recovered state).
  //
  // v3.2.37 also caps the agent call itself with a
  // Promise.race against an explicit timeout,
  // so even if the openclaw process is genuinely wedged
  // (e.g. waiting on a model that's hung server-side),
  // the renderer returns from the await within a bounded
  // time and the cleanup runs. The desktop logs the
  // timeout as a warning so the user can see "openclaw
  // took > N s, please retry" instead of a silent hang.
  //
  // v3.2.46: bumped 90s → 180s. Tobe hit a 90s timeout on
  // 2026-08-02 20:16 with a 7-file edit task. The openclaw
  // process was clearly making progress (20+ tool calls
  // visible in SessionTail), it just hadn't finished yet.
  // The IPC killed the process at 90s, the result came back
  // ok:false with the timeout error, and the error message
  // only went to the renderer's chat — the mobile's
  // typing bubble just vanished, leaving Tobe with no
  // signal of what happened. The error message is now also
  // broadcast to the mobile (v3.2.46 broadcast fix), but
  // 180s gives complex multi-step tasks a fair shot at
  // completing without being killed mid-edit.
  const AGENT_TIMEOUT_MS = 180000; // 180s
  const typingFailsafe = setTimeout(() => {
    console.warn('[sendChatMessage] typing bubble > 110s, force-clearing');
    window.addDesktopLog?.('⚠️', 'AI still thinking after 110s — clearing indicator', message.substring(0, 60), 'warn');
    try { removeChatMsg(typingId); } catch {}
    try { ipcRenderer.invoke('sync-broadcast-typing', { active: false }); } catch {}
  }, 110000);

  try {
    let result;
    try {
      result = await Promise.race([
        cyberclaw.chat.sendMessage(mainAgentId, fullMessage),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('agent call timed out after 90s')), AGENT_TIMEOUT_MS)
        ),
      ]);
    } catch (timeoutErr) {
      // Surface the timeout as an error message in the chat
      // and let the user retry. Without this the user just
      // sees the typing bubble forever.
      window.addDesktopLog?.('⏱️', 'Agent call > 90s, aborted', message.substring(0, 60), 'warn');
      throw timeoutErr;
    }
    removeChatMsg(typingId);
    try { ipcRenderer.invoke('sync-broadcast-typing', { active: false }); } catch {}

    if (result.ok) {
      const leader = agents[mainAgentId];
      // v3.1.96: see sibling site — strip the desktop's 🤖
      // default before sending.
      addChatMsg('agent', stripQuestTags(result.reply), leader?.name || 'Companion', leader?.emoji === '🤖' ? null : (leader?.emoji || getSpriteIcon(leader?._pixelCompanionId)));
      window.addDesktopLog?.('💬', 'AI responded', stripQuestTags(result.reply).substring(0, 60), 'success');
      // Notify main process for mobile TTS response
      try { ipcRenderer.send('mobile-tts-response', { text: stripQuestTags(result.reply) }); } catch {}
    } else {
      addChatMsg('error', `Error: ${result.error || 'Failed to get response'}`);
    }
  } catch (err) {
    addChatMsg('error', `Error: ${err.message}`);
  } finally {
    // v3.2.37: clear the typing bubble + chatBusy flag
    // unconditionally. Before this, a hung openclaw call
    // left "still thinking" stuck on the user's mobile +
    // desktop, and chatBusy=true meant the next message
    // got queued for up to 15s before being force-reset.
    clearTimeout(typingFailsafe);
    try { removeChatMsg(typingId); } catch {}
    try { ipcRenderer.invoke('sync-broadcast-typing', { active: false }); } catch {}
    chatBusy = false;
  }
};

let chatMsgId = 0;
let chatHistory = []; // Backwards-compat flat history (also kept in sync for mobile)
// Each companion has its own chat history. Keys are agent ids. The view shows
// only the active companion's messages. We also keep the flat `chatHistory`
// mirror in sync for mobile sync.
let chatHistoryByAgent = {};
let activeChatAgentId = null;
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

// v3.1.17: debounced persist for chatHistoryByAgent. Writes the
// whole Record to localStorage on every change, but throttles to
// once per 2s to avoid hammering storage on rapid messages.
let _persistChatHistoryTimer = null;
function schedulePersistChatHistory() {
  if (_persistChatHistoryTimer) return;
  _persistChatHistoryTimer = setTimeout(() => {
    _persistChatHistoryTimer = null;
    try {
      localStorage.setItem('cyberclaw-chat-byagent', JSON.stringify(chatHistoryByAgent));
    } catch (e) {
      console.warn('[Persist] Failed to write chat-byagent:', e.message);
    }
  }, 2000);
}

// v3.1.17: restore chatHistoryByAgent from localStorage on app
// start. Without this, the in-memory history is wiped on every
// desktop restart, which leaves the mobile companion tab bar
// showing empty chats until the user has a fresh conversation.
function restoreChatHistory() {
  try {
    const raw = localStorage.getItem('cyberclaw-chat-byagent');
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      // v3.10.65: one-shot migration — rewrite any legacy
      // `emoji: '🤖'` entries to the resolved sprite icon (or
      // null) so the chat message prefix shows the companion
      // sprite instead of the desktop's default robot. Older
      // histories were persisted before the v3.1.96 strip
      // pattern was applied at the render site, so the messages
      // showed no prefix at all. After this migration they'll
      // show the sprite icon — matching what new messages
      // already do via the same strip pattern at addChatMsg
      // call sites.
      let migrated = 0;
      for (const [agentId, msgs] of Object.entries(parsed)) {
        if (!Array.isArray(msgs)) continue;
        const agent = agents[agentId];
        const fallbackIcon = (agent && agent.emoji && agent.emoji !== '🤖')
          ? agent.emoji
          : getSpriteIcon(agent && agent._pixelCompanionId);
        for (const m of msgs) {
          if (m && m.emoji === '🤖') {
            m.emoji = fallbackIcon || null;
            migrated++;
          }
        }
      }
      if (migrated > 0) {
        console.log(`[Restore] Migrated ${migrated} legacy 🤖 emoji(s) in chat history to sprite icons`);
      }
      chatHistoryByAgent = parsed;
      // Also rebuild the flat `chatHistory` mirror in chronological
      // order (oldest first) so the legacy code that reads from it
      // still works after a restart.
      chatHistory = [];
      for (const [, msgs] of Object.entries(parsed)) {
        if (Array.isArray(msgs)) chatHistory.push(...msgs);
      }
      chatHistory.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      if (chatHistory.length > 100) chatHistory = chatHistory.slice(-100);
      console.log(`[Restore] Loaded ${Object.keys(parsed).length} agent chat histories from localStorage`);
    }
  } catch (e) {
    console.warn('[Restore] Failed to load chat-byagent:', e.message);
  }
}

function addChatMsg(type, text, name, emoji) {
  // System messages go to the Events tab
  if (type === 'system') {
    return addEventMsg(text);
  }

  // Resolve the agent id for per-companion bucketing
  const agentId = agentIdForName(name) || activeChatAgentId || (agentOrder[focusIndex]) || null;

  // Keep in-memory chat history for mobile sync
  if (type === 'agent' || type === 'user') {
    chatHistory.push({
      text: text,
      isUser: type === 'user',
      agentId: name || 'companion',
      ts: Date.now()
    });
    // Keep only last 100 messages
    if (chatHistory.length > 100) {
      chatHistory = chatHistory.slice(-100);
    }
    // Per-companion history
    if (agentId) {
      if (!chatHistoryByAgent[agentId]) chatHistoryByAgent[agentId] = [];
      chatHistoryByAgent[agentId].push({ type, text, name, emoji, ts: Date.now() });
      if (chatHistoryByAgent[agentId].length > 200) {
        chatHistoryByAgent[agentId] = chatHistoryByAgent[agentId].slice(-200);
      }
    }

    // v3.1.17: persist per-companion chat history to localStorage
    // so it survives a desktop restart. The mobile companion app
    // also persists its own copy (cyberclaw-chat-byagent) so this
    // is belt-and-braces — the desktop copy is the source of
    // truth for the on-screen chat, the mobile copy is the
    // source of truth for the tab-switch UX. Debounced to
    // avoid hammering storage on every keystroke.
    schedulePersistChatHistory();
  }

  // Broadcast to mobile companion app
  // v3.2.46: also broadcast error messages. Previously only
  // 'agent' and 'user' messages went to the mobile, so an
  // IPC timeout or other failure left the mobile with the
  // typing bubble and no follow-up — the user thought the
  // agent went silent. Tobe 2026-08-02 20:16: 'It appeared
  // for a few seconds then its gone. He cant possibly
  // have done the task so fast.' The agent hadn't done
  // anything — the IPC had timed out and the error message
  // only went to the renderer's chat, not the mobile.
  if (type === 'agent' || type === 'user' || type === 'error') {
    try {
      const { ipcRenderer } = require('electron');
      // v3.1.15: send the resolved agentId (not just the display name)
      // plus the display name separately, so the mobile can label chat
      // messages correctly when multiple companions are present.
      ipcRenderer.invoke('sync-broadcast-chat', {
        agentId: agentId || name || 'companion',
        agentName: name || null,
        text: text,
        isUser: type === 'user'
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

  const msgs = document.getElementById('chat-messages');
  if (!msgs) return null;
  const now = new Date();
  const cursor = (agentId && lastChatDateByAgent[agentId]) || null;
  lastChatDateByAgent[agentId || '_'] = checkDateSeparator(cursor, now, msgs);
  const div = document.createElement('div');
  const id = `chat-msg-${++chatMsgId}`;
  div.id = id;
  div.className = `chat-msg ${type}`;

  switch (type) {
    case 'user':
      div.innerHTML = `<span class="msg-prefix">[You]</span><span class="msg-text">${escHtml(text)}</span>`;
      break;
    case 'agent':
      // v3.1.96: same fix as the other render site — don't
      // show the prefix emoji if it's the desktop's 🤖 default.
      // Show just [name] in that case (matches the user-style
      // prefix shape).
      div.innerHTML = `<span class="msg-prefix">${(emoji && emoji !== '🤖') ? emoji + ' ' : ''}[${escHtml(name)}]</span><span class="msg-text">${escHtml(text)}</span>`;
      break;
    case 'typing':
      div.innerHTML = `<span class="msg-text" style="color:var(--text-muted);font-style:italic">${escHtml(text)}</span>`;
      break;
    case 'error':
      div.innerHTML = `<span class="msg-text" style="color:var(--red)">${escHtml(text)}</span>`;
      break;
  }

  // v3.2.47: right-click → Copy menu on chat messages. The
  // CSS user-select: text fix is the primary path for
  // drag-to-select; this is the bulletproof fallback (and
  // also lets the user copy without having to drag-select
  // precisely). Tobe 2026-08-02 20:27: 'I noticed that i
  // cannot Click the messages, as in mark and copy etc,
  // fix so i can do that.'
  //
  // The handler reads the visible text (no HTML markup),
  // strips the [prefix] tag, and writes it to the system
  // clipboard via the Electron clipboard module (exposed
  // in preload.js). The text-extraction function also lives
  // below as `getChatMessageText` so other call sites can
  // reuse it.
  //
  // We also store the text on the div via a data attribute
  // so future right-click menu items (e.g. "Copy as quote",
  // "Copy with timestamp") can read it without re-parsing
  // the DOM.
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
      // The resizer sits at the TOP of the input area. When the user drags
      // DOWN by +delta, the resizer should follow the mouse down (so its
      // Y position on screen increases), which means the input area must
      // get TALLER. Conversely, dragging up should make it shorter.
      // In the flex column, taller input = resizer moves up on screen.
      // So the sign is INVERTED vs. a typical bottom-edge resize handle.
      const delta = e.clientY - startY;
      let newH = Math.max(MIN_INPUT, Math.min(MAX_INPUT, startH - delta));
      inputArea.style.flexBasis = newH + 'px';
      inputArea.style.flexGrow = '0';
      inputArea.style.flexShrink = '0';
      // Auto-grow textarea as the input area grows
      const textarea = document.getElementById('chat-input');
      if (textarea) {
        const maxTA = Math.max(60, newH - 24); // room for padding/image-preview
        textarea.style.maxHeight = maxTA + 'px';
      }
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
          // v3.1.96: strip the desktop's 🤖 default before sending.
          if (agent) addChatMsg('agent', msg, agent.name, agent.emoji === '🤖' ? null : (agent.emoji || getSpriteIcon(agent._pixelCompanionId)));
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

  bootMsgs.forEach(({ d, t }) => {
    setTimeout(() => {
      const div = document.createElement('div');
      div.className = 'chat-msg system';
      div.innerHTML = `<span class="msg-text">${t}</span>`;
      msgs.appendChild(div);
      msgs.scrollTop = msgs.scrollHeight;
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

// Open the forge pre-configured for a brand-new companion. This is a true
// "create" — saving will register a new agent in the openclaw config
// (under `agents.list`) AND create the corresponding sprite/avatar data,
// then reload the agent list so the new companion appears in the carousel
// and the arena.
//
// The save flow is patched with a guard requiring both a sprite and a name.
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
  // Reset model selections to defaults
  refreshForgeModelDropdowns().catch(() => {});
  const modelEl = document.getElementById('forge-model-primary');
  if (modelEl) modelEl.value = baseline.primaryModel || 'anthropic/claude-opus-4-6';
  const modelEl2 = document.getElementById('forge-model-secondary');
  if (modelEl2) modelEl2.value = '';

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
    const primaryModel = document.getElementById('forge-model-primary')?.value || baseline.primaryModel || 'anthropic/claude-opus-4-6';
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

  document.getElementById('companion-editor-overlay').classList.remove('hidden');
  addChatMsg('system', '✨ Pick a sprite and name your new companion. It will be added to your openclaw agents.');
};

// ── COMPANION FORGE ─────────────────────────────────────────
let forgeCompanionSprite = null;

// Forge sprite size — stored per-companion on the sprite config. Default 4.
let currentForgeScale = 4;

// v3.2.26: chattiness scale (1–5). Default 3 = current 60–90
// min. The idle chatter scheduler reads this from the
// companion's stored sprite config on every tick (cheap lookup)
// so changes apply on the next schedule after save.
let currentForgeChattiness = 3;

// 1=Silent, 2=Quiet, 3=Balanced, 4=Chatty, 5=Very chatty
const CHATTINESS_DESCRIPTIONS = {
  1: 'Silent — never randomly comments.',
  2: 'Quiet — comments every 3–6 hours.',
  3: 'Balanced — comments every 60–90 minutes.',
  4: 'Chatty — comments every 30–60 minutes.',
  5: 'Very chatty — comments every 15–30 minutes.',
};

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
  // v3.1.6: don't write to the sprite config here — the value is
  // captured in currentForgeScale and saved by saveCompanion together
  // with the rest of the form. (Previously we'd write the scale
  // immediately, but that raced with the final saveCompanion write
  // and the user-visible bug was that the size "didn't stick".)
}

// v3.2.26: live chattiness slider update. Same pattern as
// updateForgeSize — update local state + the label, defer the
// write to saveCompanion. The label text is mirrored from the
// CHATTINESS_DESCRIPTIONS table so the user sees the human
// translation of the number.
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

  // Refresh the model dropdowns to include any custom providers the user added
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
    // Load saved traits
    const savedTraits = config?.traits || [];
    document.querySelectorAll('#forge-traits-grid input[type=checkbox]').forEach(function(cb) {
      cb.checked = savedTraits.includes(cb.id.replace('trait-', ''));
    });
    // Load models — prefer saved config, fall back to agent's stored model
    const modelEl = document.getElementById('forge-model-primary');
    if (modelEl) {
      const desired = (config && config.primaryModel) || agent.primaryModel || 'anthropic/claude-opus-4-6';
      // If the saved value isn't a current option (e.g. the provider was deleted),
      // keep it as a custom option so the user can see what's configured.
      if (![...modelEl.options].some(o => o.value === desired)) {
        const opt = document.createElement('option');
        opt.value = desired; opt.textContent = desired + ' (custom / missing)'; opt.selected = true;
        modelEl.insertBefore(opt, modelEl.firstChild);
      } else {
        modelEl.value = desired;
      }
    }
    const modelEl2 = document.getElementById('forge-model-secondary');
    if (modelEl2) modelEl2.value = agent.secondaryModel || '';
  });

  // v3.2.32: load soul.md + memory.md into the editor and viewer.
  // The soul is the character definition injected into every chat
  // turn. The memory is auto-written by the companion, read-only here.
  loadCompanionSoulEditor(agentId);
  loadCompanionMemoryViewer(agentId);

  document.getElementById('companion-editor-overlay').classList.remove('hidden');
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
    presetSel.value = 'custom'; // don't auto-select a preset
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
  if (bytes === 0) {
    status.textContent = 'Empty';
    status.style.color = '';
  } else if (bytes > 8192) {
    status.textContent = bytes + ' bytes — OVER 8KB LIMIT (save disabled)';
    status.style.color = '#ff8080';
  } else if (bytes > 4096) {
    status.textContent = bytes + ' bytes — large, will warn on save';
    status.style.color = '#ffb060';
  } else {
    status.textContent = bytes + ' bytes';
    status.style.color = '';
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
      primaryModel: document.getElementById('forge-model-primary')?.value || agent.primaryModel,
      secondaryModel: document.getElementById('forge-model-secondary')?.value || '',
      scale: currentForgeScale, // v3.1.6: persist the size slider value
      chattiness: currentForgeChattiness, // v3.2.26: persist the chattiness slider value
    });
    // v3.2.32: persist the soul.md alongside the sprite config.
    // Soul failures don't block the rest of the save — we warn
    // but continue. (Bad soul = bad character, but the user can
    // edit it later. A 5KB+ save failure shouldn't kill the
    // avatar/name/etc. updates.)
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
      // v3.1.33: actually persist the model choice to
      // openclaw.json so the runtime picks it up next
      // session. Pre-v3.1.33, the model was stored in
      // agent.spriteConfig but never propagated to
      // openclaw.json's agents.list[i].model.primary.
      // Result: every companion silently used the
      // global default regardless of the forge picker.
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
    // v3.1.20: re-broadcast the agents list to the mobile so
    // changes (sprite id, scale, name, emoji) appear
    // immediately. Without this, the mobile wouldn't see
    // the new size until the next 60s periodic sync.
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

// v3.2.1: removed dead legacy provider-key fields (keyAnthropic, keyOpenai,
// keyGoogle, ollamaUrl). These were orphaned when the new provider manager
// landed; nothing in the codebase reads them anymore. They were being
// silently re-saved on every saveSettings() call, perpetuating dead state.
// One-time migration below strips them from any persisted saved blob.
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

// v3.2.1: shared well-known-model catalog. Was duplicated inline in
// refreshDefaultModelDropdown() and refreshForgeModelDropdowns() with
// subtle drift (forge omitted the Ollama entry). Both call sites now
// derive their options from this single list.
const WELL_KNOWN_MODELS = [
  { provider: 'Anthropic',  model: 'anthropic/claude-opus-4-6',   label: 'Claude Opus 4' },
  { provider: 'Anthropic',  model: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4' },
  { provider: 'Anthropic',  model: 'anthropic/claude-haiku-3.5',  label: 'Claude Haiku 3.5' },
  { provider: 'OpenAI',     model: 'openai/gpt-4o',              label: 'GPT-4o' },
  { provider: 'OpenAI',     model: 'openai/gpt-4o-mini',         label: 'GPT-4o Mini' },
  { provider: 'Google',     model: 'google/gemini-2.5-pro',      label: 'Gemini 2.5 Pro' },
  { provider: 'Google',     model: 'google/gemini-2.5-flash',    label: 'Gemini 2.5 Flash' },
  { provider: 'Local',      model: 'ollama/llama3',              label: 'Ollama — Llama 3' },
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
  // v3.2.26: render the per-companion Chatti list with quick
  // chattiness sliders. One slider per companion + full Edit
  // button. Slider changes write directly to sprites.json via
  // cyberclaw.agents.saveSpriteConfig and re-broadcast the
  // agents_list so the mobile's Personalize screen stays in sync.
  try { renderSettingsCompanionsList(); } catch (e) { console.warn('renderSettingsCompanionsList:', e); }
};

// v3.2.26: render the Settings → Companions list. Each row
// shows the companion's emoji/icon, name, and a 1–5 chattiness
// slider + Edit button. The slider is the same scale the
// mobile's Personalize screen uses; values are clamped 1–5
// and persisted to sprites.json via the existing surface.
async function renderSettingsCompanionsList() {
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
    // Use data-id on the wrapper so the slider's oninput can
    // resolve the agent without a global lookup. Also expose
    // the original value so the description line can be
    // updated without re-rendering.
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

// v3.2.26: persist the slider value to sprites.json. Same
// surface as the forge + mobile Personalize screen. On success,
// re-broadcast agents_list so the mobile's Personalize slider
// reflects the new value (and the idle chatter scheduler picks
// up the new interval on its next tick).
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

// v3.2.32: CyberClaw.md editor — the overarching system
// prompt shared by every companion. Saved/loaded via the
// `cyberclaw.system.*` IPC bridge. Restore default deletes
// the file so the next read returns DEFAULT_SYSTEM_PROMPT.
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

// ── Custom LLM Providers ────────────────────────────────────────
// Each provider: { id, name, baseUrl, apiKey?, defaultModel?, api }
// `api` is the wire format: 'openai-completions' (most) or 'anthropic-messages'.
// CyberClaw companions mirror openclaw agents, so we read LLM providers
// directly from `~/.openclaw/openclaw.json → models.providers`. Falls back
// to the local CyberClaw providers.json if openclaw config is unavailable.
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
  // Build options: keep the "Use OpenClaw default" entry, then a group per provider
  // We list the *default model* from each provider, but also include a few
  // common well-known models so the dropdown remains useful even before any
  // provider is saved.
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

// v3.2.1: one-click provider presets. Each preset fills the add-form's
// name / baseUrl / defaultModel / api style so the user only has to type
// their API key and click Save. OpenRouter / Groq / Together / Fireworks /
// Mistral / DeepSeek cover ~95% of "I want to use a model that's not
// Anthropic or OpenAI" — Ollama lives in the Local LLM Endpoints section
// below because it needs model discovery.
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

// ─── LLM Endpoints (v3.1.33) ────────────────────────────────────
// User-managed OpenAI-compatible HTTP endpoints (Ollama, LM
// Studio, llama.cpp server, Jan.ai, vLLM, etc.). The
// companion model picker reads from this list, prefixed
// with the endpoint id so the runtime can route the
// request to the right baseUrl.
//
// Unlike providers (which are API-key cloud services),
// endpoints serve models the user has already downloaded
// locally. CyberClaw doesn't manage downloads — the user
// brings their own model, we just point at it.

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
  // Save without committing, just probe. We use the add
  // IPC with autoDetected flag and a tmp name; on cancel
  // we delete it. Simpler: just probe via a synthetic
  // fetch in main process. Use the add path with the
  // entered URL but mark it as a test by NOT calling
  // cancelAddLlmEndpoint afterwards.
  //
  // Actually, the cleanest approach: a dedicated probe
  // IPC. For now, fake it via the add IPC and the
  // user sees the result in the probe status field.
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
  // v3.1.33: per-endpoint model picker. Each model
  // discovered on a configured endpoint becomes an option
  // under a group named for the endpoint. The value is
  // namespaced as `<endpointId>/<modelId>` so the
  // runtime can route the request to the right baseUrl.
  // (Note: this assumes the runtime understands the
  // namespaced syntax. If not, we may need to convert
  // at write time — see setAgentModel fallback.)
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

  // v3.2.21: OpenClaw session tailer pushes assistant
  // text messages from Discord-routed agent runs into
  // the renderer's chat history so the mobile can see
  // them on the next request_chat_history pull. We add
  // the message to chatHistory + chatHistoryByAgent so
  // both the flat history (mobile tab) and the per-
  // companion history (mobile companion tab) get it.
  //
  // v3.2.22 fix: do NOT call addChatMsg here. The
  // session tail in main.js ALREADY broadcasts the
  // message to currently-connected mobiles via
  // syncServer.broadcastChatMessage. addChatMsg would
  // re-broadcast via sync-broadcast-chat IPC, causing
  // the mobile to receive each message TWICE. Tobe
  // reported (2026-07-23 17:54) that the mobile was
  // "spamming" — 91 addChatMsg broadcasts in a single
  // debug session because the tail was firing for
  // EVERY assistant message in the Discord session
  // (including my own internal exec-driven runs that
  // ended with a final text reply, all of which got
  // pushed to the mobile).
  //
  // The session tail is also refined in main.js to
  // skip non-Discord sessions (the desktop's own chat
  // pipeline handles those via sync-broadcast-chat
  // already). Combined with this fix, the flow is:
  //
  //   user → mobile chat → desktop chat pipeline →
  //   addChatMsg → sync-broadcast-chat → mobile
  //
  //   user → Discord → OpenClaw Discord routing →
  //   agent reply → tailer onChatMessage →
  //   syncServer.broadcastChatMessage → mobile
  //                                + this IPC handler →
  //   chatHistory push (no broadcast)
  //
  // Each path is broadcast-once. No more double-broadcast.
  ipcRenderer.on('openclaw-session-chat-message', (e, { agentId, agentName, text, isUser, ts }) => {
    try {
      const resolvedAgentId = agentName || agentId || 'companion';
      // v3.2.22: push directly to chatHistory /
      // chatHistoryByAgent, bypassing addChatMsg's
      // broadcast side effect. The sync-server broadcast
      // already went out from main.js.
      chatHistory.push({
        text,
        isUser: !!isUser,
        agentId: resolvedAgentId,
        ts: ts || Date.now(),
      });
      if (chatHistory.length > 100) {
        chatHistory = chatHistory.slice(-100);
      }
      const bucketedAgentId =
        agentIdForName(resolvedAgentId) ||
        activeChatAgentId ||
        (agentOrder[focusIndex]) ||
        null;
      if (bucketedAgentId) {
        if (!chatHistoryByAgent[bucketedAgentId]) {
          chatHistoryByAgent[bucketedAgentId] = [];
        }
        chatHistoryByAgent[bucketedAgentId].push({
          type: isUser ? 'user' : 'agent',
          text,
          name: agentName || null,
          emoji: null,
          ts: ts || Date.now(),
        });
        if (chatHistoryByAgent[bucketedAgentId].length > 200) {
          chatHistoryByAgent[bucketedAgentId] =
            chatHistoryByAgent[bucketedAgentId].slice(-200);
        }
        schedulePersistChatHistory();
      }
      window.addDesktopLog?.('💬', 'OpenClaw tail', text.substring(0, 60));
    } catch (err) {
      console.error('[App] openclaw-session-chat-message handler error:', err);
    }
  });
  ipcRenderer.on('openclaw-session-typing', (e, { active }) => {
    // The tailer emits typing-off when it sees an
    // assistant text message. We don't have an agent-
    // run in-flight via the chat pipeline (this came
    // from Discord), so we don't add a typing bubble
    // to the chat history. Just update the typing
    // broadcast so the mobile's "thinking" indicator
    // clears.
    if (active === false) {
      // The chat pipeline owns the typing indicator
      // when it's in flight. When it isn't, the
      // indicator should already be off — this is
      // belt-and-suspenders. The main process's
      // broadcastTyping IPC handler fires the actual
      // sync-server broadcast; we don't need to
      // re-broadcast from here.
    }
  });

  ipcRenderer.on('mobile-request-chat-history', () => {
    // Send current chat history to mobile
    console.log('[App] Mobile requesting chat history, sending', chatHistory.length, 'messages');
    ipcRenderer.invoke('sync-send-chat-history', { messages: chatHistory.slice(-50) })
      .then(() => console.log('[App] Chat history sent successfully'))
      .catch(err => console.log('[App] Error sending chat history:', err));
  });

  // v3.1.17: per-agent chat history for the mobile companion tab bar.
  // Mobile sends this when the user taps a different companion tab;
  // we send back the last 50 messages for that companion only.
  ipcRenderer.on('mobile-request-agent-history', (e, { agentId }) => {
    // v3.2.9: normalize the message shape before sending to
    // mobile. The internal `chatHistoryByAgent` entries are
    // stored as `{type, text, name, emoji, ts}` (the legacy
    // desktop format), but the mobile's renderMessage guard
    // rejects any message where `typeof item.isUser !==
    // 'boolean'`. Without this normalization, ALL messages
    // from agent_history (including voice-mode transcripts
    // captured while HomeScreen was unmounted) render as an
    // empty <View /> — the chat shows historical messages
    // that came through the typed-message path / chat_history
    // / chat events (all of which set isUser properly) but
    // anything that ONLY landed in chatHistoryByAgent (i.e.
    // voice-mode sessions captured while WakeModeScreen was
    // the active screen) appears to be missing.
    //
    // Tobe's report on v3.2.8: "voice mode chats should
    // appear in the chat aswell." Every voice transcript
    // and LLM response during voice mode is in
    // chatHistoryByAgent on the desktop (via
    // addChatMsg → chatHistoryByAgent push), but the
    // mobile's agent_history response shape was
    // `{type, text, name, emoji, ts}` which failed the
    // `typeof item.isUser === 'boolean'` render guard.
    //
    // Fix: map each entry to `{text, isUser, agentId,
    // agentName, ts}` before sending. `type === 'user'`
    // becomes `isUser: true`; everything else (including
    // 'agent' and 'system') becomes `isUser: false`.
    // The agentName comes from the entry's `name` field
    // (the desktop stores display names like 'Clawsuu',
    // 'Lamasuu' there); if missing, falls back to the
    // requested agentId.
    const raw = (chatHistoryByAgent[agentId] || []).slice(-50);
    const hist = raw.map((m) => ({
      text: m.text,
      isUser: m.type === 'user',
      agentId: m.name || agentId,
      agentName: m.name || null,
      ts: m.ts,
    }));
    console.log(`[App] Mobile requesting agent history for ${agentId}, sending ${hist.length} messages`);
    ipcRenderer.invoke('sync-send-agent-history', { agentId, messages: hist })
      .then(() => console.log(`[App] Agent history sent for ${agentId}`))
      .catch(err => console.log(`[App] Error sending agent history for ${agentId}:`, err));
  });

  // v3.1.16: the sync server can ask us to re-broadcast the
  // current agents list. This happens when a mobile reconnects and
  // the server's cache is empty (e.g. the mobile connected before
  // the renderer's first arena-init broadcast, or the cache was
  // cleared). We re-run the same broadcast path that
  // initArenaCompanions uses, which goes through the
  // 'sync-broadcast-agents-list' IPC and lands in the server's
  // broadcastAgentsList — populating the cache and sending the
  // list to the requesting mobile (and any others).
  ipcRenderer.on('mobile-request-agents-list', () => {
    // v3.2.27: delegate to broadcastAgentsListToMobile so
    // both broadcast sites use the SAME list shape (with
    // spriteConfig + avatar). Previously this handler
    // built its own list without those fields, which meant
    // a late-reconnecting client got a stripped-down
    // payload until the next 60s sync. The unified list
    // shape is small (~10-15KB per companion with the
    // avatar data URL) and the same code path that runs
    // on every periodic sync. The .catch is defense in
    // depth for the floating promise.
    console.log('[App] Sync server requested agents list refresh');
    broadcastAgentsListToMobile().catch((e) => {
      console.log('[App] Error re-broadcasting agents list:', e?.message);
    });
  });

  // v3.2.26: mobile-initiated companion edit (Personalize screen).
  // The mobile sends a sprite_config_sync with a partial patch;
  // main.js forwards it here. We merge the patch into the existing
  // sprite config, persist via the existing cyberclaw.agents.
  // saveSpriteConfig (which writes sprites.json + regenerates the
  // avatar if the sprite changed), then broadcast the updated
  // agents_list so every connected client (including the phone
  // that initiated the edit) sees the change.
  // v3.2.42: re-render quests when the list changes
  // externally. Without this, the renderer's in-memory
  // activeQuestId stays stale after a mobile-side quest
  // edit (set-active, update, delete, etc.) because the
  // renderer only re-reads disk state when something IT
  // does triggers renderQuests(). The next chat send then
  // builds the context with the stale active quest and
  // the companion replies with the wrong quest name.
  // Tobe hit this on 2026-08-02 17:27: the mobile
  // switched to CYBERHIVE_WEBSITE V3, but Clawsuu's
  // reply said "Yeah it says Cyber_Music is active"
  // because the renderer still had Cyber_Music cached.
  ipcRenderer.on('quests-updated', (e, list) => {
    try {
      if (!Array.isArray(list)) return;
      // Update the module-level activeQuestId from the
      // canonical list. renderQuests() also does this,
      // so re-rendering covers the visual side.
      activeQuestId = list.find(q => q.active)?.id || null;
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
      // Re-broadcast agents list so the change syncs back to
      // the phone that initiated it (and any other connected
      // client). broadcastAgentsListToMobile uses the unified
      // map that includes chattiness + sleepState. v3.2.27:
      // the function is now async (reads sprite config per
      // agent). The catch covers the floating-promise case
      // — the function's own try/catch handles inner errors,
      // but we add .catch as defense in depth.
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
    // v3.1.17: if the mobile told us which companion the user is
    // chatting with, switch the desktop's active chat companion to
    // match. This keeps `pickCurrentCompanionId()` and the response
    // `agentId` in sync with the mobile's tab bar.
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
    // v3.2.40: strip the `[From: <deviceName>]` prefix from the
    // text before forwarding to the LLM. The sync-server adds
    // it so the chat-history bubble shows the source, but the
    // LLM doesn't need it (and gets confused by it — Tobe
    // reported 2026-08-01: "clawsuu seems a bit confused
    // still of where to respond"). The chat-history bubble
    // already got the prefixed text via the addChatMsg call
    // above; only the LLM-facing copy is stripped. Same rule
    // for the voice transcript path (mobile sends voice
    // transcripts prefixed too, see HomeScreen.tsx ~line
    // 2533 for the matching mobile-side prefix).
    const llmText = (text || '').replace(/^\[From:\s*[^\]]*\]\s*/, '');
    if (typeof window.sendChatMessage === 'function') {
      window.sendChatMessage(llmText);
    } else {
      // Fallback: retry after 2s if not ready yet
      setTimeout(() => {
        console.log('[mobile-chat] retry sendChatMessage, defined:', typeof window.sendChatMessage);
        if (typeof window.sendChatMessage === 'function') window.sendChatMessage(llmText);
      }, 2000);
    }
  });

  // v3.10.3: mobile-requested companion wake. The mobile
  // sends this when the user starts any speech / chat input
  // (chat submit, voice-mode entry, voice-mode recording
  // send). The desktop flips the targeted agent's
  // sleepState from 'sleeping' to 'awake' and rebroadcasts
  // the agents_list so the mobile's arena un-grays
  // immediately. Auto-wake in sendChat() / sendChatMessage()
  // already handles the desktop-side typed/voice prompts;
  // this IPC is the explicit mobile-initiated kick.
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

  // v3.10.91: mobile activity heartbeat. The mobile sends
  // this every ~30s while the user is actively engaged
  // (chat tab open + app foregrounded) so the desktop can
  // reset the companion's auto-sleep timer. Without this,
  // a mobile-only user (no chat submit / voice / treats
  // on desktop) sees the companion fall asleep after
  // 12 min even though they're actively looking at the
  // chat on mobile.
  //
  // Only RESETS the timer — does NOT flip sleepState. If
  // the companion is already sleeping, this won't wake it.
  // Active engagement (chat / voice / treat / wake) is
  // required to wake a sleeping companion. Passive viewing
  // only delays the auto-sleep.
  ipcRenderer.on('mobile-activity-ping', (e, { agentId } = {}) => {
    try {
      const id = agentId || (agentOrder[focusIndex] || pickCurrentCompanionId());
      if (!id || !agents[id]) return;
      // Reuses the same bumpCompanionInteraction() that
      // desktop-side chat/voice/treat actions call. This
      // resets lastInteractionTs which the desktop's
      // scheduleAutoSleep() loop checks every minute.
      bumpCompanionInteraction(id);
      console.log('[mobile-activity-ping] bumped', id);
    } catch (err) {
      console.warn('[mobile-activity-ping] failed:', err?.message);
    }
  });

  // v3.10.72: mobile dropped a food/treat on the
  // arena. Mirror the desktop's placeTreatOnArena() in
  // src/js/app.js:4905.
  //
  // v3.10.74: Tobe asked that the food/play reactions
  // NOT appear in chat ("The comments the companion
  // makes when given food or played with does not need
  // to appear in the chat"). The visual reaction (😋
  // emoji overlay) is enough. We no longer call
  // promptCompanionReaction — that triggers an LLM
  // round-trip and adds the reply to chat, which is
  // noise for trivial actions like eating a treat.
  // We still log to the desktop log panel for debugging.
  ipcRenderer.on('mobile-arena-treat-placed', (e, { treat, meta } = {}) => {
    try {
      const t = (treat && TREAT_NAMES[treat]) ? treat : 'apple';
      const name = TREAT_NAMES[t] || t;
      console.log('[mobile-treat] placed:', t);
      // v3.10.74: log to the desktop log panel for
      // debugging only — NOT to chat, NOT to events.
      // Tobe wants feeding to be a non-verbal action:
      // visual emoji overlay on the mobile arena is
      // the only feedback the user gets. addChatMsg /
      // addEventMsg would put it in chat/events which
      // is the chat-noise Tobe reported.
      window.addDesktopLog?.('🍖', 'Mobile fed', t, 'info');
    } catch (err) {
      console.warn('[mobile-treat] placed failed:', err?.message);
    }
  });

  // v3.10.72: companion ate a treat (from the mobile
  // arena's seek-and-eat logic). v3.10.74: same
  // reasoning as placed — keep chat clean, no LLM
  // round-trip for trivial eat actions. The 😋+❤️
  // emoji overlay on the mobile arena provides the
  // visual feedback.
  ipcRenderer.on('mobile-arena-treat-eaten', (e, { treat, meta } = {}) => {
    try {
      const t = (treat && TREAT_NAMES[treat]) ? treat : 'apple';
      const name = TREAT_NAMES[t] || t;
      console.log('[mobile-treat] eaten:', t);
      window.addDesktopLog?.('😋', 'Companion ate', t, 'info');
    } catch (err) {
      console.warn('[mobile-treat] eaten failed:', err?.message);
    }
  });

  ipcRenderer.on('mobile-voice', (e, { id, transcript, context, meta }) => {
    // v3.2.40: strip the `[From: <deviceName>]` prefix from
    // the transcript before forwarding. The mobile pre-pends
    // it on send (HomeScreen.tsx line ~2533), but the LLM
    // already gets the `[Voice from mobile]` wrapper below
    // — the inner prefix is redundant + confusing. Same
    // rationale as the `mobile-chat` handler above.
    const cleanTranscript = (transcript || '').replace(/^\[From:\s*[^\]]*\]\s*/, '');
    const prompt = context
      ? `[Voice from mobile — last ${meta.lookbackMinutes}min context: "${context}"]\n\nUser said: ${cleanTranscript}`
      : cleanTranscript;
    console.log('[mobile-voice] received:', id, transcript?.substring(0, 60));
    window.addDesktopLog?.('🎤', 'Voice → AI', transcript?.substring(0, 50), 'info');
    addChatMsg('user', `🎤 ${transcript}`);
    // v3.2.4: ack receipt so main.js can detect a hung
    // renderer. v3.2.6: forward the id so main.js can
    // remove the corresponding entry from its
    // pending-voice queue (used to replay transcripts
    // after a renderer reload). Without forwarding the
    // id, main.js can't tell which ack corresponds to
    // which pending entry.
    try { ipcRenderer.send('mobile-voice-ack', { ts: Date.now(), id }); } catch {}
    // v3.2.7: register for response tracking. The ack
    // alone doesn't mean the LLM will respond — the
    // renderer could hang on the LLM call AFTER
    // acking. Tell main.js we're processing this
    // voiceId so the ack-watcher doesn't fire spuriously.
    if (id) {
      try { ipcRenderer.send('voice-response-tracking-start', { id }); } catch {}
    }
    if (typeof window.sendChatMessage === 'function') {
      const sendPromise = window.sendChatMessage(prompt);
      // v3.2.7: when sendChatMessage completes (success
      // or failure), signal completion so main.js can
      // remove the voice from its tracking map and stop
      // watching for it.
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

  // v3.2.4: readiness ping. When main.js sends
  // `renderer-ready-check` (on page load), ack back
  // immediately. This proves the renderer's JS
  // context is alive and IPC handlers are
  // registered. Without this, a renderer whose
  // app.js failed to load (syntax error, missing
  // module, etc.) would look identical to a hung
  // renderer from main.js's perspective.
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
    const input = document.getElementById('chat-input');
    const message = (input.value || '').trim();
    const imgData = pendingImage;
    clearImageAttachment();

    if (!message && !imgData) return;
    if (chatBusy || agentOrder.length === 0) return;

    const agent = agents[agentOrder[focusIndex]];
    if (!agent) return;

    // Show user message with image
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-msg user';
    let html = '<div class="msg-bubble">';
    if (message) html += '<span class="msg-text">' + message + '</span>';
    html += '<br><img class="chat-msg-image" src="' + imgData.dataUrl + '" alt="' + imgData.filename + '" />';
    html += '</div>';
    msgDiv.innerHTML = html;
    document.getElementById('chat-messages').appendChild(msgDiv);
    document.getElementById('chat-messages').scrollTop = document.getElementById('chat-messages').scrollHeight;
    input.value = '';

    // Send to agent with image context
    const mainAgentId = pickCurrentCompanionId();
    if (!mainAgentId) { addChatMsg('error', 'No companion found'); return; }

    let fullMessage = (message || 'Describe this image') + '\n[Image attached: ' + imgData.filename + ']';
    // v3.2.21: also inject the quest-tools hint for image-attach
    // chat path so the agent sees the same available actions.
    fullMessage = buildQuestToolsHint() + fullMessage;

    chatBusy = true;
    document.getElementById('chat-send').disabled = true;
    const typingId = addChatMsg('typing', agent.name + ' is thinking...');
    // v3.2.37: same cleanup-hardening as sendChatMessage.
    // The image-attach path here has the same hung-bubble
    // and stuck-chatBusy problems if the agent call hangs.
    // The 110s typingFailsafe is the belt; the
    // Promise.race timeout (AGENT_TIMEOUT_MS=90s) is the
    // suspenders. Without these, a wedged openclaw call
    // would leave the image-attach path frozen with
    // "thinking..." showing indefinitely and chatBusy=true
    // blocking the next message for 15s on each retry.
    const AGENT_TIMEOUT_MS = 90000;
    const typingFailsafe = setTimeout(() => {
      console.warn('[sendChat:img] typing bubble > 110s, force-clearing');
      window.addDesktopLog?.('⚠️', 'AI still thinking after 110s (image path)', message.substring(0, 60), 'warn');
      try { removeChatMsg(typingId); } catch {}
    }, 110000);

    try {
      let result;
      try {
        result = await Promise.race([
          cyberclaw.chat.sendMessage(mainAgentId, fullMessage, { image: imgData.dataUrl }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('agent call timed out after 90s')), AGENT_TIMEOUT_MS)
          ),
        ]);
      } catch (timeoutErr) {
        window.addDesktopLog?.('⏱️', 'Agent call > 90s (image path), aborted', message.substring(0, 60), 'warn');
        throw timeoutErr;
      }
      removeChatMsg(typingId);
      if (result.ok) {
        const leader = agents[mainAgentId];
        // v3.1.96: strip the desktop's 🤖 default before sending.
        addChatMsg('agent', stripQuestTags(result.reply), leader && leader.name || 'Companion', leader && (leader.emoji === '🤖' ? null : (leader.emoji || getSpriteIcon(leader._pixelCompanionId))));
        // Check for quest creation command
        if (result.reply) {
          var qm = result.reply.match(/\[CREATE_QUEST:\s*name="([^"]+)"\s*desc="([^"]*)"\s*(?:dir="([^"]*)")?\]/);
          if (qm) {
            try {
              await cyberclaw.quests.create({ name: qm[1], description: qm[2] || '', directory: qm[3] || undefined });
              addChatMsg('system', '📜 Quest created: ' + qm[1]);
              renderQuests();
            } catch(qe) {}
          }
        }
        // Drain happiness from work
        if (window.adjustHappiness && result.reply) {
          const len = result.reply.length;
          const drain = len < 200 ? -2 : len < 500 ? -4 : len < 1000 ? -6 : -10;
          window.adjustHappiness(drain);
        }
      } else {
        addChatMsg('error', 'Error: ' + (result.error || 'Failed to get response'));
      }
    } catch (err) {
      addChatMsg('error', 'Error: ' + err.message);
    } finally {
      clearTimeout(typingFailsafe);
      try { removeChatMsg(typingId); } catch {}
      chatBusy = false;
      document.getElementById('chat-send').disabled = false;
      input.focus();
    }
    return;
  }

  // No image — use original sendChat
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
setInterval(function() {
  if (happiness > 0) {
    happiness = Math.max(0, happiness - 1);
    try { localStorage.setItem(HAPPINESS_KEY, String(happiness)); } catch(e) {}
    updateHappinessBar();
  }
}, 300000); // 5 minutes

// Update bar on load
setTimeout(updateHappinessBar, 1000);

// ═══════════════════════════════════════════════════════════
//  FEED SYSTEM — drag treats onto arena
// ═══════════════════════════════════════════════════════════

// ── Treat emojis and selected treat state ──
var TREAT_EMOJIS = {
  apple: '🍎', hamburger: '🍔', meat: '🍖', fish: '🐟', cake: '🍰', cookie: '🍪', berry: '🫐',
  ball: '⚽', 'tennis-ball': '⚾', yarn: '🧶', stick: '🪵', frisbee: '🥏', bell: '🔔', feather: '🪶'
};
var TREAT_NAMES = {
  apple: 'an apple', hamburger: 'a hamburger', meat: 'some meat', fish: 'a fish', cake: 'a slice of cake', cookie: 'a cookie', berry: 'some berries',
  ball: 'a ball', 'tennis-ball': 'a tennis ball', yarn: 'a ball of yarn', stick: 'a stick', frisbee: 'a frisbee', bell: 'a bell', feather: 'a feather'
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
  a.dropTreat(canvasX, canvasY, treatType, TREAT_EMOJIS[treatType]);
  promptCompanionReaction('I just gave you ' + TREAT_NAMES[treatType] + '. What do you think?');
  if (window.adjustHappiness) window.adjustHappiness(10);
}

// Companion reacts when eating a treat (called from pixel-arena.js)
window.promptCompanionEat = function(treatType) {
  var name = TREAT_NAMES[treatType] || 'a treat';
  promptCompanionReaction('I just ate ' + name + '. Give a short happy reaction about how it tasted.');
};

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
function promptCompanionReaction(promptText) {
  // Skip if the active companion is sleeping (manual sleep toggle)
  const targetId = activeChatAgentId
    || (agentOrder.find(id => !hiddenCompanions.has(id)))
    || agentOrder[0];
  if (!targetId) return;
  const target = agents[targetId];
  if (!target) return;
  if (target.sleepState === 'sleeping') return;
  // Don't fire if main chat or another reaction is already running
  if (chatBusy || reactionBusy) return;
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
      // v3.1.96: strip the desktop's 🤖 default before sending.
      addChatMsg('agent', reply, agent.name, agent.emoji === '🤖' ? null : (agent.emoji || getSpriteIcon(agent._pixelCompanionId)));
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

// v3.1.16: expose isNightTime on window so pixel-arena.js's
// _updateCompanion can use the same boundary as app.js. Without
// this, the two could drift (e.g. the 06:30 cutoff lives in
// isNightTime but the arena had a hard-coded `< 8`).
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

// ── AUTO-SLEEP ON INACTIVITY (v3.1.4) ──────────────────────────────
// Each companion tracks a lastInteractionTs. After `AUTO_SLEEP_AFTER_MS`
// of no interaction, the companion goes to sleep on its own. Any
// interaction (chat, focus change, manual wake) resets the timer.
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
        // v3.10.3: push the new sleepState to the mobile so it
        // can render a sleeping-sprite overlay. Without this
        // the mobile stays wakeful-looking until the next
        // periodic broadcast, breaking the "they sleep on
        // the phone too" expectation.
        try { broadcastAgentsListToMobile(); } catch (_) {}
      }
    }
  }, 60 * 1000); // check every minute
}

function scheduleIdleChatter() {
  // v3.2.26: chattiness scale (1–5) controls the idle chatter
  // interval. 1 = silent (never fires), 5 = chatty (every 15–30
  // min). The default of 3 matches the v3.1.3 baseline (60–90
  // min). We resolve the interval per current companion so each
  // companion can have its own chattiness; if the user switches
  // focus mid-tick, the next tick will pick up the new companion's
  // value. (We deliberately don't cancel the in-flight timer — the
  // next tick will pick up the new value within minutes.)
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
    // v3.1.3: skip if the current companion is manually sleeping
    // v3.2.26: also skip if chattiness is 1 (silent). Re-read
    // chattiness at fire time so it can be changed without
    // restarting the desktop.
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

