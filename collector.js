import fs from 'fs';
import path from 'path';
import os from 'os';
import { statusLineSnapshot } from './collector-quota.js';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

/**
 * Encode a cwd to the project dir key used by Claude Code.
 * /home/robin/dev/toje -> -home-robin-dev-toje
 */
function cwdToProjectKey(cwd) {
  return cwd.replace(/\//g, '-');
}

function safeReadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function getRecentSessionsJsons() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json') && !f.endsWith('.key'))
    .map(f => path.join(SESSIONS_DIR, f));
}

function parseSessionMeta(file) {
  const data = safeReadJson(file);
  if (!data || !data.pid || !data.sessionId) return null;
  return data;
}

function isNoiseHumanText(t) {
  if (!t) return true;
  const s = t.trim();
  if (s.startsWith('<task-notification>')) return true;
  if (s.startsWith('<command-name>')) return true;
  if (s.startsWith('<local-command-')) return true;
  if (s.startsWith('Condense the tool payload')) return true;
  if (s.startsWith('[Request interrupted')) return true;
  if (s.startsWith('[Image')) return true;
  if (s.length < 2) return true;
  return false;
}

/**
 * Texte tapé par l'humain dans une ligne `user`, ou null si la ligne est technique.
 * Les transcripts récents marquent l'auteur dans `origin.kind` ('human', 'peer',
 * 'task-notification'…) ; `isMeta` signale les injections du harness (images, skills).
 * Sans `origin` (anciennes versions), on retombe sur l'heuristique isNoiseHumanText.
 */
function humanTextOf(j) {
  if (j.isMeta) return null;
  if (j.origin && j.origin.kind !== 'human') return null;
  const content = j.message?.content;
  const parts = typeof content === 'string'
    ? [content]
    : Array.isArray(content) ? content.filter(b => b.type === 'text' && b.text).map(b => b.text) : [];
  const txt = parts.filter(p => !isNoiseHumanText(p)).join(' ');
  if (!j.origin && isNoiseHumanText(txt)) return null;
  return txt.trim() ? txt : null;
}

