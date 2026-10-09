/* ============================================================
   CyberClaw — Setup Wizard Logic
   ============================================================ */

// v3.1.34: Auto-detect companions from the local OpenClaw config.
// Reads the existing openclaw:discover payload, then creates a
// cyberclaw companion for each agent that isn't already registered
// as a companion. One click — the user just sees a result list.
window.autoDetectCompanions = async function() {
  const result = document.getElementById('auto-detect-result');
  if (result) { result.classList.remove('hidden'); result.textContent = 'Scanning ~/.openclaw/openclaw.json…'; }
  try {
    const discovery = await cyberclaw.openclaw.discover();
    const agents = (discovery && Array.isArray(discovery.agents)) ? discovery.agents : [];
    if (agents.length === 0) {
      if (result) result.textContent = 'No agents found in ~/.openclaw/openclaw.json. Use the manual import option below.';
      return;
    }
    // OpenClaw already has them registered; this wizard's
    // `createAgent` is idempotent (it falls back to set-model on
    // existing agents). Call it for each, then report.
    const lines = ['Found ' + agents.length + ' agent(s) in OpenClaw:'];
    for (const a of agents) {
      try {
        await cyberclaw.wizard.createAgent({
          name: a.id || a.name,
          vibe: 'openclaw',
          model: (a.primaryModel || ''),
          workspace: (a.workspace || ''),
        });
        const emoji = a.emoji || '🤖';
        lines.push('✓ ' + emoji + ' ' + (a.name || a.id) + '  (model: ' + (a.primaryModel || 'default') + ')');
      } catch (e) {
        lines.push('✗ ' + (a.name || a.id) + '  failed: ' + (e && e.message ? e.message : String(e)));
      }
    }
    lines.push('');
    lines.push('All set. Click Continue to go to the channel-setup step.');
    if (result) result.textContent = lines.join('\n');
  } catch (e) {
    if (result) result.textContent = 'Auto-detect failed: ' + (e && e.message ? e.message : String(e));
  }
};

// v3.1.34: Manual import flow — let the user pick any directory on
// disk as a new companion workspace. The directory doesn't need to
// be in /media…cts/; it's a free-form folder picker.
window.showManualImport = async function() {
  // Reuse the existing projects scan + picker logic. The scan
  // already filters out projects that are already quests/companions.
  await showImportQuest();
  // Override the picker header so the user knows this creates a
  // *companion* not a quest. (Import flow is shared; the resulting
  // IPC creates whatever the user has invoked.)
  const header = document.querySelector('.quest-import-header');
  if (header) header.textContent = 'Pick a folder to use as a companion workspace:';
};
// so the user can confirm at a glance which code is loaded.
// Uses the `wizard:get-version` IPC bridge (CSP blocks the renderer's
// file:// fetch, so we ask main.js to read package.json for us).
// Falls back to a literal "v-dev" so the pill is never blank.
(async function stampWizardVersion() {
  let version = null;
  try {
    if (cyberclaw && cyberclaw.wizard && typeof cyberclaw.wizard.getVersion === 'function') {
      version = await cyberclaw.wizard.getVersion();
    }
  } catch {}
  const el = document.getElementById('wizard-version-pill');
  if (!el) return;
  el.textContent = version ? 'v' + version : 'v-dev';
})();


let currentStep = 0;
let systemState = { node: false, npm: false, openclaw: false, gateway: false };
let selectedChannel = null;
let selectedVibe = 'helpful';

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function goStep(n) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  document.getElementById(`step-${n}`).classList.add('active');
  currentStep = n;
  updateDots();
}

function updateDots() {
  document.querySelectorAll('.dot').forEach((d, i) => {
    d.classList.remove('active', 'done');
    if (i < currentStep) d.classList.add('done');
    if (i === currentStep) d.classList.add('active');
  });
}

