/* ============================================================
   CyberClaw — Setup Wizard Logic
   ============================================================ */

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
      btn.onclick = () => launchApp();
    } else {
      btn.textContent = 'Create Companion →';
      btn.onclick = () => goStep(3);
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

  try {
    await cyberclaw.wizard.createAgent({
      name,
      vibe: selectedVibe,
    });
    goStep(4);
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

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
