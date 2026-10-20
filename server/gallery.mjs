// The preset gallery: shared .uncbox presets kept in the Uncbox repo's gallery/ folder, with an
// index.json that lists them. There is no server of our own: this fetches the files from GitHub (or
// from a local folder, for trying things out), checks them, and hands them to the page.
//
//   GET /api/gallery                 { version, presets: [...], stale, fetchedAt }. The index, with
//                                    bad entries dropped. Kept 30 minutes in memory and in
//                                    data/gallery-cache.json; when the gallery can't be reached the
//                                    last copy is served with stale: true. With no copy at all it
//                                    answers 503 { error, reason: 'missing' | 'offline' | 'bad' }.
//   GET /api/gallery/preset/<id>     the preset file's text, for the page to import. Only ids in the
//                                    index; the path comes from the index and must look like
//                                    presets/<name>.uncbox; at most 1 MB.
//   GET /api/gallery/preview/<id>    the preset's preview picture, if it has one (404 if not).
//
// UNCBOX_GALLERY_URL changes where the gallery is read from: another https address (a branch), or a
// folder on this PC (a plain path or file://). All of it only answers the PC Uncbox runs on.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './datafile.mjs';

export const DEFAULT_GALLERY_URL = 'https://raw.githubusercontent.com/Liefwarrior/Uncbox/main/gallery/';

export const INDEX_VERSION = 1;
const TTL = 30 * 60 * 1000;
const TIMEOUT = 10_000;
export const MAX_INDEX_BYTES = 512 * 1024;
export const MAX_PRESET_BYTES = 1024 * 1024;
export const MAX_PREVIEW_BYTES = 512 * 1024;
export const MAX_ENTRIES = 300;
const MAX_PREVIEWS_KEPT = 40;

/** The built-in presets a gallery preset can be based on (src/state/model.ts PRESET_IDS; a test keeps them equal). */
export const GALLERY_BASES = ['pokemon', 'smite2', 'wow', 'mcd2', 'steam', 'terminal', 'desk'];

export const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const FILE_PATTERN = /^presets\/[a-z0-9-]+\.uncbox$/;
export const PREVIEW_PATTERN = /^previews\/[a-z0-9-]+\.(webp|png|jpg)$/;
const PREVIEW_TYPES = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg' };

