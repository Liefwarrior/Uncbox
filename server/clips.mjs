// Clips: the page keeps the last 60 seconds of the game in memory and uploads an MP4 when the clip
// key is pressed. This saves them to your Videos folder (Videos\Uncbox), serves them back for the
// page's player, and turns the clip hotkey's presses into a "clip" event for the page. It also
// sends clips to a Discord webhook, if one is set (the URL is kept in data/clips-discord.json).
//
//   GET  /api/clips                  { dir, hotkey, clips: [{ name, size, at, download? }] }, newest first.
//                                    Videos the yt-dlp widget saved (server/ytdlp.mjs) are in the Downloads
//                                    subfolder, named "Downloads/<title>.mp4" with download: true; every
//                                    route below takes those names too.
//   POST /api/clips[?kind=vertical]  the MP4 as the body; saves it and returns { name }. With
//                                    kind=vertical it is named "Uncbox <date> vertical.mp4"
//   POST /api/clips/claim            { press }: true for the first window to ask, so only one saves
//   POST /api/clips/reveal           { name? }: shows the clip (or the folder) in Explorer
//   GET  /api/clips/file/<name>      the clip, with Range support for seeking
//
// Uploading clips to Google Drive is server/driveupload.mjs; with "upload new clips to Drive" on
// (in the saved clip settings), each clip saved here is handed to it.
//
// Discord (these, like saving and revealing, only answer the PC Uncbox runs on):
//
//   GET  /api/clips/discord          { set, hint }: whether a webhook is set and its last 4 characters.
//                                    The URL itself is never sent back.
//   POST /api/clips/discord          { url }: sets or replaces the webhook (400 if it isn't a Discord one)
//   POST /api/clips/discord/remove   forgets the webhook
//   POST /api/clips/discord/send     { name }: posts that saved clip, or with Content-Type video/mp4 the
//                                    body (a smaller copy the page made). Over 10 MB answers 413 with
//                                    { code: 'too-big' }; Discord's refusals come back as { error } in words.

import { execFile, spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DOWNLOADS, KINDS, NAME, clipName, isClipName } from './clipnames.mjs';
import { createHotkey } from './hotkey.mjs';
import { noHelpers } from './switches.mjs';
import { DISCORD_MAX_BYTES, createWebhookStore, parseWebhook, sendToWebhook } from './webhook.mjs';

const MAX_CLIP = 2 * 1024 ** 3;
const LISTED = 30;
/** Downloads are listed apart from clips, so a big batch of them never pushes the clips off the list. */
const LISTED_DOWNLOADS = 20;
/** Matches the page's defaults in src/state/hydrate.ts, for a state saved before clips existed. */
const DEFAULTS = { enabled: true, key: 'Equal', driveAuto: false, driveShare: false };

/** Windows keeps Videos wherever the user moved it (often OneDrive), so ask it. */
function videosFolder() {
  const fallback = path.join(os.homedir(), 'Videos');
  if (process.platform !== 'win32' || noHelpers()) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('MyVideos')"],
      { windowsHide: true, timeout: 10_000 },
      (err, out) => resolve((!err && out.trim()) || fallback),
    );
  });
}

