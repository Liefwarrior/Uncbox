// The Google Drive widget's server side. Two ways in:
//
//   Signed in with Google (server/google.mjs): the Drive API lists Recent / Starred / Shared with
//   me / Search, and thumbnails are fetched here, because they need the sign-in token.
//   Google Drive for desktop: if it is installed, its folder (often G:\) is browsed directly, with
//   no sign-in at all. Files there open with the program Windows uses for them.
//
//   GET  /api/drive/files?view=recent|starred|shared|search&q=&pageToken=&source=cloud|local
//                                    { files: [...], nextPageToken }
//   GET  /api/drive/thumb/<id>       a file's thumbnail (image bytes)
//   GET  /api/drive/local            { available, name }: is Drive for desktop here?
//   POST /api/drive/open             { url } opens a Drive/Docs page in the browser, or
//                                    { path } opens a file inside the Drive for desktop folder
//
// All of it is for this PC only. Local paths never leave the Drive folder (see resolveInside).

import { execFile } from 'node:child_process';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { GOOGLE_SCOPES } from './google.mjs';
import { openInBrowser } from './open.mjs';
import { noHelpers } from './switches.mjs';

const API = 'https://www.googleapis.com/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';
const PAGE_SIZE = 30;
const VIEWS = ['recent', 'starred', 'shared', 'search'];
const FIELDS =
  'nextPageToken,files(id,name,mimeType,modifiedTime,iconLink,webViewLink,thumbnailLink,owners(displayName,emailAddress))';

