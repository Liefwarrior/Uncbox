// The quick-launch dock. Tiles (an app, folder, file, website or steam:// link) are saved here, on
// this PC, in data/launcher.json, each with an id. The page only ever sends an id to launch, never
// a path, so nothing a page says can make the server run something that wasn't saved first. Saving
// checks the path exists and that links are http, https or steam only. Everything is this PC only.
//
//   GET  /api/launcher/tiles            every saved tile: { tiles: [{ id, name, type, target }] }
//   POST /api/launcher/tiles            { id?, name, type, target } saves a new tile, or an edit of one
//   POST /api/launcher/launch           { id } opens that saved tile
//   GET  /api/launcher/icon/<id>        a PNG icon for an app or file tile (cached in data/launcher-icons/)
//   GET  /api/launcher/start-menu?q=    Start menu shortcuts to pick from: { items: [{ name, path }] }

import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openInBrowser } from './open.mjs';
import { noHelpers } from './switches.mjs';

export const TILE_TYPES = ['app', 'folder', 'file', 'url', 'steam'];
const MAX_NAME = 60;
const MAX_TARGET = 2048;
const TILE_ID = /^tile-[0-9a-f]{12}$/;

const fail = (error, status = 400) => Object.assign(new Error(error), { status });

/** A website or steam:// link cleaned up, or null if it isn't one we open (http, https and steam only). */
export function parseLink(input, type) {
  let text = String(input ?? '').trim();
  if (!text || /[\u0000-\u001f\u007f\s]/.test(text)) return null;
  // A bare Steam game id is a handy thing to paste.
  if (type === 'steam' && /^\d{1,10}$/.test(text)) text = `steam://rungameid/${text}`;
  // "example.com" means the website.
  if (type === 'url' && !/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const allowed = type === 'steam' ? ['steam:'] : ['http:', 'https:', 'steam:'];
  if (!allowed.includes(url.protocol)) return null;
  if (url.protocol !== 'steam:' && !url.hostname) return null;
  return url.href;
}

/**
 * Checks what the page sent and returns the tile to save: { tile } (without an id), or { error }.
 * `statFn` is fs.stat; the tests swap in a fake.
 */
export async function validateTile(input, { statFn = stat } = {}) {
  if (!input || typeof input !== 'object') return { error: 'That tile isn’t valid.' };
  const type = input.type;
  if (!TILE_TYPES.includes(type)) return { error: 'Pick what kind of tile this is.' };
  const name = String(input.name ?? '').trim().slice(0, MAX_NAME);
  if (!name) return { error: 'Give the tile a name.' };
  const raw = String(input.target ?? '').trim();
  if (!raw || raw.length > MAX_TARGET) return { error: type === 'url' || type === 'steam' ? 'Enter a link.' : 'Enter a path.' };

  if (type === 'url' || type === 'steam') {
    const href = parseLink(raw, type);
    if (!href) {
      return { error: type === 'steam' ? 'That isn’t a steam:// link.' : 'Links have to start with http://, https:// or steam://.' };
    }
    return { tile: { name, type, target: href } };
  }

  // Quotes are what "Copy as path" adds.
  const target = raw.replace(/^"(.*)"$/, '$1');
  if (!path.isAbsolute(target)) return { error: 'Use the full path, like C:\\Games\\Game.exe.' };
  if (/[\u0000-\u001f]/.test(target)) return { error: 'That path isn’t valid.' };
  let info;
  try {
    info = await statFn(target);
  } catch {
    return { error: 'There’s nothing at that path.' };
  }
  if (type === 'folder' && !info.isDirectory()) return { error: 'That isn’t a folder.' };
  if (type !== 'folder' && info.isDirectory()) return { error: 'That’s a folder. Pick “Folder” as the kind.' };
  if (type === 'app' && !/\.(exe|lnk)$/i.test(target)) return { error: 'Apps are .exe programs or .lnk shortcuts.' };
  return { tile: { name, type, target: path.normalize(target) } };
}

/** How to open a saved tile: the program and its argument list. No shell, so the target is never parsed as text. */
export function launchCommand(tile, platform = process.platform) {
  if (tile.type === 'url' || tile.type === 'steam') return null;
  if (platform === 'win32') return ['explorer.exe', [tile.target]];
  return [platform === 'darwin' ? 'open' : 'xdg-open', [tile.target]];
}

/** Opens a saved tile. `spawnFn` and `open` are only swapped out by the tests. */
export function launchTile(tile, { spawnFn = spawn, open = openInBrowser, platform = process.platform } = {}) {
  const command = launchCommand(tile, platform);
  if (!command) return open(tile.target);
  const child = spawnFn(command[0], command[1], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

/** The tiles in a saved file, dropping anything that has been edited into a bad shape. */
export function cleanTiles(saved) {
  if (!Array.isArray(saved)) return [];
  const seen = new Set();
  const tiles = [];
  for (const t of saved) {
    if (!t || typeof t !== 'object' || !TILE_ID.test(t.id) || seen.has(t.id)) continue;
    if (!TILE_TYPES.includes(t.type) || typeof t.name !== 'string' || typeof t.target !== 'string' || !t.target) continue;
    seen.add(t.id);
    tiles.push({ id: t.id, name: t.name.slice(0, MAX_NAME), type: t.type, target: t.target });
  }
  return tiles;
}

// ---- icons ----

/** Names a cached icon: the same file at the same size and time gives the same name, and a changed file a new one. */
export function iconCacheKey({ target, mtimeMs = 0, size = 0 }) {
  return createHash('sha1').update(`${path.normalize(target).toLowerCase()}|${Math.round(mtimeMs)}|${size}`).digest('hex').slice(0, 24);
}

// The path and the output go in as environment variables, never into the script text.
const ICON_SCRIPT = `
Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:UNCBOX_ICON_SRC)
$bmp = $icon.ToBitmap()
$bmp.Save($env:UNCBOX_ICON_OUT, [System.Drawing.Imaging.ImageFormat]::Png)
`;

function extractIcon(src, out) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(ICON_SCRIPT, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15000, env: { ...process.env, UNCBOX_ICON_SRC: src, UNCBOX_ICON_OUT: out } },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

// ---- Start menu ----

/** "Visual Studio Code.lnk" becomes "Visual Studio Code". */
export const shortcutName = (file) => file.replace(/\.lnk$/i, '');

/**
 * The .lnk files under a Start menu folder, as [{ name, path }]. Uninstall links are left out.
 * `readdirFn` is fs.readdir (with file types); the tests swap in a fake.
 */
export async function collectShortcuts(dir, { readdirFn = readdir, depth = 4 } = {}) {
  if (depth < 0) return [];
  let entries;
  try {
    entries = await readdirFn(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) found.push(...(await collectShortcuts(full, { readdirFn, depth: depth - 1 })));
    else if (/\.lnk$/i.test(e.name) && !/^uninstall\b/i.test(e.name)) found.push({ name: shortcutName(e.name), path: full });
  }
  return found;
}

/** Shortcuts from several Start menu folders, one per name, sorted, and narrowed by a search. */
export function listShortcuts(groups, query = '') {
  const q = String(query).trim().toLowerCase();
  const seen = new Set();
  return groups
    .flat()
    .filter((s) => {
      const key = s.name.toLowerCase();
      if (seen.has(key) || (q && !key.includes(q))) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function startMenuDirs() {
  return [process.env.ProgramData, process.env.APPDATA]
    .filter(Boolean)
    .map((base) => path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
}

// ---- the routes ----

export function createLauncher({ sendJson, isLocal, readJson, dataDir }) {
  const file = path.join(dataDir, 'launcher.json');
  const iconDir = path.join(dataDir, 'launcher-icons');
  // Saves go one at a time, so two quick edits can't overwrite each other.
  let chain = Promise.resolve();
  const queue = (job) => (chain = chain.then(job, job));

  async function load() {
    try {
      return cleanTiles(JSON.parse(await readFile(file, 'utf8')).tiles);
    } catch {
      return [];
    }
  }

  async function save(tiles) {
    await mkdir(dataDir, { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify({ tiles }, null, 2));
    await rename(tmp, file);
  }

  async function saveTile(body) {
    const checked = await validateTile(body);
    if (checked.error) throw fail(checked.error);
    return queue(async () => {
      const tiles = await load();
      let tile;
      if (body.id !== undefined) {
        const at = tiles.findIndex((t) => t.id === body.id);
        if (at < 0) throw fail('That tile is gone.', 404);
        tile = { id: body.id, ...checked.tile };
        tiles[at] = tile;
      } else {
        tile = { id: `tile-${randomUUID().replace(/-/g, '').slice(0, 12)}`, ...checked.tile };
        tiles.push(tile);
      }
      await save(tiles);
      return tile;
    });
  }

  // One icon is pulled out at a time, and a request for one already on its way shares it.
  const pending = new Map();
  let extracting = Promise.resolve();

  async function iconFor(tile) {
    const info = await stat(tile.target).catch(() => null);
    if (!info) return null;
    const cached = path.join(iconDir, `${iconCacheKey({ target: tile.target, mtimeMs: info.mtimeMs, size: info.size })}.png`);
    if (await stat(cached).then((s) => s.size > 0, () => false)) return cached;
    if (!pending.has(cached)) {
      const job = extracting.then(async () => {
        await mkdir(iconDir, { recursive: true });
        const tmp = `${cached}.tmp.png`;
        await extractIcon(tile.target, tmp);
        await rename(tmp, cached);
      });
      extracting = job.catch(() => {});
      pending.set(cached, job.then(() => cached).finally(() => pending.delete(cached)));
    }
    return pending.get(cached).catch(() => null);
  }

  return async function handle(req, res, url) {
    if (!isLocal(req)) return sendJson(res, 403, { error: 'This PC only' });
    const route = url.pathname.slice('/api/launcher'.length);
    try {
      if (req.method === 'GET' && route === '/tiles') return sendJson(res, 200, { tiles: await load() });

      if (req.method === 'POST' && route === '/tiles') return sendJson(res, 200, { tile: await saveTile(await readJson(req)) });

      if (req.method === 'POST' && route === '/launch') {
        // Only an id: what gets opened is whatever was saved under it.
        const { id } = await readJson(req);
        const tile = typeof id === 'string' ? (await load()).find((t) => t.id === id) : null;
        if (!tile) return sendJson(res, 404, { error: 'That tile is gone.' });
        if (tile.type === 'app' || tile.type === 'file' || tile.type === 'folder') {
          if (!(await stat(tile.target).catch(() => null))) return sendJson(res, 404, { error: `${tile.name} isn’t there any more.` });
        }
        launchTile(tile);
        return sendJson(res, 200, { ok: true });
      }

      const icon = /^\/icon\/(tile-[0-9a-f]{12})$/.exec(route);
      if (req.method === 'GET' && icon) {
        const tile = (await load()).find((t) => t.id === icon[1]);
        const png = tile && (tile.type === 'app' || tile.type === 'file') && process.platform === 'win32' && !noHelpers() ? await iconFor(tile) : null;
        if (!png) return sendJson(res, 404, { error: 'No icon' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' });
        return void createReadStream(png).pipe(res);
      }

      if (req.method === 'GET' && route === '/start-menu') {
        const groups = await Promise.all(startMenuDirs().map((d) => collectShortcuts(d)));
        return sendJson(res, 200, { items: listShortcuts(groups, url.searchParams.get('q') ?? '').slice(0, 200) });
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.status ? err.message : 'Launcher error' });
    }
  };
}
