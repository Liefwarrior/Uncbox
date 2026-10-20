// The Drive widget's server side: the Drive API queries for each view, Google's errors in plain
// words, finding Google Drive for desktop, and keeping local paths inside its folder.

import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildFilesQuery,
  createDrive,
  driveProblem,
  findDriveFolder,
  isRunnable,
  listLocal,
  pathsFromRegistry,
  resolveFileInside,
  resolveInside,
  safeDriveUrl,
  toItem,
} from './drive.mjs';

const params = (opts) => Object.fromEntries(buildFilesQuery(opts));

describe('buildFilesQuery', () => {
  it('Recent: files you last touched, newest first, no folders or trash', () => {
    const p = params({ view: 'recent' });
    expect(p.q).toBe("trashed = false and mimeType != 'application/vnd.google-apps.folder'");
    expect(p.orderBy).toBe('recency desc');
  });

  it('Starred', () => {
    const p = params({ view: 'starred' });
    expect(p.q).toBe('trashed = false and starred = true');
    expect(p.orderBy).toBe('modifiedTime desc');
  });

  it('Shared with me', () => {
    const p = params({ view: 'shared' });
    expect(p.q).toBe('trashed = false and sharedWithMe = true');
    expect(p.orderBy).toBe('sharedWithMeTime desc');
  });

  it('Search: matches names and contents', () => {
    const p = params({ view: 'search', q: 'budget' });
    expect(p.q).toBe("trashed = false and (name contains 'budget' or fullText contains 'budget')");
    expect(p.orderBy).toBeUndefined();
  });

  it('Search: escapes quotes and backslashes so the text can’t change the query', () => {
    const p = params({ view: 'search', q: "it's a \\ test' or trashed = true or name contains '" });
    expect(p.q).toContain("name contains 'it\\'s a \\\\ test\\' or trashed = true or name contains \\''");
    expect(p.q.startsWith('trashed = false and (')).toBe(true);
  });

  it('Search with nothing typed falls back to Recent', () => {
    expect(params({ view: 'search', q: '   ' }).q).toBe(params({ view: 'recent' }).q);
  });

  it('treats an unknown view as Recent', () => {
    expect(params({ view: 'whatever' }).q).toBe(params({ view: 'recent' }).q);
    expect(params({}).orderBy).toBe('recency desc');
  });

  it('asks for the fields the widget shows, a page at a time, shared drives included', () => {
    const p = params({ view: 'recent', pageToken: 'next-1' });
    for (const f of ['id', 'name', 'mimeType', 'modifiedTime', 'iconLink', 'webViewLink', 'thumbnailLink', 'owners', 'nextPageToken']) {
      expect(p.fields).toContain(f);
    }
    expect(p.pageToken).toBe('next-1');
    expect(p.pageSize).toBe('30');
    expect(p.supportsAllDrives).toBe('true');
    expect(p.includeItemsFromAllDrives).toBe('true');
    expect(params({ view: 'recent' }).pageToken).toBeUndefined();
  });

  it('caps what is searched for', () => {
    expect(params({ view: 'search', q: 'a'.repeat(500) }).q).not.toContain('a'.repeat(201));
  });
});

describe('toItem and driveProblem', () => {
  it('keeps only what the page needs, and not the thumbnail address', () => {
    const item = toItem({
      id: '1',
      name: 'Plan',
      mimeType: 'application/vnd.google-apps.document',
      modifiedTime: '2026-01-02T03:04:05Z',
      webViewLink: 'https://docs.google.com/document/d/1/edit',
      thumbnailLink: 'https://lh3.googleusercontent.com/x',
      owners: [{ displayName: 'Eli', emailAddress: 'e@x.y' }],
    });
    expect(item).toMatchObject({ id: '1', owner: 'Eli', hasThumb: true });
    expect(JSON.stringify(item)).not.toContain('googleusercontent');
  });

  it('explains a Drive API that is switched off', () => {
    const r = driveProblem(403, { error: { message: 'Google Drive API has not been used in project 1 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } });
    expect(r.code).toBe('api');
    expect(r.error).toMatch(/turned on/);
  });

  it('tells apart a lost sign-in, a missing permission and a busy Google', () => {
    expect(driveProblem(401).code).toBe('signin');
    expect(driveProblem(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }).code).toBe('scope');
    expect(driveProblem(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }], message: 'User rate limit exceeded' } }).code).toBe('busy');
    expect(driveProblem(429).status).toBe(429);
    expect(driveProblem(503).code).toBe('down');
  });
});

