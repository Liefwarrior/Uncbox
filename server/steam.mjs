// Steam, read from the Steam client's own files on this PC: no account, key or sign-in. What's
// running (the registry value Steam keeps current), your name and picture, playtime, recent games,
// and achievements for the game you're playing. Pushed as a "steam" event when it changes.
//
//   GET /api/steam                    the snapshot below
//   GET /api/steam/avatar             your Steam picture
//   GET /api/steam/art/<appid>/<file> a game's art (header.jpg, library_hero.jpg, library_600x900.jpg,
//                                     logo.png) from Steam's cache, or Steam's CDN if it isn't cached

import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const POLL_MS = 3000;
const RECENT = 8;
const STEAM_ID_BASE = 76561197960265728n;
const ART = new Set(['header.jpg', 'library_hero.jpg', 'library_600x900.jpg', 'logo.png']);

/** Valve's text KeyValues ("key" "value" / "key" { … }), as nested objects. Exported for tests. */
export function parseVdf(text) {
  const root = {};
  const stack = [root];
  const re = /"((?:[^"\\]|\\.)*)"|([{}])/g;
  let key = null;
  for (let m; (m = re.exec(text)); ) {
    const top = stack[stack.length - 1];
    if (m[2] === '{') {
      const child = {};
      if (key !== null) top[key] = child;
      stack.push(child);
      key = null;
    } else if (m[2] === '}') {
      stack.pop();
      key = null;
    } else if (key === null) key = m[1];
    else {
      top[key] = m[1].replace(/\\(.)/g, '$1');
      key = null;
    }
  }
  return root;
}

/** Valve's binary KeyValues (the appcache/stats files), as nested objects. Exported for tests. */
export function parseBinaryVdf(buf) {
  let i = 0;
  const str = () => {
    const end = buf.indexOf(0, i);
    const s = buf.toString('utf8', i, end);
    i = end + 1;
    return s;
  };
  const obj = () => {
    const o = {};
    while (i < buf.length) {
      const t = buf[i++];
      if (t === 8 || t === 11) return o;
      const k = str();
      if (t === 0) o[k] = obj();
      else if (t === 1) o[k] = str();
      else if (t === 2) (o[k] = buf.readInt32LE(i)), (i += 4);
      else if (t === 3) (o[k] = buf.readFloatLE(i)), (i += 4);
      else if (t === 7 || t === 10) (o[k] = Number(buf.readBigInt64LE(i))), (i += 8);
      else throw new Error(`Unknown KeyValues type ${t}`);
    }
    return o;
  };
  return obj();
}

/** Case-insensitive lookup through nested keys, since Steam isn't consistent ("apps" vs "Apps"). */
function dig(o, ...keys) {
  for (const k of keys) {
    if (!o || typeof o !== 'object') return undefined;
    const hit = Object.keys(o).find((x) => x.toLowerCase() === k.toLowerCase());
    o = hit === undefined ? undefined : o[hit];
  }
  return o;
}

/**
 * Achievements from a game's schema and your stats file: how many of how many, and the latest.
 * Exported for tests.
 */
export function achievements(schema, user) {
  const stats = dig(Object.values(schema)[0], 'stats') ?? {};
  const cache = dig(user, 'cache') ?? {};
  let total = 0;
  let unlocked = 0;
  let latest = null;
  for (const [statId, stat] of Object.entries(stats)) {
    const bits = dig(stat, 'bits');
    if (!bits) continue;
    const mine = cache[statId] ?? {};
    const data = Number(mine.data ?? 0);
    const times = dig(mine, 'AchievementTimes') ?? {};
    for (const [bit, a] of Object.entries(bits)) {
      total++;
      if (!((data >>> Number(bit)) & 1)) continue;
      unlocked++;
      const at = Number(times[bit] ?? 0) * 1000;
      if (!latest || at > latest.at) {
        latest = {
          name: dig(a, 'display', 'name', 'english') ?? dig(a, 'name') ?? '',
          description: dig(a, 'display', 'desc', 'english') ?? '',
          icon: dig(a, 'display', 'icon') ?? '',
          at,
        };
      }
    }
  }
  return total ? { unlocked, total, latest } : null;
}

function reg(key, value) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, ...(value ? ['/v', value] : ['/s', '/v', 'Name'])], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) =>
      resolve(err ? '' : out),
    );
  });
}