/** Something went wrong in plain words. `reason` says which kind, for the page. */
export class GalleryError extends Error {
  constructor(message, reason, status = 502) {
    super(message);
    this.reason = reason;
    this.status = status;
  }
}

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** One index entry cleaned up, or null when it can't be used. */
export function cleanEntry(raw) {
  if (!isObj(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (id.length > 48 || !ID_PATTERN.test(id)) return null;
  const name = text(raw.name, 40);
  const author = text(raw.author, 40);
  if (!name || !author) return null;
  if (!GALLERY_BASES.includes(raw.base)) return null;
  if (typeof raw.file !== 'string' || !FILE_PATTERN.test(raw.file)) return null;
  const tags = [];
  for (const t of Array.isArray(raw.tags) ? raw.tags : []) {
    const tag = text(t, 24).toLowerCase();
    if (tag && !tags.includes(tag) && tags.length < 8) tags.push(tag);
  }
  return {
    id,
    name,
    author,
    description: text(raw.description, 280),
    base: raw.base,
    tags,
    file: raw.file,
    // A preview that doesn't look right is only left out; the preset is still fine.
    preview: typeof raw.preview === 'string' && PREVIEW_PATTERN.test(raw.preview) ? raw.preview : '',
    updated: typeof raw.updated === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.updated) ? raw.updated : '',
  };
}

/**
 * Checks a parsed index.json: { version: 1, presets: [...] }. Bad entries and repeated ids are
 * dropped. Returns { version, presets, dropped }, or throws GalleryError if it isn't an index.
 */
export function validateIndex(json) {
  if (!isObj(json) || !Array.isArray(json.presets)) throw new GalleryError('The gallery’s list is damaged.', 'bad');
  if (typeof json.version !== 'number' || json.version < 1) throw new GalleryError('The gallery’s list is damaged.', 'bad');
  if (json.version > INDEX_VERSION) throw new GalleryError('The gallery needs a newer Uncbox. Update Uncbox to browse it.', 'bad');
  const presets = [];
  const seen = new Set();
  let dropped = 0;
  for (const raw of json.presets) {
    const entry = cleanEntry(raw);
    if (!entry || seen.has(entry.id) || presets.length >= MAX_ENTRIES) {
      dropped++;
      continue;
    }
    seen.add(entry.id);
    presets.push(entry);
  }
  return { version: INDEX_VERSION, presets, dropped };
}

// ---- where the files come from ----

/** A folder on this PC when the setting isn't an http(s) address: "C:\gallery", "/home/x/gallery" or file:///… */
export function localRoot(base) {
  const value = String(base).trim();
  if (/^https?:\/\//i.test(value)) return null;
  if (/^file:/i.test(value)) return path.resolve(fileURLToPath(value));
  return path.resolve(value);
}

/**
 * Reads one file of the gallery, as a Buffer of at most `max` bytes. `rel` is a path like
 * "index.json" or "presets/x.uncbox" that the caller has already checked; this checks again that it
 * can't leave the gallery. `fetchImpl` is only swapped out by the tests.
 */
export function createSource(base, fetchImpl = fetch) {
  const folder = localRoot(base);
  const root = folder ? null : String(base).trim().replace(/\/?$/, '/');

  async function readLocal(rel, max) {
    const file = path.resolve(folder, rel);
    if (!file.startsWith(folder.endsWith(path.sep) ? folder : folder + path.sep)) throw new GalleryError('That file isn’t in the gallery.', 'bad', 400);
    let info;
    try {
      info = await stat(file);
    } catch {
      throw new GalleryError('The gallery isn’t there.', 'missing', 404);
    }
    if (!info.isFile()) throw new GalleryError('The gallery isn’t there.', 'missing', 404);
    if (info.size > max) throw new GalleryError('That file is too big for the gallery.', 'toobig');
    return readFile(file);
  }

  async function readRemote(rel, max) {
    let res;
    try {
      res = await fetchImpl(new URL(rel, root), { headers: { 'User-Agent': 'Uncbox' }, signal: AbortSignal.timeout(TIMEOUT) });
    } catch {
      throw new GalleryError('Couldn’t reach the gallery. Check your internet connection.', 'offline');
    }
    if (res.status === 404) throw new GalleryError('The gallery isn’t published yet.', 'missing', 404);
    if (!res.ok) throw new GalleryError('The gallery isn’t answering right now. Try again in a bit.', 'offline');
    const tooBig = () => new GalleryError('That file is too big for the gallery.', 'toobig');
    if (Number(res.headers.get('content-length')) > max) throw tooBig();
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of res.body ?? []) {
        size += chunk.length;
        if (size > max) throw tooBig();
        chunks.push(chunk);
      }
    } catch (err) {
      if (err instanceof GalleryError) throw err;
      throw new GalleryError('Couldn’t reach the gallery. Check your internet connection.', 'offline');
    }
    return Buffer.concat(chunks);
  }

  return { local: Boolean(folder), read: folder ? readLocal : readRemote };
}

// ---- the gallery ----

/**
 * The gallery for a server. `baseUrl` is where it is read from; `fetchImpl` and `now` are only
 * swapped out by the tests.
 */