describe('safeDriveUrl', () => {
  it('only passes Google Drive and Docs pages', () => {
    expect(safeDriveUrl('https://drive.google.com/file/d/1/view')).toBeTruthy();
    expect(safeDriveUrl('https://docs.google.com/document/d/1/edit')).toBeTruthy();
    for (const bad of ['http://drive.google.com/x', 'https://evil.example/drive.google.com', 'https://drive.google.com.evil.example/', 'file:///C:/Windows/notepad.exe', 'javascript:alert(1)', 'nope']) {
      expect(safeDriveUrl(bad)).toBeNull();
    }
  });
});

// ---- Google Drive for desktop ----

describe('finding Google Drive for desktop', () => {
  const REG = [
    'HKEY_CURRENT_USER\\Software\\Google\\DriveFS',
    '    Version    REG_SZ    92.0.1',
    '    Installed    REG_DWORD    0x1',
    'HKEY_CURRENT_USER\\Software\\Google\\DriveFS\\Share',
    '    BasePath    REG_SZ    G:\\',
    '    LastRoot    REG_SZ    C:\\Users\\Eli\\AppData\\Local\\Google\\DriveFS',
    '',
  ].join('\r\n');
  const dirsOf = (...list) => async (p) => list.map((d) => d.toLowerCase()).includes(p.toLowerCase());

  it('reads folders and drive letters out of a registry listing', () => {
    expect(pathsFromRegistry(REG)).toEqual(['G:\\', 'C:\\Users\\Eli\\AppData\\Local\\Google\\DriveFS']);
    expect(pathsFromRegistry('    Mount    REG_SZ    h')).toEqual(['H:\\']);
    expect(pathsFromRegistry('    Name    REG_SZ    not a path')).toEqual([]);
    expect(pathsFromRegistry('')).toEqual([]);
  });

  it('uses the mount the registry names, when it exists', async () => {
    const found = await findDriveFolder({ regQuery: async () => REG, localAppData: 'C:\\L', isDir: dirsOf('G:\\') });
    expect(found).toBe('G:\\');
  });

  it('tries the drive letters when only the DriveFS working folder is there', async () => {
    const found = await findDriveFolder({
      regQuery: async () => '',
      localAppData: 'C:\\L',
      isDir: dirsOf('C:\\L\\Google\\DriveFS', 'H:\\My Drive'),
    });
    expect(found).toBe('H:\\');
  });

  it('finds nothing when Drive for desktop isn’t installed, even if a "My Drive" folder exists', async () => {
    const found = await findDriveFolder({ regQuery: async () => '', localAppData: 'C:\\L', isDir: dirsOf('D:\\', 'D:\\My Drive') });
    expect(found).toBeNull();
  });

  it('finds nothing when the registry mount is gone and there is no DriveFS folder', async () => {
    expect(await findDriveFolder({ regQuery: async () => REG, localAppData: 'C:\\L', isDir: dirsOf() })).toBeNull();
  });
});

