// Boots the real server (server/index.mjs) as a child process and asks every GET route a question.
// It catches the route that crashes on empty data, answers 500, or sends something that isn't the
// JSON the page expects. Nothing leaves the test: the server runs with UNCBOX_OFFLINE and
// UNCBOX_NO_HELPERS (see switches.mjs), a temp data folder and clips folder, and the "AppData"
// folders pointed at an empty temp folder, so it never reads or starts anything on this PC.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clipName } from './clipnames.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIP = clipName(new Date(2026, 9, 20, 21, 30, 5));
const INDEX_HTML = '<!doctype html><html><head><title>Uncbox</title></head><body><div id="root"></div></body></html>';

let temp;
let child;
let port;
let log = '';

/** A port nothing is listening on right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port: p } = srv.address();
      srv.close(() => resolve(p));
    });
  });
}

/**
 * One request, the way a browser tab on the same PC makes it: a Host header with the port and no
 * Origin. Resolves to { status, headers, text, json } (json is undefined unless the body parses).
 */
function request(method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers: { Host: `localhost:${port}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            // Not JSON.
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.setTimeout(15_000, () => req.destroy(new Error(`${method} ${urlPath} timed out`)));
    req.on('error', reject);
    req.end(body);
  });
}
const get = (urlPath, options) => request('GET', urlPath, options);

beforeAll(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'uncbox-smoke-'));
  const data = path.join(temp, 'data');
  const clips = path.join(temp, 'clips');
  const dist = path.join(temp, 'dist');
  const home = path.join(temp, 'home');
  await Promise.all([data, clips, path.join(dist, 'assets'), home].map((d) => mkdir(d, { recursive: true })));
  await writeFile(path.join(dist, 'index.html'), INDEX_HTML);
  await writeFile(path.join(dist, 'assets', 'app.js'), 'console.log("hi");');
  await writeFile(path.join(clips, CLIP), Buffer.alloc(2048, 1));
  port = await freePort();

  child = spawn(process.execPath, [path.join(root, 'server', 'index.mjs'), `--data=${data}`, `--clips=${clips}`, `--port=${port}`], {
    cwd: temp,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      UNCBOX_OFFLINE: '1',
      UNCBOX_NO_HELPERS: '1',
      UNCBOX_DIST: dist,
      // The checked-in gallery, read from disk instead of the internet.
      UNCBOX_GALLERY_URL: path.join(root, 'gallery'),
      UNCBOX_DISCORD_CLIENT_ID: '',
      // Every place the server looks for things that belong to the person running the tests.
      LOCALAPPDATA: home,
      APPDATA: home,
      ProgramData: home,
      HOME: home,
      USERPROFILE: home,
      XDG_RUNTIME_DIR: home,
      TMP: home,
      TMPDIR: home,
    },
  });
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The server didn’t start in 15 s. Output:\n${log}`)), 15_000);
    const check = () => {
      if (!log.includes('running at')) return;
      clearTimeout(timer);
      resolve();
    };
    child.stdout.on('data', check);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`The server exited with ${code}. Output:\n${log}`));
    });
    check();
  });
}, 30_000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (temp) await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ---- every GET route ----

// [route, statuses it may answer with, how to check the body, a line about what is checked]. In
// this setup nothing is signed in, installed or running, so these are the "not set up" answers.
const NOT_SIGNED_IN = [401];
const JSON_OK = [200];