export function createGallery({ dataDir, sendJson, isLocal, baseUrl = DEFAULT_GALLERY_URL, fetchImpl = fetch, now = Date.now }) {
  const base = String(baseUrl || DEFAULT_GALLERY_URL).trim();
  const source = createSource(base, fetchImpl);
  const cacheFile = path.join(dataDir, 'gallery-cache.json');
  let cache = null;
  let loaded = false;
  let inFlight = null;
  const previews = new Map();

  async function loadCache() {
    if (loaded) return;
    loaded = true;
    try {
      const saved = JSON.parse(await readFile(cacheFile, 'utf8'));
      if (saved?.source !== base || typeof saved.fetchedAt !== 'number') return;
      const { version, presets } = validateIndex(saved.index);
      cache ??= { fetchedAt: saved.fetchedAt, index: { version, presets } };
    } catch {
      // No saved copy, or one that isn't readable: the same as none.
    }
  }

  async function saveCache() {
    try {
      await writeJsonAtomic(cacheFile, { source: base, fetchedAt: cache.fetchedAt, index: cache.index });
    } catch {
      // Not being able to remember it only means asking again next time.
    }
  }

  async function download() {
    const buf = await source.read('index.json', MAX_INDEX_BYTES);
    let json;
    try {
      json = JSON.parse(buf.toString('utf8'));
    } catch {
      throw new GalleryError('The gallery’s list is damaged.', 'bad');
    }
    const { version, presets } = validateIndex(json);
    cache = { fetchedAt: now(), index: { version, presets } };
    // A folder on this PC is read fresh each time (it is being edited), so nothing is kept for it.
    if (!source.local) await saveCache();
    return cache;
  }

  /**
   * The index: the kept copy if it is under 30 minutes old, else a fresh one. If the gallery can't be
   * reached, the last copy with stale: true; throws GalleryError when there is none.
   */
  async function getIndex() {
    await loadCache();
    if (cache && !source.local) {
      const age = now() - cache.fetchedAt;
      // A clock set backwards makes age negative: ask again rather than trust it.
      if (age >= 0 && age < TTL) return { ...cache.index, stale: false, fetchedAt: cache.fetchedAt };
    }
    inFlight ??= download().finally(() => {
      inFlight = null;
    });
    try {
      const fresh = await inFlight;
      return { ...fresh.index, stale: false, fetchedAt: fresh.fetchedAt };
    } catch (err) {
      if (cache && !source.local) return { ...cache.index, stale: true, fetchedAt: cache.fetchedAt };
      throw err;
    }
  }

  async function entryFor(id) {
    if (!ID_PATTERN.test(id)) throw new GalleryError('That preset isn’t in the gallery.', 'unknown', 404);
    const { presets } = await getIndex();
    const entry = presets.find((p) => p.id === id);
    if (!entry) throw new GalleryError('That preset isn’t in the gallery.', 'unknown', 404);
    return entry;
  }

  /** The preset's file as text. */
  async function presetText(id) {
    const entry = await entryFor(id);
    // The index was checked on the way in; this is the last look before a path is used.
    if (!FILE_PATTERN.test(entry.file)) throw new GalleryError('That preset isn’t in the gallery.', 'unknown', 404);
    const buf = await source.read(entry.file, MAX_PRESET_BYTES);
    return buf.toString('utf8');
  }

  /** The preview picture, or null if the preset has none. */
  async function preview(id) {
    const entry = await entryFor(id);
    if (!entry.preview || !PREVIEW_PATTERN.test(entry.preview)) return null;
    const kept = previews.get(id);
    if (kept && kept.file === entry.preview && !source.local && now() - kept.at >= 0 && now() - kept.at < TTL) return kept;
    try {
      const data = await source.read(entry.preview, MAX_PREVIEW_BYTES);
      const type = PREVIEW_TYPES[entry.preview.split('.').pop()];
      const item = { file: entry.preview, at: now(), data, type };
      previews.delete(id);
      previews.set(id, item);
      // The oldest go first, so a long list of previews doesn't pile up.
      while (previews.size > MAX_PREVIEWS_KEPT) previews.delete(previews.keys().next().value);
      return item;
    } catch (err) {
      if (kept && kept.file === entry.preview) return kept;
      throw err;
    }
  }

  async function handle(req, res, url) {
    if (!isLocal(req)) return sendJson(res, 403, { error: 'Run this on the PC Uncbox is on.' });
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
    const rest = url.pathname.slice('/api/gallery'.length);
    try {
      if (rest === '') {
        let index;
        try {
          index = await getIndex();
        } catch (err) {
          if (!(err instanceof GalleryError)) throw err;
          // The page shows this in words, so the reason is a few plain kinds.
          return sendJson(res, 503, { error: err.message, reason: err.reason });
        }
        return sendJson(res, 200, index);
      }
      const m = /^\/(preset|preview)\/([^/]+)$/.exec(rest);
      if (!m) return sendJson(res, 404, { error: 'Not found' });
      if (m[1] === 'preset') {
        const body = await presetText(m[2]);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(body);
      }
      const item = await preview(m[2]);
      if (!item) return sendJson(res, 404, { error: 'No preview' });
      res.writeHead(200, {
        'Content-Type': item.type,
        'Content-Length': item.data.length,
        'Cache-Control': 'private, max-age=1800',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(item.data);
    } catch (err) {
      if (err instanceof GalleryError) return sendJson(res, err.status, { error: err.message, reason: err.reason });
      return sendJson(res, 500, { error: 'The gallery had a problem. Try again.' });
    }
  }

  return { handle, getIndex, presetText, preview };
}
