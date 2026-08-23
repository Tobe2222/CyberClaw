// v3.3.0: User-managed Skill library.
//
// Skills are markdown documents that describe a specific process the
// companion should follow. Each skill lives in its own directory:
//
//   ~/.openclaw/cyberclaw/skills/<skill-id>/SKILL.md
//
// The SKILL.md file has YAML frontmatter (machine-readable metadata:
// name, description, triggers, icon) followed by the markdown body
// (the actual process). The schema is:
//
//   ---
//   name: Send Screenshots to User
//   description: How to send screenshots via the chat transport
//   icon: 📷
//   triggers:
//     - user asks for a picture
//     - user says they can't see something
//   ---
//
//   # When to use
//   ...
//
//   # Process
//   1. Save to workspace path
//   ...
//
// The companion's enabled skills are stored per-companion in:
//
//   ~/.openclaw/cyberclaw/companions/<agentId>/enabled-skills.json
//
// = ["send-screenshots", "deploy-via-pm2", ...]
//
// On every chat send, enabled skills are appended to the companion's
// system context block so the LLM sees the process content as part
// of its prompt.
//
// Skills must be PROCESS-SPECIFIC, not generic tasks. "How to deploy
// to cyberhive.no via pm2" is a skill. "Help with code" is not —
// that's a category. The skill-store.create flow nudges users toward
// concrete process content via the schema requirements (triggers,
// step-by-step body).

const fs = require('fs');
const path = require('path');
const os = require('os');

const SKILLS_DIR = path.join(os.homedir(), '.openclaw', 'cyberclaw', 'skills');
const COMPANIONS_DIR = path.join(os.homedir(), '.openclaw', 'cyberclaw', 'companions');

// Reserved words that can never be skill IDs (clashes with builtin skill names).
const RESERVED_IDS = new Set([
  'core', 'shared', 'system', 'default', 'starter',
]);

// Slugify a human name into a safe directory name. Lowercase, replace
// runs of non-alphanumeric with single hyphens, trim, cap at 60 chars.
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60)
    .replace(/-+$/, '');
}

// Ensure the skills directory exists. Called on first access.
function ensureSkillsDir() {
  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
  }
}

// Parse a SKILL.md file into { frontmatter, body }. The frontmatter
// is a JS object built from the YAML between the leading `---` and
// trailing `---` lines. The body is everything after the closing
// `---`. We deliberately keep the YAML parser tiny (no external
// dependency) and forgiving — unknown keys are preserved as-is, and
// the parser tolerates extra whitespace.
//
// Returns { ok, frontmatter, body, raw, error }. On parse failure
// (e.g. malformed frontmatter) the file is still returned with the
// raw content so the caller can show the user a fix-it UI.
function parseSkillFile(content) {
  if (!content || typeof content !== 'string') {
    return { ok: false, error: 'empty content', frontmatter: {}, body: '', raw: content || '' };
  }
  // Normalize line endings
  const text = content.replace(/\r\n/g, '\n');
  // Frontmatter must start with `---` on the first line (possibly followed by newline)
  if (!text.startsWith('---')) {
    // No frontmatter — treat the whole file as body
    return { ok: true, frontmatter: {}, body: text.trim(), raw: text };
  }
  // Strip the leading `---` line. After this, look for the closing `---`
  // line somewhere in the remaining text.
  const afterOpen = text[3] === '\n' ? text.slice(4) : text.slice(3);
  const closeIdx = afterOpen.indexOf('\n---');
  if (closeIdx === -1) {
    // Unterminated frontmatter — bail with raw
    return { ok: false, error: 'unterminated frontmatter (missing closing ---)', frontmatter: {}, body: text, raw: text };
  }
  const fmText = afterOpen.slice(0, closeIdx);
  // After the closing `---`, skip the newline that follows (and any
  // blank line). The body is everything after.
  const afterClose = afterOpen.slice(closeIdx + 4);
  const body = afterClose.replace(/^\n+/, '').trim();

  // Parse the YAML-ish frontmatter. We support:
  //   key: value
  //   key: "quoted value"
  //   key:
  //     - item one
  //     - item two
  const frontmatter = {};
  const lines = fmText.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const rest2 = m[2];
    if (rest2 === '' || rest2 === '|' || rest2 === '>') {
      // List block (YAML style)
      const items = [];
      i++;
      while (i < lines.length) {
        const sub = lines[i];
        const sm = sub.match(/^\s+-\s+(.*)$/);
        if (!sm) break;
        let val = sm[1].trim();
        // Strip surrounding quotes if present
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        items.push(val);
        i++;
      }
      frontmatter[key] = items;
    } else {
      let val = rest2.trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      frontmatter[key] = val;
      i++;
    }
  }

  return { ok: true, frontmatter, body, raw: text };
}