export function createClips({ clipsDir, dataDir, broadcastEvent, isLocal, sendJson, readJson }) {
  const dir = clipsDir ? Promise.resolve(clipsDir) : videosFolder().then((v) => path.join(v, 'Uncbox'));
  const webhook = createWebhookStore(dataDir);
  const claimed = new Set();
  let presses = 0;
  /** Called with each clip saved (name, kind) so it can go on to Drive; set by index.mjs. */
  let afterSave = null;
  /** The saved settings that matter after a save: upload new clips to Drive, and share them. */
  let drive = { auto: false, share: false };

  const hotkey = createHotkey({
    onPress: () => {
      const press = `${Date.now()}-${++presses}`;
      broadcastEvent('clip', { press });
    },
    onStatus: (status) => broadcastEvent('clips', { hotkey: status }),
  });

  /** The newest `limit` files in `sub` (a folder inside the clips folder, '' for the folder itself) that pass `ok`. */
  async function listIn(sub, ok, limit, extra = {}) {
    const folder = path.join(await dir, sub);
    const full = (n) => (sub ? `${sub}/${n}` : n);
    const names = (await readdir(folder).catch(() => [])).filter((n) => ok(full(n)));
    const found = await Promise.all(
      names.map(async (n) => {
        const info = await stat(path.join(folder, n)).catch(() => null);
        return info?.isFile() ? { name: full(n), size: info.size, at: info.mtimeMs, ...extra } : null;
      }),
    );
    return found
      .filter(Boolean)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  }

  async function list() {
    const [clips, downloads] = await Promise.all([
      listIn('', (n) => NAME.test(n), LISTED),
      listIn(DOWNLOADS, (n) => isClipName(n), LISTED_DOWNLOADS, { download: true }),
    ]);
    return [...clips, ...downloads].sort((a, b) => b.at - a.at);
  }

  async function snapshot() {
    return { dir: await dir, hotkey: hotkey.status(), clips: await list() };
  }

  async function save(req, kind) {
    const folder = await dir;
    await mkdir(folder, { recursive: true });
    const now = new Date();
    let name = clipName(now, kind);
    // Two clips in the same second get a suffix rather than overwriting each other.
    for (let n = 2; await stat(path.join(folder, name)).catch(() => null); n++) name = clipName(now, kind, n);
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
    // Only the clip key's clips go up by themselves, not the vertical shorts made by hand.
    if (kind === 'clip' && drive.auto) afterSave?.(name, { share: drive.share });
    return name;
  }

  /** The webhook's state for the page. Never the URL: it is a secret, and the page doesn't need it. */
  async function discordStatus() {
    const parsed = parseWebhook(await webhook.get());
    return { set: Boolean(parsed), hint: parsed?.hint ?? '' };
  }

  /** The request body, or a 413 if it is over `max`. It is read to the end either way, so the answer can still be sent. */
  function readUpTo(req, max) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size <= max) chunks.push(chunk);
      });
      req.on('end', () => (size > max ? reject(Object.assign(new Error('Too big'), { status: 413 })) : resolve(Buffer.concat(chunks))));
      req.on('error', reject);
    });
  }

  const tooBig = (res) =>
    sendJson(res, 413, {
      code: 'too-big',
      error: 'That clip is over Discord’s 10 MB limit. Try a shorter trim.',
    });

  async function discord(req, res, action) {
    if (action === '' && req.method === 'GET') return sendJson(res, 200, await discordStatus());
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    if (action === '') {
      const parsed = parseWebhook((await readJson(req)).url);
      if (!parsed) {
        return sendJson(res, 400, {
          error: 'That doesn’t look like a Discord webhook. In Discord: channel settings, Integrations, Webhooks, Copy Webhook URL.',
        });
      }
      await webhook.set(parsed.url);
      return sendJson(res, 200, await discordStatus());
    }
    if (action === '/remove') {
      await webhook.clear();
      return sendJson(res, 200, await discordStatus());
    }
    if (action !== '/send') return sendJson(res, 404, { error: 'Not found' });

    const target = await webhook.get();
    if (!target) return sendJson(res, 400, { error: 'Add a Discord webhook in Clips first.' });
    let bytes;
    let filename;
    if ((req.headers['content-type'] ?? '').startsWith('video/mp4')) {
      // A copy the page made to fit under Discord's limit.
      try {
        bytes = await readUpTo(req, DISCORD_MAX_BYTES);
      } catch (err) {
        if (err.status === 413) return tooBig(res);
        throw err;
      }
      filename = 'Uncbox clip.mp4';
    } else {
      const { name } = await readJson(req);
      if (!isClipName(name)) return sendJson(res, 400, { error: 'Pick a clip to send.' });
      const file = path.join(await dir, name);
      const info = await stat(file).catch(() => null);
      if (!info) return sendJson(res, 404, { error: 'That clip is gone.' });
      if (info.size > DISCORD_MAX_BYTES) return tooBig(res);
      bytes = await readFile(file);
      filename = path.basename(name);
    }
    const sent = await sendToWebhook(target, bytes, filename);
    return sent.ok ? sendJson(res, 200, { ok: true }) : sendJson(res, sent.status === 413 ? 413 : 502, { error: sent.error });
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
      if (action === '/discord' || action.startsWith('/discord/')) {
        if (!isLocal(req)) return sendJson(res, 403, { error: 'Local only' });
        return await discord(req, res, action.slice('/discord'.length));
      }
      if (action === '' && req.method === 'GET') return sendJson(res, 200, await snapshot());
      if (action.startsWith('/file/') && req.method === 'GET') {
        let name;
        try {
          name = decodeURIComponent(action.slice('/file/'.length));
        } catch {
          name = '';
        }
        if (!isClipName(name)) return sendJson(res, 404, { error: 'Not found' });
        return await serveFile(req, res, name);
      }
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      // Saving and opening folders only from the PC Uncbox runs on, even when HOST opens it to the LAN.
      if (!isLocal(req)) return sendJson(res, 403, { error: 'Local only' });
      if (action === '') {
        const kind = url.searchParams.get('kind') ?? 'clip';
        if (!KINDS.includes(kind)) return sendJson(res, 400, { error: 'Unknown kind of clip' });
        return sendJson(res, 200, { name: await save(req, kind) });
      }
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
        const target = isClipName(name) ? path.join(folder, name) : null;
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
      drive = { auto: s.driveAuto === true, share: s.driveShare === true };
    },
    /** The clips folder. */
    folder: () => dir,
    /** Tells every open page the clip list changed (a download finished). */
    async announce() {
      broadcastEvent('clips', await snapshot());
    },
    /** Sets what happens after a clip is saved while "upload new clips to Drive" is on. */
    onSaved(fn) {
      afterSave = fn;
    },
    close: hotkey.close,
  };
}
