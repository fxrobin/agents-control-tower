import fs from 'fs';
import path from 'path';
import os from 'os';

const VIBE_HOME = process.env.VIBE_HOME || path.join(os.homedir(), '.vibe');
const SESSIONS_DIR = path.join(VIBE_HOME, 'logs', 'session');
const ACTIVE_DIR = path.join(SESSIONS_DIR, 'active');

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function getActiveVibeSessions() {
  const active = new Map(); // session_id -> pid
  if (!fs.existsSync(ACTIVE_DIR)) return active;
  for (const f of fs.readdirSync(ACTIVE_DIR)) {
    if (!f.endsWith('.lock')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(ACTIVE_DIR, f), 'utf-8'));
      if (data.session_id && data.process_id && isPidAlive(data.process_id)) {
        active.set(data.session_id, data.process_id);
      }
    } catch {}
  }
  return active;
}

function readVibeSessions(limit = 50) {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  const dirs = fs.readdirSync(SESSIONS_DIR)
    .filter(d => d.startsWith('session_'))
    .map(d => path.join(SESSIONS_DIR, d))
    .filter(p => fs.statSync(p).isDirectory());

  const sessions = [];
  for (const dir of dirs) {
    const metaPath = path.join(dir, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      sessions.push({ dir, meta });
    } catch {}
  }
  // sort by end_time or start_time desc
  sessions.sort((a,b)=>{
    const ta = Date.parse(a.meta.end_time || a.meta.start_time || 0);
    const tb = Date.parse(b.meta.end_time || b.meta.start_time || 0);
    return tb - ta;
  });
  return sessions.slice(0, limit);
}

function parseActiveModel() {
  try {
    const cfg = fs.readFileSync(path.join(VIBE_HOME, 'config.toml'), 'utf-8');
    const m = cfg.match(/active_model\s*=\s*"([^"]+)"/);
    return m ? m[1] : 'mistral-medium-3.5';
  } catch { return 'mistral-medium-3.5'; }
}

export function collectVibeSessions(limit = 50) {
  const activeMap = getActiveVibeSessions();
  const model = parseActiveModel();
  const raw = readVibeSessions(limit);
  const now = Date.now();

  const sessions = raw.map(({ dir, meta }) => {
    const start = meta.start_time ? Date.parse(meta.start_time) : null;
    const end = meta.end_time ? Date.parse(meta.end_time) : null;
    const ageMs = start ? now - start : null;
    const idleMs = end ? now - end : (start ? now - start : null);
    const pid = activeMap.get(meta.session_id) || null;
    const isLive = pid !== null;
    let status = 'idle';
    if (isLive) status = 'busy';
    else if (!end) status = 'busy'; // no end_time = still running but lock missing?
    // if end within 2min, consider busy?
    const projectName = meta.environment?.working_directory
      ? path.basename(meta.environment.working_directory) || meta.environment.working_directory
      : 'unknown';
    const stats = meta.stats || {};
    return {
      id: meta.session_id,
      shortId: meta.session_id ? meta.session_id.slice(0, 8) : dir.split('_').pop().slice(0,8),
      projectName,
      directory: meta.environment?.working_directory || '',
      title: meta.title || 'Sans titre',
      gitBranch: meta.git_branch || null,
      gitCommit: meta.git_commit || null,
      startTime: start,
      endTime: end,
      ageMs, idleMs,
      status,
      isLive,
      livePid: pid,
      model: { id: model, provider: 'mistral' },
      modelShort: model.replace('mistral-','').slice(0,22),
      tokens: {
        input: stats.session_prompt_tokens || 0,
        output: stats.session_completion_tokens || 0,
        total: stats.session_total_llm_tokens || 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      cost: stats.session_cost || 0,
      steps: stats.steps || 0,
      toolCalls: {
        agreed: stats.tool_calls_agreed || 0,
        succeeded: stats.tool_calls_succeeded || 0,
        failed: stats.tool_calls_failed || 0,
      },
      totalMessages: meta.total_messages || 0,
      tokensPerSecond: stats.tokens_per_second || null,
      version: null,
    };
  });

  const totalCount = (() => {
    try {
      return fs.readdirSync(SESSIONS_DIR).filter(d=>d.startsWith('session_')).length;
    } catch { return sessions.length; }
  })();

  const liveCount = sessions.filter(s=>s.isLive).length;
  const totalCost = sessions.reduce((a,s)=>a+s.cost,0);
  const totalIn = sessions.reduce((a,s)=>a+s.tokens.input,0);
  const totalOut = sessions.reduce((a,s)=>a+s.tokens.output,0);

  return {
    generatedAt: now,
    totalCount,
    returnedCount: sessions.length,
    liveCount,
    totalCost,
    totalTokens: { input: totalIn, output: totalOut },
    activeModel: model,
    sessions,
  };
}
