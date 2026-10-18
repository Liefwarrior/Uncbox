// Local server for the dashboard: serves the app, persists state to data/state.json,
// and pushes state changes to every open window over Server-Sent Events.
//
//   node server/index.mjs          serve the built app from dist/
//   node server/index.mjs --dev    serve through Vite with hot reload

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const dataArg = process.argv.find((a) => a.startsWith('--data='));
const dataDir = dataArg ? path.resolve(dataArg.slice(7)) : path.join(root, 'data');
const stateFile = path.join(dataDir, 'state.json');

const isDev = process.argv.includes('--dev');
const portArg = process.argv.find((a) => a.startsWith('--port='));
const port = Number(portArg?.slice(7) || process.env.PORT) || 5170;
// Loopback only by default. Set HOST=0.0.0.0 to reach it from a phone or second PC on your LAN
// (there is no auth, so only do that on a network you trust).
const host = process.env.HOST || '127.0.0.1';
const MAX_BODY = 5 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** @type {Set<http.ServerResponse>} */
const listeners = new Set();
let writeChain = Promise.resolve();

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function loadState() {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Writes are serialized and go through a temp file so a crash mid-write never leaves half a JSON file.
function saveState(state) {
  writeChain = writeChain.then(async () => {
    await mkdir(dataDir, { recursive: true });
    const tmp = `${stateFile}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, stateFile);
  });
  return writeChain;
}

function broadcast(state, fromClient) {
  const payload = `data: ${JSON.stringify({ clientId: fromClient, state })}\n\n`;
  for (const res of listeners) res.write(payload);
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/state') {
    if (req.method === 'GET') return sendJson(res, 200, await loadState());
    // POST is accepted too so the page can flush with navigator.sendBeacon on unload.
    if (req.method === 'PUT' || req.method === 'POST') {
      let state;
      try {
        state = JSON.parse(await readBody(req));
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.status ? err.message : 'Invalid JSON' });
      }
      if (!state || typeof state !== 'object' || Array.isArray(state)) {
        return sendJson(res, 400, { error: 'State must be a JSON object' });
      }
      await saveState(state);
      const clientId = req.headers['x-client-id'] || url.searchParams.get('client') || '';
      broadcast(state, String(clientId));
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  if (url.pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    listeners.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      listeners.delete(res);
    });
    return;
  }

  return sendJson(res, 404, { error: 'Not found' });
}

async function serveStatic(req, res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = path.join(distDir, path.normalize(rel));
  if (!file.startsWith(distDir + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  let info = await stat(file).catch(() => null);
  if (!info || info.isDirectory()) {
    // Single-page app: anything that is not a real file gets index.html.
    file = path.join(distDir, 'index.html');
    info = await stat(file).catch(() => null);
    if (!info) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('dist/ is missing. Run "npm start" (or "npm run build") first.');
      return;
    }
  }
  const ext = path.extname(file).toLowerCase();
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

const server = http.createServer();

let vite = null;
if (isDev) {
  const { createServer } = await import('vite');
  vite = await createServer({
    root,
    appType: 'spa',
    server: { middlewareMode: true, hmr: { server } },
  });
}

server.on('request', async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (vite) return vite.middlewares(req, res);
    return await serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
    else res.end();
  }
});

server.listen(port, host, () => {
  const shown = host === '0.0.0.0' ? 'localhost' : host;
  console.log(`Uncbox ${isDev ? '(dev) ' : ''}running at http://${shown}:${port}`);
});
