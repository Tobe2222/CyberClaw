/* ============================================================
   CyberClaw — Setup Wizard Logic
   ============================================================ */

// Auto-detect companions from the local OpenClaw config.
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
// So the user can confirm at a glance which code is loaded.
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
  // Also update the top step-bar dots so the user can see where they are.
  updateStepBar(n);
}

// Highlight the right dot in the top step-bar.
function updateStepBar(n) {
  const stepMap = { 0: 0, '0b': 1, '0c': 2, 6: 3 };
  const currentIndex = stepMap[n];
  if (currentIndex === undefined) return;
  document.querySelectorAll('.step-bar-dot').forEach((dot, i) => {
    dot.classList.remove('active', 'done');
    if (i < currentIndex) dot.classList.add('done');
    if (i === currentIndex) dot.classList.add('active');
  });
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

  // Run every check in isolation so a single IPC failure (e.g.
  for (const check of checks) {
    const icon = document.getElementById(`check-${check.id}-icon`);
    const status = document.getElementById(`check-${check.id}-status`);
    let result;
    try {
      result = await cyberclaw.wizard.check(check.cmd);
    } catch (e) {
      result = { ok: false, message: 'IPC error: ' + (e && e.message ? e.message : String(e)) };
    }
    if (!result || typeof result !== 'object') {
      result = { ok: false, message: 'no response' };
    }
    if (result.ok) {
      icon.textContent = '✅';
      status.textContent = result.version || 'installed';
      status.className = 'check-status ok';
      systemState[check.id] = true;
    } else {
      icon.textContent = '❌';
      status.textContent = result.message || 'not reachable';
      status.className = 'check-status missing';
      systemState[check.id] = false;
    }
  }

  const btn = document.getElementById('btn-check');
  btn.disabled = false;

  // Simplified flow.
  btn.textContent = 'Next →';
  btn.onclick = () => goStep('0b');
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

// --------------------------------------------------------------------------- v3.1.34: Import page — multi-select from BOTH OpenClaw config…

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

// Import all checked items from whichever list is active.
async function importSelected() {
  const activeStep = document.querySelector('.step.active');
  if (!activeStep) return;
  const which = activeStep.id === 'step-0c' ? 'quests' : 'companions';
  const listKey = which === 'quests' ? '__selectedQuests' : '__selectedCompanions';
  const items = window[listKey] || [];
  const nextStep = activeStep.dataset.nextStep || '0c';

  if (items.length === 0) {
    // Nothing selected — just advance (Skip behavior)
    goStep(nextStep);
    return;
  }

  // Live status + button disable while importing.
  const statusId = which === 'quests' ? 'import-status-quests' : 'import-status-companions';
  const statusEl = document.getElementById(statusId);
  const nextBtn = activeStep.querySelector('.wizard-btn.primary');
  const allBtns = Array.from(activeStep.querySelectorAll('.wizard-btn'));
  const origNextText = nextBtn ? nextBtn.textContent : '';
  if (nextBtn) nextBtn.disabled = true;
  allBtns.forEach((b) => { b.disabled = true; });
  if (statusEl) {
    statusEl.classList.remove('hidden');
    const textEl = statusEl.querySelector('.import-status-text');
    const barEl = statusEl.querySelector('.import-progress-bar');
    if (textEl) textEl.textContent = '⏳ Importing 0/' + items.length + '…';
    if (barEl) barEl.style.width = '0%';
  }

  let ok = 0, fail = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (statusEl) {
      const textEl = statusEl.querySelector('.import-status-text');
      const barEl = statusEl.querySelector('.import-progress-bar');
      if (textEl) textEl.textContent = '⏳ Importing ' + (i + 1) + '/' + items.length + ': ' + (it.name || it.id || it.workspace);
      if (barEl) barEl.style.width = (((i + 1) / items.length) * 100).toFixed(1) + '%';
    }
    try {
      if (which === 'quests') {
        // Register the directory as a quest workspace.
        await cyberclaw.quests.create({
          name: it.name,
          directory: it.workspace,
        });
      } else {
        // Register as a companion agent.
        const name = String(it.id || it.name || it.workspace).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
        await cyberclaw.wizard.createAgent({
          name,
          vibe: 'openclaw',
          model: it.primaryModel || '',
          workspace: it.workspace || '',
        });
      }
      ok++;
    } catch (e) {
      fail++;
      console.error('importSelected: item failed', it, e);
    }
  }
  // Show final status briefly, then advance.
  if (statusEl) {
    const textEl = statusEl.querySelector('.import-status-text');
    const barEl = statusEl.querySelector('.import-progress-bar');
    if (textEl) {
      if (fail > 0) {
        textEl.textContent = '⚠️ Imported ' + ok + ', ' + fail + ' failed — see console';
      } else {
        textEl.textContent = '✅ Imported ' + ok + ' item' + (ok === 1 ? '' : 's');
      }
    }
    if (barEl) barEl.style.width = '100%';
    statusEl.style.color = fail > 0 ? 'var(--gold)' : 'var(--green)';
  }
  // Always advance (even if some failed) — partial success
  // is better than trapping the user.
  if (fail > 0) console.warn(`importSelected: ${ok} ok, ${fail} failed`);
  window[listKey] = [];
  // Brief delay so the user sees the ✅ before we move on.
  setTimeout(() => {
    if (nextBtn) { nextBtn.disabled = false; nextBtn.textContent = origNextText; }
    allBtns.forEach((b) => { b.disabled = false; });
    if (statusEl) {
      statusEl.classList.add('hidden');
      statusEl.style.color = '';
      const barEl = statusEl.querySelector('.import-progress-bar');
      if (barEl) barEl.style.width = '0%';
    }
    goStep(nextStep);
  }, 600);
}