// ---------------------------------------------------------------------------
// Step 0: System Check
// ---------------------------------------------------------------------------
async function runChecks() {
  const checks = [
    { id: 'node', cmd: 'check-node' },
    { id: 'npm', cmd: 'check-npm' },
    { id: 'openclaw', cmd: 'check-openclaw' },
    { id: 'gateway', cmd: 'check-gateway' },
  ];

  for (const check of checks) {
    const result = await cyberclaw.wizard.check(check.cmd);
    const icon = document.getElementById(`check-${check.id}-icon`);
    const status = document.getElementById(`check-${check.id}-status`);

    if (result.ok) {
      icon.textContent = '✅';
      status.textContent = result.version || 'installed';
      status.className = 'check-status ok';
      systemState[check.id] = true;
    } else {
      icon.textContent = '❌';
      status.textContent = result.message || 'not found';
      status.className = 'check-status missing';
      systemState[check.id] = false;
    }
  }

  const btn = document.getElementById('btn-check');
  btn.disabled = false;

  // Determine what needs to happen next
  const needsNode = !systemState.node;
  const needsNpm = !systemState.npm;
  const needsOpenClaw = !systemState.openclaw;
  const needsGateway = !systemState.gateway;

  if (needsNode || needsNpm || needsOpenClaw) {
    // Go to install step — it will handle everything
    btn.textContent = 'Install Requirements →';
    btn.onclick = () => goStep(1);
  } else if (needsGateway) {
    btn.textContent = 'Start Gateway →';
    btn.onclick = () => goStep(5);
  } else {
    const hasAgents = await cyberclaw.wizard.check('check-agents');
    if (hasAgents.ok && hasAgents.count > 0) {
      btn.textContent = 'Launch CyberClaw →';
      // v3.1.34: also show the Import from OpenClaw button so
      // the user can pick a different agent without having to
      // uninstall existing ones first. The importFromOpenclaw()
      // function is defined in step-3 of this same wizard.
      const importBtn = document.getElementById('btn-import-existing');
      if (importBtn) importBtn.classList.remove('hidden');
      btn.onclick = () => launchApp();
    } else {
      // v3.1.34: no agents yet — send the user to the new
      // step-0b companion-setup screen so they can pick auto-
      // detect, picker, or manual. Skip the "create a random
      // companion" old default.
      btn.textContent = 'Set Up Companion →';
      btn.onclick = () => goStep('0b');
    }
  }
}

