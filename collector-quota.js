import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Quota Claude (abonnement claude.ai) sur les fenêtres glissantes 5 h et 7 jours.
 *
 * Claude Code ne transmet `rate_limits` qu'au script de status line, sur stdin, et ne
 * l'écrit nulle part. On relit donc le dernier stdin mis en cache par la status line
 * `claude-statusbar` (`cs`), puis, à défaut, son instantané `rate_latest.*.json`.
 * Aucun appel réseau, aucun identifiant lu.
 */
const STATUSBAR_CACHE = process.env.CLAUDE_STATUSBAR_CACHE
  || path.join(os.homedir(), '.cache', 'claude-statusbar');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

function mtimeMs(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

/** Normalise une fenêtre ; une fenêtre dont l'échéance est passée repart à 0 %. */
function windowOf(usedPct, resetsAtSec, now) {
  if (typeof usedPct !== 'number') return null;
  const resetsAt = typeof resetsAtSec === 'number' ? resetsAtSec * 1000 : null;
  const expired = resetsAt !== null && resetsAt <= now;
  return {
    usedPct: expired ? 0 : usedPct,
    resetsAt,
    resetsInMs: resetsAt !== null && !expired ? resetsAt - now : null,
    expired,
  };
}

function fromLastStdin(now) {
  const file = path.join(STATUSBAR_CACHE, 'last_stdin.json');
  const rl = readJson(file)?.rate_limits;
  if (!rl) return null;
  return {
    source: file,
    observedAt: mtimeMs(file),
    fiveHour: windowOf(rl.five_hour?.used_percentage, rl.five_hour?.resets_at, now),
    sevenDay: windowOf(rl.seven_day?.used_percentage, rl.seven_day?.resets_at, now),
  };
}

function fromRateLatest(now) {
  let files;
  try {
    files = fs.readdirSync(STATUSBAR_CACHE)
      .filter(f => /^rate_latest\..+\.json$/.test(f))
      .map(f => path.join(STATUSBAR_CACHE, f));
  } catch { return null; }
  const file = files.sort((a, b) => (mtimeMs(b) || 0) - (mtimeMs(a) || 0))[0];
  const j = file && readJson(file);
  if (!j) return null;
  const observed = Math.max(j.five_hour?.observed_at || 0, j.seven_day?.observed_at || 0);
  return {
    source: file,
    observedAt: observed ? observed * 1000 : mtimeMs(file),
    fiveHour: windowOf(j.five_hour?.used, j.five_hour?.resets_at, now),
    sevenDay: windowOf(j.seven_day?.used, j.seven_day?.resets_at, now),
  };
}

export function collectQuota() {
  const now = Date.now();
  const q = fromLastStdin(now) || fromRateLatest(now);
  if (!q || (!q.fiveHour && !q.sevenDay)) {
    return { available: false, reason: `aucune donnée rate_limits dans ${STATUSBAR_CACHE}` };
  }
  return { available: true, ...q, ageMs: q.observedAt ? now - q.observedAt : null };
}
