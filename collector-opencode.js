import { execSync } from 'child_process';
import fs from 'fs';

function runOpencode(sql) {
  const escaped = sql.replace(/"/g, '\\"');
  try {
    const out = execSync(`opencode db "${escaped}" --format json`, {
      encoding: 'utf-8',
      timeout: 10000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const trimmed = out.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) return JSON.parse(trimmed);
    return trimmed.split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l));
  } catch (e) {
    throw new Error(`opencode db failed: ${e.message}`);
  }
}

function getOpencodePids() {
  // Map cwd -> pid for live opencode processes
  try {
    const out = execSync('ps aux 2>/dev/null | grep -E "[o]pencode" | awk \'{print $2}\'', { encoding: 'utf-8' });
    const pids = out.split('\n').filter(Boolean).map(p=>parseInt(p,10)).filter(Boolean);
    const map = new Map(); // directory -> pid
    for (const pid of pids) {
      try {
        const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        map.set(cwd, pid);
      } catch {}
    }
    return map;
  } catch { return new Map(); }
}

function parseModel(modelRaw) {
  if (!modelRaw) return null;
  try {
    const m = JSON.parse(modelRaw);
    return { id: m.id || modelRaw, provider: m.providerID || '', variant: m.variant || '' };
  } catch { return { id: modelRaw, provider: '', variant: '' }; }
}

export function collectOpencodeSessions(limit = 50) {
  const sessions = runOpencode(`
    SELECT
      s.id, s.project_id, s.directory, s.title, s.version, s.agent, s.model,
      s.cost, s.tokens_input, s.tokens_output, s.tokens_reasoning,
      s.tokens_cache_read, s.tokens_cache_write,
      s.time_created, s.time_updated, s.time_archived,
      p.worktree
    FROM session s
    LEFT JOIN project p ON p.id = s.project_id
    ORDER BY s.time_updated DESC
    LIMIT ${limit}
  `);

  const liveMap = getOpencodePids();
  const now = Date.now();

  const enriched = sessions.map(s => {
    const model = parseModel(s.model);
    const isArchived = !!s.time_archived;
    const ageMs = now - s.time_created;
    const idleMs = now - s.time_updated;
    // Live if pid cwd matches directory and updated < 5min ago and not archived
    const livePid = liveMap.get(s.directory) || null;
    const isLive = !isArchived && (livePid !== null || idleMs < 5*60*1000) && idleMs < 30*60*1000;
    // But if we have a livePid, it's truly busy; otherwise recent non-archived is "idle" (recent)
    let status = 'idle';
    if (isArchived) status = 'archived';
    else if (livePid !== null) status = 'busy';
    else if (idleMs < 2*60*1000) status = 'busy'; // heuristic: very recent update = likely still running
    // project name like for Claude cards
    const projectName = s.directory ? s.directory.split('/').pop() || s.directory : 'global';
    const directory = s.directory;
    return {
      id: s.id,
      shortId: s.id.slice(0, 8),
      projectName,
      directory,
      worktree: s.worktree,
      title: s.title,
      version: s.version,
      agent: s.agent,
      model,
      modelShort: model ? model.id.replace('muse-','').slice(0, 22) : '—',
      cost: s.cost,
      tokens: {
        input: s.tokens_input,
        output: s.tokens_output,
        reasoning: s.tokens_reasoning,
        cacheRead: s.tokens_cache_read,
        cacheWrite: s.tokens_cache_write,
      },
      timeCreated: s.time_created,
      timeUpdated: s.time_updated,
      timeArchived: s.time_archived,
      ageMs, idleMs,
      status,
      isLive: !!livePid,
      livePid,
      isArchived,
    };
  });

  // KPIs
  const totalCost = enriched.reduce((a,s)=>a+s.cost,0);
  const totalIn = enriched.reduce((a,s)=>a+s.tokens.input,0);
  const totalOut = enriched.reduce((a,s)=>a+s.tokens.output,0);
  const liveCount = enriched.filter(s=>s.status==='busy').length;

  // Count total non-archived
  let totalCount = 0;
  try {
    const c = runOpencode(`SELECT COUNT(*) as c FROM session`);
    totalCount = c[0]?.c || enriched.length;
  } catch {}

  return {
    generatedAt: now,
    totalCount,
    returnedCount: enriched.length,
    liveCount,
    totalCost,
    totalTokens: { input: totalIn, output: totalOut },
    sessions: enriched,
  };
}