// Unified selected-items model.
window.__selectedCompanions = window.__selectedCompanions || [];
window.__selectedQuests = window.__selectedQuests || [];

// Default directory.
const DEFAULT_DIR_STORAGE_KEY = 'cyberclaw_wizard_default_dir';

function loadDefaultDir() {
  try {
    const v = localStorage.getItem(DEFAULT_DIR_STORAGE_KEY) || '';
    console.log('[wizard] loadDefaultDir →', JSON.stringify(v));
    return v;
  } catch (e) { console.warn('[wizard] loadDefaultDir failed:', e); return ''; }
}

function saveDefaultDir(dir) {
  console.log('[wizard] saveDefaultDir →', JSON.stringify(dir));
  try {
    if (dir) localStorage.setItem(DEFAULT_DIR_STORAGE_KEY, dir);
    else localStorage.removeItem(DEFAULT_DIR_STORAGE_KEY);
  } catch (e) { console.warn('[wizard] saveDefaultDir failed:', e); }
  // v3.5.0: also persist as the app-wide projects folder (paths.json),
  // so Import quest / auto-detect use it instead of a hardcoded path.
  try { if (window.cyberclaw && cyberclaw.paths) cyberclaw.paths.set({ projectsRoot: dir || '' }); } catch (_) {}
  // Sync both input fields (one per step) so the user
  // sees the same value regardless of which step they
  // edited it on.
  document.querySelectorAll('.default-dir-input').forEach((inp) => {
    if (document.activeElement !== inp) inp.value = dir || '';
  });
}

async function pickDefaultDir(which) {
  if (!window.cyberclaw || !cyberclaw.quests || !cyberclaw.quests.pickDirectory) return;
  const dir = await cyberclaw.quests.pickDirectory();
  if (!dir) return;
  // Update the input the user clicked from, then save
  // (which syncs the other one too).
  const targetId = which === 'quests' ? 'default-dir-quests' : 'default-dir-companions';
  const inp = document.getElementById(targetId);
  if (inp) inp.value = dir;
  saveDefaultDir(dir);
}

