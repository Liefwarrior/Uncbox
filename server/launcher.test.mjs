import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  cleanTiles,
  collectShortcuts,
  createLauncher,
  iconCacheKey,
  launchCommand,
  launchTile,
  listShortcuts,
  parseLink,
  sameOrigin,
  validateTile,
} from './launcher.mjs';

/** A fake fs.stat over a small set of files and folders. */
const fakeStat = (files, folders = []) => async (p) => {
  if (files.includes(p)) return { isDirectory: () => false };
  if (folders.includes(p)) return { isDirectory: () => true };
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};

describe('parseLink', () => {
  it('allows http, https and steam only', () => {
    expect(parseLink('https://example.com/a?b=1', 'url')).toBe('https://example.com/a?b=1');
    expect(parseLink('http://example.com', 'url')).toBe('http://example.com/');
    expect(parseLink('steam://rungameid/570', 'url')).toBe('steam://rungameid/570');
    for (const bad of ['javascript:alert(1)', 'file:///C:/Windows/notepad.exe', 'ftp://example.com', 'data:text/html,hi', 'cmd:/c calc']) {
      expect(parseLink(bad, 'url')).toBeNull();
    }
  });

  it('adds https:// to a bare site name', () => {
    expect(parseLink('example.com', 'url')).toBe('https://example.com/');
  });

  it('turns a bare game number into a steam link, and only accepts steam:// for Steam tiles', () => {
    expect(parseLink('570', 'steam')).toBe('steam://rungameid/570');
    expect(parseLink('https://example.com', 'steam')).toBeNull();
  });

  it('refuses spaces and control characters', () => {
    expect(parseLink('https://example.com/a b', 'url')).toBeNull();
    expect(parseLink('https://exam\nple.com/', 'url')).toBeNull();
    expect(parseLink('', 'url')).toBeNull();
  });
});

describe('validateTile', () => {
  const exe = path.resolve('C:\\Games\\Game.exe');
  const folder = path.resolve('C:\\Games');
  const statFn = fakeStat([exe, path.resolve('C:\\notes.txt')], [folder]);

  it('accepts a path that exists', async () => {
    const r = await validateTile({ name: ' Game ', type: 'app', target: exe }, { statFn });
    expect(r.tile).toEqual({ name: 'Game', type: 'app', target: path.normalize(exe) });
  });

  it('strips the quotes from "Copy as path"', async () => {
    expect((await validateTile({ name: 'Game', type: 'app', target: `"${exe}"` }, { statFn })).tile.target).toBe(path.normalize(exe));
  });

  it('refuses a path that does not exist, or is not absolute', async () => {
    expect((await validateTile({ name: 'x', type: 'app', target: path.resolve('C:\\Nope\\x.exe') }, { statFn })).error).toMatch(/nothing/);
    expect((await validateTile({ name: 'x', type: 'app', target: 'Game.exe' }, { statFn })).error).toMatch(/full path/);
  });

  it('checks the kind against what is there', async () => {
    expect((await validateTile({ name: 'x', type: 'folder', target: exe }, { statFn })).error).toMatch(/isn’t a folder/);
    expect((await validateTile({ name: 'x', type: 'file', target: folder }, { statFn })).error).toMatch(/folder/);
    expect((await validateTile({ name: 'x', type: 'app', target: path.resolve('C:\\notes.txt') }, { statFn })).error).toMatch(/\.exe/);
    expect((await validateTile({ name: 'x', type: 'folder', target: folder }, { statFn })).tile.type).toBe('folder');
  });

  it('checks links, and never touches the disk for them', async () => {
    const stat = vi.fn();
    expect((await validateTile({ name: 'Site', type: 'url', target: 'https://example.com' }, { statFn: stat })).tile.target).toBe('https://example.com/');
    expect((await validateTile({ name: 'Bad', type: 'url', target: 'javascript:alert(1)' }, { statFn: stat })).error).toMatch(/http/);
    expect(stat).not.toHaveBeenCalled();
  });

  it('needs a name and a known kind', async () => {
    expect((await validateTile({ name: '  ', type: 'url', target: 'https://example.com' })).error).toMatch(/name/);
    expect((await validateTile({ name: 'x', type: 'shell', target: 'calc' })).error).toMatch(/kind/);
    expect((await validateTile(null)).error).toBeTruthy();
  });
});

