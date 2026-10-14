// Voice learning: makes local speech recognition adapt to this user.
//  1. Vocabulary — words the user actually uses (names, project terms,
//     jargon) are collected from typed messages and fed to Whisper as a
//     glossary prompt, so "Clawsuu" stops becoming "Claw Sue".
//  2. Corrections — if the user types a fix shortly after a voice message,
//     the differing words get a strong boost and the pair is logged.
//  3. Corpus — every voice clip is kept with its transcript (and later
//     correction) in voice/corpus/, ready for fine-tuning on this voice.
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.openclaw', 'cyberclaw', 'voice');
const VOCAB_FILE = path.join(DIR, 'vocab.json');
const CORPUS = path.join(DIR, 'corpus');
const CORPUS_INDEX = path.join(CORPUS, 'index.jsonl');
const CORPUS_MAX_FILES = 3000;
const PROMPT_TERMS = 60;
const CORRECTION_WINDOW_MS = 90 * 1000;

const COMMON = new Set(('the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us is are was were been has had did does am yes ok okay hey hi hello please thanks thank sure right yeah lets let im dont cant its thats whats').split(' '));

let vocab = null;
let lastTranscript = null; // { text, ts, sampleId }

function load() {
  if (vocab) return vocab;
  try { vocab = JSON.parse(fs.readFileSync(VOCAB_FILE, 'utf8')); } catch { vocab = { terms: {} }; }
  if (!vocab.terms) vocab.terms = {};
  return vocab;
}
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(VOCAB_FILE, JSON.stringify(vocab, null, 1)); } catch (e) { console.warn('[voice-learning] save failed:', e.message); }
  }, 1500);
}

function bump(term, weight, kind) {
  const v = load();
  const key = term.toLowerCase();
  const t = v.terms[key] || (v.terms[key] = { term, n: 0, fixed: 0, seed: 0 });
  if (/[A-Z]/.test(term) && !/[A-Z]/.test(t.term)) t.term = term; // prefer the cased spelling
  if (kind === 'fixed') t.fixed += weight; else if (kind === 'seed') t.seed = Math.max(t.seed, weight); else t.n += weight;
  t.last = Date.now();
  save();
}

function candidates(text) {
  const out = [];
  const clean = String(text || '')
    .replace(/\[[^\]]{0,4000}\]/g, ' ')        // strip [context] / [From: …] blocks
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/`[^`]*`/g, ' ');
  const sentences = clean.split(/(?<=[.!?\n])\s+/);
  for (const s of sentences) {
    const words = s.match(/[A-Za-z][A-Za-z0-9_\-]{2,30}/g) || [];
    words.forEach((w, i) => {
      const lw = w.toLowerCase();
      if (COMMON.has(lw)) return;
      const special = /[_\d]/.test(w) || /[a-z][A-Z]/.test(w) || (/^[A-Z]/.test(w) && i > 0) || /^[A-Z]{2,}$/.test(w);
      if (special) out.push(w);
    });
  }
  return out;
}

// Typed user messages (desktop or phone).
function learnFromText(text) {
  if (!text) return;
  const plain = String(text).replace(/^\[From:[^\]]*\]\s*/, '');
  for (const w of candidates(plain)) bump(w, 1, 'n');
  if (lastTranscript && Date.now() - lastTranscript.ts < CORRECTION_WINDOW_MS) learnCorrection(plain);
}

function tokens(s) { return (String(s || '').toLowerCase().match(/[a-z0-9_]+/g) || []); }
function learnCorrection(typed) {
  const heard = lastTranscript; lastTranscript = null;
  const a = tokens(heard.text), b = tokens(typed);
  if (!a.length || !b.length) return;
  const A = new Set(a), B = new Set(b);
  const shared = [...B].filter(x => A.has(x)).length;
  if (shared / Math.max(A.size, B.size) < 0.4 || typed.trim() === heard.text.trim()) return; // a new message, not a correction
  const original = String(typed).match(/[A-Za-z][A-Za-z0-9_\-]{1,30}/g) || [];
  const fixed = original.filter(w => !A.has(w.toLowerCase()) && !COMMON.has(w.toLowerCase()));
  for (const w of fixed) bump(w, 1, 'fixed');
  try {
    fs.mkdirSync(CORPUS, { recursive: true });
    fs.appendFileSync(path.join(CORPUS, 'corrections.jsonl'), JSON.stringify({ ts: Date.now(), heard: heard.text, meant: typed, sample: heard.sampleId || null, words: fixed }) + '\n');
  } catch {}
  if (fixed.length) console.log('[voice-learning] learned from correction:', fixed.join(', '));
}

// Names that should always be recognised (companions, quests).
function seed(terms) { for (const t of terms || []) if (t && String(t).length > 2) bump(String(t).replace(/_/g, ' ').trim(), 3, 'seed'); }

function buildPrompt() {
  const v = load();
  const scored = Object.values(v.terms)
    .map(t => ({ t: t.term, s: t.fixed * 6 + t.seed * 2 + Math.log2(1 + t.n) }))
    .filter(x => x.s >= 1.5)
    .sort((x, y) => y.s - x.s)
    .slice(0, PROMPT_TERMS)
    .map(x => x.t);
  return scored.length ? 'Glossary: ' + scored.join(', ') + '.' : '';
}

function recordSample(audioBase64, mimeType, text, meta) {
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  lastTranscript = { text: text || '', ts: Date.now(), sampleId: id };
  try {
    fs.mkdirSync(CORPUS, { recursive: true });
    const ext = (mimeType || '').includes('wav') ? 'wav' : 'm4a';
    fs.writeFileSync(path.join(CORPUS, id + '.' + ext), Buffer.from(audioBase64, 'base64'));
    fs.appendFileSync(CORPUS_INDEX, JSON.stringify({ id, file: id + '.' + ext, text, ts: Date.now(), ...(meta || {}) }) + '\n');
    const files = fs.readdirSync(CORPUS).filter(f => /\.(wav|m4a)$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - CORPUS_MAX_FILES))) fs.unlinkSync(path.join(CORPUS, f));
  } catch (e) { console.warn('[voice-learning] sample save failed:', e.message); }
  return id;
}

function stats() {
  const v = load();
  const terms = Object.values(v.terms);
  let samples = 0, corrections = 0;
  try { samples = fs.readdirSync(CORPUS).filter(f => /\.(wav|m4a)$/.test(f)).length; } catch {}
  try { corrections = fs.readFileSync(path.join(CORPUS, 'corrections.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch {}
  return { terms: terms.length, corrected: terms.filter(t => t.fixed > 0).length, samples, corrections, prompt: buildPrompt() };
}

module.exports = { learnFromText, seed, buildPrompt, recordSample, stats, DIR };
