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

      agents[a.id] = {
        name: a.name,
        class: a.class,
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

    el.innerHTML = `
      <div class="carousel-avatar ${agent.rarity}-aura" style="position:relative">
        ${avatarContent}
        <div class="carousel-status ${agent.status}"></div>
      </div>
      <div class="carousel-label">
        <span class="carousel-label-name ${agent.rarity}-text">${agent.name}</span>
        <span class="carousel-label-class">${agent.class}</span>
        <div class="carousel-label-channel">
          <span class="channel-badge ${agent.channelBadge}">${agent.channelIcon} ${agent.channel}</span>
        </div>
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

  // Update focused agent strip (below carousel)
  updateFocused(agentOrder[focusIndex]);
  updateChatTarget();
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
// Inspect panel (always shows party leader)
// ---------------------------------------------------------------------------
function updateInspect(agentId) {
  const agent = agents[agentId];
  if (!agent) return;

  // Always shows party leader
  document.getElementById('right-header-text').textContent = 'PARTY LEADER';

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

  document.getElementById('inspect-channel-badge').innerHTML =
    `<span class="channel-badge ${agent.channelBadge}">${agent.channelIcon} ${agent.channelDetail}</span>`;

  setBar('inspect-hp', agent.hp);
  setBar('inspect-mp', agent.mp);
  setBar('inspect-xp', agent.xp);

  document.getElementById('inspect-model').textContent = agent.model;
  document.getElementById('inspect-provider').textContent = agent.provider;
  document.getElementById('inspect-channel').textContent = agent.channel;
  document.getElementById('inspect-workspace').textContent = agent.workspace;
  document.getElementById('inspect-workspace').title = agent.workspace;

  const skillsEl = document.getElementById('inspect-skills');
  const icons = { 'Coding Agent': '💻', 'Weather': '🌤️', 'Healthcheck': '🔒', 'Skill Creator': '📜' };
  skillsEl.innerHTML = agent.skills.length === 0
    ? '<div style="color:var(--text-muted);font-size:10px">No skills equipped</div>'
    : agent.skills.map(s => `<div class="skill-slot-sm"><div class="skill-icon-sm">${icons[s]||'✨'}</div><span class="skill-name-sm">${s}</span></div>`).join('');
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

window.selectQuest = function(el) {
  document.querySelectorAll('.quest-item').forEach(q => q.classList.remove('quest-selected'));
  el.classList.add('quest-selected');
};

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
    background: '#05050a', foreground: '#e0e0e0', cursor: '#00ffcc', cursorAccent: '#05050a',
    selectionBackground: '#a855f740',
    black: '#1a1a2e', red: '#ef4444', green: '#4ade80', yellow: '#fbbf24',
    blue: '#3b82f6', magenta: '#a855f7', cyan: '#00ffcc', white: '#e0e0e0',
    brightBlack: '#555', brightRed: '#f87171', brightGreen: '#86efac',
    brightYellow: '#fde68a', brightBlue: '#93c5fd', brightMagenta: '#c084fc',
    brightCyan: '#5eead4', brightWhite: '#ffffff',
  };
}

function initMainTerminal() {
  const c = document.getElementById('terminal-container');
  mainTerminal = new Terminal({ theme: termTheme(), fontFamily: '"JetBrains Mono", monospace', fontSize: 12, lineHeight: 1.2, cursorBlink: true, cursorStyle: 'bar', scrollback: 5000, allowProposedApi: true });
  mainFit = new FitAddon();
  mainTerminal.loadAddon(mainFit);
  mainTerminal.loadAddon(new WebLinksAddon());
  mainTerminal.open(c);
  mainFit.fit();
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

  // Show typing indicator
  chatBusy = true;
  document.getElementById('chat-send').disabled = true;
  const typingId = addChatMsg('typing', `${agent.name} is thinking...`);

  try {
    const result = await cyberclaw.chat.sendMessage(agent.id, message);
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

  // Right panel always shows the party leader
  const leaderId = agentOrder.find(id => agents[id].isMain) || agentOrder[0];
  if (leaderId) updateInspect(leaderId);

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
    const leaderId = agentOrder.find(id => agents[id].isMain) || agentOrder[0];
    if (leaderId) updateInspect(leaderId);
    updateRateLimit();
  }, 30000);

  // Initial rate limit check
  updateRateLimit();
});