describe('resolveInside', () => {
  const root = path.resolve(os.tmpdir(), 'fake-drive');
  const inside = (rel) => resolveInside(root, rel);

  it('resolves paths inside the folder', () => {
    expect(inside('notes.txt')).toBe(path.join(root, 'notes.txt'));
    expect(inside('Work/2026/plan.docx')).toBe(path.join(root, 'Work', '2026', 'plan.docx'));
    expect(inside('Work\\plan.docx')).toBe(path.join(root, 'Work', 'plan.docx'));
    expect(inside('a..b/c.txt')).toBe(path.join(root, 'a..b', 'c.txt'));
  });

  it.each([
    ['../outside.txt'],
    ['..\\outside.txt'],
    ['Work/../../outside.txt'],
    ['Work/../notes.txt'],
    ['./notes.txt'],
    ['.. /x'],
    ['.../x'],
    ['/etc/passwd'],
    ['\\Windows\\System32\\cmd.exe'],
    ['C:\\Windows\\notepad.exe'],
    ['C:notepad.exe'],
    ['notes.txt:stream'],
    ['con?.txt'],
    ['a\0b'],
    [''],
    ['/'],
    [undefined],
    [42],
    [{ toString: () => 'x' }],
  ])('refuses %j', (rel) => {
    expect(inside(rel)).toBeNull();
  });

  it('works for a root that is a drive root', () => {
    const r = path.parse(root).root;
    expect(resolveInside(r, 'My Drive/x.txt')).toBe(path.join(r, 'My Drive', 'x.txt'));
    expect(resolveInside(r, '../x.txt')).toBeNull();
  });

  it('does not treat a sibling folder with the same start as inside', () => {
    expect(inside('../fake-drive-evil/x.txt')).toBeNull();
  });
});