/** @type {[string, number[], ((r: Awaited<ReturnType<typeof get>>) => void)?][]} */
const ROUTES = [
  ['/api/state', JSON_OK, (r) => expect(r.json).toBeNull()],
  ['/api/update', JSON_OK, (r) => expect(r.json).toMatchObject({ update: null })],
  ['/api/running?names=dungeons.exe', JSON_OK, (r) => expect(r.json).toEqual({ running: [] })],
  ['/api/running', JSON_OK],
  ['/api/discord', JSON_OK, (r) => expect(r.json.status).toBe('offline')],
  ['/api/discord/guilds', [409]],
  ['/api/discord/channels?guild=123', [409]],
  ['/api/discord/nope', [404]],
  ['/api/wow/installs', JSON_OK, (r) => expect(Array.isArray(r.json.installs)).toBe(true)],
  ['/api/wow/status', JSON_OK, (r) => expect(r.json).toMatchObject({ addons: expect.any(Object), autoInstall: true, link: { watching: false } })],
  ['/api/wow/settings', JSON_OK, (r) => expect(r.json.settings.modules.guild).toBe(true)],
  ['/api/wow/guild', JSON_OK, (r) => expect(r.json).toMatchObject({ available: false, members: [] })],
  ['/api/wow/guild/events?since=0', JSON_OK, (r) => expect(r.json).toEqual({ events: [] })],
  ['/api/wow/guild/sessions', JSON_OK, (r) => expect(r.json).toEqual({ sessions: [] })],
  ['/api/wow/guild/member?name=Nobody', [404]],
  ['/api/wow/raid', JSON_OK, (r) => expect(r.json).toMatchObject({ inRaid: false, raid: null })],
  ['/api/wow/raids', JSON_OK, (r) => expect(r.json).toEqual({ raids: [] })],
  ['/api/wow/attendance', JSON_OK, (r) => expect(r.json).toMatchObject({ raids: 0 })],
  ['/api/wow/loot?member=Nobody', JSON_OK, (r) => expect(r.json).toEqual({ loot: [] })],
  ['/api/wow/readychecks', JSON_OK, (r) => expect(r.json).toEqual({ readyChecks: [] })],
  // The auction house engine, with no addon data yet: every answer is empty, never an error.
  ['/api/wow/ah/status', JSON_OK, (r) => expect(r.json).toMatchObject({ addonInstalled: false, realms: [], dataAge: null })],
  ['/api/wow/ah/items?q=linen&sort=market&limit=5', JSON_OK, (r) => expect(r.json).toMatchObject({ total: 0, items: [] })],
  ['/api/wow/ah/item/i%3A2589', [404]],
  ['/api/wow/ah/deals', JSON_OK, (r) => expect(r.json.rows).toEqual([])],
  ['/api/wow/ah/flips', JSON_OK, (r) => expect(r.json.rows).toEqual([])],
  ['/api/wow/ah/vendor-flips', JSON_OK, (r) => expect(r.json.rows).toEqual([])],
  ['/api/wow/ah/crafting', JSON_OK, (r) => expect(r.json.rows).toEqual([])],
  ['/api/wow/ah/sell', JSON_OK, (r) => expect(r.json.rows).toEqual([])],
  ['/api/wow/ah/undercuts', JSON_OK, (r) => expect(r.json.rows).toEqual([])],
  ['/api/wow/ah/accounting?days=7', JSON_OK, (r) => expect(r.json).toMatchObject({ days: 7, entries: [] })],
  ['/api/wow/ah/gold', JSON_OK, (r) => expect(r.json).toMatchObject({ total: [], current: 0 })],
  ['/api/wow/ah/groups', JSON_OK, (r) => expect(r.json.groups).toEqual([])],
  ['/api/wow/ah/operations', JSON_OK, (r) => expect(r.json.operations.map((o) => o.id)).toEqual(['default-post', 'default-shop'])],
  ['/api/wow/ah/shopping', JSON_OK, (r) => expect(r.json.shopping).toEqual([])],
  ['/api/wow/ah/deals-settings', JSON_OK, (r) => expect(r.json.percent).toBe(0.6)],
  ['/api/wow/ah/nothing', [404]],
  ['/api/clips', JSON_OK, (r) => {
    expect(r.json.hotkey).toBe('unsupported');
    expect(r.json.clips.map((c) => c.name)).toEqual([CLIP]);
  }],
  ['/api/clips/discord', JSON_OK, (r) => expect(r.json.set).toBe(false)],
  [`/api/clips/file/${encodeURIComponent(CLIP)}`, [200]],
  ['/api/clips/file/not-a-clip.mp4', [404]],
  ['/api/clips/file/..%2F..%2Fpackage.json', [404]],
  ['/api/system', JSON_OK, (r) => expect(r.json).toMatchObject({ cpu: expect.any(Number), memory: { total: expect.any(Number) }, gpu: null })],
  ['/api/media', JSON_OK, (r) => expect(r.json.playing).toBe(false)],
  ['/api/media/art?v=none', [404]],
  ['/api/notifications', [501]],
  ['/api/netstats?target=example.com', JSON_OK, (r) => expect(r.json).toHaveProperty('targets')],
  ['/api/netstats?target=%20bad%20host', [400]],
  ['/api/web/frameable?url=https%3A%2F%2Fexample.com&from=http%3A%2F%2Flocalhost', JSON_OK, (r) => expect(r.json.frameable).toBe(true)],
  ['/api/web/frameable?url=javascript%3Aalert(1)', [400]],
  ['/api/steam', JSON_OK, (r) => expect(r.json.available).toBe(false)],
  ['/api/steam/windowed', [409]],
  ['/api/steam/avatar', [404]],
  ['/api/steam/art/570/header.jpg', [302]],
  ['/api/steam/art/570/evil.exe', [404]],
  ['/api/obs', JSON_OK, (r) => expect(r.json.status).toBe('offline')],
  ['/api/obs/settings', JSON_OK, (r) => expect(r.json).toMatchObject({ port: 4455, passwordSet: false })],
  ['/api/launcher/tiles', JSON_OK, (r) => expect(r.json).toEqual({ tiles: [] })],
  ['/api/launcher/start-menu?q=a', JSON_OK, (r) => expect(Array.isArray(r.json.items)).toBe(true)],
  ['/api/launcher/icon/tile-000000000000', [404]],
  ['/api/google/status', JSON_OK, (r) => expect(r.json).toMatchObject({ configured: false, signedIn: false })],
  ['/api/google/callback', [400], (r) => expect(r.headers['content-type']).toContain('text/html')],
  ['/api/drive/files?source=cloud&view=recent', NOT_SIGNED_IN],
  ['/api/drive/files?source=local&view=recent', [404]],
  ['/api/drive/local', JSON_OK, (r) => expect(r.json.available).toBe(false)],
  ['/api/drive/thumb/abc', [400, 401]],
  ['/api/calendar/events?days=3', NOT_SIGNED_IN],
  ['/api/gmail/summary?label=INBOX&unread=0', NOT_SIGNED_IN],
  ['/api/gmail/labels', NOT_SIGNED_IN],
  ['/api/twitch/status', JSON_OK, (r) => expect(r.json).toMatchObject({ configured: false, signedIn: false })],
  ['/api/twitch/categories?q=smite', [401, 409]],
  ['/api/stream', JSON_OK, (r) => expect(r.json).toMatchObject({ state: 'off', key: { set: false } })],
  ['/api/smite', JSON_OK, (r) => expect(r.json.phase).toBe('lobby')],
  ['/api/ytdlp', JSON_OK, (r) => expect(r.json).toMatchObject({ tools: { ytdlp: { found: false }, ffmpeg: { found: false }, winget: false }, queue: [], history: [] })],
  ['/api/gallery', JSON_OK, (r) => expect(r.json.presets.length).toBeGreaterThan(0)],
  ['/api/gallery/preset/nuzlocke-run', [200]],
  ['/api/gallery/preset/not-there', [404]],
  ['/api/gallery/preview/nuzlocke-run', [200, 404]],
  // Routes that only take a POST say so, rather than failing.
  ['/api/ocr', [405]],
  ['/api/game-settings', [405]],
  ['/api/nothing-here', [404]],
];

