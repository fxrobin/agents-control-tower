import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { collectSessions } from './collector.js';
import { collectOpencodeSessions } from './collector-opencode.js';
import { collectVibeSessions } from './collector-vibe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = parseInt(process.env.PORT || '3417', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let filePath = req.url.split('?')[0];
  if (filePath === '/') filePath = '/index.html';
  const full = path.join(PUBLIC_DIR, filePath);
  // Prevent traversal
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('forbidden'); return true;
  }
  if (fs.existsSync(full) && fs.statSync(full).isFile()) {
    const ext = path.extname(full);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(full).pipe(res);
    return true;
  }
  return false;
}

const server = http.createServer((req, res) => {
  // CORS for dev
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url.startsWith('/api/sessions')) {
    try {
      const data = collectSessions();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, stack: e.stack }));
    }
    return;
  }

  if (req.url.startsWith('/api/opencode-sessions')) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const data = collectOpencodeSessions(Math.min(Math.max(limit, 1), 200));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, stack: e.stack }));
    }
    return;
  }

  if (req.url.startsWith('/api/vibe-sessions')) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const data = collectVibeSessions(Math.min(Math.max(limit, 1), 200));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, stack: e.stack }));
    }
    return;
  }

  if (req.url.startsWith('/api/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: '0.1.0', publicDir: PUBLIC_DIR }));
    return;
  }

  if (serveStatic(req, res)) return;

  // SPA fallback
  if (req.url.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  // Fallback to index.html for unknown static
  const idx = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(idx)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(idx).pipe(res);
  } else {
    res.writeHead(404); res.end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  agents-control-tower v0.1.0`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  API → http://localhost:${PORT}/api/sessions\n`);
});
