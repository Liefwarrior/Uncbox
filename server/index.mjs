// Local server for the dashboard: serves the app, persists state to data/state.json,
// and pushes state changes to every open window over Server-Sent Events.
//
//   node server/index.mjs          serve the built app from dist/
//   node server/index.mjs --dev    serve through Vite with hot reload
//
// Always on http://localhost:5170. Once `npm run setup-domain` has made a certificate, the built
// app is also served at https://unc.box (dev mode stays on localhost, where hot reload works).

import http from 'node:http';
import https from 'node:https';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findInstalls, install as installWowAddon, reveal as revealWowAddon } from '../integrations/wow/install.mjs';
import { createClips } from './clips.mjs';
import { createDiscordBridge } from './discord.mjs';
import { openInBrowser, pageFor } from './open.mjs';
import { createGameSettings } from './gamesettings.mjs';
import { createOcr } from './ocr.mjs';
import { createSteam } from './steam.mjs';
import { createWidgets } from './widgets.mjs';
import { DOMAIN, loadTls } from './tls.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const dataArg = process.argv.find((a) => a.startsWith('--data='));
const dataDir = dataArg ? path.resolve(dataArg.slice(7)) : path.join(root, 'data');
const stateFile = path.join(dataDir, 'state.json');
const clipsArg = process.argv.find((a) => a.startsWith('--clips='));

const isDev = process.argv.includes('--dev');
const portArg = process.argv.find((a) => a.startsWith('--port='));
const port = Number(portArg?.slice(7) || process.env.PORT) || 5170;
// Loopback only by default. Set HOST=0.0.0.0 to reach it from a phone or second PC on your LAN
// (there is no auth, so only do that on a network you trust).
const host = process.env.HOST || '127.0.0.1';
const numArg = (name, fallback) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]) || fallback;
// The hosts file points unc.box at 127.0.0.1, so these only ever listen there.
const httpsPort = numArg('https-port', 443);
const redirectPort = numArg('redirect-port', 80);
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

/** Named SSE event, so it does not reach the page's state-sync onmessage handler. */
function broadcastEvent(name, data) {
  const payload = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners) res.write(payload);
}

const discord = createDiscordBridge({ dataDir, onChange: (snap) => broadcastEvent('discord', snap) });

async function readJson(req) {
  try {
    return JSON.parse((await readBody(req)) || '{}');
  } catch (err) {
    throw Object.assign(new Error(err.status ? err.message : 'Invalid JSON'), { status: err.status || 400 });
  }
}

async function handleDiscord(req, res, url) {
  const action = url.pathname.slice('/api/discord'.length);
  try {
    if (req.method === 'GET') {
      if (action === '') return sendJson(res, 200, discord.snapshot());
      if (action === '/guilds') return sendJson(res, 200, await discord.guilds());
      if (action === '/channels') return sendJson(res, 200, await discord.channels(url.searchParams.get('guild')));
      return sendJson(res, 404, { error: 'Not found' });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    if (action === '/config') await discord.configure(await readJson(req));
    else if (action === '/join') await discord.join((await readJson(req)).channelId);
    else if (action === '/leave') await discord.leave();
    else if (action === '/voice') await discord.setVoice(await readJson(req));
    else if (action === '/authorize') {
      // Settles when the user answers Discord's prompt; reply now and report progress over SSE.
      void discord.authorize();
    } else if (action === '/forget') await discord.forget();
    else return sendJson(res, 404, { error: 'Not found' });
    return sendJson(res, 200, discord.snapshot());
  } catch (err) {
    return sendJson(res, err.status || 500, { error: err.message || 'Discord error' });
  }
}

// Only the PC Uncbox runs on may open pages or touch files on it, even when HOST exposes the
// server to the LAN.
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');

/** Which of the given programs are running ("Dungeons.exe"), for presets that notice their game starting. */
async function running(req, res, url) {
  const names = (url.searchParams.get('names') ?? '').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (process.platform !== 'win32' || !names.length) return sendJson(res, 200, { running: [] });
  const { execFile } = await import('node:child_process');
  execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
    const seen = new Set(err ? [] : out.split(/\r?\n/).map((l) => (/^"([^"]+)"/.exec(l)?.[1] ?? '').toLowerCase()));
    sendJson(res, 200, { running: names.filter((n) => seen.has(n)) });
  });
}