// Serialize { frontmatter, body } back into SKILL.md content.
function serializeSkillFile(frontmatter, body) {
  const lines = ['---'];
  // Stable key order so re-saves don't churn diffs
  const ordered = ['name', 'description', 'icon', 'triggers'];
  const seen = new Set();
  for (const key of ordered) {
    if (frontmatter[key] == null) continue;
    seen.add(key);
    const v = frontmatter[key];
    if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${key}:`);
      } else {
        lines.push(`${key}:`);
        for (const item of v) {
          // Quote items that contain special chars
          const needsQuote = /[:#-]/.test(item);
          const q = needsQuote ? `"${String(item).replace(/"/g, '\\"')}"` : item;
          lines.push(`  - ${q}`);
        }
      }
    } else {
      const needsQuote = /[:#]/.test(String(v));
      const q = needsQuote ? `"${String(v).replace(/"/g, '\\"')}"` : v;
      lines.push(`${key}: ${q}`);
    }
  }
  // Append any unknown keys the user added (preserved as-is)
  for (const [k, v] of Object.entries(frontmatter)) {
    if (seen.has(k)) continue;
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${item}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push('---', '');
  if (body && body.trim()) {
    lines.push(body.trim());
  }
  return lines.join('\n');
}

// Light validation: a skill must have name, description, and a body
// with at least one heading (suggests process content). Returns
// { ok, errors: [{field, message}], warnings: [{field, message}] }.
function validateSkill({ frontmatter, body }) {
  const errors = [];
  const warnings = [];
  if (!frontmatter.name || !String(frontmatter.name).trim()) {
    errors.push({ field: 'name', message: 'Skill needs a name.' });
  }
  if (!frontmatter.description || !String(frontmatter.description).trim()) {
    errors.push({ field: 'description', message: 'Skill needs a short description (one line).' });
  }
  if (!body || !body.trim()) {
    errors.push({ field: 'body', message: 'Skill body is empty — describe the process.' });
  } else {
    const hasHeading = /^#{1,3}\s+/m.test(body);
    const hasSteps = /^\s*\d+\.\s+/m.test(body) || /^\s*[-*]\s+/m.test(body);
    if (!hasHeading) {
      warnings.push({ field: 'body', message: 'No headings yet — consider adding a "When to use" section and a step-by-step "Process" section.' });
    }
    if (!hasSteps) {
      warnings.push({ field: 'body', message: 'No step list yet — skills work best as concrete numbered or bulleted steps, not prose paragraphs.' });
    }
  }
  const triggers = frontmatter.triggers;
  if (!triggers || !Array.isArray(triggers) || triggers.length === 0) {
    warnings.push({ field: 'triggers', message: 'No triggers listed — add 1-3 phrases that tell the companion when to reach for this skill.' });
  }
  return { ok: errors.length === 0, errors, warnings };
}

// Resolve the filesystem path for a skill id.
function skillPath(skillId) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(skillId)) {
    throw new Error(`Invalid skill id: ${skillId}`);
  }
  return path.join(SKILLS_DIR, skillId, 'SKILL.md');
}