/** A value inside a Drive search query's quotes: backslashes and quotes escaped. */
const quote = (text) => `'${String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** The files.list parameters for one view of the widget. Exported for the tests. */
export function buildFilesQuery({ view = 'recent', q = '', pageToken = '' } = {}) {
  const text = String(q).trim().slice(0, 200);
  // Search with nothing typed yet shows what Recent would.
  const kind = view === 'search' && !text ? 'recent' : view;
  const params = new URLSearchParams({
    pageSize: String(PAGE_SIZE),
    fields: FIELDS,
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  let query = 'trashed = false';
  if (kind === 'starred') {
    query += ' and starred = true';
    params.set('orderBy', 'modifiedTime desc');
  } else if (kind === 'shared') {
    query += ' and sharedWithMe = true';
    params.set('orderBy', 'sharedWithMeTime desc');
  } else if (kind === 'search') {
    query += ` and (name contains ${quote(text)} or fullText contains ${quote(text)})`;
  } else {
    // Drive's own "Recent": what you last opened or changed, files only.
    query += ` and mimeType != ${quote(FOLDER)}`;
    params.set('orderBy', 'recency desc');
  }
  params.set('q', query);
  if (pageToken) params.set('pageToken', String(pageToken).slice(0, 2000));
  return params;
}

/** What the page gets for one Drive API file. */
export function toItem(f) {
  const owner = f.owners?.[0];
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime ?? '',
    iconLink: f.iconLink ?? '',
    webViewLink: f.webViewLink ?? '',
    hasThumb: Boolean(f.thumbnailLink),
    owner: owner?.displayName || owner?.emailAddress || '',
  };
}

/** Google's refusal in plain words, with a code the page can act on. */
export function driveProblem(status, body = {}) {
  const err = body.error ?? {};
  const reason = err.errors?.[0]?.reason || err.details?.[0]?.reason || '';
  if (status === 401) return { status: 401, code: 'signin', error: 'Google needs you to sign in again.' };
  if (reason === 'accessNotConfigured' || reason === 'SERVICE_DISABLED' || /has not been used|is disabled/i.test(err.message ?? '')) {
    return { status: 403, code: 'api', error: 'The Google Drive API isn’t turned on for your Google project. Turn it on in Google Cloud Console, then try again.' };
  }
  if (reason === 'insufficientPermissions' || reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') {
    return { status: 403, code: 'scope', error: 'Uncbox wasn’t allowed to see your Drive files. Sign in again and allow access to Drive.' };
  }
  if (status === 403 && /rate|quota/i.test(`${reason} ${err.message ?? ''}`)) {
    return { status: 429, code: 'busy', error: 'Google says that’s too many requests. Try again in a minute.' };
  }
  if (status === 429) return { status: 429, code: 'busy', error: 'Google says that’s too many requests. Try again in a minute.' };
  if (status >= 500) return { status: 502, code: 'down', error: 'Google Drive is having trouble right now. Try again in a minute.' };
  const said = String(err.message ?? '').trim().slice(0, 200);
  return { status: status === 400 ? 400 : 502, code: 'other', error: said ? `Google Drive said: ${said}` : `Google Drive said no (${status}).` };
}

// ---- Google Drive for desktop ----

/** The values in a `reg query` listing that look like a folder or a drive letter. */
export function pathsFromRegistry(out) {
  const found = [];
  for (const line of String(out).split(/\r?\n/)) {
    const m = /^\s+\S.*?\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const value = m[1];
    if (/^[A-Za-z]:\\.+/.test(value)) found.push(path.win32.normalize(value));
    else if (/^[A-Za-z]:?\\?$/.test(value)) found.push(`${value[0].toUpperCase()}:\\`);
  }
  return [...new Set(found)];
}

const MARKERS = ['My Drive', 'Shared drives', '.shortcut-targets-by-id'];

/**
 * Where Google Drive for desktop shows your files, or null when it isn't installed. It leaves its
 * mount in the registry (HKCU\Software\Google\DriveFS) and its working files in
 * %LOCALAPPDATA%\Google\DriveFS; if only the latter is found, the drive letters are tried.
 * Everything touching the PC is passed in, so the tests can use a fake one.
 *
 * @param {{ regQuery: () => Promise<string>, localAppData?: string, isDir: (p: string) => Promise<boolean> }} deps
 */
export async function findDriveFolder({ regQuery, localAppData, isDir }) {
  for (const candidate of pathsFromRegistry(await regQuery())) {
    if (await isDir(candidate)) return candidate;
  }
  const installed = localAppData && (await isDir(path.win32.join(localAppData, 'Google', 'DriveFS')));
  if (!installed) return null;
  // G: is where Drive usually mounts; then the rest.
  for (const letter of 'GHIJKLMNOPQRSTUVWXYZDEF') {
    const root = `${letter}:\\`;
    for (const marker of MARKERS) if (await isDir(path.win32.join(root, marker))) return root;
  }
  return null;
}

/** A path inside the Drive folder ("Work/notes.txt") as an absolute one, or null if it would leave the folder. */
export function resolveInside(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  // No "..", no ":" (drive letters, NTFS streams), no characters Windows can't have in a name, and
  // no names of only dots or spaces (Windows reads "... " as "..").
  if (!parts.length || /^[\\/]/.test(rel)) return null;
  if (parts.some((p) => /^[. ]+$/.test(p) || /[:<>"|?*]/.test(p))) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, ...parts);
  const inside = base.endsWith(path.sep) ? base : base + path.sep;
  return full.startsWith(inside) ? full : null;
}

/** Like resolveInside, but also after following shortcuts and junctions, and only for a plain file. */
export async function resolveFileInside(root, rel) {
  const full = resolveInside(root, rel);
  if (!full) return null;
  try {
    const [real, realRoot] = await Promise.all([realpath(full), realpath(root)]);
    const inside = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    const same = process.platform === 'win32' ? (a) => a.toLowerCase() : (a) => a;
    if (!same(real).startsWith(same(inside))) return null;
    return (await stat(real)).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** Programs that run when "opened". Never launched from here, even from inside the Drive folder. */
const RUNNABLE = new Set([
  '.exe', '.com', '.scr', '.bat', '.cmd', '.msi', '.msp', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
  '.hta', '.cpl', '.jar', '.reg', '.lnk', '.url', '.pif', '.msc', '.gadget', '.appx', '.msix', '.dll', '.sh',
]);
export const isRunnable = (file) => RUNNABLE.has(path.extname(file).toLowerCase());

const MIME = {
  '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.zip': 'application/zip', '.7z': 'application/x-7z-compressed',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.gdoc': 'application/vnd.google-apps.document',
  '.gsheet': 'application/vnd.google-apps.spreadsheet',
  '.gslides': 'application/vnd.google-apps.presentation',
  '.gform': 'application/vnd.google-apps.form',
};
export const mimeFor = (name) => MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';

/**
 * The files in the Drive folder, newest change first (Recent), or those whose name contains the
 * text (Search). Looks at most `maxEntries` files, `maxDepth` folders deep, for at most `maxMs`,
 * so a huge Drive can't tie the server up. Names starting with "." are Drive's own and skipped.
 */
export async function listLocal(root, { view = 'recent', q = '' } = {}, { limit = 40, maxEntries = 20_000, maxDepth = 8, maxMs = 3000 } = {}) {
  const needle = view === 'search' ? String(q).trim().toLowerCase() : '';
  const deadline = Date.now() + maxMs;
  const found = [];
  let seen = 0;
  const walk = async (dir, rel, depth) => {
    if (depth > maxDepth || seen >= maxEntries || Date.now() > deadline) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subdirs = [];
    await Promise.all(
      entries.map(async (e) => {
        if (e.name.startsWith('.') || e.isSymbolicLink()) return;
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) return void subdirs.push([path.join(dir, e.name), relPath]);
        if (!e.isFile() || seen >= maxEntries) return;
        seen++;
        if (needle && !e.name.toLowerCase().includes(needle)) return;
        const info = await stat(path.join(dir, e.name)).catch(() => null);
        if (info) found.push({ relPath, name: e.name, mtime: info.mtimeMs });
      }),
    );
    for (const [sub, relPath] of subdirs) await walk(sub, relPath, depth + 1);
  };
  await walk(root, '', 0);
  found.sort((a, b) => b.mtime - a.mtime);
  return found.slice(0, limit).map((f) => ({
    id: f.relPath,
    name: f.name,
    mimeType: mimeFor(f.name),
    modifiedTime: new Date(f.mtime).toISOString(),
    iconLink: '',
    webViewLink: '',
    hasThumb: false,
    owner: '',
  }));
}

/** A Drive or Docs page address that is safe to open in the browser, or null. */
export function safeDriveUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ['drive.google.com', 'docs.google.com'].includes(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

function regQuery() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || noHelpers()) return resolve('');
    execFile('reg', ['query', 'HKCU\\Software\\Google\\DriveFS', '/s'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? '' : out));
  });
}

const isDir = (p) => stat(p).then((s) => s.isDirectory(), () => false);

/**
 * @param {object} o
 * @param {ReturnType<import('./google.mjs').createGoogle>} o.google
 * @param {string} [o.localFolder]  use this as the Drive for desktop folder (for trying it without the app)
 * @param {(target: string) => void} [o.open]  opens a page or file; swapped out by the tests
 */
export function createDrive({ google, isLocal, sendJson, readJson, localFolder = '', open = openInBrowser, findFolder }) {
  google.requireScopes(GOOGLE_SCOPES.drive);
  const thumbLinks = new Map();
  /** The Drive for desktop folder, looked up once a minute at most. */
  let folder = { at: 0, path: null };
  const locate =
    findFolder ??
    (async () => {
      if (localFolder) return (await isDir(localFolder)) ? path.resolve(localFolder) : null;
      return findDriveFolder({ regQuery, localAppData: process.env.LOCALAPPDATA, isDir });
    });
  async function driveFolder() {
    if (Date.now() - folder.at > 60_000) folder = { at: Date.now(), path: await locate() };
    return folder.path;
  }

  async function files(res, url) {
    const view = VIEWS.includes(url.searchParams.get('view')) ? url.searchParams.get('view') : 'recent';
    const q = url.searchParams.get('q') ?? '';
    if (url.searchParams.get('source') === 'local') {
      const root = await driveFolder();
      if (!root) return sendJson(res, 404, { code: 'nolocal', error: 'Google Drive for desktop isn’t installed.' });
      if (view === 'starred' || view === 'shared') return sendJson(res, 200, { files: [] });
      return sendJson(res, 200, { files: await listLocal(root, { view, q }) });
    }
    if (!(await google.hasScopes([GOOGLE_SCOPES.drive[0]]))) {
      const status = await google.snapshot();
      return sendJson(res, 401, status.signedIn
        ? { code: 'scope', error: 'Uncbox wasn’t allowed to see your Drive files. Sign in again and allow access to Drive.' }
        : { code: 'signin', error: 'Sign in with Google first.' });
    }
    const r = await google.fetch(`${API}?${buildFilesQuery({ view, q, pageToken: url.searchParams.get('pageToken') ?? '' })}`);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const { status, ...rest } = driveProblem(r.status, body);
      return sendJson(res, status, rest);
    }
    for (const f of body.files ?? []) {
      if (f.thumbnailLink) thumbLinks.set(f.id, f.thumbnailLink);
    }
    // Links go stale and the list only needs the latest few hundred.
    while (thumbLinks.size > 500) thumbLinks.delete(thumbLinks.keys().next().value);
    return sendJson(res, 200, { files: (body.files ?? []).map(toItem), nextPageToken: body.nextPageToken ?? '' });
  }

  async function thumb(res, id) {
    if (!/^[\w-]{6,120}$/.test(id)) return sendJson(res, 400, { error: 'Not a file' });
    let link = thumbLinks.get(id);
    if (!link) {
      const r = await google.fetch(`${API}/${id}?fields=thumbnailLink&supportsAllDrives=true`);
      link = r.ok ? (await r.json().catch(() => ({}))).thumbnailLink : '';
    }
    // Drive sizes thumbnails with a trailing "=s220"; ask for one big enough for a wide widget.
    const sized = link ? link.replace(/=s\d+$/, '=s400') : '';
    const image = sized && (await google.fetch(sized).catch(() => null));
    if (!image?.ok) return sendJson(res, 404, { error: 'No thumbnail' });
    const type = image.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) return sendJson(res, 404, { error: 'No thumbnail' });
    const bytes = Buffer.from(await image.arrayBuffer());
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': 'private, max-age=600' });
    res.end(bytes);
  }

  async function openIt(res, body) {
    if (typeof body.url === 'string') {
      const target = safeDriveUrl(body.url);
      if (!target) return sendJson(res, 400, { error: 'That isn’t a Google Drive page.' });
      open(target);
      return sendJson(res, 200, { ok: true });
    }
    const root = await driveFolder();
    if (!root) return sendJson(res, 404, { error: 'Google Drive for desktop isn’t installed.' });
    const file = await resolveFileInside(root, body.path);
    if (!file) return sendJson(res, 400, { error: 'That file isn’t in your Drive folder.' });
    if (isRunnable(file)) return sendJson(res, 400, { error: 'Uncbox won’t run programs. Open it from File Explorer instead.' });
    open(file);
    return sendJson(res, 200, { ok: true });
  }

  return async function handle(req, res, url) {
    if (!isLocal(req)) return sendJson(res, 403, { error: 'Run this on the PC Uncbox is on.' });
    const action = url.pathname.slice('/api/drive'.length);
    try {
      if (req.method === 'GET' && action === '/files') return await files(res, url);
      if (req.method === 'GET' && action.startsWith('/thumb/')) return await thumb(res, decodeURIComponent(action.slice('/thumb/'.length)));
      if (req.method === 'GET' && action === '/local') {
        const root = await driveFolder();
        return sendJson(res, 200, { available: Boolean(root), name: root ? path.basename(root) || root : '' });
      }
      if (req.method === 'POST' && action === '/open') return await openIt(res, await readJson(req));
      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      return sendJson(res, err.status || 500, {
        code: err.status === 401 ? 'signin' : 'other',
        error: err.status ? err.message : 'Couldn’t read Google Drive.',
      });
    }
  };
}
