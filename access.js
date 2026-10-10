import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

/**
 * Contrôle d'accès du mode réseau (HOST=0.0.0.0).
 *
 * Les requêtes venant de la machine elle-même passent toujours. Les autres doivent
 * présenter le jeton : une première fois dans l'URL (?token=…), que le serveur échange
 * contre un cookie HttpOnly puis retire de l'URL par redirection, ensuite via ce cookie.
 * Le jeton est généré une fois et gardé dans le cache de l'outil, pour qu'un téléphone
 * déjà autorisé le reste après un redémarrage.
 */

const CACHE_DIR = process.env.ACT_CACHE_DIR || path.join(os.homedir(), '.cache', 'agents-control-tower');
const TOKEN_FILE = path.join(CACHE_DIR, 'access-token');
const COOKIE = 'act_token';
const COOKIE_MAX_AGE_S = 365 * 24 * 3600;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackHost(host) {
  return host === 'localhost' || LOOPBACK.has(host);
}

/** Jeton d'accès : ACT_TOKEN s'il est fourni, sinon celui du cache, créé au besoin. */
export function loadOrCreateToken() {
  if (process.env.ACT_TOKEN) return process.env.ACT_TOKEN;
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
    if (t) return t;
  } catch { /* premier lancement en mode réseau */ }
  const token = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
  return token;
}

function sameToken(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookieToken(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

const DENIED_PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Accès refusé</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0e14;color:#e6e8ee;font:15px system-ui,sans-serif;padding:16px}
main{max-width:420px}h1{font-size:18px}code{background:#151a28;padding:2px 6px;border-radius:4px}p{color:#8b92a8;line-height:1.5}</style></head>
<body><main><h1>Agents Control Tower — accès refusé</h1>
<p>Ouvre l'adresse complète affichée par <code>./run.sh</code> sur le PC (elle contient <code>?token=…</code>). Ce navigateur sera ensuite autorisé.</p></main></body></html>`;

/**
 * Renvoie true si la requête peut continuer ; sinon la réponse est déjà envoyée
 * (redirection après dépôt du cookie, ou refus).
 */
export function checkAccess(req, res, token) {
  if (LOOPBACK.has(req.socket.remoteAddress)) return true;

  const url = new URL(req.url, 'http://localhost');
  const fromQuery = url.searchParams.get('token');
  if (fromQuery !== null && sameToken(fromQuery, token)) {
    // Échange contre un cookie, puis on retire le jeton de l'URL (historique, captures)
    url.searchParams.delete('token');
    res.writeHead(303, {
      'Set-Cookie': `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`,
      Location: url.pathname + url.search,
    });
    res.end();
    return false;
  }
  const fromCookie = cookieToken(req);
  if (fromCookie !== null && sameToken(fromCookie, token)) return true;

  if (url.pathname.startsWith('/api/')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'jeton d\'accès requis' }));
  } else {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DENIED_PAGE);
  }
  return false;
}

/** Adresses IPv4 du réseau local, interfaces physiques d'abord (wifi, ethernet). */
export function lanAddresses() {
  const virtual = /^(docker|br-|veth|virbr|lo|tun|tap|vmnet|vboxnet)/;
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, addrs]) => (addrs || [])
      .filter(a => a.family === 'IPv4' && !a.internal)
      .map(a => ({ name, address: a.address, virtual: virtual.test(name) })))
    .sort((a, b) => a.virtual - b.virtual);
}