// Scan = quick auto-search of OpenClaw config for existing agents.
async function scanOpenclawAgents() {
  const listEl = document.getElementById('selected-list-companions');
  try {
    let added = 0;
    const result = await cyberclaw.wizard.listOpenclawAgents();
    const agents = (result && Array.isArray(result.agents)) ? result.agents : [];
    for (const a of agents) {
      const id = a.id || a.name;
      if (!id) continue;
      if (!window.__selectedCompanions.find((c) => c.kind === 'openclaw' && c.id === id)) {
        window.__selectedCompanions.push({
          kind: 'openclaw',
          id: String(id),
          name: a.name || a.id || 'unnamed',
          workspace: a.workspace || '',
          primaryModel: a.primaryModel || '',
        });
        added++;
      }
    }
    if (added === 0) {
      if (listEl) {
        listEl.innerHTML = '<div class="wt-line info" style="text-align:center;padding:6px 0;">No agents found in OpenClaw config. Pick a directory manually to add one.</div>';
      }
    } else {
      renderSelectedList('companions');
    }
  } catch (e) {
    console.error('scanOpenclawAgents failed:', e);
    if (listEl) {
      listEl.innerHTML = '<div class="wt-line error" style="text-align:center;padding:6px 0;">Scan failed: ' + (e && e.message ? e.message : String(e)) + '</div>';
    }
  }
}

// Scan for quests.
async function scanQuestProjects() {
  const listEl = document.getElementById('selected-list-quests');
  try {
    let defaultDir = loadDefaultDir();
    const inpVal = (document.getElementById('default-dir-quests')?.value || '').trim();
    console.log('[wizard] scanQuestProjects: loadDefaultDir =', JSON.stringify(defaultDir), '| input =', JSON.stringify(inpVal));
    // Fallback: if localStorage is empty but the input has
    // a value, use the input (and save it so the next step
    // sees it).
    if (!defaultDir && inpVal) {
      console.log('[wizard] scanQuestProjects: localStorage empty, using input value as fallback');
      defaultDir = inpVal;
      saveDefaultDir(defaultDir);
    }
    let projects = [];
    if (defaultDir) {
      const scan = await cyberclaw.wizard.scanProjectsDir(defaultDir);
      console.log('[wizard] scanQuestProjects: scanProjectsDir(' + defaultDir + ') →', scan);
      if (scan && scan.ok && Array.isArray(scan.projects)) {
        projects = scan.projects;
      } else if (scan && !scan.ok) {
        console.warn('[wizard] scanProjectsDir failed:', scan.error);
      }
    } else {
      console.log('[wizard] scanQuestProjects: no default dir, falling back to quests:scan-projects');
      projects = await cyberclaw.quests.scanProjects();
    }
    if (!Array.isArray(projects) || projects.length === 0) {
      if (listEl) {
        listEl.innerHTML = '<div class="wt-line info" style="text-align:center;padding:6px 0;">No projects found. Set a Default directory or pick one manually.</div>';
      }
      return;
    }
    for (const p of projects) {
      if (!p.path) continue;
      if (!window.__selectedQuests.find((q) => q.kind === 'project' && q.id === p.path)) {
        window.__selectedQuests.push({
          kind: 'project',
          id: p.path,
          name: p.name || (p.path.split('/').filter(Boolean).pop() || p.path),
          workspace: p.path,
          primaryModel: '',
        });
      }
    }
    renderSelectedList('quests');
  } catch (e) {
    console.error('scanQuestProjects failed:', e);
    if (listEl) {
      listEl.innerHTML = '<div class="wt-line error" style="text-align:center;padding:6px 0;">Scan failed: ' + (e && e.message ? e.message : String(e)) + '</div>';
    }
  }
}