describe('launching', () => {
  const tile = { id: 'tile-0123456789ab', name: 'Game', type: 'app', target: 'C:\\Games\\My Game & Co\\Game.exe' };

  it('hands the saved path to explorer as one argument, never through a shell', () => {
    expect(launchCommand(tile, 'win32')).toEqual(['explorer.exe', [tile.target]]);
    const child = { on: vi.fn(), unref: vi.fn() };
    const spawnFn = vi.fn(() => child);
    launchTile(tile, { spawnFn, platform: 'win32' });
    expect(spawnFn).toHaveBeenCalledWith('explorer.exe', [tile.target], expect.not.objectContaining({ shell: true }));
    expect(child.unref).toHaveBeenCalled();
  });

  it('opens links in the default handler instead', () => {
    const open = vi.fn();
    const spawnFn = vi.fn();
    launchTile({ ...tile, type: 'steam', target: 'steam://rungameid/570' }, { spawnFn, open, platform: 'win32' });
    expect(open).toHaveBeenCalledWith('steam://rungameid/570');
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

describe('the launch route', () => {
  /** Runs the route with a saved tile list, and reports what came back. */
  async function run(method, route, body, headers = {}) {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const os = await import('node:os');
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'uncbox-launcher-'));
    await writeFile(path.join(dataDir, 'launcher.json'), JSON.stringify({ tiles: [{ id: 'tile-0123456789ab', name: 'Site', type: 'url', target: 'https://example.com/' }] }));
    const out = {};
    const handle = createLauncher({
      dataDir,
      isLocal: () => true,
      sendJson: (res, status, data) => Object.assign(out, { status, data }),
      readJson: async () => body,
    });
    await handle({ method, headers, socket: {} }, {}, new URL(`http://x${route}`));
    return out;
  }

  it('refuses a path: it only takes the id of a saved tile', async () => {
    expect((await run('POST', '/api/launcher/launch', { id: 'C:\\Windows\\System32\\calc.exe' })).status).toBe(404);
    expect((await run('POST', '/api/launcher/launch', { path: 'C:\\Windows\\System32\\calc.exe' })).status).toBe(404);
    expect((await run('POST', '/api/launcher/launch', { id: 'tile-ffffffffffff' })).status).toBe(404);
  });

  it('turns away pages from other sites', async () => {
    const r = await run('GET', '/api/launcher/tiles', undefined, { origin: 'https://evil.example', host: 'localhost:3000' });
    expect(r.status).toBe(403);
    const ok = await run('GET', '/api/launcher/tiles', undefined, { origin: 'http://localhost:3000', host: 'localhost:3000' });
    expect(ok.status).toBe(200);
    expect(ok.data.tiles).toHaveLength(1);
  });

  it('rejects an invalid tile when saving', async () => {
    const r = await run('POST', '/api/launcher/tiles', { name: 'x', type: 'url', target: 'file:///C:/x' });
    expect(r.status).toBe(400);
  });
});

describe('sameOrigin', () => {
  it('lets requests with no Origin through and compares the host otherwise', () => {
    expect(sameOrigin({ headers: {} })).toBe(true);
    expect(sameOrigin({ headers: { origin: 'https://uncbox.example', host: 'uncbox.example' } })).toBe(true);
    expect(sameOrigin({ headers: { origin: 'https://other.example', host: 'uncbox.example' } })).toBe(false);
    expect(sameOrigin({ headers: { origin: 'not a url', host: 'uncbox.example' } })).toBe(false);
  });
});

describe('cleanTiles', () => {
  it('keeps well-formed tiles and drops the rest', () => {
    const good = { id: 'tile-0123456789ab', name: 'A', type: 'url', target: 'https://a.example/' };
    expect(cleanTiles([good, good, { ...good, id: 'x' }, { ...good, id: 'tile-aaaaaaaaaaaa', type: 'shell' }, null, 'junk'])).toEqual([good]);
    expect(cleanTiles('nope')).toEqual([]);
  });
});

describe('Start menu listing', () => {
  /** A fake readdir over a tree: { dir: [names ending in "/" are folders] }. */
  const tree = {
    root: ['Discord.lnk', 'Uninstall Thing.lnk', 'readme.txt', 'Games/', 'Empty/'],
    [path.join('root', 'Games')]: ['Steam.lnk', 'discord.lnk', 'Deep/'],
    [path.join('root', 'Games', 'Deep')]: ['Zed.LNK'],
    [path.join('root', 'Empty')]: [],
  };
  const readdirFn = async (dir) => {
    if (!tree[dir]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return tree[dir].map((n) => ({ name: n.replace(/\/$/, ''), isDirectory: () => n.endsWith('/') }));
  };

  it('finds shortcuts in subfolders, without uninstallers or other files', async () => {
    const found = await collectShortcuts('root', { readdirFn });
    expect(found.map((f) => f.name).sort()).toEqual(['Discord', 'Steam', 'Zed', 'discord']);
    expect(found.find((f) => f.name === 'Zed').path).toBe(path.join('root', 'Games', 'Deep', 'Zed.LNK'));
  });

  it('copes with a missing folder and limits how deep it goes', async () => {
    expect(await collectShortcuts('nowhere', { readdirFn })).toEqual([]);
    const shallow = await collectShortcuts('root', { readdirFn, depth: 0 });
    expect(shallow.map((f) => f.name)).toEqual(['Discord']);
  });

  it('merges folders, one entry per name, sorted and searchable', async () => {
    const a = await collectShortcuts('root', { readdirFn });
    const b = [{ name: 'Blender', path: 'C:\\b.lnk' }];
    expect(listShortcuts([a, b]).map((s) => s.name)).toEqual(['Blender', 'Discord', 'Steam', 'Zed']);
    expect(listShortcuts([a, b], ' STE ').map((s) => s.name)).toEqual(['Steam']);
  });
});

describe('iconCacheKey', () => {
  const base = { target: 'C:\\Games\\Game.exe', mtimeMs: 1700000000000, size: 1234 };

  it('is the same for the same file, whatever the case or slashes', () => {
    expect(iconCacheKey(base)).toBe(iconCacheKey({ ...base }));
    expect(iconCacheKey(base)).toBe(iconCacheKey({ ...base, target: 'c:/games/game.exe' }));
  });

  it('changes when the file changes, so a new version gets a new icon', () => {
    expect(iconCacheKey(base)).not.toBe(iconCacheKey({ ...base, mtimeMs: base.mtimeMs + 1000 }));
    expect(iconCacheKey(base)).not.toBe(iconCacheKey({ ...base, size: 9999 }));
    expect(iconCacheKey(base)).not.toBe(iconCacheKey({ ...base, target: 'C:\\Games\\Other.exe' }));
  });

  it('is safe to use as a file name', () => {
    expect(iconCacheKey(base)).toMatch(/^[0-9a-f]{24}$/);
  });
});