export function createSteam({ broadcastEvent, sendJson }) {
  let root = null;
  let names = new Map();
  let user = null;
  let localConfig = { mtime: 0, apps: {} };
  let running = { appid: 0, since: 0 };
  let snap = { available: false };
  let polling = null;

  async function findSteam() {
    if (process.platform !== 'win32') return null;
    const out = await reg('HKCU\\Software\\Valve\\Steam', 'SteamPath');
    const m = /SteamPath\s+REG_SZ\s+(.+)/.exec(out);
    return m ? path.normalize(m[1].trim()) : null;
  }

  /** Every game Steam knows the name of, from the registry (one call, refreshed for new ones). */
  async function loadNames() {
    const out = await reg('HKCU\\Software\\Valve\\Steam\\Apps');
    const map = new Map();
    let id = 0;
    for (const line of out.split(/\r?\n/)) {
      const key = /\\Apps\\(\d+)$/.exec(line.trim());
      if (key) id = Number(key[1]);
      const name = /^\s+Name\s+REG_SZ\s+(.+)$/.exec(line);
      if (name && id) map.set(id, name[1].trim());
    }
    names = map;
  }

  /**
   * Steam only keeps names in the registry for installed games, so others are looked up once in
   * the Steam store and remembered.
   */
  const asked = new Set();
  async function storeName(appid) {
    if (asked.has(appid)) return;
    asked.add(appid);
    try {
      const r = await fetch(`https://store.steampowered.com/api/appdetails?filters=basic&appids=${appid}`, { signal: AbortSignal.timeout(5000) });
      const name = (await r.json())?.[appid]?.data?.name;
      if (name) names.set(appid, name);
    } catch {
      // Offline: the panel shows the game without its name.
    }
  }

  async function loadUser() {
    const users = dig(parseVdf(await readFile(path.join(root, 'config', 'loginusers.vdf'), 'utf8')), 'users') ?? {};
    const entries = Object.entries(users);
    const [id64, info] = entries.find(([, u]) => u.MostRecent === '1') ?? entries[0] ?? [];
    if (!id64) return null;
    return { id64, account: String(BigInt(id64) - STEAM_ID_BASE), name: info.PersonaName ?? '' };
  }

  async function loadLocalConfig() {
    const file = path.join(root, 'userdata', user.account, 'config', 'localconfig.vdf');
    const info = await stat(file).catch(() => null);
    if (!info || info.mtimeMs === localConfig.mtime) return;
    const apps = dig(parseVdf(await readFile(file, 'utf8')), 'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps') ?? {};
    localConfig = { mtime: info.mtimeMs, apps };
  }

  async function loadAchievements(appid) {
    const dir = path.join(root, 'appcache', 'stats');
    try {
      const [schema, mine] = await Promise.all([
        readFile(path.join(dir, `UserGameStatsSchema_${appid}.bin`)),
        readFile(path.join(dir, `UserGameStats_${user.account}_${appid}.bin`)).catch(() => Buffer.from([8])),
      ]);
      return achievements(parseBinaryVdf(schema), parseBinaryVdf(mine));
    } catch {
      return null;
    }
  }

  const game = (appid) => {
    const c = localConfig.apps[appid] ?? {};
    return { appid, name: names.get(appid) ?? '', lastPlayed: Number(c.LastPlayed ?? 0) * 1000, playtime: Number(c.Playtime ?? 0) };
  };

  async function refresh() {
    root ??= await findSteam();
    if (!root) return { available: false };
    user ??= await loadUser().catch(() => null);
    if (!user) return { available: false };
    const out = await reg('HKCU\\Software\\Valve\\Steam', 'RunningAppID');
    const hex = /RunningAppID\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out)?.[1];
    const appid = hex ? parseInt(hex, 16) : 0;
    if (appid !== running.appid) running = { appid, since: appid ? Date.now() : 0 };
    if (appid && !names.has(appid)) await loadNames();
    if (appid && !names.has(appid)) await storeName(appid);
    await loadLocalConfig();
    const recent = Object.keys(localConfig.apps)
      .map(Number)
      .filter((id) => id && names.has(id))
      .map(game)
      .filter((g) => g.lastPlayed)
      .sort((a, b) => b.lastPlayed - a.lastPlayed)
      .slice(0, RECENT);
    return {
      available: true,
      user: { name: user.name },
      playing: appid ? { ...game(appid), since: running.since, achievements: await loadAchievements(appid) } : null,
      recent,
    };
  }

  async function poll() {
    try {
      const next = await refresh();
      if (JSON.stringify(next) !== JSON.stringify(snap)) {
        snap = next;
        broadcastEvent('steam', snap);
      }
    } catch (err) {
      console.warn('Uncbox: reading Steam failed:', err.message);
    }
  }

  async function sendFile(res, file, type) {
    const info = await stat(file).catch(() => null);
    if (!info) return false;
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size, 'Cache-Control': 'max-age=3600' });
    createReadStream(file).pipe(res);
    return true;
  }

  return async function handle(req, res, url) {
    try {
      if (!polling) {
        // Names load once up front; after that, only new games trigger another look.
        await findSteam().then((r) => (root = r));
        if (root) await loadNames();
        await poll();
        polling = setInterval(poll, POLL_MS);
      }
      if (url.pathname === '/api/steam') return sendJson(res, 200, snap);
      if (url.pathname === '/api/steam/avatar') {
        if (root && user && (await sendFile(res, path.join(root, 'config', 'avatarcache', `${user.id64}.png`), 'image/png'))) return;
        return sendJson(res, 404, { error: 'No picture' });
      }
      const art = /^\/api\/steam\/art\/(\d+)\/([\w.]+)$/.exec(url.pathname);
      if (art && ART.has(art[2])) {
        const [, appid, file] = art;
        const type = file.endsWith('.png') ? 'image/png' : 'image/jpeg';
        if (root && (await sendFile(res, path.join(root, 'appcache', 'librarycache', appid, file), type))) return;
        res.writeHead(302, { Location: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/${file}` });
        return void res.end();
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      return sendJson(res, 500, { error: err.message || 'Steam error' });
    }
  };
}