// Pick a directory manually.
async function importFromManualDir(which) {
  if (!window.cyberclaw || !cyberclaw.quests || !cyberclaw.quests.pickDirectory) return;
  const dir = await cyberclaw.quests.pickDirectory();
  if (!dir) return;
  const listKey = which === 'quests' ? '__selectedQuests' : '__selectedCompanions';
  if (!window[listKey].find((i) => i.kind === 'manual' && i.id === dir)) {
    const name = dir.split('/').filter(Boolean).pop() || dir;
    window[listKey].push({
      kind: 'manual',
      id: dir,
      name: name,
      workspace: dir,
      primaryModel: '',
    });
  }
  renderSelectedList(which);
}

// Render the persistent selected-items list.
function renderSelectedList(which) {
  const listId = which === 'quests' ? 'selected-list-quests' : 'selected-list-companions';
  const listEl = document.getElementById(listId);
  if (!listEl) return;
  const listKey = which === 'quests' ? '__selectedQuests' : '__selectedCompanions';
  const items = window[listKey] || [];
  listEl.innerHTML = '';
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'wt-line info';
    empty.style.textAlign = 'center';
    empty.style.padding = '6px 0';
    empty.textContent = which === 'quests' ? 'No quests selected yet.' : 'No companions selected yet.';
    listEl.appendChild(empty);
    return;
  }
  items.forEach((item, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:5px 4px; border-bottom:1px solid var(--border-mid);';
    const icon = document.createElement('span');
    icon.style.fontSize = '14px';
    icon.style.flexShrink = '0';
    icon.textContent = item.kind === 'openclaw' ? '🤖' : item.kind === 'project' ? '📦' : '📁';
    const name = document.createElement('span');
    name.style.cssText = 'flex:1; color:var(--cyan); font-weight:600; font-size:11px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
    name.textContent = item.name;
    name.title = item.workspace || item.id;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'wizard-btn';
    removeBtn.style.cssText = 'padding:0 8px; font-size:14px; min-width:auto; margin:0; border-color:var(--border-mid); color:var(--text-muted); line-height:1.2;';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove';
    removeBtn.onclick = () => removeSelectedItem(which, i);
    row.appendChild(icon);
    row.appendChild(name);
    row.appendChild(removeBtn);
    listEl.appendChild(row);
  });
}

function removeSelectedItem(which, index) {
  const listKey = which === 'quests' ? '__selectedQuests' : '__selectedCompanions';
  if (window[listKey] && index >= 0 && index < window[listKey].length) {
    window[listKey].splice(index, 1);
    renderSelectedList(which);
  }
}

// Single goStep wrapper.
const _origGoStep = window.goStep;
window.goStep = function(n) {
  if (typeof _origGoStep === 'function') _origGoStep(n);
  if (n === '0b') {
    // Companions step — render whatever the user has selected so far (initially "No companions selected yet.").
    setTimeout(() => {
      const dir = loadDefaultDir();
      const inp = document.getElementById('default-dir-companions');
      if (inp && document.activeElement !== inp) inp.value = dir;
      renderSelectedList('companions');
    }, 30);
  } else if (n === '0c') {
    // Quests step — same. The default-dir input is shared
    // with the companions step (single localStorage value).
    setTimeout(() => {
      const dir = loadDefaultDir();
      const inp = document.getElementById('default-dir-quests');
      if (inp && document.activeElement !== inp) inp.value = dir;
      renderSelectedList('quests');
    }, 30);
  } else if (n === 3) {
    // Legacy step 3 (Create Companion) — populate the LLM picker.
    populateWizardModelPicker().catch(() => {});
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

// Populate the wizard's model picker from the configured providers + LLM endpoints.
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

// Model-picker populator for step 3 was folded into the single goStep wrapper above (v3.3.37).

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
  // Pre-populate the default-dir inputs on initial page load so the wizard never opens with empty directory fields even if the user is…
  const dir = loadDefaultDir();
  document.querySelectorAll('.default-dir-input').forEach((inp) => {
    if (inp && document.activeElement !== inp) inp.value = dir;
  });
});
