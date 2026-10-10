import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

/**
 * Historique multi-outils (Claude Code, OpenCode, Mistral Vibe) pour l'onglet Historique.
 *
 * Le temps actif se mesure en créneaux de 15 min : un créneau compte dès qu'au moins un
 * message y est daté. Les créneaux de plusieurs sessions simultanées ne comptent qu'une
 * fois (union), ce qui donne un temps de présence, pas une somme de durées de sessions.
 *
 * Les ~1 Go de transcripts Claude ne sont parsés qu'une fois : chaque fichier est résumé
 * et le résumé est mis en cache sur disque (clé : taille + mtime). Seuls les fichiers
 * modifiés depuis sont relus.
 */

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const HISTORY_JSONL = path.join(CLAUDE_DIR, 'history.jsonl');
const VIBE_SESSIONS = path.join(process.env.VIBE_HOME || path.join(os.homedir(), '.vibe'), 'logs', 'session');
const CACHE_DIR = process.env.ACT_CACHE_DIR || path.join(os.homedir(), '.cache', 'agents-control-tower');
const CACHE_FILE = path.join(CACHE_DIR, 'history-v1.json');
const CACHE_VERSION = 1;

const SLOT_MS = 15 * 60_000;
const DAY_MS = 24 * 3600_000;
// Vibe ne date pas ses messages : la session entière compte, plafonnée pour ne pas
// transformer une fenêtre oubliée ouverte en journée de travail
const VIBE_MAX_SPAN_MS = 4 * 3600_000;
const OBSERVER_MARK = '.claude-mem/observer-sessions';
const OPENCODE_TTL_MS = 60_000;
// Une ligne plus longue est un gros résultat d'outil : on n'en lit que l'horodatage
const MAX_PARSED_LINE = 200_000;

/**
 * Tarifs API Anthropic en $ par million de tokens : [entrée, sortie, lecture cache,
 * écriture cache 5 min, écriture cache 1 h]. Source : skill claude-api, 2026-10-06.
 * Sert à estimer ce qu'aurait coûté la consommation Claude Code au tarif API.
 */
const OPUS_4 = [5, 25, 0.50, 6.25, 10];
const PRICES = {
  'claude-fable-5-1': [10, 50, 0.25, 12.5, 20],
  'claude-fable-5': [10, 50, 1.00, 12.5, 20],
  'claude-opus-5-5': [4, 20, 0.20, 5, 8],
  'claude-opus-5': [5, 25, 0.50, 6.25, 10],
  'claude-opus-4-8': OPUS_4,
  'claude-opus-4-7': OPUS_4,
  'claude-opus-4-6': OPUS_4,
  'claude-sonnet-5-5': [2, 10, 0.20, 2.5, 4],
  'claude-sonnet-5': [2, 10, 0.20, 2.5, 4],
  'claude-sonnet-4-6': [3, 15, 0.30, 3.75, 6],
  'claude-haiku-5-5': [0.10, 0.50, 0.01, 0.125, 0.20],
  'claude-haiku-4-5': [1, 5, 0.10, 1.25, 2],
};

function normalizeModel(model) {
  return model.replace(/\[1m\]$/, '').replace(/-\d{8}$/, '');
}

/** Coût API d'un usage [in, out, cacheRead, cacheWrite5m, cacheWrite1h], ou null si modèle inconnu. */
function apiCost(model, u) {
  const p = PRICES[normalizeModel(model)];
  if (!p) return null;
  return (u[0] * p[0] + u[1] * p[1] + u[2] * p[2] + u[3] * p[3] + u[4] * p[4]) / 1e6;
}

function pad(n) { return String(n).padStart(2, '0'); }
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function projectOf(cwd) {
  if (!cwd) return { key: '(inconnu)', name: '(inconnu)', background: false };
  if (cwd.includes(OBSERVER_MARK)) return { key: OBSERVER_MARK, name: 'claude-mem observer', background: true };
  return { key: cwd, name: path.basename(cwd) || cwd, background: false };
}

