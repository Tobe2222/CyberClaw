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

   The chat transport can fetch files from any path the OpenClaw
   gateway's file-transfer plugin allows. On a typical setup, save
   the screenshot into the user's project workspace (e.g. a
   \`screenshots/\` folder under the active quest directory, or the
   user's home directory). 

   **Never use \`/tmp/\`** — the chat transport can't reach across into
   /tmp and the image will silently fail to render for the user.

   Use a stable filename (not \`/tmp/abc.png\`) so the path is easy to
   reference if the user wants to revisit it later.

3. **Attach via the \`MEDIA:\` directive on its own line** in the chat reply:

   \`\`\`
   Here's the dashboard as of 14:32:

   MEDIA:/home/<you>/projects/<project>/screenshots/dashboard-2026-08-23T1432.png
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
  // deploy-via-pm2 and manage-cybercomputer-services were removed from
  // the default seed in v3.3.1 — they're Tobe-specific desktop
  // workflows that shouldn't ship to other users. Tobe keeps them
  // as manual skills in his own ~/.openclaw/cyberclaw/skills/.
  // If we ever want to ship them as opt-in starters, list them under
  // STARTER_SKILLS with a per-user filter rather than as universal
  // defaults.
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