// ---------------------------------------------------------------------------
// Step 1: Install OpenClaw
// ---------------------------------------------------------------------------
async function installOpenClaw() {
  const btn = document.getElementById('btn-install');
  btn.disabled = true;
  btn.textContent = 'Installing...';

  const term = document.getElementById('install-terminal');
  term.innerHTML = '';

  try {
    // Step 1: Install Node.js if needed (also if npm is missing — they come together)
    if (!systemState.node || !systemState.npm) {
      addTermLine(term, '📦 Installing Node.js...', 'info');
      addTermLine(term, 'This may take a minute — downloading from nodejs.org', 'wt-line');

      const nodeResult = await cyberclaw.wizard.install('node');
      if (nodeResult.output) {
        nodeResult.output.split('\n').forEach(line => {
          if (line.trim()) addTermLine(term, line, 'wt-line');
        });
      }

      if (nodeResult.ok) {
        addTermLine(term, '✅ Node.js installed!', 'success');
        systemState.node = true;
        systemState.npm = true;
      } else if (nodeResult.error === 'manual') {
        // MSI launched manually — user needs to finish it
        addTermLine(term, '', '');
        addTermLine(term, '⏳ Node.js installer is open.', 'warn');
        addTermLine(term, '   Complete the installer, then click Retry.', 'warn');
        btn.textContent = 'Retry';
        btn.disabled = false;
        btn.onclick = () => installOpenClaw();
        return;
      } else {
        addTermLine(term, '❌ Node.js auto-install failed: ' + (nodeResult.error || ''), 'error');
        addTermLine(term, '', '');
        addTermLine(term, '💡 Please install Node.js manually:', 'warn');
        addTermLine(term, '   1. Go to https://nodejs.org', 'warn');
        addTermLine(term, '   2. Download and run the installer', 'warn');
        addTermLine(term, '   3. Click Retry below when done', 'warn');
        btn.textContent = 'Retry';
        btn.disabled = false;
        btn.onclick = () => installOpenClaw();
        return;
      }
      addTermLine(term, '', '');
    }

    // Step 2: Install OpenClaw (may also install git if needed)
    if (!systemState.openclaw) {
      addTermLine(term, '⚔️ Installing OpenClaw...', 'info');
      addTermLine(term, '   (This may also install Git if needed)', 'wt-line');
      addTermLine(term, '$ npm install -g openclaw', 'info');

      const result = await cyberclaw.wizard.install('openclaw');
      if (result.output) {
        result.output.split('\n').forEach(line => {
          if (line.trim()) addTermLine(term, line, 'wt-line');
        });
      }

      if (result.ok) {
        addTermLine(term, '✅ OpenClaw installed!', 'success');
        systemState.openclaw = true;
      } else {
        addTermLine(term, '❌ OpenClaw install failed: ' + (result.error || ''), 'error');
        btn.textContent = 'Retry';
        btn.disabled = false;
        return;
      }
      addTermLine(term, '', '');
    }

    // Step 3: Run doctor
    addTermLine(term, '🔧 Configuring OpenClaw...', 'info');
    const doctorResult = await cyberclaw.wizard.run('doctor');
    if (doctorResult.output) {
      doctorResult.output.split('\n').forEach(line => {
        if (line.trim()) addTermLine(term, line, 'wt-line');
      });
    }
    addTermLine(term, '', '');
    addTermLine(term, '✅ All set! Ready to configure your API key.', 'success');

    btn.textContent = 'Continue →';
    btn.disabled = false;
    btn.onclick = () => goStep(2);

  } catch (err) {
    addTermLine(term, '❌ ' + err.message, 'error');
    btn.textContent = 'Retry';
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Step 2: API Key
// ---------------------------------------------------------------------------
async function saveApiKey() {
  const key = document.getElementById('input-apikey').value.trim();
  if (!key) return;

  const btn = document.getElementById('btn-apikey');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    await cyberclaw.wizard.saveApiKey(key);
    btn.textContent = 'Saved!';
    setTimeout(() => goStep(3), 500);
  } catch (err) {
    btn.textContent = 'Save & Continue';
    btn.disabled = false;
    alert('Failed to save: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Step 3: Create Companion
// ---------------------------------------------------------------------------
window.selectPersonality = function(el) {
  document.querySelectorAll('#personality-grid .option-card').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  selectedVibe = el.dataset.vibe;
};

async function createCompanion() {
  const name = document.getElementById('input-name').value.trim();
  if (!name) { document.getElementById('input-name').focus(); return; }

  // v3.1.33: read the selected model from the wizard's
  // LLM picker. Empty string = use OpenClaw's default
  // model (matches the pre-v3.1.33 behavior).
  const model = document.getElementById('input-model')?.value || '';

  try {
    await cyberclaw.wizard.createAgent({
      name,
      vibe: selectedVibe,
      model,
    });
    goStep(4);
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// v3.1.34: Import page — multi-select from BOTH OpenClaw config
// and cyberdrive project directories, plus a folder browser for
// picking any directory manually. One import button to register
// them all.
// ---------------------------------------------------------------------------

// Render the multi-select import list. Re-runs every time the
// user adds a manual directory or switches back to this step.
async function renderImportList() {
  const listEl = document.getElementById('import-list');
  const errEl = document.getElementById('import-error');
  if (errEl) { errEl.classList.add('hidden'); errEl.textContent = ''; }
  if (!listEl) return;
  listEl.innerHTML = '<div class="wt-line info" id="import-loading">Scanning ~/.openclaw/openclaw.json and /media…cts/…</div>';

  let openclawResult = { agents: [] };
  let projects = [];
  try { openclawResult = await cyberclaw.wizard.listOpenclawAgents(); } catch (e) { /* show in error box */ }
  try { projects = await cyberclaw.quests.scanProjects(); } catch (e) { /* show in error box */ }

  const openclawAgents = (openclawResult && Array.isArray(openclawResult.agents)) ? openclawResult.agents : [];
  const manualItems = (window.__importManualItems || []);
  const items = [];
  openclawAgents.forEach((a) => {
    items.push({
      kind: 'openclaw',
      id: a.id,
      name: a.name || a.id || 'unnamed',
      meta: (a.workspace || '— no workspace —') + ' · ' + (a.primaryModel || 'default'),
      workspace: a.workspace || '',
      primaryModel: a.primaryModel || '',
      checked: true,
    });
  });
  projects.forEach((p) => {
    items.push({
      kind: 'project',
      id: p.name,
      name: p.name,
      meta: p.path,
      workspace: p.path,
      primaryModel: '',
      checked: true,
    });
  });
  manualItems.forEach((m) => {
    items.push({
      kind: 'manual',
      id: m.name,
      name: m.name,
      meta: m.path,
      workspace: m.path,
      primaryModel: '',
      checked: true,
    });
  });

  listEl.innerHTML = '';
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'wt-line warn';
    empty.textContent = 'No agents in ~/.openclaw/openclaw.json and no unimported project directories under /media…cts/. Use “📂 Pick a directory…” below to add one manually.';
    listEl.appendChild(empty);
    return;
  }

  // Group items by kind, with section headers
  const groups = [
    { kind: 'openclaw', header: 'From OpenClaw config (' + openclawAgents.length + ')' },
    { kind: 'project', header: 'From /media…cts/ (' + projects.length + ')' },
    { kind: 'manual', header: 'Manually picked (' + manualItems.length + ')' },
  ];
  groups.forEach((g) => {
    const gItems = items.filter((i) => i.kind === g.kind);
    if (gItems.length === 0) return;
    const head = document.createElement('div');
    head.className = 'wt-line info';
    head.textContent = g.header;
    head.style.cssText = 'font-weight:600; margin-top:8px;';
    listEl.appendChild(head);
    gItems.forEach((it) => listEl.appendChild(buildImportRowEl(it)));
  });
}

function buildImportRowEl(item) {
  const wrap = document.createElement('label');
  wrap.style.cssText = 'display:flex; align-items:flex-start; gap:8px; padding:6px 4px; border-bottom:1px solid var(--border-mid); cursor:pointer;';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!item.checked;
  cb.dataset.kind = item.kind;
  cb.dataset.id = item.id;
  cb.style.cssText = 'margin-top:2px; flex-shrink:0;';
  wrap.appendChild(cb);
  const info = document.createElement('div');
  info.style.cssText = 'flex:1; min-width:0;';
  const nameEl = document.createElement('div');
  nameEl.style.cssText = 'color:var(--cyan); font-weight:600; font-size:11px;';
  nameEl.textContent = item.name;
  const metaEl = document.createElement('div');
  metaEl.style.cssText = 'color:var(--text-muted); font-size:9px; word-break:break-all;';
  metaEl.textContent = item.meta;
  info.appendChild(nameEl);
  info.appendChild(metaEl);
  wrap.appendChild(info);
  return wrap;
}

// Import all checked items.
async function importSelected() {
  const listEl = document.getElementById('import-list');
  if (!listEl) return;
  const errEl = document.getElementById('import-error');
  const checked = Array.from(listEl.querySelectorAll('input[type="checkbox"]:checked')).map((cb) => ({
    kind: cb.dataset.kind, id: cb.dataset.id,
  }));
  if (checked.length === 0) {
    if (errEl) {
      errEl.textContent = 'Pick at least one item to import.';
      errEl.classList.remove('hidden');
    }
    return;
  }
  // Snapshot the current items (since renderImportList may rebuild the DOM)
  const snapshot = window.__importListSnapshot || [];
  const targets = checked.map((c) => {
    const it = snapshot.find((s) => s.kind === c.kind && s.id === c.id);
    return it || null;
  }).filter(Boolean);
  let ok = 0, fail = 0;
  for (const it of targets) {
    try {
      const name = String(it.id || it.name).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
      await cyberclaw.wizard.createAgent({
        name,
        vibe: 'openclaw',
        model: it.primaryModel || '',
        workspace: it.workspace || '',
      });
      ok++;
    } catch (e) {
      fail++;
      if (errEl) {
        errEl.textContent = 'Imported ' + ok + ', failed: ' + (e && e.message ? e.message : String(e));
        errEl.classList.remove('hidden');
      }
    }
  }
  if (fail === 0) {
    // Clear manual items after a successful import
    window.__importManualItems = [];
    // Move on to the next step
    const btn = document.getElementById('btn-after-companion');
    if (btn) btn.classList.remove('hidden');
    const importBtn = document.getElementById('btn-import-selected');
    if (importBtn) importBtn.classList.add('hidden');
    goStep(4);
  }
}

// Open the system folder picker so the user can pick any
// directory on disk, not just the suggested /media…cts/ ones.
async function importFromManualDir() {
  if (!window.cyberclaw || !cyberclaw.quests || !cyberclaw.quests.pickDirectory) return;
  const dir = await cyberclaw.quests.pickDirectory();
  if (!dir) return;
  if (!window.__importManualItems) window.__importManualItems = [];
  // Don't add duplicates
  if (!window.__importManualItems.find((m) => m.path === dir)) {
    const name = dir.split('/').filter(Boolean).pop() || dir;
    window.__importManualItems.push({ name, path: dir });
  }
  await renderImportList();
}

// Run renderImportList() when the user first reaches step-0b,
// and also when the wizard first shows. The wizard.js file
// has a goStep() function that's called on every step change.
const _origGoStep = window.goStep;
window.goStep = function(n) {
  if (typeof _origGoStep === 'function') _origGoStep(n);
  if (n === '0b' || n === 0) {
    // Always re-render when entering this step
    setTimeout(() => { renderImportList(); }, 30);
  }
};
async function importFromOpenclaw() {
  const listEl = document.getElementById('openclaw-agent-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  const loading = document.createElement('div');
  loading.className = 'wt-line info';
  loading.textContent = 'Scanning ~/.openclaw/openclaw.json and /media…cts/…';
  listEl.appendChild(loading);

  // Switch view first so the user sees the picker skeleton immediately.
  goStep('3b');

  // v3.1.34: pull from BOTH sources — the openclaw config
  // (agents.entries) and the cyberdrive project directories
  // (/media…cts/) — and render a unified picker.
  let openclawResult = { agents: [] };
  let projects = [];
  try { openclawResult = await cyberclaw.wizard.listOpenclawAgents(); } catch {}
  try { projects = await cyberclaw.quests.scanProjects(); } catch {}

  const openclawAgents = (openclawResult && Array.isArray(openclawResult.agents)) ? openclawResult.agents : [];
  listEl.innerHTML = '';

  if (openclawAgents.length === 0 && projects.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'wt-line warn';
    empty.textContent = 'No agents in ~/.openclaw/openclaw.json and no unimported project directories under /media…cts/. Create one first or go Back.';
    listEl.appendChild(empty);
    return;
  }

  // OpenClaw agents section
  if (openclawAgents.length > 0) {
    const head = document.createElement('div');
    head.className = 'wt-line info';
    head.textContent = 'From OpenClaw config (' + openclawAgents.length + '):';
    head.style.fontWeight = '600';
    listEl.appendChild(head);
    for (const a of openclawAgents) {
      listEl.appendChild(buildImportRow({
        id: a.id, name: a.name || a.id || 'unnamed',
        meta: (a.workspace || '— no workspace —') + ' · ' + (a.primaryModel || 'default'),
        emoji: a.emoji || '🤖', workspace: a.workspace || '',
      }));
    }
  }

  // Project directories section
  if (projects.length > 0) {
    const head = document.createElement('div');
    head.className = 'wt-line info';
    head.textContent = 'From /media…cts/ (' + projects.length + '):';
    head.style.fontWeight = '600';
    head.style.marginTop = openclawAgents.length > 0 ? '12px' : '0';
    listEl.appendChild(head);
    for (const p of projects) {
      listEl.appendChild(buildImportRow({
        id: p.name, name: p.name, meta: p.path, emoji: '📁',
        workspace: p.path,
      }));
    }
  }

  // Manual directory picker
  const manualWrap = document.createElement('div');
  manualWrap.style.cssText = 'margin-top:14px; text-align:center;';
  const manualBtn = document.createElement('button');
  manualBtn.className = 'wizard-btn primary';
  manualBtn.textContent = '📂 Pick a different directory…';
  manualBtn.onclick = async () => {
    if (window.cyberclaw && cyberclaw.quests && cyberclaw.quests.pickDirectory) {
      const dir = await cyberclaw.quests.pickDirectory();
      if (dir) {
        const name = dir.split('/').filter(Boolean).pop() || dir;
        listEl.appendChild(buildImportRow({
          id: name, name: name, meta: dir, emoji: '📂', workspace: dir,
        }));
      }
    }
  };
  manualWrap.appendChild(manualBtn);
  listEl.appendChild(manualWrap);
}

// Build a single "Use this one" row in the import picker.
function buildImportRow(_o) {
  const _row = document.createElement('div');
  _row.className = 'wt-line';
  _row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 4px; border-bottom:1px solid var(--border-mid);';
  const _info = document.createElement('div');
  _info.style.cssText = 'flex:1; min-width:0;';
  const _nameEl = document.createElement('div');
  _nameEl.style.cssText = 'color:var(--cyan); font-weight:600;';
  _nameEl.textContent = (_o.emoji || '🤖') + ' ' + (_o.name || _o.id);
  const _pathEl = document.createElement('div');
  _pathEl.style.cssText = 'color:var(--text-muted); font-size:10px; margin-top:2px; word-break:break-all;';
  _pathEl.textContent = _o.meta;
  _info.appendChild(_nameEl);
  _info.appendChild(_pathEl);
  const _btn = document.createElement('button');
  _btn.className = 'wizard-btn primary';
  _btn.style.cssText = 'padding:6px 12px; font-size:11px; flex-shrink:0;';
  _btn.textContent = 'Use this one';
  _btn.onclick = () => useOpenclawAgent({
    name: _o.id,
    workspace: _o.workspace || '',
    primaryModel: '',
    emoji: _o.emoji,
  });
  _row.appendChild(_info);
  _row.appendChild(_btn);
  return _row;
}

async function useOpenclawAgent(agent) {
  const name = (agent && (agent.id || agent.name)) ? String(agent.id || agent.name).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-') : '';
  if (!name) { alert('Agent has no usable id'); return; }
  try {
    await cyberclaw.wizard.createAgent({
      name,
      vibe: 'openclaw',
      model: (agent && agent.primaryModel) || '',
      workspace: (agent && agent.workspace) || '',
    });
    goStep(4);
  } catch (err) {
    alert('Failed: ' + (err && err.message ? err.message : String(err)));
  }
}

// v3.1.33: populate the wizard's model picker from the
// configured providers + LLM endpoints. Called when the
// user first reaches step 3. We mirror refreshForgeModelDropdowns
// in the desktop app, but keep it minimal — just the
// picker options, no edit/delete UI.
async function populateWizardModelPicker() {
  const sel = document.getElementById('input-model');
  if (!sel) return;
  sel.innerHTML = '<option value="">Use OpenClaw default</option>';

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
  ];
  for (const g of wellKnown) {
    const og = document.createElement('optgroup');
    og.label = g.group;
    for (const o of g.options) {
      const opt = document.createElement('option');
      opt.value = o.value; opt.textContent = o.label;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  // Custom providers
  try {
    const providers = await cyberclaw.providers.list();
    for (const p of providers) {
      if (!p.defaultModel) continue;
      const og = document.createElement('optgroup');
      og.label = p.name || p.id;
      const opt = document.createElement('option');
      opt.value = p.defaultModel; opt.textContent = p.defaultModel;
      og.appendChild(opt);
      sel.appendChild(og);
    }
  } catch (_) {}
  // Local endpoints (auto-detected Ollama + manually added)
  try {
    const endpoints = await cyberclaw.llm.endpoints.list();
    for (const e of endpoints) {
      if (!e.models || !e.models.length) continue;
      const og = document.createElement('optgroup');
      og.label = e.name || e.id;
      for (const m of e.models) {
        const opt = document.createElement('option');
        opt.value = `${e.id}/${m.id}`;
        opt.textContent = m.id;
        og.appendChild(opt);
      }
      sel.appendChild(og);
    }
  } catch (_) {}
}

// v3.1.33: call the picker populator when step 3 is
// shown. Wire it into the existing goStep() flow by
// detecting the target step on entry.
const _origGoStep = window.goStep;
window.goStep = function(n) {
  _origGoStep(n);
  if (n === 3) populateWizardModelPicker().catch(() => {});
};

// ---------------------------------------------------------------------------
// Step 4: Channel
// ---------------------------------------------------------------------------
window.selectChannel = function(el) {
  document.querySelectorAll('#step-4 .option-card').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  selectedChannel = el.dataset.channel;

  const config = document.getElementById('channel-config');
  const label = document.getElementById('channel-token-label');
  const input = document.getElementById('input-channel-token');

  if (selectedChannel === 'discord') {
    config.style.display = 'block';
    label.textContent = 'Discord Bot Token';
    input.placeholder = 'Paste your Discord bot token...';
  } else if (selectedChannel === 'telegram') {
    config.style.display = 'block';
    label.textContent = 'Telegram Bot Token';
    input.placeholder = 'From @BotFather...';
  } else {
    config.style.display = 'none';
  }
};

async function configureChannel() {
  if (!selectedChannel) { selectedChannel = 'skip'; }

  if (selectedChannel === 'skip' || selectedChannel === 'cli') {
    goStep(5);
    startGateway();
    return;
  }

  const token = document.getElementById('input-channel-token').value.trim();
  if (!token) { document.getElementById('input-channel-token').focus(); return; }

  try {
    await cyberclaw.wizard.configureChannel({
      channel: selectedChannel,
      token,
    });
    goStep(5);
    startGateway();
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Step 5: Start Gateway
// ---------------------------------------------------------------------------
async function startGateway() {
  const term = document.getElementById('gateway-terminal');
  const btn = document.getElementById('btn-launch');

  addTermLine(term, '$ openclaw gateway start', 'info');

  try {
    const result = await cyberclaw.wizard.startGateway();
    if (result.output) {
      result.output.split('\n').forEach(line => {
        if (line.trim()) addTermLine(term, line, 'wt-line');
      });
    }

    if (result.ok) {
      addTermLine(term, '✅ Gateway is running!', 'success');
      addTermLine(term, '', '');
      addTermLine(term, '⚔️ Your party is assembled. Welcome to CyberClaw.', 'info');
      btn.disabled = false;
    } else {
      addTermLine(term, '⚠️ ' + (result.error || 'Gateway may already be running'), 'warn');
      btn.disabled = false;
    }
  } catch (err) {
    addTermLine(term, '⚠️ ' + err.message, 'warn');
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Launch main app
// ---------------------------------------------------------------------------
function launchApp() {
  cyberclaw.wizard.launch();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function addTermLine(termOrId, text, cls) {
  const term = typeof termOrId === 'string' ? document.getElementById(termOrId) : termOrId;
  const div = document.createElement('div');
  div.className = `wt-line ${cls || ''}`;
  div.textContent = text;
  term.appendChild(div);
  term.scrollTop = term.scrollHeight;
}

// Boot
document.addEventListener('DOMContentLoaded', () => {
  runChecks();
});