// ---------------------------------------------------------------------------
// Claude Code : un résumé par transcript
// ---------------------------------------------------------------------------

/** Horodatage de premier niveau d'une ligne trop longue pour être parsée. */
function timestampOfRawLine(line) {
  const i = line.lastIndexOf('"timestamp":"');
  if (i === -1) return null;
  return Date.parse(line.slice(i + 13, i + 13 + 40).split('"')[0]) || null;
}

function summarizeClaudeTranscript(text, file) {
  const slots = new Set();
  const lastUsageById = new Map(); // message.id -> dernière ligne (le streaming réécrit le usage)
  let cwd = null, sessionId = null, start = null, end = null;

  for (const line of text.split('\n')) {
    if (!line) continue;
    let ts, j = null;
    if (line.length > MAX_PARSED_LINE) {
      ts = timestampOfRawLine(line);
    } else {
      try { j = JSON.parse(line); } catch { continue; }
      if (j.type !== 'user' && j.type !== 'assistant') continue;
      ts = Date.parse(j.timestamp);
      cwd ||= j.cwd;
      sessionId ||= j.sessionId;
    }
    if (!ts) continue;
    slots.add(Math.floor(ts / SLOT_MS));
    if (start === null || ts < start) start = ts;
    if (end === null || ts > end) end = ts;
    const u = j?.type === 'assistant' && j.message?.usage;
    if (u && j.message.model && j.message.model !== '<synthetic>') {
      lastUsageById.set(j.message.id || j.uuid, { ts, model: j.message.model, u });
    }
  }

  // usage agrégé par jour et par modèle : [in, out, cacheRead, cw5m, cw1h, réponses]
  const usage = {};
  for (const { ts, model, u } of lastUsageById.values()) {
    const key = `${dayKey(ts)}|${normalizeModel(model)}`;
    const cw1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
    const cw5m = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - cw1h);
    const row = usage[key] ||= [0, 0, 0, 0, 0, 0];
    row[0] += u.input_tokens || 0;
    row[1] += u.output_tokens || 0;
    row[2] += u.cache_read_input_tokens || 0;
    row[3] += cw5m;
    row[4] += cw1h;
    row[5] += 1;
  }

  return {
    sessionId: sessionId || path.basename(file, '.jsonl'),
    cwd,
    subagent: file.includes(`${path.sep}subagents${path.sep}`),
    start, end,
    slots: [...slots].sort((a, b) => a - b),
    usage,
  };
}

async function listTranscripts(dir) {
  const out = [];
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await listTranscripts(p));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

let diskCache = null;
function loadDiskCache() {
  if (diskCache) return diskCache;
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    if (c.version === CACHE_VERSION) return (diskCache = c);
  } catch { /* pas encore de cache */ }
  return (diskCache = { version: CACHE_VERSION, files: {} });
}

async function saveDiskCache() {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(diskCache));
  await fsp.rename(tmp, CACHE_FILE);
}

async function collectClaudeTranscripts() {
  const cache = loadDiskCache();
  const files = await listTranscripts(PROJECTS_DIR);
  const seen = new Set();
  let parsed = 0;
  for (const file of files) {
    seen.add(file);
    let st;
    try { st = await fsp.stat(file); } catch { continue; }
    const hit = cache.files[file];
    if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) continue;
    try {
      const text = await fsp.readFile(file, 'utf-8'); // await : laisse respirer le serveur entre deux fichiers
      cache.files[file] = { size: st.size, mtime: st.mtimeMs, summary: summarizeClaudeTranscript(text, file) };
      parsed++;
    } catch { /* fichier disparu ou illisible : ignoré */ }
  }
  let removed = 0;
  for (const file of Object.keys(cache.files)) {
    if (!seen.has(file)) { delete cache.files[file]; removed++; }
  }
  if (parsed || removed) await saveDiskCache();
  return { summaries: Object.values(cache.files).map(f => f.summary), parsed, total: files.length };
}

