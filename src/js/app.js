/* ============================================================
   CyberClaw — Main application logic
   ============================================================ */

const { Terminal } = require('xterm');
const { FitAddon } = require('xterm-addon-fit');
const { WebLinksAddon } = require('xterm-addon-web-links');

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

      agents[a.id] = {
        name: a.name,
        class: cleanClass,
        id: a.id,
        avatar: a.avatar,
        emoji: a.emoji || '🤖',
        rarity,
        model: 'Claude Opus 4',
        provider: 'Anthropic',
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
            model: run.model || 'Claude Opus 4',
            provider: 'Anthropic',
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
// Carousel — 3D rotating platform
// ---------------------------------------------------------------------------
function buildCarousel() {
  const ring = document.getElementById('carousel-ring');
  ring.innerHTML = '';

  agentOrder.forEach((id, i) => {
    const agent = agents[id];
    const el = document.createElement('div');
    el.className = 'carousel-agent';
    el.setAttribute('data-index', i);
    el.setAttribute('data-id', id);
    el.onclick = () => { focusIndex = i; updateCarousel(); };

    const avatarContent = agent.avatar
      ? `<img src="${agent.avatar}" alt="${agent.name}">`
      : `<div class="carousel-emoji">${agent.emoji}</div>`;

    const crownHtml = agent.isMain ? '<div class="carousel-crown">👑</div>' : '';

    el.innerHTML = `
      <div class="carousel-avatar ${agent.rarity}-aura" style="position:relative">
        ${crownHtml}
        ${avatarContent}
        <div class="carousel-status ${agent.status}"></div>
      </div>
      <div class="carousel-label">
        <span class="carousel-label-name ${agent.rarity}-text">${agent.name}</span>
        <span class="carousel-label-class">${agent.class}</span>
      </div>
    `;
    ring.appendChild(el);
  });

  updateCarousel();
}

function updateCarousel() {
  const items = document.querySelectorAll('.carousel-agent');
  const n = items.length;
  if (n === 0) return;

  const arena = document.getElementById('party-arena');
  const aW = arena.offsetWidth;
  const aH = arena.offsetHeight;
  const centerX = aW / 2;
  const centerY = aH / 2 - 20;

  const rx = Math.min(aW * 0.40, 380);
  const ry = 70;

  items.forEach((el, i) => {
    let offset = i - focusIndex;
    if (offset > n / 2) offset -= n;
    if (offset < -n / 2) offset += n;

    const angle = (offset / n) * Math.PI * 2;
    const x = centerX + Math.sin(angle) * rx;
    const y = centerY + Math.cos(angle) * ry * 0.5;
    const depth = Math.cos(angle);

    const scale = 0.5 + (depth + 1) * 0.25;
    const z = Math.round((depth + 1) * 100);

    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(2)})`;
    el.style.zIndex = z;
    // All companions visible — further back = more faded
    const opacity = Math.max(0.15, (depth + 1) / 2);
    el.style.opacity = opacity;
    el.style.filter = `brightness(${Math.max(0.2, 0.4 + depth * 0.3 + 0.3).toFixed(2)})`;
    el.style.pointerEvents = opacity < 0.2 ? 'none' : 'all';

    el.classList.remove('focused', 'side', 'far-side', 'hidden-back');
    if (offset === 0) el.classList.add('focused');
    else if (Math.abs(offset) === 1) el.classList.add('side');
    else el.classList.add('far-side');
  });

  // Update focused agent strip + right panel
  const focusedId = agentOrder[focusIndex];
  updateFocused(focusedId);
  updateInspect(focusedId);
  updateChatTarget();

  // Show 3D model in arena for focused companion
  updateArena3D(focusedId);
}

async function updateArena3D(agentId) {
  if (!agentId) return;
  const agent = agents[agentId];
  if (!agent) return;

  // Get sprite config to find cybermonId
  try {
    const config = await cyberclaw.agents.getSpriteConfig(agentId);
    const cybermonId = config?.cybermonId;

    if (cybermonId) {
      // Initialize arena viewer if needed
      if (!arenaViewer && CybermonViewer) {
        try { arenaViewer = new CybermonViewer('arena-3d-viewer'); } catch(e) { console.warn('Arena 3D viewer failed:', e); }
      }
      // Load the 3D model
      const mon = cybermonCatalog?.cybermons?.find(m => m.id === cybermonId);
      const rimColor = mon?.elements?.[0] ? ELEMENT_COLORS[mon.elements[0]] : '#00aaff';
      arenaViewer.show(cybermonId, { rimColor });

      // Hide the focused carousel item's avatar (3D replaces it)
      const focusedEl = document.querySelector('.carousel-agent.focused');
      if (focusedEl) focusedEl.style.opacity = '0.15';
    } else {
      // No cybermon — clear 3D, show default carousel
      if (arenaViewer) arenaViewer.clear();
    }
  } catch (e) {
    // No config — just show normal carousel
    if (arenaViewer) arenaViewer.clear();
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
// Focused agent strip (below carousel)
// ---------------------------------------------------------------------------
function updateFocused(agentId) {
  const agent = agents[agentId];
  if (!agent) return;

  const img = document.getElementById('focused-avatar-img');
  const emoji = document.getElementById('focused-emoji');
  if (agent.avatar) { img.src = agent.avatar; img.style.display = 'block'; emoji.style.display = 'none'; }
  else { img.style.display = 'none'; emoji.style.display = 'flex'; emoji.textContent = agent.emoji || '🤖'; }

  document.getElementById('focused-border').className = `focused-avatar-border ${agent.rarity}`;
  document.getElementById('focused-name').textContent = agent.name;
  document.getElementById('focused-name').className = `${agent.rarity}-text`;
  document.getElementById('focused-class').textContent = agent.class;
  document.getElementById('focused-id').textContent = agent.id;

  const statusEl = document.getElementById('focused-status');
  statusEl.innerHTML = `<span class="status-dot ${agent.status}"></span> ${agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}`;

  document.getElementById('focused-channel-badge').innerHTML =
    `<span class="channel-badge ${agent.channelBadge}">${agent.channelIcon} ${agent.channelDetail}</span>`;

  setBar('focused-hp', agent.hp);
  setBar('focused-mp', agent.mp);
  setBar('focused-xp', agent.xp);

  document.getElementById('focused-model').textContent = agent.model;
  document.getElementById('focused-provider').textContent = agent.provider;

  // Skills
  const icons = { 'Coding Agent': '💻', 'Weather': '🌤️', 'Healthcheck': '🔒', 'Skill Creator': '📜' };
  const skillsEl = document.getElementById('focused-skills');
  skillsEl.innerHTML = agent.skills.length === 0
    ? '<span class="focused-skill-tag" style="color:var(--text-muted)">No skills</span>'
    : agent.skills.map(s => `<span class="focused-skill-tag"><span class="skill-tag-icon">${icons[s]||'✨'}</span>${s}</span>`).join('');
}

// ---------------------------------------------------------------------------
// Inspect panel (shows focused/selected companion)
// ---------------------------------------------------------------------------
function updateInspect(agentId) {
  const agent = agents[agentId];
  if (!agent) return;

  document.getElementById('right-header-text').textContent = agent.isMain ? 'PARTY LEADER' : agent.name?.toUpperCase() || 'COMPANION';

  // Portrait
  const img = document.getElementById('inspect-avatar-img');
  const emoji = document.getElementById('inspect-emoji');
  if (agent.avatar) { img.src = agent.avatar; img.style.display = 'block'; emoji.style.display = 'none'; }
  else { img.style.display = 'none'; emoji.style.display = 'flex'; emoji.textContent = agent.emoji || '🤖'; }

  document.getElementById('inspect-border').className = `inspect-avatar-border ${agent.rarity}`;
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

    setBar('inspect-mp', agent.mp);
    setBar('inspect-xp', [stats.xp, xpNeeded]);

    // Show level
    const levelEl = document.getElementById('inspect-level');
    if (levelEl) levelEl.textContent = `Lv.${stats.level}`;

    // RuneScape-style skill list — all categories shown with level + XP bar
    const skillsEl = document.getElementById('inspect-skills');
    const allSkills = [
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
    const skills = stats.skills || {};
    skillsEl.innerHTML = allSkills.map(s => {
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
  });

  document.getElementById('inspect-model').textContent = agent.model;
  document.getElementById('inspect-provider').textContent = agent.provider;
  loadEquipment(agentId);
  document.getElementById('inspect-channel').textContent = agent.channel;
  document.getElementById('inspect-workspace').textContent = agent.workspace;
  document.getElementById('inspect-workspace').title = agent.workspace;
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

// Estimate progress to next full version based on semver
function getVersionProgress(version) {
  if (!version) return 0;
  const parts = version.split('.');
  if (parts.length < 2) return 0;
  const minor = parseInt(parts[1]) || 0;
  const patch = parseInt(parts[2]) || 0;
  // Assume 10 minor versions = 1 major, each minor = 10%
  // Patch adds fractional progress within the minor
  const progress = Math.min(95, (minor * 10) + Math.min(9, patch));
  return progress;
}

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
    // Find companions assigned to this quest
    const assignedCompanions = agentOrder
      .map(id => agents[id])
      .filter(a => a && a.assignedQuest === q.id);
    const companionAvatars = assignedCompanions.length > 0
      ? `<div class="quest-companions">${assignedCompanions.map(a =>
          a.avatar
            ? `<img class="quest-companion-avatar" src="${a.avatar}" title="${a.name}" />`
            : `<span class="quest-companion-emoji" title="${a.name}">${a.emoji || '🤖'}</span>`
        ).join('')}</div>`
      : '';

    div.innerHTML = `
      <div class="quest-top-row">
        <div class="quest-name">${isComplete ? '✅' : '⚔️'} ${escapeHtml(q.name)}</div>
        <div class="quest-top-actions">
          <button class="quest-edit-btn" onclick="openQuestEditor(event,'${q.id}')" title="Edit">✏️</button>
          <button class="quest-delete" onclick="deleteQuest(event,'${q.id}')" title="Delete">✕</button>
        </div>
      </div>
      ${q.description ? `<div class="quest-desc">${escapeHtml(q.description)}</div>` : ''}
      ${companionAvatars}
      ${q.directory ? `<div class="quest-dir">📁 ${escapeHtml(q.directory.split('/').pop() || q.directory)}</div>` : ''}
      <div class="quest-progress">
        <div class="quest-bar"><div class="quest-fill" style="width:${getVersionProgress(q.version)}%"></div></div>
        <span class="quest-pct">${getVersionProgress(q.version)}%</span>
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
  // Ensure at least one empty input
  const items = Array.isArray(goals) ? [...goals] : [];
  if (items.length === 0 || items[items.length - 1].trim() !== '') items.push('');
  return items.map((g, i) =>
    `<div class="qe-goal-row">
      <span class="qe-goal-num">${i + 1}.</span>
      <input type="text" class="qe-goal-input" value="${escapeHtml(g)}" placeholder="Goal ${i + 1}..." oninput="onGoalInput()" />
      ${i > 0 && g.trim() === '' ? '' : ''}
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

  // Get all companions for assignment checkboxes
  const companionChecks = agentOrder.map(id => {
    const a = agents[id];
    if (!a) return '';
    const checked = a.assignedQuest === questId ? 'checked' : '';
    const avatar = a.avatar
      ? `<img src="${a.avatar}" class="qe-companion-img" />`
      : `<span class="qe-companion-emoji">${a.emoji || '🤖'}</span>`;
    return `<label class="qe-companion-row">
      <input type="checkbox" value="${id}" ${checked} />
      ${avatar}
      <span>${a.name}</span>
    </label>`;
  }).join('');

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
      <div class="editor-field">
        <label>Assigned Companions</label>
        <div class="qe-companions-list">${companionChecks}</div>
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
  const goals = Array.from(goalInputs).map(i => i.value.trim()).filter(g => g !== '');
  const directory = document.getElementById('qe-dir').value.trim();

  // Gather skills
  const skillChecks = document.querySelectorAll('.qe-content .skill-checkbox-grid input[type="checkbox"]');
  const skills = Array.from(skillChecks).filter(cb => cb.checked).map(cb => cb.value);

  // Gather assigned companions
  const companionChecks = document.querySelectorAll('.qe-companions-list input[type="checkbox"]');
  const assignedIds = Array.from(companionChecks).filter(cb => cb.checked).map(cb => cb.value);
  const unassignedIds = Array.from(companionChecks).filter(cb => !cb.checked).map(cb => cb.value);

  // Update quest
  await cyberclaw.quests.update(editingQuestId, { name, description, goals, skills, directory: directory || undefined });

  // Update companion assignments
  for (const id of assignedIds) {
    if (agents[id]) {
      agents[id].assignedQuest = editingQuestId;
      await cyberclaw.agents.saveSpriteConfig(id, {
        ...(await cyberclaw.agents.getSpriteConfig(id) || {}),
        assignedQuest: editingQuestId,
      });
    }
  }
  for (const id of unassignedIds) {
    if (agents[id] && agents[id].assignedQuest === editingQuestId) {
      agents[id].assignedQuest = null;
      const cfg = await cyberclaw.agents.getSpriteConfig(id) || {};
      cfg.assignedQuest = null;
      await cyberclaw.agents.saveSpriteConfig(id, cfg);
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

function rebuildLeftPanel() {
  const panel = document.getElementById('panel-left');
  panel.innerHTML = `
    <div class="panel-header">
      <span class="rune-icon">📜</span> QUEST LOG
      <button class="quest-add-btn" onclick="showQuestForm()" title="New Quest">+</button>
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
      <div class="stat-row"><span class="stat-key">Channel</span><span class="stat-value" id="inspect-channel">Discord</span></div>
      <div class="stat-row"><span class="stat-key">Workspace</span><span class="stat-value truncate" id="inspect-workspace">/media/.../2Print</span></div>
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
      <div class="stat-row"><span class="stat-key">Companions</span><span class="stat-value" id="stat-companions">0</span></div>
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
  document.querySelectorAll('.term-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.term-view').forEach(v => v.classList.remove('active'));
  document.querySelector(`.term-tab[data-tab="${tabName}"]`).classList.add('active');
  document.getElementById(`view-${tabName}`).classList.add('active');
  setTimeout(() => { mainFit?.fit(); }, 50);
};

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
  const el = document.getElementById('chat-target');
  if (agentOrder.length === 0) {
    el.textContent = '🤖 —';
    return;
  }
  const agent = agents[agentOrder[focusIndex]];
  if (agent) {
    el.textContent = `${agent.emoji || '🤖'} ${agent.name}`;
  }
}

window.sendChat = async function() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message || chatBusy || agentOrder.length === 0) return;

  const agent = agents[agentOrder[focusIndex]];
  if (!agent) return;

  // Show user message
  addChatMsg('user', message, agent.name);
  input.value = '';

  // Build message with quest context if active
  let fullMessage = message;
  if (activeQuestId) {
    const quests = await cyberclaw.quests.list();
    const q = quests.find(q => q.id === activeQuestId);
    if (q) {
      let ctx = `[Active Quest: "${q.name}"`;
      if (q.description) ctx += ` — ${q.description}`;
      if (q.directory) ctx += ` | Project dir: ${q.directory}`;
      ctx += `] `;
      fullMessage = ctx + message;
    }
  }

  // Show typing indicator
  chatBusy = true;
  document.getElementById('chat-send').disabled = true;
  const typingId = addChatMsg('typing', `${agent.name} is thinking...`);

  try {
    const result = await cyberclaw.chat.sendMessage(agent.id, fullMessage);
    removeChatMsg(typingId);

    if (result.ok) {
      addChatMsg('agent', result.reply, agent.name, agent.emoji);
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

let chatMsgId = 0;
function addChatMsg(type, text, name, emoji) {
  const msgs = document.getElementById('chat-messages');
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
    case 'system':
      div.innerHTML = `<span class="msg-prefix">[SYS]</span><span class="msg-text">${escHtml(text)}</span>`;
      break;
  }

  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
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

// Runtime counter
setInterval(() => {
  const s = Math.floor((Date.now() - startTime) / 1000);
  const el = document.getElementById('stat-runtime');
  if (el) el.textContent = [Math.floor(s/3600), Math.floor(s%3600/60), s%60].map(v => String(v).padStart(2,'0')).join(':');
}, 1000);

// Resize carousel on window resize
window.addEventListener('resize', () => { requestAnimationFrame(updateCarousel); });

// Update system section with live companion count
function updateSystemInfo() {
  const el = document.getElementById('stat-companions');
  if (el) el.textContent = agentOrder.length.toString();
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

// Boot
document.addEventListener('DOMContentLoaded', async () => {
  // Discover agents from OpenClaw
  await loadAgents();

  if (agentOrder.length === 0) {
    console.warn('No companions found');
  }

  // Pre-load Cybermon catalog for 3D arena
  try { await loadCybermonCatalog(); } catch(e) { console.warn('Catalog load failed:', e); }

  buildCarousel();
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
  if (agentOrder[focusIndex]) updateInspect(agentOrder[focusIndex]);

  initMainTerminal();

  // Chat input Enter key
  document.getElementById('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window.sendChat(); }
  });

  // Boot messages in chat
  const msgs = document.getElementById('chat-messages');
  const bootMsgs = [
    { d: 400,  t: '> CyberClaw v0.1.0 initializing...' },
  ];

  if (agentOrder.length > 0) {
    bootMsgs.push({ d: 900, t: `> Discovered ${agentOrder.length} companion(s)...` });
    agentOrder.forEach((id, i) => {
      const a = agents[id];
      const statusIcon = a.status === 'online' ? '⚔️' : '💤';
      bootMsgs.push({
        d: 1400 + i * 300,
        t: `> ${statusIcon} ${a.name} (${a.class}) — ${a.status.toUpperCase()}`
      });
    });
    bootMsgs.push({
      d: 1400 + agentOrder.length * 300 + 400,
      t: '> Party assembled. Use ← → to rotate.'
    });
  } else {
    bootMsgs.push({ d: 900, t: '> No companions found. Create one to get started!' });
  }

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

    // Only rebuild carousel DOM if agents changed
    const orderChanged = agentOrder.length !== oldOrder.length || agentOrder.some((id, i) => id !== oldOrder[i]);
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
// Companion Editor (Cybermon Gallery + Sprite Generator + Skill Assignment)
// ---------------------------------------------------------------------------
let editorAgentId = null;
let selectedCybermon = null;
let cybermonCatalog = null;
let activeFilters = { animal: null, element: null, mood: null };
let arenaViewer = null; // Three.js viewer for the arena
let editorViewer = null; // Three.js viewer for the editor preview

// Three.js viewer — lazy loaded to avoid breaking app if it fails
let CybermonViewer = null;
try {
  CybermonViewer = require('./js/cybermon-viewer.js').CybermonViewer;
} catch (e) {
  console.warn('CybermonViewer failed to load:', e.message);
}

const ELEMENT_COLORS = {
  fire: '#f24d05', water: '#1a73e8', electric: '#ffd900', nature: '#40b840',
  shadow: '#6a1ab3', ice: '#99d9ff', steel: '#8c949e', toxic: '#73cc19', cyber: '#00a8d9'
};
const ELEMENT_EMOJI = {
  fire: '🔥', water: '💧', electric: '⚡', nature: '🌿', shadow: '🌑',
  ice: '❄️', steel: '⚙️', toxic: '☠️', cyber: '🤖'
};
const ANIMAL_EMOJI = {
  fox: '🦊', cat: '🐱', dog: '🐕', bird: '🐦', fish: '🐟', snake: '🐍',
  turtle: '🐢', rabbit: '🐰', dragon: '🐉', wolf: '🐺', frog: '🐸',
  owl: '🦉', bat: '🦇', bear: '🐻', shark: '🦈'
};
const MOOD_EMOJI = { cute: '🥰', fierce: '😤', chill: '😎', angry: '😠', playful: '😜' };

async function loadCybermonCatalog() {
  if (cybermonCatalog) return cybermonCatalog;
  try {
    const path = require('path');
    const fs = require('fs');
    const catalogPath = path.join(__dirname, 'assets', 'cybermons', 'catalog.json');
    const data = fs.readFileSync(catalogPath, 'utf-8');
    cybermonCatalog = JSON.parse(data);
    return cybermonCatalog;
  } catch (e) {
    console.error('Failed to load Cybermon catalog:', e);
    return { cybermons: [], animals: [], elements: [], moods: [], sizes: [] };
  }
}

function buildFilterChips(containerId, items, emojiMap, filterKey) {
  const container = document.getElementById(containerId);
  container.innerHTML = items.map(item =>
    `<span class="filter-chip" data-filter="${filterKey}" data-value="${item}" onclick="toggleFilter('${filterKey}','${item}')">${emojiMap[item] || ''} ${item}</span>`
  ).join('');
}

window.toggleFilter = function(key, value) {
  activeFilters[key] = activeFilters[key] === value ? null : value;
  // Update chip styles
  document.querySelectorAll(`.filter-chip[data-filter="${key}"]`).forEach(chip => {
    chip.classList.toggle('active', chip.dataset.value === activeFilters[key]);
  });
  renderCybermonGallery();
};

function renderCybermonGallery() {
  if (!cybermonCatalog) return;
  const grid = document.getElementById('cybermon-gallery');
  const filtered = cybermonCatalog.cybermons.filter(mon => {
    if (activeFilters.animal && mon.animal !== activeFilters.animal) return false;
    if (activeFilters.element && !mon.elements.includes(activeFilters.element)) return false;
    if (activeFilters.mood && mon.mood !== activeFilters.mood) return false;
    return true;
  });

  if (filtered.length === 0) {
    grid.innerHTML = '<div class="cybermon-empty">No matches — try different filters</div>';
    return;
  }

  const path = require('path');
  grid.innerHTML = filtered.map(mon => {
    const imgPath = path.join(__dirname, 'assets', 'cybermons', `${mon.id}.png`);
    const selected = selectedCybermon === mon.id ? 'selected' : '';
    const elementDots = mon.elements.map(e =>
      `<span class="element-dot" style="background:${ELEMENT_COLORS[e] || '#666'}"></span>`
    ).join('');
    return `<div class="cybermon-card ${selected}" onclick="selectCybermon('${mon.id}')" title="${mon.name} (${mon.elements.join('/')})">
      <div class="cybermon-elements">${elementDots}</div>
      <img src="file://${imgPath}" alt="${mon.name}" />
      <div class="cybermon-label">${mon.name}</div>
    </div>`;
  }).join('');
}

window.selectCybermon = function(id) {
  selectedCybermon = id;
  // Update gallery selection
  document.querySelectorAll('.cybermon-card').forEach(card => {
    card.classList.toggle('selected', card.querySelector('img')?.alt === cybermonCatalog?.cybermons.find(m => m.id === id)?.name);
  });
  // Show 3D preview in editor
  if (editorViewer) {
    const mon = cybermonCatalog?.cybermons.find(m => m.id === id);
    const rimColor = mon?.elements[0] ? ELEMENT_COLORS[mon.elements[0]] : '#00aaff';
    editorViewer.show(id, { rimColor });
  }
};

window.openCompanionEditor = function() {
  const agentId = agentOrder[focusIndex];
  if (!agentId) return;
  editorAgentId = agentId;
  const agent = agents[agentId];

  // Set name
  document.getElementById('editor-name').value = agent.name || '';

  // Initialize editor 3D preview
  if (editorViewer) editorViewer.dispose();
  if (CybermonViewer) {
    try { editorViewer = new CybermonViewer('editor-3d-viewer'); } catch(e) { console.warn('Editor 3D viewer failed:', e); }
  }

  // Initialize Cybermon gallery
  loadCybermonCatalog().then(catalog => {
    buildFilterChips('filter-animals', catalog.animals, ANIMAL_EMOJI, 'animal');
    buildFilterChips('filter-elements', catalog.elements, ELEMENT_EMOJI, 'element');
    buildFilterChips('filter-moods', catalog.moods, MOOD_EMOJI, 'mood');
    activeFilters = { animal: null, element: null, mood: null };
    selectedCybermon = null;
    renderCybermonGallery();
  });

  // Load saved config — restore selected cybermon
  cyberclaw.agents.getSpriteConfig(agentId).then(config => {
    if (config && config.cybermonId) {
      selectedCybermon = config.cybermonId;
      selectCybermon(config.cybermonId);
    }
  });

  // Populate skill checkboxes
  const skillTypes = ['Coding', 'Writing', 'Design', 'Analysis', 'Strategy', 'Research', 'Communication', 'Game', 'General'];
  const skillIcons = { Coding: '💻', Writing: '✍️', Design: '🎨', Analysis: '📊', Strategy: '🗺️', Research: '🔍', Communication: '💬', Game: '🎮', General: '✨' };
  const checkboxGrid = document.getElementById('editor-skill-checkboxes');
  const focusSkills = agent.focusSkills || [];
  checkboxGrid.innerHTML = skillTypes.map(s =>
    `<label><input type="checkbox" value="${s}" ${focusSkills.includes(s) ? 'checked' : ''}> ${skillIcons[s]||'✨'} ${s}</label>`
  ).join('');

  // Populate quest dropdown
  cyberclaw.quests.list().then(quests => {
    const select = document.getElementById('editor-quest');
    select.innerHTML = '<option value="">— None —</option>' +
      quests.map(q => `<option value="${q.id}" ${agent.assignedQuest === q.id ? 'selected' : ''}>${q.name}</option>`).join('');
  });

  document.getElementById('companion-editor-overlay').classList.remove('hidden');
};

window.closeCompanionEditor = function(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('companion-editor-overlay').classList.add('hidden');
  if (editorViewer) { editorViewer.dispose(); editorViewer = null; }
  editorAgentId = null;
};

window.saveCompanion = async function() {
  if (!editorAgentId) return;
  const agent = agents[editorAgentId];

  // Gather skill focus
  const checkboxes = document.querySelectorAll('#editor-skill-checkboxes input[type="checkbox"]');
  const focusSkills = Array.from(checkboxes).filter(cb => cb.checked).map(cb => cb.value);

  // Gather quest assignment
  const questId = document.getElementById('editor-quest').value || null;

  if (!selectedCybermon) return; // Must select a Cybermon

  // Save Cybermon selection
  const path = require('path');
  const fs = require('fs');
  const imgPath = path.join(__dirname, 'assets', 'cybermons', `${selectedCybermon}.png`);
  const imgData = fs.readFileSync(imgPath);
  const dataUrl = 'data:image/png;base64,' + imgData.toString('base64');

  await cyberclaw.agents.saveSpriteConfig(editorAgentId, {
    cybermonId: selectedCybermon,
    focusSkills,
    assignedQuest: questId,
  });
  await cyberclaw.agents.saveAvatar(editorAgentId, dataUrl);
  agent.avatar = dataUrl;

  // Update in-memory agent
  agent.focusSkills = focusSkills;
  agent.assignedQuest = questId;

  // Refresh UI
  buildCarousel();
  closeCompanionEditor();
};

// (populateSelect removed — pixel sprites replaced by Cybermon gallery)

// ---------------------------------------------------------------------------
// Equipment / Skills System
// ---------------------------------------------------------------------------
let allSkillsCache = null;

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
    if (!allSkillsCache) {
      document.getElementById('equip-search-results').innerHTML = '<div style="color:var(--text-muted);font-size:10px;padding:8px">Loading skills...</div>';
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
  if (!allSkillsCache) return;

  const filtered = allSkillsCache.filter(s =>
    s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query)
  ).slice(0, 8);

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
  const skill = allSkillsCache?.find(s => s.name === skillName);
  if (!skill) return;

  // Prompt for custom equipment name
  const customName = prompt(`Name this equipment (${skillName}):`, skillName);
  if (!customName) return;

  const config = await cyberclaw.agents.getSpriteConfig(agentId) || {};
  const equipment = config.equipment || [];
  // Don't duplicate
  if (equipment.find(e => e.skill === skillName)) return;

  equipment.push({
    skill: skillName,
    name: customName,
    icon: skill.ready ? '⚔️' : '📦',
    description: skill.description,
    ready: skill.ready,
  });

  config.equipment = equipment;
  await cyberclaw.agents.saveSpriteConfig(agentId, config);
  loadEquipment(agentId);
};