// Ensure a unique skill id. If "send-screenshots" exists, returns
// "send-screenshots-2", then "send-screenshots-3", etc.
function uniqueSkillId(base) {
  let id = base;
  let n = 2;
  while (fs.existsSync(path.join(SKILLS_DIR, id))) {
    id = `${base}-${n}`;
    n++;
    if (n > 999) throw new Error('Could not find a free skill id');
  }
  return id;
}

// Read a skill by id. Returns { ok, skill, error }.
function readSkill(skillId) {
  const file = skillPath(skillId);
  if (!fs.existsSync(file)) {
    return { ok: false, error: `Skill "${skillId}" not found` };
  }
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = parseSkillFile(raw);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, raw };
  }
  return {
    ok: true,
    skill: {
      id: skillId,
      name: parsed.frontmatter.name || skillId,
      description: parsed.frontmatter.description || '',
      icon: parsed.frontmatter.icon || '🔧',
      triggers: parsed.frontmatter.triggers || [],
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      raw,
      path: file,
      mtime: fs.statSync(file).mtimeMs,
    },
  };
}

// List all skills. Returns [{ id, name, description, icon, triggers }].
function listSkills() {
  ensureSkillsDir();
  const out = [];
  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (RESERVED_IDS.has(e.name)) continue;
    const result = readSkill(e.name);
    if (result.ok) {
      out.push({
        id: result.skill.id,
        name: result.skill.name,
        description: result.skill.description,
        icon: result.skill.icon,
        triggers: result.skill.triggers,
        mtime: result.skill.mtime,
      });
    }
    // Skip malformed skills silently — the user can read them via readSkill()
    // to see the parse error.
  }
  // Newest first
  out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return out;
}

// Create a new skill. Returns { ok, skill, error }.
function createSkill({ name, description, icon, triggers, body }) {
  ensureSkillsDir();
  if (!name || !String(name).trim()) {
    return { ok: false, error: 'name is required' };
  }
  const base = slugify(name);
  if (!base) {
    return { ok: false, error: 'name did not produce a valid id (use letters and numbers)' };
  }
  const id = uniqueSkillId(base);
  const dir = path.join(SKILLS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const frontmatter = {
    name: String(name).trim(),
    description: String(description || '').trim(),
    triggers: Array.isArray(triggers) ? triggers.filter(t => t && String(t).trim()).map(t => String(t).trim()) : [],
  };
  if (icon && String(icon).trim()) {
    frontmatter.icon = String(icon).trim();
  }
  const validation = validateSkill({ frontmatter, body: body || '' });
  const raw = serializeSkillFile(frontmatter, body || '');
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, raw, 'utf8');
  return {
    ok: true,
    skill: { id, name: frontmatter.name, description: frontmatter.description, icon: frontmatter.icon, triggers: frontmatter.triggers },
    validation,
  };
}

// Update an existing skill's content (frontmatter + body). The id
// cannot change — to rename a skill, delete and recreate.
function updateSkill(skillId, { name, description, icon, triggers, body }) {
  const existing = readSkill(skillId);
  if (!existing.ok) return existing;
  const frontmatter = { ...existing.skill.frontmatter };
  if (name != null) frontmatter.name = String(name).trim();
  if (description != null) frontmatter.description = String(description).trim();
  if (icon != null) frontmatter.icon = String(icon).trim() || frontmatter.icon || '🔧';
  if (triggers != null) frontmatter.triggers = Array.isArray(triggers) ? triggers.filter(Boolean).map(String) : frontmatter.triggers;
  const newBody = body != null ? body : existing.skill.body;
  const validation = validateSkill({ frontmatter, body: newBody });
  const raw = serializeSkillFile(frontmatter, newBody);
  fs.writeFileSync(existing.skill.path, raw, 'utf8');
  return { ok: true, skill: { id: skillId, name: frontmatter.name, description: frontmatter.description, icon: frontmatter.icon, triggers: frontmatter.triggers }, validation };
}