/** Prompts tapés par l'humain, depuis l'historique de saisie de Claude Code. */
async function collectClaudePrompts() {
  try {
    const text = await fsp.readFile(HISTORY_JSONL, 'utf-8');
    const prompts = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        if (j.timestamp) prompts.push({ ts: j.timestamp, cwd: j.project || null });
      } catch { /* ligne tronquée */ }
    }
    return prompts;
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// OpenCode et Mistral Vibe
// ---------------------------------------------------------------------------

function runOpencode(sql) {
  const out = execFileSync('opencode', ['db', sql, '--format', 'json'], {
    encoding: 'utf-8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  return out ? JSON.parse(out) : [];
}

let opencodeCache = { at: 0, data: null };
function collectOpencode() {
  if (opencodeCache.data && Date.now() - opencodeCache.at < OPENCODE_TTL_MS) return opencodeCache.data;
  let data;
  try {
    const sessions = runOpencode(`SELECT s.id, s.directory, s.model, s.cost, s.tokens_input, s.tokens_output,
      s.tokens_cache_read, s.tokens_cache_write, s.time_created, s.time_updated FROM session s`);
    // Créneaux de 15 min déjà agrégés en SQL (division entière sur les ms)
    const slots = runOpencode(`SELECT s.directory AS d, m.time_created / ${SLOT_MS} AS slot
      FROM message m JOIN session s ON s.id = m.session_id GROUP BY d, slot`);
    data = { available: true, sessions, slots };
  } catch (e) {
    data = { available: false, reason: e.code === 'ENOENT' ? 'CLI opencode introuvable' : e.message, sessions: [], slots: [] };
  }
  opencodeCache = { at: Date.now(), data };
  return data;
}

function opencodeModel(raw) {
  try { return JSON.parse(raw).id || 'inconnu'; } catch { return raw || 'inconnu'; }
}

async function collectVibe() {
  let dirs;
  try { dirs = await fsp.readdir(VIBE_SESSIONS, { withFileTypes: true }); } catch { return { available: false, sessions: [] }; }
  const sessions = [];
  for (const d of dirs) {
    if (!d.isDirectory() || d.name === 'active') continue;
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(VIBE_SESSIONS, d.name, 'meta.json'), 'utf-8'));
      const start = Date.parse(meta.start_time);
      if (!start) continue;
      const end = Date.parse(meta.end_time) || start;
      sessions.push({
        cwd: meta.environment?.working_directory || null,
        start, end,
        cost: meta.stats?.session_cost || 0,
        tokensIn: meta.stats?.session_prompt_tokens || 0,
        tokensOut: meta.stats?.session_completion_tokens || 0,
        model: meta.config?.active_model || 'mistral',
      });
    } catch { /* session sans meta.json lisible */ }
  }
  return { available: true, sessions };
}

// ---------------------------------------------------------------------------
// Agrégation
// ---------------------------------------------------------------------------

const TOOLS = ['claude', 'opencode', 'vibe'];

function emptyProject(p) {
  return {
    key: p.key, name: p.name, background: p.background,
    slots: { claude: new Set(), opencode: new Set(), vibe: new Set() },
    sessions: { claude: 0, opencode: 0, vibe: 0 },
    prompts: 0, lastActivity: 0, apiCost: 0, realCost: 0, tokensOut: 0,
  };
}

let inFlight = null;
const resultCache = new Map(); // rangeDays -> { at, data }
const RESULT_TTL_MS = 60_000;

export function collectHistory(rangeDays = 90) {
  const hit = resultCache.get(rangeDays);
  if (hit && Date.now() - hit.at < RESULT_TTL_MS) return Promise.resolve(hit.data);
  // Une seule reconstruction à la fois, partagée entre requêtes concurrentes
  inFlight ||= buildHistory(rangeDays).finally(() => { inFlight = null; });
  return inFlight.then(data => {
    if (data.rangeDays !== rangeDays) return collectHistory(rangeDays);
    resultCache.set(rangeDays, { at: Date.now(), data });
    return data;
  });
}