describe('every GET route answers', () => {
  it.each(ROUTES)('%s', async (route, statuses, check) => {
    const r = await get(route);
    expect(r.status, `${route} → ${r.status} ${r.text.slice(0, 200)}`).not.toBe(500);
    expect(statuses, `${route} → ${r.status} ${r.text.slice(0, 200)}`).toContain(r.status);
    // Anything the page reads as JSON really is JSON (clips and the HTML pages are the exceptions).
    const type = String(r.headers['content-type'] ?? '');
    if (type.includes('application/json')) expect(r.json, `${route} sent invalid JSON`).not.toBeUndefined();
    else if (route.startsWith('/api/') && r.status < 300 && !route.includes('/file/') && !route.includes('/gallery/preset/')) {
      throw new Error(`${route} should answer JSON, not ${type}`);
    }
    check?.(r);
  });
});

describe('the page', () => {
  it('serves the app at /', async () => {
    const r = await get('/');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.text).toBe(INDEX_HTML);
  });

  it('serves built files, and the app for a path that is not a file', async () => {
    const js = await get('/assets/app.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');
    const spa = await get('/some/page');
    expect(spa.status).toBe(200);
    expect(spa.text).toBe(INDEX_HTML);
  });

  it('does not serve files outside the built app', async () => {
    const r = await get('/..%2F..%2Fpackage.json');
    expect([403, 200]).toContain(r.status);
    expect(r.text).not.toContain('"name": "uncbox"');
  });
});

describe('saved state and the live stream', () => {
  it('sends the first event on /api/events, then state changes', async () => {
    const seen = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: `localhost:${port}` } }, (res) => {
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/event-stream');
        let text = '';
        let saved = false;
        res.setEncoding('utf8');
        res.on('data', async (chunk) => {
          text += chunk;
          if (!saved && text.includes(': connected')) {
            saved = true;
            // Saving from another window is what the stream carries.
            const put = await request('PUT', '/api/state', { body: JSON.stringify({ version: 2, hello: 'smoke' }), headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'smoke' } });
            if (put.status !== 200) reject(new Error(`PUT /api/state → ${put.status}`));
          }
          if (text.includes('"hello":"smoke"')) {
            req.destroy();
            resolve(text);
          }
        });
      });
      req.on('error', (err) => (req.destroyed ? undefined : reject(err)));
      setTimeout(() => {
        req.destroy();
        reject(new Error('No event arrived in 10 s'));
      }, 10_000);
    });
    expect(seen).toContain('data: {"clientId":"smoke"');
  });

  it('keeps what was saved, and refuses what is not a state', async () => {
    const r = await get('/api/state');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ version: 2, hello: 'smoke' });
    const bad = await request('PUT', '/api/state', { body: '[1,2]' });
    expect(bad.status).toBe(400);
    const worse = await request('PUT', '/api/state', { body: '{nope' });
    expect(worse.status).toBe(400);
  });
});

describe('the server', () => {
  it('stayed up and quiet', () => {
    expect(child.exitCode).toBeNull();
    // A route that crashes logs its error; the child's output has no stack traces or failures.
    expect(log).not.toMatch(/Error:|Internal error|Unhandled|at .*\.mjs:\d+/);
  });
});
