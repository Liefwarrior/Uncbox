// WoW, for the WoW preset: finding the game and its addon, installing and updating the addon by
// itself, writing the settings it loads, and the guild and raid data it collects. Everything here
// is for this PC only.
//
//   GET  /api/wow/installs        every WoW install found: { installs: [{ flavor, label, path, dir, exes, … }] }
//   GET  /api/wow/status          the addons Uncbox ships and what each install has (see integrations/wow/install.mjs)
//   POST /api/wow/install         { path? } installs every shipped addon (into every install without a path)
//   POST /api/wow/uninstall       { path? } removes them, and stops the automatic install
//   POST /api/wow/auto            installs or updates by itself where needed; answers what it changed
//   POST /api/wow/reveal          opens the folder holding the addon
//   GET/POST /api/wow/settings    { settings, autoInstall, flavor }: what the addon collects (UncboxConfig.lua)
//   POST /api/wow/live            { messages: [{ kind, text }] } what the page read off the strip
//   GET  /api/wow/guild           roster plus counts (?officer=1 adds officer notes, ?former=1 past members)
//   GET  /api/wow/guild/events    ?since=<ms>&limit=&type= newest first
//   GET  /api/wow/guild/sessions  ?member=&since=&limit=
//   GET  /api/wow/guild/member    ?name= one member with rank history, sessions, loot, attendance
//   POST /api/wow/guild/reset     forget the guild (for someone who changed guilds)
//   GET  /api/wow/raid            the raid group now, and the raid going on
//   GET  /api/wow/raids           ?limit= history with bosses and who was there
//   GET  /api/wow/attendance      ?last=10 per member over the last raids
//   GET  /api/wow/loot            ?member=&since=<ms>&raid=&limit=
//   GET  /api/wow/readychecks     ?limit=
//   SSE  wowguild                 { at, what: ['guild', 'events', 'raid', 'raids', 'loot', 'readychecks'] } when any changed
//
// The database is data/wow.db (server/wowdb.mjs); the settings are data/wow.json.

import { existsSync, mkdirSync, watch as fsWatch } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  bundledAddons,
  ensure,
  findInstalls,
  install as installAddons,
  normalizeSettings,
  preferred,
  resolveRoots,
  reveal,
  status as addonStatus,
  uninstall as uninstallAddons,
  writeConfig,
} from '../integrations/wow/install.mjs';
import { parseSavedVariables } from '../integrations/wow/savedvars.mjs';
import { readJsonSafe, writeJsonAtomic } from './datafile.mjs';
import { noHelpers } from './switches.mjs';
import { createStore } from './wowdb.mjs';

const POLL_MS = 15_000;
const CHANGE_DELAY_MS = 200;
const READ_DELAY_MS = 750;
const ROOTS_TTL_MS = 30_000;
const MAX_LIVE_MESSAGES = 100;
const MAX_LIVE_TEXT = 12_000;

/** Whether the page is on the WoW preset (the built-in one, or a copy of it). */
export function isWowState(state) {
  if (!state || typeof state !== 'object') return false;
  if (state.preset === 'wow') return true;
  return Array.isArray(state.custom) && state.custom.some((c) => c?.id === state.preset && c.base === 'wow');
}

/** The first number in a query parameter, or the fallback. */
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : fallback);