const clips = createClips({
  clipsDir: clipsArg ? path.resolve(clipsArg.slice(8)) : null,
  broadcastEvent,
  isLocal,
  sendJson,
  readJson,
});

const widgets = createWidgets({ broadcastEvent, isLocal, sendJson });
const steam = createSteam({ broadcastEvent, sendJson });
const ocr = createOcr({ isLocal, sendJson, readBody });
const gameSettings = createGameSettings({ isLocal, sendJson, readJson });

async function handleWow(req, res, url) {
  if (!isLocal(req)) return sendJson(res, 403, { error: 'Run this on the PC WoW is on.' });
  try {
    if (url.pathname === '/api/wow/installs' && req.method === 'GET') return sendJson(res, 200, { installs: await findInstalls() });
    if (url.pathname === '/api/wow/install' && req.method === 'POST') {
      return sendJson(res, 200, { ok: true, path: await installWowAddon((await readJson(req)).path) });
    }
    if (url.pathname === '/api/wow/reveal' && req.method === 'POST') {
      revealWowAddon();
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    return sendJson(res, err.status || 500, { error: err.status ? err.message : `Couldn’t install the addon: ${err.message}` });
  }
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/discord' || url.pathname.startsWith('/api/discord/')) return handleDiscord(req, res, url);
  if (url.pathname.startsWith('/api/wow/')) return handleWow(req, res, url);
  if (url.pathname === '/api/clips' || url.pathname.startsWith('/api/clips/')) return clips.handle(req, res, url);
  if (['/api/system', '/api/media', '/api/notifications'].includes(url.pathname)) return widgets(req, res, url);
  if (url.pathname === '/api/steam' || url.pathname.startsWith('/api/steam/')) return steam(req, res, url);
  if (url.pathname === '/api/ocr') return ocr(req, res);
  if (url.pathname === '/api/game-settings') return gameSettings(req, res);
  if (url.pathname === '/api/running') return running(req, res, url);

  if (url.pathname === '/api/open' && req.method === 'POST') {
    if (!isLocal(req)) return sendJson(res, 403, { error: 'Local only' });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { error: err.message });
    }
    const target = pageFor(body.target, { discordAppId: discord.snapshot().clientId || discord.appId() });
    if (!target) return sendJson(res, 400, { error: 'Unknown page' });
    openInBrowser(target);
    return sendJson(res, 200, { ok: true, url: target });
  }

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
      clips.configure(state.clips);
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

async function handleRequest(req, res) {
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
}

server.on('request', handleRequest);

discord.start().catch((err) => console.error('Discord bridge:', err.message));
// The clip key follows the saved settings; with none saved yet, the default (=) is on.
loadState()
  .then((s) => clips.configure(s?.clips))
  .catch(() => clips.configure(null));

server.listen(port, host, () => {
  const shown = host === '0.0.0.0' ? 'localhost' : host;
  console.log(`Uncbox ${isDev ? '(dev) ' : ''}running at http://${shown}:${port}`);
});

/** Listens on a loopback port, reporting why not (port taken, not allowed) instead of crashing. */
function listenLocal(srv, p, onReady) {
  srv.once('error', (err) => {
    const why = err.code === 'EADDRINUSE' ? `another program is using port ${p}` : err.message;
    console.warn(`Uncbox: can't serve ${DOMAIN} on port ${p}: ${why}.`);
  });
  srv.listen(p, '127.0.0.1', onReady);
}

const tls = isDev ? null : await loadTls(dataDir).catch((err) => console.warn(`Uncbox: can't read the ${DOMAIN} certificate: ${err.message}`));
let secure = null;
try {
  if (tls) secure = https.createServer(tls, handleRequest);
} catch (err) {
  // A damaged or unreadable certificate only costs the unc.box address, never the whole app.
  console.warn(`Uncbox: the ${DOMAIN} certificate didn't load (${err.message}). Run npm run setup-domain again.`);
}
if (secure) {
  const origin = `https://${DOMAIN}${httpsPort === 443 ? '' : `:${httpsPort}`}`;
  listenLocal(secure, httpsPort, () => console.log(`Uncbox running at ${origin}`));
  // Typing plain "unc.box" may try http first; send it to the secure address.
  const redirect = http.createServer((req, res) => {
    res.writeHead(301, { Location: `${origin}${req.url || '/'}` });
    res.end();
  });
  listenLocal(redirect, redirectPort);
}