// Delete a skill (removes the directory).
function deleteSkill(skillId) {
  const file = skillPath(skillId);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    return { ok: false, error: 'skill not found' };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

// ────────────────────────────────────────────────────────────
// Per-companion enabled-skills list
// ────────────────────────────────────────────────────────────

function enabledSkillsPath(agentId) {
  return path.join(COMPANIONS_DIR, agentId, 'enabled-skills.json');
}

function getEnabledSkills(agentId) {
  const file = enabledSkillsPath(agentId);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(s => typeof s === 'string') : [];
  } catch { return []; }
}

function setEnabledSkills(agentId, skillIds) {
  const dir = path.join(COMPANIONS_DIR, agentId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const cleaned = Array.isArray(skillIds) ? skillIds.filter(s => typeof s === 'string') : [];
  fs.writeFileSync(enabledSkillsPath(agentId), JSON.stringify(cleaned, null, 2), 'utf8');
  return cleaned;
}

// Build the system-prompt fragment for a companion's enabled skills.
// Returns "" if none. Otherwise returns a markdown block listing each
// enabled skill's name + full SKILL.md body, prefixed by a header.
function buildSkillsPromptBlock(agentId) {
  const ids = getEnabledSkills(agentId);
  if (!ids.length) return '';
  const sections = [];
  for (const id of ids) {
    const r = readSkill(id);
    if (!r.ok) continue; // skip broken skills silently
    const s = r.skill;
    const triggers = (s.triggers || []).map(t => `- ${t}`).join('\n');
    sections.push(`## Skill: ${s.name} _(id: ${s.id})_\n\n${triggers ? `**Trigger when:**\n${triggers}\n\n` : ''}${s.body}`);
  }
  if (!sections.length) return '';
  return `# Your enabled skills (apply these when relevant)\n\n${sections.join('\n\n---\n\n')}\n\n`;
}

// ────────────────────────────────────────────────────────────
// Built-in starter skills — seeded on first access
// ────────────────────────────────────────────────────────────

const STARTER_SKILLS = [
  {
    id: 'send-screenshots',
    content: `---
name: Send Screenshots to User
description: How to share images and screenshots with the user via the CyberClaw chat transport
icon: 📷
triggers:
  - user asks for a picture or screenshot
  - user says they can't see something
  - agent wants to show a visual state (UI, terminal output, log file)
---

# Send Screenshots to User

## When to use

Reach for this skill any time the user asks to **see** something — a UI,
a dashboard, a terminal window, a log file, a list, a graph, a diagram.
Never respond with "here's what it looks like" or a prose description
when the user wants a visual. Save the actual image and attach it.

## Process

1. **Identify the source** — what is the user asking to see?
   - A specific app screen → use a screenshot tool (e.g. \`gnome-screenshot\`,
     a Playwright script for a web page, an in-app screen capture).
   - A log/dashboard → render to a PNG (e.g. curl an HTML dashboard to a
     PDF, then convert; or copy a chunk of text into a styled markdown file
     and render that).
   - A diagram or chart → generate the SVG/PNG with the diagram-maker
     skill, then attach.

2. **Save to a workspace path the chat transport can resolve.**

   Workspace paths the renderer can fetch:

   - \`/media/humpsuu/CYBERDRIVE/2B/work/...\`  (the CYBERDRIVE)
   - \`/home/humpsuu/...\`                       (the home directory)

   **Never use \`/tmp/\`** — the chat transport can't reach across into
   /tmp and the image will silently fail to render for the user.

   Use a stable filename (not \`/tmp/abc.png\`) so the path is easy to
   reference if the user wants to revisit it later.

3. **Attach via the \`MEDIA:\` directive on its own line** in the chat reply:

   \`\`\`
   Here's the dashboard as of 14:32:

   MEDIA:/media/humpsuu/CYBERDRIVE/2B/work/projects/cyber_database/screenshots/dashboard-2026-08-23T1432.png
   \`\`\`

   The MEDIA: line must be on its own line, not inline with text.
   Multiple images are fine — one MEDIA: line per image.

4. **Confirm the attachment in your prose.** Don't just paste the MEDIA:
   line and stop. Tell the user what they're looking at: "5 active
   visitors, 8 today, top product is the S19j Pro".

## Common pitfalls

- **/tmp paths** — the most common failure mode. Always save to a
  workspace path before attaching.
- **Inline MEDIA:** — must be on its own line, not part of a sentence.
- **Forgetting the prose** — bare MEDIA: lines without context leave
  the user wondering what they're looking at.
- **Stale screenshots** — if you're capturing live data, capture *after*
  the action you're documenting, not before.
`,
  },
  {
    id: 'deploy-via-pm2',
    content: `---
name: Deploy Website via pm2
description: How to deploy code changes to the cyberhive.no VPS using pm2 + scp
icon: 🚀
triggers:
  - user asks to ship a code change to production
  - user asks to update the website
  - user says "deploy" or "push to live"
---

# Deploy Website via pm2

## When to use

Use this when the user wants to push a code change to the live
**cyberhive.no** website (the VPS at \`208.113.135.124\`).

**Not for:** CyberClaw desktop/mobile (those use git + .deb rebuild
+ apt install), CyberDatabase (runs locally from source), CyberRepair
(local CLI). Use the right skill for the right thing.

## VPS cheatsheet

- **Host:** \`cyberhive-30gb\` @ \`208.113.135.124\` (ubuntu)
- **SSH key:** \`~/.ssh/cyberhive.pem\`
- **Project root:** \`/home/ubuntu/projects/cyberhive_website\`
- **Run manager:** pm2. Two processes:
  - \`0\` = \`nok_btc\` (BTC/NOK price updater)
  - \`1\` = \`server\` (main Express app)
- **Public URL:** \`https://cyberhive.no\`
- **PM2 restart:** \`pm2 restart 1\` or \`pm2 restart server\`
  (NEVER restart 0 unless you mean to bounce the price updater)

## Restart semantics

The site has two kinds of files; they restart differently:

- **\`Public/*.{css,js,ejs}\`** — LIVE on next page load, no restart.
- **\`Server/*.js\`** — REQUIRES \`pm2 restart 1\` after scp.

If you're not sure which files changed, restart. The cost is ~3 seconds
of downtime.

## Process

1. **Confirm what changed and confirm it builds locally.** Run
   \`node -c <file>\` on any changed Server/*.js files. If anything
   parses wrong, fix it locally first — never deploy broken code.

2. **SCP the changed files to the VPS:**

   \`\`\`bash
   scp -i ~/.ssh/cyberhive.pem \\
     Server/software-routes.js \\
     ubuntu@208.113.135.124:/home/ubuntu/projects/cyberhive_website/Server/
   \`\`\`

   For multi-file changes, list each file on its own \`scp\` line. The
   VPS destination path mirrors the local path under
   \`/home/ubuntu/projects/cyberhive_website/\`.

3. **Restart pm2 if any \`Server/*.js\` changed:**

   \`\`\`bash
   ssh -i ~/.ssh/cyberhive.pem ubuntu@208.113.135.124 \\
     'cd /home/ubuntu/projects/cyberhive_website && pm2 restart 1'
   \`\`\`

4. **Verify the deploy.** Curl the affected endpoint from the VPS:

   \`\`\`bash
   ssh -i ~/.ssh/cyberhive.pem ubuntu@208.113.135.124 \\
     'curl -sI https://cyberhive.no/<affected-path> | head -5'
   \`\`\`

   Or \`pm2 logs server --lines 50 --nostream\` to check for errors.

5. **Tell the user what shipped and what URL to hit.**

## Anti-patterns

- **Don't \`git pull\` on the VPS** unless the user explicitly asks. The
  local \`cyberhive_website\` checkout isn't always in sync with the
  VPS — files were historically scp'd piecemeal. \`git pull\` may bring
  in unrelated changes or fail outright.
- **Don't restart pm2 process \`0\`** unless you mean to bounce the
  price updater. \`pm2 restart 1\` for app changes.
- **Don't \`apt install\` anything on the VPS** without explicit ask.
`,
  },
  {
    id: 'manage-cybercomputer-services',
    content: `---
name: Manage Cybercomputer Services
description: How to start/stop/check status of background services running on cybercomputer
icon: 🛠️
triggers:
  - user asks to start/stop/restart CyberDatabase
  - user asks why something isn't responding on localhost
  - agent needs to verify a service is running before testing
---

# Manage Cybercomputer Services

## When to use

Use this when you need to check, start, stop, or restart one of the
background services running on **cybercomputer** (this host,
\`192.168.10.133\`). Cybercomputer is the primary company host as of
2026-08-23, so these are the services the rest of the house relies on.

## Service catalogue

| Service | Port | Launcher | Status command |
|---|---|---|---|
| **CyberDatabase** server | 3847 | \`cyber-database {start\|stop\|status}\` | \`cyber-database status\` |
| **CyberDatabase** Electron GUI | 3847 | \`cyber-database-electron\` | \`ss -tln \\| grep 3847\` |
| **CyberRepair** CLI | (CLI) | \`cyber-repair\` | \`cyber-repair --help\` |
| **CyberClaw** desktop dev | 9247 | \`npm start\` from cyberclaw project | \`ss -tln \\| grep 9247\` |
| **OpenClaw** gateway | 18789 | systemd / user session | \`ss -tln \\| grep 18789\` |

## Process

1. **Identify which service** the user (or you) need to touch. Don't
   shotgun-restart everything.

2. **Check status first.** Most service launchers have a \`status\`
   subcommand, and the port check (\`ss -tln | grep <port>\`) is a
   reliable cross-check.

3. **Stop before swapping modes.** CyberDatabase has two modes
   (standalone server + Electron desktop); they BOTH try to bind port
   3847. Switching modes requires stopping one first. The
   \`cyber-database-electron\` launcher handles this automatically.

4. **Read the logs** if a service fails to start:
   - CyberDatabase: \`/tmp/cyber-database.log\`
   - CyberClaw: \`/tmp/cyberclaw-desktop.log\`
   - OpenClaw: \`journalctl --user -u openclaw-gateway -n 50\` or
     \`/tmp/openclaw/openclaw-<date>.log\`

5. **Don't \`kill -9\` unless you've tried SIGTERM first.** Electron
   processes have zygote children that need a clean shutdown to avoid
   leaving GPU/network helper orphans.

## Port-conflict matrix

If port 3847 (CyberDatabase) is occupied when you try to start the
standalone server, the Electron GUI from a previous session is still
running. \`cyber-database stop\` resolves it.

If port 9247 (CyberClaw sync server) is occupied when you try to
launch the desktop, an old \`npm start\` process is still alive. Find
it with \`ps -ef | grep -E "electron|node " | grep cyberclaw\` and
kill the chain (see TOOLS.md for the exact restart pattern).
`,
  },
];

function seedStarterSkills() {
  ensureSkillsDir();
  const seeded = [];
  for (const s of STARTER_SKILLS) {
    const file = path.join(SKILLS_DIR, s.id, 'SKILL.md');
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, s.content, 'utf8');
    seeded.push(s.id);
  }
  return seeded;
}

module.exports = {
  // Storage
  SKILLS_DIR, COMPANIONS_DIR,
  // Skill CRUD
  listSkills, readSkill, createSkill, updateSkill, deleteSkill,
  // Per-companion enabled
  getEnabledSkills, setEnabledSkills,
  // Prompt assembly
  buildSkillsPromptBlock,
  // Seeding
  seedStarterSkills, STARTER_SKILLS,
  // Helpers
  parseSkillFile, serializeSkillFile, validateSkill, slugify,
};