export function createWow({
  broadcastEvent = () => {},
  sendJson,
  isLocal = () => true,
  readJson,
  dataDir,
  roots,
  helpers = !noHelpers(),
  pollMs = POLL_MS,
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  const settingsFile = path.join(dataDir, 'wow.json');
  const dbFile = path.join(dataDir, 'wow.db');

  // ---- settings ----
  let config = null;
  async function loadConfig() {
    if (config) return config;
    const saved = (await readJsonSafe(settingsFile, {})) ?? {};
    config = {
      autoInstall: saved.autoInstall !== false,
      flavor: typeof saved.flavor === 'string' ? saved.flavor : '',
      settings: normalizeSettings(saved.settings),
    };
    return config;
  }
  async function saveConfig() {
    await writeJsonAtomic(settingsFile, config, { pretty: true });
  }

  // ---- where WoW is ----
  let rootsCache = null;
  async function rootsNow() {
    if (roots) return typeof roots === 'function' ? roots() : roots;
    if (!rootsCache || Date.now() - rootsCache.at > ROOTS_TTL_MS) rootsCache = { at: Date.now(), list: await resolveRoots({ registry: helpers }) };
    return rootsCache.list;
  }

  // ---- the database ----
  let sqlite;
  let conn = null;
  let store = null;
  let opening = null;
  let memory = null;

  async function sqliteModule() {
    sqlite ??= await import('node:sqlite').catch(() => null);
    if (!sqlite) throw Object.assign(new Error('The guild link needs Node.js 22.5 or newer.'), { status: 501 });
    return sqlite;
  }

  /** The store on data/wow.db, made on first need. */
  function openStore() {
    if (store) return Promise.resolve(store);
    opening ??= (async () => {
      const { DatabaseSync } = await sqliteModule();
      mkdirSync(dataDir, { recursive: true });
      conn = new DatabaseSync(dbFile);
      conn.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
      store = createStore(conn, { now });
      return store;
    })().finally(() => (opening = null));
    return opening;
  }

  /** For reading: the real store, or an empty one when nothing has been collected yet (so a read never makes the file). */
  async function readStore() {
    if (store || existsSync(dbFile)) return openStore();
    if (!memory) {
      const { DatabaseSync } = await sqliteModule();
      memory = createStore(new DatabaseSync(':memory:'), { now });
    }
    return memory;
  }

  // ---- telling the page ----
  const topics = new Set();
  let announce = null;
  function changed(what) {
    if (!what.length) return;
    for (const t of what) topics.add(t);
    announce ??= setTimeout(() => {
      announce = null;
      const sent = [...topics];
      topics.clear();
      broadcastEvent('wowguild', { at: Date.now(), what: sent });
    }, CHANGE_DELAY_MS);
    announce.unref?.();
  }

  // ---- SavedVariables ----
  const link = { watching: false, files: [], readAt: 0, liveAt: 0, error: '', otherGuilds: [] };
  const watchers = new Map();
  const known = new Map();
  const pending = new Map();
  let poller = null;

  async function readSaved(file) {
    // A read that was already on its way when the watching stopped must not reopen anything.
    if (!started) return;
    let info;
    try {
      info = await stat(file);
    } catch {
      return;
    }
    const signature = `${info.mtimeMs}:${info.size}`;
    if (known.get(file) === signature) return;
    try {
      const sv = parseSavedVariables(await readFile(file, 'utf8'));
      if (!started) return;
      const s = await openStore();
      const result = s.ingestSaved(sv.UncboxDB);
      known.set(file, signature);
      link.readAt = Date.now();
      link.error = '';
      link.otherGuilds = result.otherGuilds;
      changed(result.changed);
    } catch (err) {
      // Most likely WoW was still writing it: the next change or poll tries again.
      link.error = err.message;
    }
  }

  function scheduleRead(file) {
    clearTimeout(pending.get(file));
    const t = setTimeout(() => {
      pending.delete(file);
      void readSaved(file);
    }, READ_DELAY_MS);
    t.unref?.();
    pending.set(file, t);
  }

  /** Looks for the SavedVariables files of the chosen install, watches their folders, and reads any that changed. */
  async function scan() {
    const cfg = await loadConfig();
    const best = preferred(await findInstalls(await rootsNow()), cfg.flavor);
    const accounts = best ? await readdir(path.join(best.dir, 'WTF', 'Account'), { withFileTypes: true }).catch(() => []) : [];
    const files = [];
    for (const a of accounts) {
      if (!a.isDirectory() || !started) continue;
      const dir = path.join(best.dir, 'WTF', 'Account', a.name, 'SavedVariables');
      const file = path.join(dir, 'Uncbox.lua');
      files.push(file);
      if (!watchers.has(dir) && existsSync(dir)) {
        try {
          const w = fsWatch(dir, { persistent: false }, (_, name) => {
            if (!name || String(name).toLowerCase() === 'uncbox.lua') scheduleRead(file);
          });
          w.on('error', () => {});
          watchers.set(dir, w);
        } catch {
          // The poll below still sees it.
        }
      }
      await readSaved(file);
    }
    link.files = files;
  }

  let started = false;
  /** Starts looking after WoW: installs the addon if wanted and follows SavedVariables. Safe to call again. */
  async function start() {
    if (started || !helpers) return;
    started = true;
    link.watching = true;
    try {
      await loadConfig();
      await autoSetup();
      await scan();
    } catch (err) {
      link.error = err.message;
    }
    if (!started) return;
    poller = setInterval(() => void scan().catch((err) => (link.error = err.message)), pollMs);
    poller.unref?.();
  }

  function stop() {
    started = false;
    link.watching = false;
    clearInterval(poller);
    poller = null;
    for (const w of watchers.values()) w.close();
    watchers.clear();
    for (const t of pending.values()) clearTimeout(t);
    pending.clear();
    known.clear();
  }

  /** Called with the saved state each time it changes: runs while the WoW preset is on, rests otherwise. */
  function noteState(state) {
    if (isWowState(state)) void start();
    else if (started) stop();
  }

  function close() {
    stop();
    clearTimeout(announce);
    try {
      conn?.close();
    } catch {
      // Already closed.
    }
    store = conn = null;
  }

  // ---- the addon ----
  /** What the server did on its own since the page last asked, so the page can say so. */
  const unannounced = [];

  async function autoSetup() {
    const cfg = await loadConfig();
    if (!helpers || !cfg.autoInstall) return [];
    const reports = await ensure({ roots: await rootsNow(), chosenPath: cfg.flavor, settings: cfg.settings });
    const did = reports.map((r) => ({ ...r, addons: r.addons.filter((a) => a.action !== 'current') })).filter((r) => r.addons.length);
    unannounced.push(...did);
    return did;
  }

  /** What the page needs to offer the other installs: those without the addon. */
  async function describe() {
    const cfg = await loadConfig();
    const st = await addonStatus(await rootsNow(), cfg.flavor);
    const guild = await readStore().then((s) => s.meta('guild') ?? '', () => '');
    return { ...st, autoInstall: cfg.autoInstall, flavor: cfg.flavor, settings: cfg.settings, link: { ...link, guild } };
  }

  async function settingsOut() {
    const cfg = await loadConfig();
    const installs = await findInstalls(await rootsNow());
    return {
      settings: cfg.settings,
      autoInstall: cfg.autoInstall,
      flavor: cfg.flavor,
      preferred: preferred(installs, cfg.flavor)?.path ?? null,
      installs: installs.map((i) => ({ flavor: i.flavor, label: i.label, path: i.path, exes: i.exes })),
    };
  }

  async function changeSettings(body) {
    const cfg = await loadConfig();
    const patch = body.settings && typeof body.settings === 'object' ? body.settings : {};
    cfg.settings = normalizeSettings({
      ...cfg.settings,
      ...patch,
      strip: { ...cfg.settings.strip, ...patch.strip },
      modules: { ...cfg.settings.modules, ...patch.modules },
    });
    if (typeof body.autoInstall === 'boolean') cfg.autoInstall = body.autoInstall;
    if (typeof body.flavor === 'string') {
      const installs = await findInstalls(await rootsNow());
      if (body.flavor && !installs.some((i) => i.path === body.flavor)) throw Object.assign(new Error('That isn’t a WoW install Uncbox found.'), { status: 400 });
      if (body.flavor !== cfg.flavor) {
        cfg.flavor = body.flavor;
        // The data now comes from another install's saved files.
        if (started) {
          stop();
          void start();
        }
      }
    }
    await saveConfig();
    // Written to every copy of the addon, taking effect at the next /reload.
    const written = await writeConfig(cfg.settings, undefined, await rootsNow());
    return { ...(await settingsOut()), written };
  }

  // ---- routes ----
  async function handle(req, res, url) {
    if (!isLocal(req)) return sendJson(res, 403, { error: 'Run this on the PC WoW is on.' });
    const route = url.pathname.slice('/api/wow'.length);
    const q = url.searchParams;
    try {
      if (req.method === 'GET') {
        if (route === '/installs') return sendJson(res, 200, { installs: await findInstalls(await rootsNow()) });
        if (route === '/status') return sendJson(res, 200, await describe());
        if (route === '/settings') return sendJson(res, 200, await settingsOut());
        const s = await readStore();
        if (route === '/guild') return sendJson(res, 200, s.guild({ officer: q.get('officer') === '1', former: q.get('former') === '1' }));
        if (route === '/guild/events') return sendJson(res, 200, s.events({ since: num(q.get('since')), limit: num(q.get('limit'), 100), type: q.get('type') ?? '' }));
        if (route === '/guild/sessions') return sendJson(res, 200, s.sessions({ member: q.get('member') ?? '', since: num(q.get('since')), limit: num(q.get('limit'), 100) }));
        if (route === '/guild/member') {
          const m = s.member(q.get('name') ?? '', { officer: q.get('officer') === '1' });
          return m ? sendJson(res, 200, m) : sendJson(res, 404, { error: 'No such member' });
        }
        if (route === '/raid') return sendJson(res, 200, s.raid());
        if (route === '/raids') return sendJson(res, 200, s.raids({ limit: num(q.get('limit'), 20) }));
        if (route === '/attendance') return sendJson(res, 200, s.attendance({ last: num(q.get('last'), 10) }));
        if (route === '/loot') return sendJson(res, 200, s.loot({ member: q.get('member') ?? '', since: num(q.get('since')), raid: num(q.get('raid')), limit: num(q.get('limit'), 100) }));
        if (route === '/readychecks') return sendJson(res, 200, s.readyChecks({ limit: num(q.get('limit'), 20) }));
        return sendJson(res, 404, { error: 'Not found' });
      }
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });

      if (route === '/live') {
        const body = await readJson(req);
        const list = Array.isArray(body.messages) ? body.messages : [];
        if (list.length > MAX_LIVE_MESSAGES) return sendJson(res, 413, { error: 'Too many messages' });
        const messages = list.filter((m) => Number.isInteger(m?.kind) && typeof m.text === 'string' && m.text.length <= MAX_LIVE_TEXT);
        const s = await openStore();
        link.liveAt = Date.now();
        changed(s.ingestLive(messages));
        return sendJson(res, 200, { ok: true, accepted: messages.length });
      }
      if (route === '/guild/reset') {
        (await openStore()).resetGuild();
        changed(['guild', 'events']);
        return sendJson(res, 200, { ok: true });
      }
      if (route === '/settings') return sendJson(res, 200, { ok: true, ...(await changeSettings(await readJson(req))) });
      if (route === '/reveal') {
        reveal();
        return sendJson(res, 200, { ok: true });
      }
      if (route === '/install' || route === '/uninstall') {
        const body = await readJson(req);
        const cfg = await loadConfig();
        const where = typeof body.path === 'string' ? body.path : undefined;
        const list = await rootsNow();
        let reports;
        try {
          reports = route === '/install' ? await installAddons(where, list, { settings: cfg.settings }) : await uninstallAddons(where, list);
        } catch (err) {
          return sendJson(res, err.status || 500, { error: err.status ? err.message : `Couldn’t ${route === '/install' ? 'install' : 'remove'} the addon: ${err.message}` });
        }
        // Asking for it, or removing it, is the player's say: the automatic install follows that.
        const want = route === '/install';
        // And what it installed on its own and was never announced is no longer news.
        if (!want) unannounced.length = 0;
        if (cfg.autoInstall !== want) {
          cfg.autoInstall = want;
          await saveConfig();
        }
        return sendJson(res, 200, { ok: true, paths: reports.map((r) => r.path), reports });
      }
      if (route === '/auto') {
        await loadConfig();
        if (helpers) await autoSetup();
        // Changes made while the page wasn't asking (at server start) come with this answer, once.
        const mine = unannounced.splice(0);
        return sendJson(res, 200, { ok: true, disabled: !helpers || !config.autoInstall, changed: mine, ...(await describe()) });
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.status ? err.message : `WoW: ${err.message}` });
    }
  }

  // The plain functions the tests and index.mjs use.
  handle.start = start;
  handle.stop = stop;
  handle.close = close;
  handle.noteState = noteState;
  handle.store = openStore;
  handle.scan = scan;
  handle.autoSetup = autoSetup;
  handle.bundled = bundledAddons;
  return handle;
}
