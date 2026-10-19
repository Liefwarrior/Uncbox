// Clips: the page keeps the last 60 seconds of the game in memory and uploads an MP4 when the clip
// key is pressed. This saves them to your Videos folder (Videos\Uncbox), serves them back for the
// page's player, and turns the clip hotkey's presses into a "clip" event for the page.
//
//   GET  /api/clips                  { dir, hotkey, clips: [{ name, size, at }] }, newest first
//   POST /api/clips                  the MP4 as the body; saves it and returns { name }
//   POST /api/clips/claim            { press }: true for the first window to ask, so only one saves
//   POST /api/clips/reveal           { name? }: shows the clip (or the folder) in Explorer
//   GET  /api/clips/file/<name>      the clip, with Range support for seeking

import { execFile, spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHotkey } from './hotkey.mjs';

const MAX_CLIP = 2 * 1024 ** 3;
const LISTED = 30;
const NAME = /^Uncbox [\d -]+\.mp4$/;
/** Matches the page's defaults in src/state/hydrate.ts, for a state saved before clips existed. */
const DEFAULTS = { enabled: true, key: 'Equal' };

/** Windows keeps Videos wherever the user moved it (often OneDrive), so ask it. */
function videosFolder() {
  const fallback = path.join(os.homedir(), 'Videos');
  if (process.platform !== 'win32') return Promise.resolve(fallback);
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('MyVideos')"],
      { windowsHide: true, timeout: 10_000 },
      (err, out) => resolve((!err && out.trim()) || fallback),
    );
  });
}

const pad = (n) => String(n).padStart(2, '0');
function clipName(d = new Date()) {
  return `Uncbox ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.mp4`;
}

export function createClips({ clipsDir, broadcastEvent, isLocal, sendJson, readJson }) {
  const dir = clipsDir ? Promise.resolve(clipsDir) : videosFolder().then((v) => path.join(v, 'Uncbox'));
  const claimed = new Set();
  let presses = 0;

  const hotkey = createHotkey({
    onPress: () => {
      const press = `${Date.now()}-${++presses}`;
      broadcastEvent('clip', { press });
    },
    onStatus: (status) => broadcastEvent('clips', { hotkey: status }),
  });

  async function list() {
    const folder = await dir;
    const names = (await readdir(folder).catch(() => [])).filter((n) => NAME.test(n));
    const clips = await Promise.all(
      names.map(async (name) => {
        const info = await stat(path.join(folder, name)).catch(() => null);
        return info && { name, size: info.size, at: info.mtimeMs };
      }),
    );
    return clips
      .filter(Boolean)
      .sort((a, b) => b.at - a.at)
      .slice(0, LISTED);
  }

  async function snapshot() {
    return { dir: await dir, hotkey: hotkey.status(), clips: await list() };
  }

  async function save(req) {
    const folder = await dir;
    await mkdir(folder, { recursive: true });
    let name = clipName();
    // Two clips in the same second get a suffix rather than overwriting each other.
    for (let n = 2; await stat(path.join(folder, name)).catch(() => null); n++) name = clipName().replace('.mp4', ` ${n}.mp4`);
    const file = path.join(folder, name);
    const part = `${file}.part`;
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_CLIP) req.destroy(Object.assign(new Error('Clip too large'), { status: 413 }));
    });
    try {
      await pipeline(req, createWriteStream(part));
      await rename(part, file);
    } catch (err) {
      await unlink(part).catch(() => {});
      throw err;
    }
    broadcastEvent('clips', await snapshot());
    return name;
  }

  async function serveFile(req, res, name) {
    const file = path.join(await dir, name);
    const info = await stat(file).catch(() => null);
    if (!info) return sendJson(res, 404, { error: 'Not found' });
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
    if (!range || (!range[1] && !range[2])) {
      res.writeHead(200, { ...headers, 'Content-Length': info.size });
      return void createReadStream(file).pipe(res);
    }
    let start = range[1] ? Number(range[1]) : info.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : info.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, info.size - 1);
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
      return void res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${info.size}` });
    createReadStream(file, { start, end }).pipe(res);
  }

  async function handle(req, res, url) {
    const action = url.pathname.slice('/api/clips'.length);
    try {
      if (action === '' && req.method === 'GET') return sendJson(res, 200, await snapshot());
      if (action.startsWith('/file/') && req.method === 'GET') {
        let name;
        try {
          name = decodeURIComponent(action.slice('/file/'.length));
        } catch {
          name = '';
        }
        if (!NAME.test(name)) return sendJson(res, 404, { error: 'Not found' });
        return await serveFile(req, res, name);
      }
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      // Saving and opening folders only from the PC Uncbox runs on, even when HOST opens it to the LAN.
      if (!isLocal(req)) return sendJson(res, 403, { error: 'Local only' });
      if (action === '') return sendJson(res, 200, { name: await save(req) });
      if (action === '/claim') {
        const { press } = await readJson(req);
        const ok = typeof press === 'string' && !claimed.has(press);
        if (ok) claimed.add(press);
        if (claimed.size > 100) claimed.delete(claimed.values().next().value);
        return sendJson(res, 200, { ok });
      }
      if (action === '/reveal') {
        const { name } = await readJson(req);
        const folder = await dir;
        await mkdir(folder, { recursive: true });
        const target = typeof name === 'string' && NAME.test(name) ? path.join(folder, name) : null;
        const [cmd, args] =
          process.platform === 'win32'
            ? ['explorer.exe', target ? [`/select,${target}`] : [folder]]
            : [process.platform === 'darwin' ? 'open' : 'xdg-open', [folder]];
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
        child.on('error', () => {});
        child.unref();
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      if (!res.headersSent) return sendJson(res, err.status || 500, { error: err.message || 'Clip error' });
      res.end();
    }
  }

  return {
    handle,
    /** Follows the saved settings: { enabled, key }. */
    configure(settings) {
      const s = settings && typeof settings === 'object' ? settings : DEFAULTS;
      hotkey.watch(s.enabled !== false ? (s.key ?? DEFAULTS.key) : '');
    },
    close: hotkey.close,
  };
}