/** Version lisible d'un message pour l'aperçu : sans balises techniques ni Markdown. */
function toPreview(text, max = 300) {
  if (!text) return null;
  const s = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/\[Image #\d+\]/g, '🖼')
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')       // liens et images Markdown
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '') // titres, citations, puces
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')              // gras, barré
    .replace(/`([^`]+)`/g, '$1')                        // code inline
    .replace(/^\s*\|.*\|\s*$/gm, ' ')                   // lignes de tableau
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function emptySummary() {
  return {
    model: null, gitBranch: null, cwd: null,
    userCount: 0, assistantCount: 0, toolUseCount: 0, thinkingCount: 0,
    lastHumanText: null, lastAssistantText: null, lastToolName: null,
    contextTokens: null,     // taille du contexte au dernier appel du modèle
    pendingQuestion: false,  // le dernier tour de l'IA se termine par une question
    tokenAgg: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
  };
}

const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

/**
 * Intègre une ligne du transcript au résumé courant.
 * Claude Code écrit une réponse en plusieurs lignes (une par bloc de contenu) qui portent
 * le même `message.id` et un `usage` mis à jour au fil du streaming : seule la dernière
 * ligne de chaque réponse compte, d'où `usageById` qui remplace la contribution précédente.
 */
function applyLine(state, j) {
  const acc = state.acc;
  if (j.cwd) acc.cwd = j.cwd;
  if (j.gitBranch) acc.gitBranch = j.gitBranch;
  if (j.type === 'user') {
    acc.userCount++;
    const txt = toPreview(humanTextOf(j));
    if (txt) { acc.lastHumanText = txt; acc.pendingQuestion = false; }
  }
  if (j.type === 'assistant') {
    const msg = j.message;
    if (msg?.model) acc.model = msg.model;
    const u = msg?.usage;
    if (u) {
      const id = msg.id || j.uuid;
      const prev = state.usageById.get(id);
      if (!prev) acc.assistantCount++;
      const p = prev || ZERO_USAGE;
      state.usageById.set(id, u);
      acc.tokenAgg.input += (u.input_tokens || 0) - (p.input_tokens || 0);
      acc.tokenAgg.output += (u.output_tokens || 0) - (p.output_tokens || 0);
      acc.tokenAgg.cacheRead += (u.cache_read_input_tokens || 0) - (p.cache_read_input_tokens || 0);
      acc.tokenAgg.cacheCreate += (u.cache_creation_input_tokens || 0) - (p.cache_creation_input_tokens || 0);
      if (!j.isSidechain) {
        acc.contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      }
    }
    for (const b of (Array.isArray(msg?.content) ? msg.content : [])) {
      if (b.type === 'thinking') acc.thinkingCount++;
      if (b.type === 'text' && b.text) {
        acc.lastAssistantText = toPreview(b.text) || acc.lastAssistantText;
        acc.pendingQuestion = /\?\s*$/.test(b.text);
      }
      if (b.type === 'tool_use') { acc.toolUseCount++; acc.lastToolName = b.name; acc.pendingQuestion = false; }
    }
  }
}

/**
 * Résumés par transcript, mis à jour de façon incrémentale : un transcript n'est lu en
 * entier qu'une fois, puis seuls les octets ajoutés depuis le relevé précédent sont
 * parsés. `rest` garde la dernière ligne incomplète (en cours d'écriture).
 */
const transcripts = new Map();
const CHUNK_SIZE = 4 * 1024 * 1024;

function summarizeJsonl(jsonlPath) {
  const stat = fs.statSync(jsonlPath);
  let state = transcripts.get(jsonlPath);
  // Fichier tronqué ou remplacé : on repart de zéro
  if (!state || stat.size < state.offset) {
    state = { offset: 0, rest: Buffer.alloc(0), acc: emptySummary(), usageById: new Map() };
    transcripts.set(jsonlPath, state);
  }
  if (stat.size > state.offset) {
    const fd = fs.openSync(jsonlPath, 'r');
    try {
      const buf = Buffer.alloc(Math.min(CHUNK_SIZE, stat.size - state.offset));
      while (state.offset < stat.size) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, stat.size - state.offset), state.offset);
        if (n <= 0) break;
        state.offset += n;
        // Découpe sur les octets '\n' : un caractère UTF-8 n'est jamais coupé en deux
        let data = Buffer.concat([state.rest, buf.subarray(0, n)]);
        let nl;
        while ((nl = data.indexOf(10)) !== -1) {
          const line = data.subarray(0, nl).toString('utf-8');
          data = data.subarray(nl + 1);
          if (!line) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          applyLine(state, j);
        }
        state.rest = Buffer.from(data);
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return { ...state.acc, totalSize: stat.size, mtime: stat.mtimeMs };
}

function findJsonlForSession(sessionId, cwd) {
  // Try project dir derived from cwd
  if (cwd) {
    const key = cwdToProjectKey(cwd);
    const projDir = path.join(PROJECTS_DIR, key);
    const candidate = path.join(projDir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  // Fallback: brute force search (only for v1, small number of projects)
  for (const proj of fs.readdirSync(PROJECTS_DIR)) {
    const p = path.join(PROJECTS_DIR, proj, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getProcInfo(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8').split(' ');
    // state is field 3 (index 2)
    const state = stat[2];
    const utime = parseInt(stat[13], 10);
    const stime = parseInt(stat[14], 10);
    const rssPages = parseInt(stat[23], 10);
    const rssKb = Math.round(rssPages * 4096 / 1024);
    let statusText = fs.readFileSync(`/proc/${pid}/status`, 'utf-8');
    let vmRss = null;
    for (const line of statusText.split('\n')) {
      if (line.startsWith('VmRSS:')) { vmRss = line.trim(); break; }
    }
    const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim().slice(0, 200);
    return { state, utime, stime, rssKb, vmRss, cwd, cmdline };
  } catch {
    return null;
  }
}

const DEFAULT_CONTEXT_WINDOW = 200_000;
const LARGE_CONTEXT_WINDOW = 1_000_000;
// Tailles de fenêtre exactes vues dans la status line, mémorisées par session
const knownContextWindows = new Map();

function defaultModelHas1mContext() {
  const model = safeReadJson(path.join(CLAUDE_DIR, 'settings.json'))?.model;
  return typeof model === 'string' && model.includes('[1m]');
}

/**
 * Fenêtre de contexte de la session. Exacte quand la status line l'a fournie pour cette
 * session ; sinon déduite (contexte déjà > 200k, modèle Fable, ou `[1m]` dans settings).
 */
function contextWindowFor(sessionId, model, usedTokens, snapshot) {
  if (snapshot?.sessionId === sessionId && snapshot.contextWindowSize) {
    knownContextWindows.set(sessionId, snapshot.contextWindowSize);
  }
  if (knownContextWindows.has(sessionId)) return { size: knownContextWindows.get(sessionId), exact: true };
  const large = (usedTokens || 0) > DEFAULT_CONTEXT_WINDOW
    || /fable|\[1m\]/.test(model || '')
    || defaultModelHas1mContext();
  return { size: large ? LARGE_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW, exact: false };
}

export function collectSessions() {
  const snapshot = statusLineSnapshot();
  const metas = getRecentSessionsJsons()
    .map(parseSessionMeta)
    .filter(Boolean)
    // keep only alive pids — that's the "en cours"
    .filter(m => isPidAlive(m.pid));

  const sessions = metas.map(meta => {
    const jsonlPath = findJsonlForSession(meta.sessionId, meta.cwd);
    const summary = jsonlPath ? summarizeJsonl(jsonlPath) : null;
    const proc = getProcInfo(meta.pid);

    const updatedAt = meta.updatedAt || meta.startedAt;
    const ageMs = Date.now() - meta.startedAt;
    const idleMs = Date.now() - (meta.statusUpdatedAt || meta.updatedAt || meta.startedAt);
    const contextTokens = summary?.contextTokens ?? null;
    const contextWindow = contextTokens !== null ? contextWindowFor(meta.sessionId, summary?.model, contextTokens, snapshot) : null;

    // History preview fallback — history.jsonl display field indexed by sessionId
    // We don't parse it for v1 (costly), summary already has lastHumanText

    return {
      pid: meta.pid,
      sessionId: meta.sessionId,
      name: meta.name || meta.sessionId.slice(0, 8),
      cwd: meta.cwd,
      projectName: meta.cwd ? path.basename(meta.cwd) : 'unknown',
      status: meta.status || 'unknown', // idle | busy | waiting, écrit par Claude Code lui-même
      // Avec status=waiting : ce qui bloque ('dialog open', 'input needed', 'sandbox request'…)
      waitingFor: meta.waitingFor || null,
      // Session idle dont la dernière réponse de l'IA se termine par une question
      pendingQuestion: meta.status === 'idle' && !!summary?.pendingQuestion,
      context: contextWindow ? {
        tokens: contextTokens,
        windowSize: contextWindow.size,
        pct: Math.min(100, contextTokens / contextWindow.size * 100),
        exact: contextWindow.exact,
      } : null,
      kind: meta.kind,
      entrypoint: meta.entrypoint,
      // Présent seulement quand la session est reliée à claude.ai via Remote Control
      bridgeSessionId: meta.bridgeSessionId || null,
      version: meta.version,
      startedAt: meta.startedAt,
      updatedAt,
      statusUpdatedAt: meta.statusUpdatedAt,
      ageMs,
      idleMs,
      proc: proc ? { state: proc.state, rssKb: proc.rssKb, cwd: proc.cwd } : null,
      jsonl: jsonlPath ? { path: jsonlPath, size: summary?.totalSize || 0, mtime: summary?.mtime || null } : null,
      model: summary?.model || null,
      gitBranch: summary?.gitBranch || meta.gitBranch || null,
      counts: summary ? {
        user: summary.userCount,
        assistant: summary.assistantCount,
        toolUse: summary.toolUseCount,
        thinking: summary.thinkingCount,
      } : null,
      tokens: summary?.tokenAgg || null,
      lastHumanText: summary?.lastHumanText || null,
      lastAssistantText: summary?.lastAssistantText || null,
      lastToolName: summary?.lastToolName || null,
    };
  });

  // Sort: sessions qui t'attendent d'abord, puis busy, puis activité la plus récente
  sessions.sort((a, b) => {
    const busyRank = s => s.status === 'waiting' ? 0 : s.pendingQuestion ? 1 : s.status === 'busy' ? 2 : 3;
    const r = busyRank(a) - busyRank(b);
    if (r !== 0) return r;
    return b.updatedAt - a.updatedAt;
  });

  // Also collect recently dead sessions (last 24h) for context, without pid
  // For v1 we only return alive, but include total counts
  const allJsonls = [];
  try {
    for (const proj of fs.readdirSync(PROJECTS_DIR)) {
      const dir = path.join(PROJECTS_DIR, proj);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(dir, f);
        const st = fs.statSync(p);
        const ageH = (Date.now() - st.mtimeMs) / 3600000;
        if (ageH < 24) allJsonls.push({ proj, file: f, mtime: st.mtimeMs, size: st.size });
      }
    }
  } catch {}

  return {
    generatedAt: Date.now(),
    claudeDir: CLAUDE_DIR,
    aliveCount: sessions.length,
    sessions,
    recentJsonlCount24h: allJsonls.length,
  };
}
