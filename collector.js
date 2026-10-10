import fs from 'fs';
import path from 'path';
import os from 'os';

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

/**
 * Tail-parse a jsonl file efficiently — only reads last N lines.
 * For active sessions we need: model, counts, last messages, token totals.
 */
function tailJsonl(file, maxLines = 120) {
  if (!fs.existsSync(file)) return { lines: [] };
  const stat = fs.statSync(file);
  const fileSize = stat.size;
  // Read last ~200KB or whole file if small — enough for last ~100 lines (avg line ~2KB)
  const tailSize = Math.min(fileSize, 300 * 1024);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(tailSize);
  fs.readSync(fd, buf, 0, tailSize, fileSize - tailSize);
  fs.closeSync(fd);
  const text = buf.toString('utf-8');
  // If we truncated, drop first incomplete line
  const rawLines = text.split('\n').filter(Boolean);
  const cleaned = tailSize < fileSize ? rawLines.slice(1) : rawLines;
  // Keep only last maxLines
  const lines = cleaned.slice(-maxLines);
  return { lines, totalSize: fileSize, mtime: stat.mtimeMs };
}

function isNoiseHumanText(t) {
  if (!t) return true;
  const s = t.trim();
  if (s.startsWith('<task-notification>')) return true;
  if (s.startsWith('<command-name>')) return true;
  if (s.startsWith('Condense the tool payload')) return true;
  if (s.length < 3) return true;
  return false;
}

function summarizeJsonl(jsonlPath) {
  const { lines: tailLines, totalSize, mtime } = tailJsonl(jsonlPath);
  let model = null;
  let gitBranch = null;
  let cwd = null;
  let lastHumanText = null;
  let lastHumanTextRaw = null;
  let lastAssistantText = null;
  let lastToolName = null;

  // --- Accurate counts via streaming full file (cheap: just JSON parse + counters) ---
  let userCount = 0, assistantCount = 0, toolUseCount = 0, thinkingCount = 0;
  let tokenAgg = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let isTailSampled = false;
  try {
    // Stream-like: read file in chunks and split lines without loading huge string twice
    // For simplicity, use readFileSync for now — files are at most ~3MB, OK for 20 sessions
    // If file > 5MB we fall back to tail-only tokens
    if (totalSize > 5 * 1024 * 1024) {
      isTailSampled = true;
    } else {
      const content = fs.readFileSync(jsonlPath, 'utf-8');
      const allLines = content.split('\n');
      for (const line of allLines) {
        if (!line) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.type === 'user') userCount++;
        if (j.type === 'assistant') {
          assistantCount++;
          const msg = j.message;
          if (msg?.usage) {
            tokenAgg.input += msg.usage.input_tokens || 0;
            tokenAgg.output += msg.usage.output_tokens || 0;
            tokenAgg.cacheRead += msg.usage.cache_read_input_tokens || 0;
            tokenAgg.cacheCreate += msg.usage.cache_creation_input_tokens || 0;
          }
          for (const b of (msg?.content || [])) {
            if (b.type === 'thinking') thinkingCount++;
            if (b.type === 'tool_use') toolUseCount++;
          }
        }
      }
    }
  } catch { isTailSampled = true; }

  // If tail-sampled (huge file), tokens are approximate from tail
  if (isTailSampled) {
    tokenAgg = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    for (const line of tailLines) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.type === 'assistant' && j.message?.usage) {
        tokenAgg.input += j.message.usage.input_tokens || 0;
        tokenAgg.output += j.message.usage.output_tokens || 0;
        tokenAgg.cacheRead += j.message.usage.cache_read_input_tokens || 0;
        tokenAgg.cacheCreate += j.message.usage.cache_creation_input_tokens || 0;
      }
    }
  }

  // --- Tail for last messages / model / branch (always from tail, cheap) ---
  for (const line of tailLines) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    const t = j.type;
    if (t === 'user') {
      const content = j.message?.content;
      let txt = null;
      if (typeof content === 'string' && content.trim()) txt = content.slice(0, 300);
      else if (Array.isArray(content)) txt = content.find(b => b.type === 'text')?.text?.slice(0, 300) || null;
      if (txt && !isNoiseHumanText(txt)) lastHumanText = txt;
      if (txt) lastHumanTextRaw = txt;
      if (j.cwd) cwd = j.cwd;
      if (j.gitBranch) gitBranch = j.gitBranch;
    }
    if (t === 'assistant') {
      const msg = j.message;
      if (msg?.model) model = msg.model;
      const content = msg?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'text' && b.text) lastAssistantText = b.text.slice(0, 300);
          if (b.type === 'tool_use') lastToolName = b.name;
        }
      }
      if (j.cwd) cwd = j.cwd;
      if (j.gitBranch) gitBranch = j.gitBranch;
    }
    if (t === 'attachment' && j.gitBranch) gitBranch = j.gitBranch;
    if (j.cwd && !cwd) cwd = j.cwd;
  }
  // If lastHumanText was filtered as noise, keep raw as fallback (so we show something)
  if (!lastHumanText && lastHumanTextRaw) lastHumanText = lastHumanTextRaw;

  return {
    model, gitBranch, cwd,
    userCount, assistantCount, toolUseCount, thinkingCount,
    lastHumanText, lastAssistantText, lastToolName,
    tokenAgg,
    isTailSampled,
    totalSize, mtime,
  };
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

export function collectSessions() {
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

    // History preview fallback — history.jsonl display field indexed by sessionId
    // We don't parse it for v1 (costly), summary already has lastHumanText

    return {
      pid: meta.pid,
      sessionId: meta.sessionId,
      name: meta.name || meta.sessionId.slice(0, 8),
      cwd: meta.cwd,
      projectName: meta.cwd ? path.basename(meta.cwd) : 'unknown',
      status: meta.status || 'unknown', // idle | busy etc from Claude's own state machine
      kind: meta.kind,
      entrypoint: meta.entrypoint,
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
      tokensTailSampled: summary?.isTailSampled || false,
      lastHumanText: summary?.lastHumanText || null,
      lastAssistantText: summary?.lastAssistantText || null,
      lastToolName: summary?.lastToolName || null,
    };
  });

  // Sort: busy first, then most recent activity first
  sessions.sort((a, b) => {
    const busyRank = s => s.status === 'busy' ? 0 : 1;
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
