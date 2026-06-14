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

// Rarity assignment based on role/binding
function assignRarity(agent, index) {
  if (agent.isMain && index === 0) return 'legendary';
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

    // Sort: party leader first (clawsuu or default-bound), then by name
    const sorted = filtered.sort((a, b) => {
      // Party leader: agent whose class contains "party leader" or is the default binding
      const aLeader = a.class.toLowerCase().includes('party leader');
      const bLeader = b.class.toLowerCase().includes('party leader');
      if (aLeader && !bLeader) return -1;
      if (!aLeader && bLeader) return 1;
      if (a.isMain && !b.isMain) return -1;
      if (!a.isMain && b.isMain) return 1;
      return a.name.localeCompare(b.name);
    });

    sorted.forEach((a, i) => {
      const isPartyLeader = i === 0 && (a.class.toLowerCase().includes('party leader') || a.isMain);
      const rarity = isPartyLeader ? 'legendary' : assignRarity(a, i);
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
        isMain: isPartyLeader,
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
          // Support both legacy single assignedQuest and new assignedQuests array
          if (cfg.assignedQuests) agents[id].assignedQuests = cfg.assignedQuests;
          else if (cfg.assignedQuest) agents[id].assignedQuests = [cfg.assignedQuest];
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
// Shared 2D Pixel Arena — Companion + Spirits
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

  // Populate companion + spirits
  initArenaCompanions();
  updateCarousel();
}

async function initArenaCompanions() {
  if (!pixelArena) { debugLog('[Arena] ERROR: No pixelArena!'); return; }
  debugLog('[Arena] initArenaCompanions called, agents: ' + agentOrder.join(', '));
  debugLog('[Arena] isMain flags: ' + agentOrder.map(id => `${id}=${agents[id]?.isMain}`).join(', '));

  const catalog = loadPixelCatalog();
  const defaultCompanions = catalog.companions || [];
  const fallbackCompanionId = defaultCompanions[0]?.id || 'boar';

  // Find party leader (main agent) — first agent with isMain, else first in order
  const leaderId = agentOrder.find(id => agents[id]?.isMain) || agentOrder[0];
  window.leaderId = leaderId;

  debugLog(`[Arena] Leader: ${leaderId}, Agents: ${agentOrder.length}, Companion catalog: ${defaultCompanions.length}`);

  // Every agent gets a Companion sprite (no more spirits)
  // The leader gets the arena center; everyone else gets a sidebar slot.
  for (let i = 0; i < agentOrder.length; i++) {
    const id = agentOrder[i];
    const agent = agents[id];
    let pixelId = null;
    try {
      const config = await cyberclaw.agents.getSpriteConfig(id);
      pixelId = config?.pixelCompanionId;
      debugLog('[Arena] ' + id + ' config: ' + JSON.stringify(config));
    } catch (e) { debugLog('[Arena] ERROR ' + id + ' config: ' + e.message); }

    // Default to a rotating companion sprite if none assigned
    if (!pixelId && defaultCompanions.length > 0) {
      pixelId = defaultCompanions[i % defaultCompanions.length].id;
    }

    if (!pixelId) { debugLog('[Arena] WARN: No pixelId for ' + id); continue; }

    agent._pixelCompanionId = pixelId;
    try {
      if (id === leaderId) {
        // Center companion
        currentCompanionId = pixelId;
        localStorage.setItem('cyberclaw-selected-companion', pixelId);
        await pixelArena.setCompanion(id, pixelId, agent.name);
        debugLog('[Arena] Companion set: ' + agent.name + ' (' + pixelId + ')');
      } else {
        // Sidebar companion — same sprite catalogue, just placed off-center
        await pixelArena.setCompanion(id, pixelId, agent.name, { isSidekick: true, sidekickIndex: i });
        debugLog('[Arena] Sidekick set: ' + agent.name + ' (' + pixelId + ')');
      }
    } catch (e) { debugLog('[Arena] ERROR set companion for ' + id + ': ' + e.message + '\n' + e.stack); }
  }
  debugLog('[Arena] Init complete. Companion: ' + (pixelArena.companion ? 'yes' : 'no'));
}

// Camera view render loop — renders a cropped arena view into inspect panel
function startCameraLoop() {
  const cam = document.getElementById('inspect-camera');
  if (!cam) return;
  function renderCamera() {
    if (pixelArena && window._inspectAgentId) {
      const agent = agents[window._inspectAgentId];
      const zoom = agent && agent.isMain ? 1.2 : 1.5;
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
    const isLeader = !!agent.isMain;
    const hidden = hiddenCompanions.has(id);

    const row = document.createElement('label');
    row.className = 'arena-companion-row' + (isLeader ? ' is-leader' : '') + (hidden ? ' hidden-from-arena' : '');

    // Avatar
    const avatar = document.createElement('span');
    avatar.className = 'arena-companion-avatar';
    if (agent.avatar && String(agent.avatar).startsWith('data:')) {
      avatar.innerHTML = `<img src="${escAttr(agent.avatar)}" alt="${escAttr(agent.name)}">`;
    } else {
      avatar.textContent = agent.emoji || '🤖';
    }
    row.appendChild(avatar);

    // Info
    const info = document.createElement('div');
    info.className = 'arena-companion-info';
    const name = document.createElement('div');
    name.className = 'arena-companion-name';
    name.textContent = agent.name + (isLeader ? ' ★' : '');
    const cls = document.createElement('div');
    cls.className = 'arena-companion-class';
    cls.textContent = agent.class || agent.id;
    info.appendChild(name);
    info.appendChild(cls);
    row.appendChild(info);

    // Toggle
    const lbl = document.createElement('span');
    lbl.className = 'arena-companion-toggle';
    lbl.title = isLeader ? 'Leader is always shown' : 'Show / hide in the arena';
    const sw = document.createElement('span');
    sw.className = 'toggle-switch' + (isLeader || !hidden ? ' on' : '');
    if (isLeader) sw.style.opacity = '0.5';
    const lblText = document.createElement('span');
    lblText.textContent = (isLeader || !hidden) ? 'shown' : 'hidden';
    lbl.appendChild(sw);
    lbl.appendChild(lblText);
    // Prevent the leader from being hidden
    if (!isLeader) {
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
    } else {
      lbl.style.opacity = '0.6';
    }
    row.appendChild(lbl);
    wrap.appendChild(row);
  }
}

// Apply the current hiddenCompanions set to the pixelArena. We don't have
// a true multi-companion arena yet (the existing pixelArena only renders
// one companion), so this hook is a stub for the future. The hidden flag
// primarily affects carousel + channel tab display.
function applyCompanionVisibility() {
  if (!pixelArena) return;
  // Future: if pixelArena.companions becomes an array, filter out hidden ids.
  // For now we just persist the set to localStorage so the choice survives a reload.
  try { localStorage.setItem('cyberclaw-hidden-companions', JSON.stringify([...hiddenCompanions])); } catch {}
}

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

  // Set type badge — all agents are Companions now (no more spirits)
  const typeBadge = document.getElementById('inspect-type-label');
  if (typeBadge) {
    const isLeader = agent.isMain;
    typeBadge.textContent = isLeader ? 'Companion · Leader' : 'Companion';
    typeBadge.className = 'inspect-type-badge companion';
  }

  // Camera view — track the currently inspected agent ID for the render loop
  window._inspectAgentId = agentId;

  // Equipment is available for all companions
  const equipSection = document.getElementById('inspect-equipment-section');
  if (equipSection) equipSection.style.display = '';

  document.getElementById('inspect-name').textContent = agent.name;
  document.getElementById('inspect-name').className = `${agent.rarity}-text`;
  document.getElementById('inspect-class').textContent = agent.class;
  document.getElementById('inspect-id').textContent = agent.id;

  const statusEl = document.getElementById('inspect-status');
  statusEl.innerHTML = `<span class="status-dot ${agent.status}"></span> ${agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}`;

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

    // Skill list — companion shows ALL skills, spirits show only focus skills
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
    
    // All companions show their full skill set (no more spirits with focus-only)
    const displaySkills = allSkillDefs;
    
    const skills = stats.skills || {};
    if (displaySkills.length === 0 && !agent.isMain) {
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
let activeQuestId = null;

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
    input.value = 'I want to create a new quest! Help me figure out what it should be — ask me what I want to work on, then create it for me. When we agree on the quest, respond with exactly this format on its own line: [CREATE_QUEST: name="Quest Name" desc="Description" dir="optional/path"]';
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

window.selectQuest = function(el, questId) {
  const wasSelected = el.classList.contains('quest-selected');
  document.querySelectorAll('.quest-item').forEach(q => q.classList.remove('quest-selected'));
  if (wasSelected) {
    // Deselect
    activeQuestId = null;
    updateQuestIndicator();
  } else {
    el.classList.add('quest-selected');
    activeQuestId = questId;
    updateQuestIndicator();
  }
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

  for (const q of sorted) {
    const isComplete = q.status === 'completed';
    const div = document.createElement('div');
    div.className = `quest-item ${isComplete ? 'completed-quest' : 'active-quest'} ${q.id === activeQuestId ? 'quest-selected' : ''}`;
    div.onclick = () => selectQuest(div, q.id);
    const companionAvatars = ''; // Companion auto-assigns spirits based on quest category

    div.innerHTML = `
      <div class="quest-top-row">
        <div class="quest-name">${isComplete ? '✅' : '⚔️'} ${escapeHtml(q.name)}</div>
        <div class="quest-top-actions">
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

  // Skill categories for the quest
  const skillTypes = ['Coding', 'Writing', 'Design', 'Analysis', 'Strategy', 'Research', 'Communication', 'Game', 'General'];
  const questSkills = quest.skills || [];
  const skillChecks = skillTypes.map(s => {
    const icons = { Coding: '💻', Writing: '✍️', Design: '🎨', Analysis: '📊', Strategy: '🗺️', Research: '🔍', Communication: '💬', Game: '🎮', General: '✨' };
    return `<label class="qe-skill-tag"><input type="checkbox" value="${s}" ${questSkills.includes(s) ? 'checked' : ''} /> ${icons[s]} ${s}</label>`;
  }).join('');

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
        <label>Work Categories</label>
        <div class="skill-checkbox-grid">${skillChecks}</div>
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

  // Gather skills
  const skillChecks = document.querySelectorAll('.qe-content .skill-checkbox-grid input[type="checkbox"]');
  const skills = Array.from(skillChecks).filter(cb => cb.checked).map(cb => cb.value);

  // Update quest
  await cyberclaw.quests.update(editingQuestId, { name, description, goals, skills, directory: directory || undefined });

  closeQuestEditor();
};

window.closeQuestEditor = function() {
  editingQuestId = null;
  // Rebuild the entire left panel
  rebuildLeftPanel();
  renderQuests();
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
      div.innerHTML = `<span class="msg-prefix">${m.emoji || '🤖'} [${escHtml(m.name)}]</span><span class="msg-text">${escHtml(m.text)}</span>`;
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
      headerAvatar.innerHTML = agent.emoji || '🤖';
    }
  }
  if (headerStatus) {
    const isLeader = agent.isMain;
    headerStatus.textContent = isLeader ? '★ leader · online' : 'online';
    headerStatus.className = 'chat-header-status online';
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
    // Avatar (image or emoji)
    if (agent.avatar && String(agent.avatar).startsWith('data:')) {
      const img = document.createElement('img');
      img.className = 'companion-tab-avatar';
      img.src = agent.avatar;
      img.alt = agent.name;
      tab.appendChild(img);
    } else {
      const em = document.createElement('div');
      em.className = 'companion-tab-emoji';
      em.textContent = agent.emoji || '🤖';
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

function updateChatTarget() {
  // chat-target element was removed — no-op
}

window.sendChat = async function() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message || chatBusy || agentOrder.length === 0) return;

  // Wake companion if sleeping
  nudgeNightWake();

  const agent = agents[agentOrder[focusIndex]];
  if (!agent) return;

  // Show user message
  addChatMsg('user', message, agent.name);
  input.value = '';

  // Always chat through the party leader
  const mainAgentId = agentOrder.find(id => agents[id]?.isMain);
  if (!mainAgentId) { addChatMsg('error', 'No companion found'); return; }

  // Build message with context
  let fullMessage = message;

  // Add quest context if active
  if (activeQuestId) {
    const quests = await cyberclaw.quests.list();
    const q = quests.find(q => q.id === activeQuestId);
    if (q) {
      let ctx = `[Active Quest: "${q.name}"`;
      if (q.description) ctx += ` — ${q.description}`;
      if (q.directory) ctx += ` | Project dir: ${q.directory}`;
      ctx += `] `;
      fullMessage = ctx + fullMessage;
    }
  }

  // Show typing indicator
  chatBusy = true;
  document.getElementById('chat-send').disabled = true;
  const typingId = addChatMsg('typing', `${agent.name} is thinking...`);

  try {
    const result = await cyberclaw.chat.sendMessage(mainAgentId, fullMessage);
    removeChatMsg(typingId);

    if (result.ok) {
      // Show response from party leader
      const leader = agents[mainAgentId];
      addChatMsg('agent', result.reply, leader?.name || 'Companion', leader?.emoji);

      // Check for quest creation command in reply
      if (result.reply) {
        var questMatch = result.reply.match(/\[CREATE_QUEST:\s*name="([^"]+)"\s*desc="([^"]*)"\s*(?:dir="([^"]*)")?\]/);
        if (questMatch) {
          var qName = questMatch[1];
          var qDesc = questMatch[2] || '';
          var qDir = questMatch[3] || '';
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
 */
window.sendChatMessage = async function(message) {
  window.addDesktopLog?.('📨', 'sendChatMessage called', `busy=${chatBusy} agents=${agentOrder.length} msg="${(message||'').substring(0,40)}"`, 'info');
  if (!message) return;
  // Wake companion if sleeping
  nudgeNightWake();
  if (chatBusy) {
    console.warn('[sendChatMessage] chatBusy=true, queuing message:', message.substring(0, 60));
    // Wait up to 15s for chatBusy to clear, then force-reset and proceed
    let waited = 0;
    while (chatBusy && waited < 15000) {
      await new Promise(r => setTimeout(r, 200));
      waited += 200;
    }
    if (chatBusy) {
      console.warn('[sendChatMessage] chatBusy stuck, force-resetting');
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

  const mainAgentId = agentOrder.find(id => agents[id]?.isMain);
  if (!mainAgentId) { addChatMsg('error', 'No companion found'); return; }

  const agent = agents[mainAgentId];
  if (!agent) return;

  let fullMessage = message;

  // Add quest context if active
  if (activeQuestId) {
    try {
      const quests = await cyberclaw.quests.list();
      const q = quests.find(q => q.id === activeQuestId);
      if (q) {
        let ctx = `[Active Quest: "${q.name}"`;
        if (q.description) ctx += ` — ${q.description}`;
        if (q.directory) ctx += ` | Project dir: ${q.directory}`;
        ctx += `] `;
        fullMessage = ctx + fullMessage;
      }
    } catch {}
  }

  chatBusy = true;
  window.addDesktopLog?.('🧠', 'AI thinking', message.substring(0, 60), 'voice');
  const typingId = addChatMsg('typing', `${agent.name} is thinking...`);
  try { ipcRenderer.invoke('sync-broadcast-typing', { active: true }); } catch {}

  try {
    const result = await cyberclaw.chat.sendMessage(mainAgentId, fullMessage);
    removeChatMsg(typingId);
    try { ipcRenderer.invoke('sync-broadcast-typing', { active: false }); } catch {}

    if (result.ok) {
      const leader = agents[mainAgentId];
      addChatMsg('agent', result.reply, leader?.name || 'Companion', leader?.emoji);
      window.addDesktopLog?.('💬', 'AI responded', result.reply.substring(0, 60), 'success');
      // Notify main process for mobile TTS response
      try { ipcRenderer.send('mobile-tts-response', { text: result.reply }); } catch {}
    } else {
      addChatMsg('error', `Error: ${result.error || 'Failed to get response'}`);
    }
  } catch (err) {
    removeChatMsg(typingId);
    try { ipcRenderer.invoke('sync-broadcast-typing', { active: false }); } catch {}
    addChatMsg('error', `Error: ${err.message}`);
  }

  chatBusy = false;
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
  }

  // Broadcast to mobile companion app
  if (type === 'agent' || type === 'user') {
    console.log(`[addChatMsg] Broadcasting ${type} message to mobile`);
    try {
      const { ipcRenderer } = require('electron');
      ipcRenderer.invoke('sync-broadcast-chat', {
        agentId: name || 'companion',
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
      div.innerHTML = `<span class="msg-prefix">${emoji || '🤖'} [${escHtml(name)}]</span><span class="msg-text">${escHtml(text)}</span>`;
      break;
    case 'typing':
      div.innerHTML = `<span class="msg-text" style="color:var(--text-muted);font-style:italic">${escHtml(text)}</span>`;
      break;
    case 'error':
      div.innerHTML = `<span class="msg-text" style="color:var(--red)">${escHtml(text)}</span>`;
      break;
  }

  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return id;
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
  // Initialise the chat channel tabs and pick the default chat target
  // (the party leader, falling back to the first agent).
  renderCompanionChannelTabs();
  const initialChat = agentOrder.find(id => agents[id]?.isMain) || agentOrder[0];
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
          var agentId = agentOrder.find(function(id) { return agents[id] && agents[id].isMain; });
          var agent = agentId ? agents[agentId] : null;
          if (agent) addChatMsg('agent', msg, agent.name, agent.emoji);
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
    const mainId = agentOrder.find(id => agents[id]?.isMain);
    const leader = mainId ? agents[mainId] : agents[agentOrder[0]];
    const sidekickCount = agentOrder.length - 1;
    bootMsgs.push({ d: 900, t: `> Companion: ${leader?.name || 'Unknown'}` });
    if (sidekickCount > 0) {
      bootMsgs.push({ d: 1200, t: `> ${sidekickCount} companion${sidekickCount > 1 ? 's' : ''} ready` });
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
// companions now, no spirit selection needed)

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

// All agents are Companions now (no more spirits). The companion forge
// opens for whoever is currently focused.
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
  // Persist to the sprite config so it survives a reload
  if (editorAgentId) {
    cyberclaw.agents.getSpriteConfig(editorAgentId).then(cfg => {
      cfg = cfg || {};
      cfg.scale = currentForgeScale;
      return cyberclaw.agents.saveSpriteConfig(editorAgentId, cfg);
    }).catch(e => console.warn('save scale:', e));
  }
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

  document.getElementById('companion-editor-overlay').classList.remove('hidden');
}

window.toggleCompanionPicker = function() {
  const picker = document.getElementById('companion-picker');
  if (picker) picker.classList.toggle('hidden');
};

window.closeCompanionEditor = function(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('companion-editor-overlay').classList.add('hidden');
  if (forgeCompanionSprite) { forgeCompanionSprite.dispose(); forgeCompanionSprite = null; }
  editorAgentId = null;
};
// ── SPIRIT FORGE — removed in v3.1.1 ──────────────────────────────────
// (all agents are companions now; the spirit editor is no longer wired
// to anything. The save path also unified: saveCompanion handles both
// editing an existing companion and creating a new one.)

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
    });
    await cyberclaw.agents.saveAvatar(editorAgentId, canvas.toDataURL('image/png'));
    agent.avatar = canvas.toDataURL('image/png');
    agent._pixelCompanionId = selectedPixelCompanion;
    agent._spiritId = null;
    if (newName) agent.name = newName;
    agent.traits = getCheckedTraits();
    const savedModel = document.getElementById('forge-model-primary')?.value;
    if (savedModel) {
      agent.primaryModel = savedModel;
      agent.model = formatModelName(savedModel);
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
  } catch (e) {
    debugLog('[Save] ERROR: ' + e.message + '\n' + e.stack);
    alert('Save failed: ' + e.message);
    pendingNewCompanionId = null;
  }
};

// (Save spirit path removed in v3.1.1 — all agents are companions now
// and the only save flow is window.saveCompanion.)

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
const DEFAULT_SETTINGS = {
  theme: 'dark',
  voiceLang: 'en-US',
  voiceKeybind: 'KeyV',
  voiceKeybindLabel: 'V',
  voiceAutoSend: false,
  ttsVoice: 'lessac',
  defaultModel: '',
  keyAnthropic: '',
  keyOpenai: '',
  keyGoogle: '',
  ollamaUrl: '',
  discordToken: '',
  telegramToken: '',
  // User profile
  userName: '',
  userGender: '' // 'male', 'female', or ''
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    return Object.assign({}, DEFAULT_SETTINGS, saved || {});
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
  // Legacy provider key fields were removed; values still in s.* if previously saved.
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
  // Refresh the dynamic providers list + default-model dropdown whenever settings opens
  try { renderProvidersList(); } catch (e) { console.warn('renderProvidersList:', e); }
  try { refreshDefaultModelDropdown(); } catch (e) { console.warn('refreshDefaultModelDropdown:', e); }
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
  const wellKnown = [
    { provider: 'Anthropic',  model: 'anthropic/claude-opus-4-6',   label: 'Claude Opus 4' },
    { provider: 'Anthropic',  model: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4' },
    { provider: 'Anthropic',  model: 'anthropic/claude-haiku-3.5',  label: 'Claude Haiku 3.5' },
    { provider: 'OpenAI',     model: 'openai/gpt-4o',              label: 'GPT-4o' },
    { provider: 'OpenAI',     model: 'openai/gpt-4o-mini',         label: 'GPT-4o Mini' },
    { provider: 'Google',     model: 'google/gemini-2.5-pro',      label: 'Gemini 2.5 Pro' },
    { provider: 'Google',     model: 'google/gemini-2.5-flash',    label: 'Gemini 2.5 Flash' },
    { provider: 'Local',      model: 'ollama/llama3',              label: 'Ollama — Llama 3' },
  ];
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

// Populate the companion forge model dropdown with hard-coded + custom providers
async function refreshForgeModelDropdowns() {
  const providers = await fetchProviders();
  // Hard-coded well-known models
  const wellKnown = [
    { group: 'Anthropic', options: [
      { value: 'anthropic/claude-opus-4-6',   label: 'Claude Opus 4' },
      { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4' },
      { value: 'anthropic/claude-haiku-3.5',  label: 'Claude Haiku 3.5' },
    ]},
    { group: 'OpenAI', options: [
      { value: 'openai/gpt-4o',              label: 'GPT-4o' },
      { value: 'openai/gpt-4o-mini',         label: 'GPT-4o Mini' },
    ]},
    { group: 'Google', options: [
      { value: 'google/gemini-2.5-pro',      label: 'Gemini 2.5 Pro' },
      { value: 'google/gemini-2.5-flash',    label: 'Gemini 2.5 Flash' },
    ]},
    { group: 'Local', options: [
      { value: 'ollama/llama3',              label: 'Ollama — Llama 3' },
    ]},
  ];
  // Custom providers
  for (const p of providers) {
    const model = (p.defaultModel || '').trim();
    if (!model) continue;
    wellKnown.push({ group: p.name || p.id, options: [{ value: model, label: model }] });
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

  ipcRenderer.on('mobile-request-chat-history', () => {
    // Send current chat history to mobile
    console.log('[App] Mobile requesting chat history, sending', chatHistory.length, 'messages');
    ipcRenderer.invoke('sync-send-chat-history', { messages: chatHistory.slice(-50) })
      .then(() => console.log('[App] Chat history sent successfully'))
      .catch(err => console.log('[App] Error sending chat history:', err));
  });

  // Route mobile chat to companion
  ipcRenderer.on('mobile-chat', (e, { text, agentId, meta }) => {
    console.log('[mobile-chat] received:', text?.substring(0, 60), 'sendChatMessage defined:', typeof window.sendChatMessage);
    window.addDesktopLog?.('💬', 'Mobile chat → AI', text?.substring(0, 50), 'info');
    addChatMsg('user', text);
    if (typeof window.sendChatMessage === 'function') {
      window.sendChatMessage(text);
    } else {
      // Fallback: retry after 2s if not ready yet
      setTimeout(() => {
        console.log('[mobile-chat] retry sendChatMessage, defined:', typeof window.sendChatMessage);
        if (typeof window.sendChatMessage === 'function') window.sendChatMessage(text);
      }, 2000);
    }
  });

  ipcRenderer.on('mobile-voice', (e, { transcript, context, meta }) => {
    const prompt = context
      ? `[Voice from mobile — last ${meta.lookbackMinutes}min context: "${context}"]\n\nUser said: ${transcript}`
      : transcript;
    console.log('[mobile-voice] received:', transcript?.substring(0, 60));
    window.addDesktopLog?.('🎤', 'Voice → AI', transcript?.substring(0, 50), 'info');
    addChatMsg('user', `🎤 ${transcript}`);
    if (typeof window.sendChatMessage === 'function') {
      window.sendChatMessage(prompt);
    } else {
      setTimeout(() => {
        if (typeof window.sendChatMessage === 'function') window.sendChatMessage(prompt);
      }, 2000);
    }
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

        console.log('[App] Updating arena from mobile:', companionId);
        localStorage.setItem('cyberclaw-selected-companion', companionId);
        window.pixelArena.setCompanion(window.leaderId, companionId, companionName);
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
    const mainAgentId = agentOrder.find(function(id) { return agents[id] && agents[id].isMain; });
    if (!mainAgentId) { addChatMsg('error', 'No companion found'); return; }

    let fullMessage = (message || 'Describe this image') + '\n[Image attached: ' + imgData.filename + ']';

    chatBusy = true;
    document.getElementById('chat-send').disabled = true;
    const typingId = addChatMsg('typing', agent.name + ' is thinking...');

    try {
      const result = await cyberclaw.chat.sendMessage(mainAgentId, fullMessage, { image: imgData.dataUrl });
      removeChatMsg(typingId);
      if (result.ok) {
        const leader = agents[mainAgentId];
        addChatMsg('agent', result.reply, leader && leader.name || 'Companion', leader && leader.emoji);
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
      removeChatMsg(typingId);
      addChatMsg('error', 'Error: ' + err.message);
    }

    chatBusy = false;
    document.getElementById('chat-send').disabled = false;
    input.focus();
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
    promptCompanionReaction('The user wants to play with you! They opened the toy box. Give a short excited reaction about playtime.');
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
  // Silent while asleep (night + not woken by user)
  if (isAsleep()) return;
  var agentId = agentOrder.find(function(id) { return agents[id] && agents[id].isMain; });
  if (!agentId) return;
  var agent = agents[agentId];
  if (!agent) return;
  // Don't fire if main chat or another reaction is already running
  if (chatBusy || reactionBusy) return;

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
      addChatMsg('agent', reply, agent.name, agent.emoji);
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
  var agentId = agentOrder.find(function(id) { return agents[id] && agents[id].isMain; });
  if (!agentId) return '';
  var agent = agents[agentId];
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
  'Make a playful comment about being bored and suggest something fun to do.',
  'Say something quirky about being a digital creature living on a computer.',
  'Make a short comment about food or treats (hint that you\'re hungry).',
  'Ask the user what they\'re working on today in a curious way.',
  'Say something random and funny about the forest or nature.',
  'Make a light observation about the user seeming busy or quiet.',
  'Say something about wanting to go on an adventure.',
];

function isNightTime() {
  var h = new Date().getHours();
  return h >= 22 || h < 8;
}

// ── SLEEP WAKE LOGIC ────────────────────────────────────────
var _nightWakeTimer = null;
window._nightWakeTimer = null;
var _wakeDurationMs = 10 * 60 * 1000; // 10 minutes

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

function scheduleIdleChatter() {
  // Random interval between 19 and 31 minutes (~20% less frequent than before)
  var minMs = 19 * 60 * 1000;
  var maxMs = 31 * 60 * 1000;
  var delay = minMs + Math.random() * (maxMs - minMs);

  setTimeout(function() {
    // Silent while asleep
    if (!isAsleep()) {
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
    { id: 'black_grouse', name: '🐦 Black Grouse', desc: 'Proud and rare spirit' }
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
          console.log('[Companions] leaderId:', leaderId);
          if (leaderId && window.pixelArena.setCompanion) {
            console.log('[Companions] Calling setCompanion with:', leaderId, companionId, displayName);
            try {
              window.pixelArena.setCompanion(leaderId, companionId, displayName);
              console.log('[Companions] Arena updated successfully');
            } catch (e) {
              console.error('[Companions] setCompanion error:', e);
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

// (Spirits view removed in v3.1.0 — companion visuals are managed through
// the Companion Forge. The previous no-op stubs are deleted in v3.1.1
// since nothing references them anymore.)

window.editSpiritFromView = function(agentId) {
  setTimeout(function() {
    var idx = agentOrder.indexOf(agentId);
    if (idx >= 0) focusIndex = idx;
    openCompanionForge(agentId);
  }, 150);
};

