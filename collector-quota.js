import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Quota Claude (abonnement claude.ai) sur les fenêtres glissantes 5 h et 7 jours.
 *
 * Claude Code ne transmet `rate_limits` qu'au script de status line, sur stdin, et ne
 * l'écrit nulle part. On relit donc le dernier stdin mis en cache par la status line
 * `claude-statusbar` (`cs`), puis, à défaut, son instantané `rate_latest.*.json`.
 * L'historique `rate_projection.*.json` sert à la courbe et à la prévision d'épuisement.
 * Aucun appel réseau, aucun identifiant lu.
 */
const STATUSBAR_CACHE = process.env.CLAUDE_STATUSBAR_CACHE
  || path.join(os.homedir(), '.cache', 'claude-statusbar');

const HOUR = 3600_000;
const WINDOWS = {
  fiveHour: { key: 'five_hour', durationMs: 5 * HOUR, lookbackMs: 0.5 * HOUR },
  sevenDay: { key: 'seven_day', durationMs: 7 * 24 * HOUR, lookbackMs: 24 * HOUR },
};
const MAX_HISTORY_POINTS = 80;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

function mtimeMs(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

/** Fichier le plus récent du cache correspondant au motif (un fichier par compte). */
function latestCacheFile(pattern) {
  try {
    return fs.readdirSync(STATUSBAR_CACHE)
      .filter(f => pattern.test(f))
      .map(f => path.join(STATUSBAR_CACHE, f))
      .sort((a, b) => (mtimeMs(b) || 0) - (mtimeMs(a) || 0))[0] || null;
  } catch { return null; }
}

// L'historique pèse quelques centaines de Ko : on ne le relit que s'il a changé.
let projectionCache = { file: null, mtime: null, data: null };
function readProjection() {
  const file = latestCacheFile(/^rate_projection\..+\.json$/);
  if (!file) return null;
  const mtime = mtimeMs(file);
  if (projectionCache.file !== file || projectionCache.mtime !== mtime) {
    projectionCache = { file, mtime, data: readJson(file) };
  }
  return projectionCache.data;
}

/** Garde au plus `max` points, en conservant toujours le premier et le dernier. */
function downsample(points, max) {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]);
}

/**
 * Rythme de consommation (en % par heure) mesuré sur `lookbackMs`, puis projections :
 * pourcentage atteint au reset et, s'il dépasse 100 %, heure d'épuisement.
 * Les relevés n'existent qu'à chaque point de pourcentage gagné : on compare le dernier
 * relevé antérieur à la période avec l'usage actuel, ce qui compte aussi les pauses.
 */
function projectWindow(win, spec, history, now) {
  const start = win.resetsAt - spec.durationMs;
  const points = (history || [])
    .filter(p => p.resets_at * 1000 === win.resetsAt)
    .map(p => [p.observed_at * 1000, p.used_pct]);
  points.push([now, win.usedPct]);

  const since = Math.max(start, now - spec.lookbackMs);
  const before = points.filter(([t]) => t <= since).pop() || points[0];
  const elapsedH = (now - before[0]) / HOUR;
  // Moins de 5 minutes d'historique : rythme trop bruité pour projeter
  const ratePerHour = elapsedH >= 1 / 12 ? Math.max(0, (win.usedPct - before[1]) / elapsedH) : null;

  let projectedAtReset = null, exhaustAt = null;
  if (ratePerHour !== null) {
    projectedAtReset = win.usedPct + ratePerHour * (win.resetsAt - now) / HOUR;
    if (projectedAtReset >= 100 && ratePerHour > 0) {
      exhaustAt = now + (100 - win.usedPct) / ratePerHour * HOUR;
    }
  }
  return {
    windowStart: start,
    ratePerHour,
    projectedAtReset,
    exhaustAt,
    history: downsample(points, MAX_HISTORY_POINTS),
  };
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
  const file = latestCacheFile(/^rate_latest\..+\.json$/);
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

/**
 * Dernier stdin de status line : contexte exact (taille de fenêtre, % utilisé) de la
 * session qui l'a rendu en dernier. Sert à collector.js pour la jauge de contexte.
 */
export function statusLineSnapshot() {
  const j = readJson(path.join(STATUSBAR_CACHE, 'last_stdin.json'));
  if (!j?.session_id || !j.context_window) return null;
  return {
    sessionId: j.session_id,
    contextWindowSize: j.context_window.context_window_size || null,
    usedPct: j.context_window.used_percentage ?? null,
  };
}

export function collectQuota() {
  const now = Date.now();
  const q = fromLastStdin(now) || fromRateLatest(now);
  if (!q || (!q.fiveHour && !q.sevenDay)) {
    return { available: false, reason: `aucune donnée rate_limits dans ${STATUSBAR_CACHE}` };
  }
  const projection = readProjection();
  for (const [name, spec] of Object.entries(WINDOWS)) {
    const win = q[name];
    if (win && !win.expired && win.resetsAt) Object.assign(win, projectWindow(win, spec, projection?.[spec.key], now));
  }
  return { available: true, ...q, ageMs: q.observedAt ? now - q.observedAt : null };
}