describe('with a fake Drive folder on disk', () => {
  const made = [];
  afterEach(async () => {
    while (made.length) await rm(made.pop(), { recursive: true, force: true });
  });

  /** A folder shaped like Drive for desktop, and a file next to it that must stay out of reach. */
  async function fake() {
    const base = await mkdtemp(path.join(os.tmpdir(), 'uncbox-drive-'));
    made.push(base);
    const root = path.join(base, 'drive');
    await mkdir(path.join(root, 'My Drive', 'Work'), { recursive: true });
    await mkdir(path.join(root, '.shortcut-targets-by-id'), { recursive: true });
    const put = async (rel, ageMin) => {
      const file = path.join(root, rel);
      await writeFile(file, 'x');
      const t = new Date(Date.now() - ageMin * 60_000);
      await utimes(file, t, t);
    };
    await put('My Drive/old.pdf', 500);
    await put('My Drive/Work/Budget 2026.xlsx', 5);
    await put('My Drive/Work/budget-notes.gdoc', 50);
    await put('My Drive/setup.exe', 1);
    await put('.shortcut-targets-by-id/hidden.txt', 0);
    await writeFile(path.join(base, 'secret.txt'), 'secret');
    return { base, root };
  }

  it('lists files by newest change, skipping Drive’s hidden folders', async () => {
    const { root } = await fake();
    const files = await listLocal(root, { view: 'recent' });
    expect(files.map((f) => f.name)).toEqual(['setup.exe', 'Budget 2026.xlsx', 'budget-notes.gdoc', 'old.pdf']);
    expect(files[1]).toMatchObject({ id: 'My Drive/Work/Budget 2026.xlsx', hasThumb: false });
    expect(files[1].mimeType).toContain('spreadsheetml');
    expect(files[2].mimeType).toBe('application/vnd.google-apps.document');
  });

  it('searches names, ignoring case', async () => {
    const { root } = await fake();
    const files = await listLocal(root, { view: 'search', q: 'BUDGET' });
    expect(files.map((f) => f.name)).toEqual(['Budget 2026.xlsx', 'budget-notes.gdoc']);
  });

  it('stops after the entries and depth it was allowed', async () => {
    const { root } = await fake();
    expect(await listLocal(root, {}, { maxEntries: 2 })).toHaveLength(2);
    expect(await listLocal(root, {}, { maxDepth: 1 })).toHaveLength(2);
    expect(await listLocal(root, {}, { limit: 1 })).toHaveLength(1);
  });

  it('opens real files inside the folder and nothing outside it', async () => {
    const { base, root } = await fake();
    expect(await resolveFileInside(root, 'My Drive/old.pdf')).toBeTruthy();
    expect(await resolveFileInside(root, 'My Drive/Work')).toBeNull();
    expect(await resolveFileInside(root, 'My Drive/missing.pdf')).toBeNull();
    expect(await resolveFileInside(root, '../secret.txt')).toBeNull();
    expect(await resolveFileInside(root, `..\\${path.basename(base)}\\secret.txt`)).toBeNull();
  });

  it('does not follow a link out of the folder', async () => {
    const { base, root } = await fake();
    try {
      await symlink(path.join(base, 'secret.txt'), path.join(root, 'My Drive', 'link.txt'));
    } catch {
      return; // Making links needs a privilege some PCs don't give.
    }
    expect(await resolveFileInside(root, 'My Drive/link.txt')).toBeNull();
    expect((await listLocal(root, { view: 'search', q: 'link' })).map((f) => f.name)).toEqual([]);
  });

  it('never opens programs', () => {
    for (const f of ['a.exe', 'A.BAT', 'x.ps1', 'x.lnk', 'x.js', 'x.msi']) expect(isRunnable(f)).toBe(true);
    for (const f of ['a.pdf', 'a.docx', 'a.gdoc', 'noextension']) expect(isRunnable(f)).toBe(false);
  });

  // The routes, end to end, with a fake request and response.
  async function route(pathname, { method = 'GET', body, root, local = true } = {}) {
    const opened = [];
    const google = {
      requireScopes() {},
      hasScopes: async () => false,
      snapshot: async () => ({ signedIn: false }),
      fetch: async () => {
        throw new Error('no network');
      },
    };
    const handle = createDrive({
      google,
      isLocal: () => local,
      sendJson: (res, status, data) => (res.out = { status, body: data }),
      readJson: async () => body,
      localFolder: root,
      open: (t) => opened.push(t),
    });
    const res = {};
    await handle({ method }, res, new URL(pathname, 'http://127.0.0.1:5170'));
    return { ...res.out, opened };
  }

  it('lists and opens through the routes', async () => {
    const { root } = await fake();
    expect((await route('/api/drive/local', { root })).body).toEqual({ available: true, name: 'drive' });
    const list = await route('/api/drive/files?source=local&view=search&q=old', { root });
    expect(list.body.files.map((f) => f.name)).toEqual(['old.pdf']);
    const open = await route('/api/drive/open', { method: 'POST', body: { path: 'My Drive/old.pdf' }, root });
    expect(open.status).toBe(200);
    expect(open.opened).toHaveLength(1);
    expect(path.normalize(open.opened[0]).toLowerCase()).toBe(path.join(root, 'My Drive', 'old.pdf').toLowerCase());
  });

  it('refuses to open anything it shouldn’t', async () => {
    const { root } = await fake();
    for (const body of [{ path: '../secret.txt' }, { path: 'My Drive/setup.exe' }, { path: 'My Drive/Work' }, { url: 'https://evil.example/' }, {}]) {
      const r = await route('/api/drive/open', { method: 'POST', body, root });
      expect(r.status).toBe(400);
      expect(r.opened).toEqual([]);
    }
  });

  it('opens a Drive page in the browser', async () => {
    const r = await route('/api/drive/open', { method: 'POST', body: { url: 'https://drive.google.com/file/d/1/view' }, root: '' });
    expect(r.opened).toEqual(['https://drive.google.com/file/d/1/view']);
  });

  it('says Drive for desktop is missing when it is', async () => {
    const { base } = await fake();
    const gone = path.join(base, 'not-there');
    expect((await route('/api/drive/local', { root: gone })).body.available).toBe(false);
    expect((await route('/api/drive/files?source=local', { root: gone })).status).toBe(404);
  });

  it('only answers this PC', async () => {
    const { root } = await fake();
    expect((await route('/api/drive/files?source=local', { root, local: false })).status).toBe(403);
    expect((await route('/api/drive/open', { method: 'POST', body: { path: 'My Drive/old.pdf' }, root, local: false })).status).toBe(403);
  });

  it('asks to sign in when the cloud is wanted without being signed in', async () => {
    const r = await route('/api/drive/files?view=recent', { root: '' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('signin');
  });
});