async function buildHistory(rangeDays) {
  const t0 = Date.now();
  const now = Date.now();
  const rangeStart = startOfDay(now - (rangeDays - 1) * DAY_MS);
  const firstSlot = Math.floor(rangeStart / SLOT_MS);
  const inRange = ts => ts >= rangeStart && ts <= now;

  const [claude, prompts, vibe] = await Promise.all([collectClaudeTranscripts(), collectClaudePrompts(), collectVibe()]);
  const opencode = collectOpencode();

  const projects = new Map();
  const project = cwd => {
    const p = projectOf(cwd);
    if (!projects.has(p.key)) projects.set(p.key, emptyProject(p));
    return projects.get(p.key);
  };
  const toolSlots = { claude: new Set(), opencode: new Set(), vibe: new Set() };
  const models = new Map();
  const model = (tool, name) => {
    const k = `${tool}|${name}`;
    if (!models.has(k)) models.set(k, { tool, model: name, responses: 0, sessions: 0, tokens: [0, 0, 0, 0, 0], cost: 0, costKind: tool === 'claude' ? 'api' : 'real' });
    return models.get(k);
  };
  const days = new Map();
  for (let t = rangeStart; t <= now; t += DAY_MS) days.set(dayKey(t), { date: dayKey(t), apiCost: 0, realCost: 0, prompts: 0, sessions: 0 });
  const addSlot = (tool, p, slot) => {
    if (slot < firstSlot) return;
    p.slots[tool].add(slot);
    // Les sessions d'arrière-plan (observer claude-mem) ne comptent pas comme présence humaine
    if (!p.background) toolSlots[tool].add(slot);
    p.lastActivity = Math.max(p.lastActivity, slot * SLOT_MS);
  };

  // Claude Code
  for (const s of claude.summaries) {
    const p = project(s.cwd);
    for (const slot of s.slots) addSlot('claude', p, slot);
    if (!s.subagent && s.start && inRange(s.start)) {
      p.sessions.claude++;
      if (!p.background) days.get(dayKey(s.start)).sessions++;
    }
    for (const [key, u] of Object.entries(s.usage)) {
      const [day, name] = key.split('|');
      const d = days.get(day);
      if (!d) continue;
      const cost = apiCost(name, u) ?? 0;
      const m = model('claude', name);
      m.responses += u[5];
      for (let i = 0; i < 5; i++) m.tokens[i] += u[i];
      m.cost += cost;
      d.apiCost += cost;
      p.apiCost += cost;
      p.tokensOut += u[1];
    }
  }
  for (const pr of prompts) {
    if (!inRange(pr.ts)) continue;
    days.get(dayKey(pr.ts)).prompts++;
    project(pr.cwd).prompts++;
  }

  // OpenCode
  for (const row of opencode.slots) addSlot('opencode', project(row.d), Number(row.slot));
  for (const s of opencode.sessions) {
    if (!inRange(s.time_created)) continue;
    const p = project(s.directory);
    p.sessions.opencode++;
    p.realCost += s.cost || 0;
    p.tokensOut += s.tokens_output || 0;
    const d = days.get(dayKey(s.time_created));
    d.sessions++;
    d.realCost += s.cost || 0;
    const m = model('opencode', opencodeModel(s.model));
    m.sessions++;
    m.tokens[0] += s.tokens_input || 0;
    m.tokens[1] += s.tokens_output || 0;
    m.tokens[2] += s.tokens_cache_read || 0;
    m.tokens[3] += s.tokens_cache_write || 0;
    m.cost += s.cost || 0;
  }

  // Mistral Vibe
  for (const s of vibe.sessions) {
    if (!inRange(s.start)) continue;
    const p = project(s.cwd);
    const last = Math.min(s.end, s.start + VIBE_MAX_SPAN_MS);
    for (let slot = Math.floor(s.start / SLOT_MS); slot <= Math.floor(last / SLOT_MS); slot++) addSlot('vibe', p, slot);
    p.sessions.vibe++;
    p.realCost += s.cost;
    p.tokensOut += s.tokensOut;
    const d = days.get(dayKey(s.start));
    d.sessions++;
    d.realCost += s.cost;
    const m = model('vibe', s.model);
    m.sessions++;
    m.tokens[0] += s.tokensIn;
    m.tokens[1] += s.tokensOut;
    m.cost += s.cost;
  }

  // Minutes actives par jour et par outil, union tous outils, carte heures × jours
  const allSlots = new Set([...toolSlots.claude, ...toolSlots.opencode, ...toolSlots.vibe]);
  const minutes = {};
  for (const d of days.values()) minutes[d.date] = { claude: 0, opencode: 0, vibe: 0, all: 0 };
  for (const tool of TOOLS) {
    for (const slot of toolSlots[tool]) {
      const m = minutes[dayKey(slot * SLOT_MS)];
      if (m) m[tool] += 15;
    }
  }
  // punch[jour 0=lundi][heure] = minutes, tous outils confondus
  const punch = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const slot of allSlots) {
    const ts = slot * SLOT_MS;
    const m = minutes[dayKey(ts)];
    if (!m) continue;
    m.all += 15;
    const d = new Date(ts);
    punch[(d.getDay() + 6) % 7][d.getHours()] += 15;
  }

  const weekCount = Math.ceil(rangeDays / 7);
  const projectList = [...projects.values()]
    .map(p => {
      const union = new Set([...p.slots.claude, ...p.slots.opencode, ...p.slots.vibe]);
      const weekly = new Array(weekCount).fill(0);
      for (const slot of union) {
        const w = Math.floor((slot * SLOT_MS - rangeStart) / (7 * DAY_MS));
        if (w >= 0 && w < weekCount) weekly[w] += 15;
      }
      return {
        name: p.name, cwd: p.key, background: p.background,
        activeMin: union.size * 15,
        minutesByTool: { claude: p.slots.claude.size * 15, opencode: p.slots.opencode.size * 15, vibe: p.slots.vibe.size * 15 },
        sessions: p.sessions, prompts: p.prompts,
        lastActivity: p.lastActivity || null,
        apiCost: p.apiCost, realCost: p.realCost, tokensOut: p.tokensOut,
        weekly,
      };
    })
    .filter(p => p.activeMin > 0 || p.apiCost > 0 || p.realCost > 0)
    .sort((a, b) => b.activeMin - a.activeMin);

  const dayList = [...days.values()].map(d => ({ ...d, minutes: minutes[d.date] }));
  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);

  return {
    generatedAt: now,
    rangeDays, rangeStart,
    buildMs: Date.now() - t0,
    index: { transcripts: claude.total, reparsed: claude.parsed, cacheFile: CACHE_FILE },
    sources: {
      claude: true,
      opencode: opencode.available ? true : opencode.reason,
      vibe: vibe.available,
    },
    totals: {
      activeMin: allSlots.size * 15,
      activeMinByTool: { claude: toolSlots.claude.size * 15, opencode: toolSlots.opencode.size * 15, vibe: toolSlots.vibe.size * 15 },
      sessions: sum(dayList, d => d.sessions),
      prompts: sum(dayList, d => d.prompts),
      activeDays: dayList.filter(d => d.minutes.all > 0).length,
      apiCost: sum(dayList, d => d.apiCost),
      realCost: sum(dayList, d => d.realCost),
    },
    days: dayList,
    punch,
    projects: projectList,
    models: [...models.values()].sort((a, b) => b.cost - a.cost),
  };
}
