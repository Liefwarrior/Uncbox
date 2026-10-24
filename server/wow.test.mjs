import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { World } from '../integrations/wow/addonWorld';
import { parseSavedVariables } from '../integrations/wow/savedvars.mjs';
import { createWow, isWowState } from './wow.mjs';

let dir;
let data;
let root;
let wow;
let server;
let base;
let events;

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readJson = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
};

/** Closes the server, dropping the keep-alive connections fetch leaves open. */
async function stopServer() {
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await closed;
}

async function boot(options = {}, { local = true } = {}) {
  wow = createWow({
    broadcastEvent: (name, payload) => events.push([name, payload]),
    sendJson,
    isLocal: () => local,
    readJson,
    dataDir: data,
    roots: [root],
    helpers: true,
    pollMs: 40,
    ...options,
  });
  server = http.createServer((req, res) => {
    void wow(req, res, new URL(req.url, 'http://localhost')).catch((err) => sendJson(res, 500, { error: err.message }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}
const get = async (p) => {
  const r = await fetch(base + p);
  return { status: r.status, json: await r.json() };
};
const post = async (p, body = {}) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
async function until(check, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const touch = async (...parts) => {
  await mkdir(path.dirname(path.join(...parts)), { recursive: true });
  await writeFile(path.join(...parts), '');
};
const addOns = (flavor) => path.join(root, flavor, 'Interface', 'AddOns');
const svFile = (flavor) => path.join(root, flavor, 'WTF', 'Account', 'ACCOUNT', 'SavedVariables', 'Uncbox.lua');

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'uncbox-wowsrv-'));
  data = path.join(dir, 'data');
  root = path.join(dir, 'World of Warcraft');
  events = [];
  await touch(root, '_classic_era_', 'WowClassic.exe');
  await touch(root, '_classic_beta_', 'WowB.exe');
});
afterEach(async () => {
  wow?.close();
  if (server) await stopServer();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  server = wow = null;
}, 30_000);

/** A small guild and raid, as the addon would save it. */
function savedVariables(level = 60) {
  const w = new World();
  w.run(`
    __world.guild = { name = "Night's Watch", motd = "Raid Tuesday", info = "", ranks = { "Guild Master", "Raider" }, members = {
      { name = "Lief", rank = "Guild Master", rankIndex = 0, level = ${level}, classFile = "DRUID", zone = "Orgrimmar", online = true },
      { name = "Bumta", rank = "Raider", rankIndex = 1, level = 59, classFile = "WARRIOR", zone = "Orgrimmar", online = false, ago = { 0, 0, 1, 0 } },
    } }
  `);
  w.login();
  w.advance(5);
  return w.savedVariables();
}

describe('the WoW preset', () => {
  it('is on for the built-in preset and for copies of it', () => {
    expect(isWowState({ preset: 'wow' })).toBe(true);
    expect(isWowState({ preset: 'custom-1', custom: [{ id: 'custom-1', base: 'wow' }] })).toBe(true);
    expect(isWowState({ preset: 'custom-1', custom: [{ id: 'custom-1', base: 'smite2' }] })).toBe(false);
    expect(isWowState({ preset: 'smite2' })).toBe(false);
    expect(isWowState(null)).toBe(false);
  });
});

describe('answering before anything is collected', () => {
  it('says there is nothing yet, without making the database', async () => {
    await boot();
    expect((await get('/api/wow/guild')).json).toMatchObject({ available: false, members: [], counts: { total: 0 } });
    expect((await get('/api/wow/guild/events')).json).toEqual({ events: [] });
    expect((await get('/api/wow/raid')).json).toMatchObject({ inRaid: false, members: [], raid: null });
    expect((await get('/api/wow/raids')).json).toEqual({ raids: [] });
    expect((await get('/api/wow/attendance')).json).toMatchObject({ raids: 0, members: [] });
    expect((await get('/api/wow/loot')).json).toEqual({ loot: [] });
    expect((await get('/api/wow/readychecks')).json).toEqual({ readyChecks: [] });
    expect((await get('/api/wow/guild/sessions')).json).toEqual({ sessions: [] });
    expect((await get('/api/wow/guild/member?name=Lief')).status).toBe(404);
    expect(existsSync(path.join(data, 'wow.db'))).toBe(false);
  });

  it('only answers this PC, and only things it knows', async () => {
    await boot({}, { local: false });
    expect((await get('/api/wow/guild')).status).toBe(403);
    expect((await post('/api/wow/live', { messages: [] })).status).toBe(403);
    expect((await get('/api/wow/status')).status).toBe(403);
    await wow.close();
    await stopServer();
    await boot();
    expect((await get('/api/wow/nothing')).status).toBe(404);
    expect((await post('/api/wow/nothing')).status).toBe(404);
    expect((await fetch(`${base}/api/wow/guild`, { method: 'DELETE' })).status).toBe(405);
  });
});

describe('what the page reads off the strip', () => {
  it('goes into the database, and the page hears about it once', async () => {
    await boot();
    const events5 = ['join', '1760000000', 'Newbie', '', ''].join('\x1f');
    const r = await post('/api/wow/live', { messages: [{ kind: 5, text: events5 }, { kind: 5, text: events5 }, { kind: 'x' }, null] });
    expect(r.json).toEqual({ ok: true, accepted: 2 });
    expect((await get('/api/wow/guild/events')).json.events).toMatchObject([{ type: 'join', name: 'Newbie', at: 1760000000000 }]);
    expect((await get('/api/wow/guild?former=1')).json.members.map((m) => m.name)).toEqual(['Newbie']);
    expect(existsSync(path.join(data, 'wow.db'))).toBe(true);
    await until(() => events.length > 0);
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe('wowguild');
    expect(events[0][1].what).toEqual(expect.arrayContaining(['guild', 'events']));
    // The same news again changes nothing, so says nothing.
    await post('/api/wow/live', { messages: [{ kind: 5, text: events5 }] });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(events).toHaveLength(1);
  });

  it('refuses too many at once', async () => {
    await boot();
    const messages = Array.from({ length: 101 }, () => ({ kind: 5, text: 'x' }));
    expect((await post('/api/wow/live', { messages })).status).toBe(413);
    expect((await post('/api/wow/live', { messages: 'nope' })).json).toEqual({ ok: true, accepted: 0 });
  });

  it('answers the guild routes with the filters they take', async () => {
    await boot();
    const t = 1760000000;
    const text = [['on', t, 'A', '', ''], ['off', t + 60, 'A', '', ''], ['on', t + 120, 'B', '', '']].map((e) => e.join('\x1f')).join('\x1e');
    await post('/api/wow/live', { messages: [{ kind: 5, text }] });
    expect((await get(`/api/wow/guild/events?since=${(t + 30) * 1000}&limit=1`)).json.events.map((e) => e.name)).toEqual(['B']);
    expect((await get('/api/wow/guild/events?type=off')).json.events).toHaveLength(1);
    expect((await get('/api/wow/guild/sessions?member=A')).json.sessions).toEqual([{ name: 'A', start: t * 1000, end: (t + 60) * 1000 }]);
    expect((await get('/api/wow/loot?member=Nobody&since=zzz&limit=oops')).json).toEqual({ loot: [] });
    const reset = await post('/api/wow/guild/reset');
    expect(reset.json).toEqual({ ok: true });
    expect((await get('/api/wow/guild/events')).json.events).toEqual([]);
  });
});

describe('following SavedVariables', () => {
  it('reads the saved file when it appears and again when WoW rewrites it', async () => {
    await touch(root, '_classic_beta_', 'WTF', 'Account', 'ACCOUNT', 'SavedVariables', 'other.lua');
    await boot();
    await wow.start();
    expect((await get('/api/wow/guild')).json.available).toBe(false);

    await writeFile(svFile('_classic_beta_'), savedVariables(58));
    const first = await until(async () => {
      const g = (await get('/api/wow/guild')).json;
      return g.available && g;
    });
    expect(first.guild).toMatchObject({ name: "Night's Watch", motd: 'Raid Tuesday' });
    expect(first.members.map((m) => [m.name, m.level])).toEqual([['Lief', 58], ['Bumta', 59]]);
    await until(() => events.some(([name]) => name === 'wowguild'));
    expect((await get('/api/wow/status')).json.link).toMatchObject({ watching: true, guild: "Night's Watch", files: [svFile('_classic_beta_')] });

    // WoW saves again, on /reload.
    await writeFile(svFile('_classic_beta_'), savedVariables(60));
    await until(async () => (await get('/api/wow/guild')).json.members[0].level === 60);
  });

  it('does not stumble over a half-written file, and reads it once it is whole', async () => {
    await boot();
    await wow.start();
    const text = savedVariables();
    await mkdir(path.dirname(svFile('_classic_beta_')), { recursive: true });
    await writeFile(svFile('_classic_beta_'), text.slice(0, text.length / 2));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await get('/api/wow/guild')).json.available).toBe(false);
    expect((await get('/api/wow/status')).json.link.error).toMatch(/./);
    await writeFile(svFile('_classic_beta_'), text);
    await until(async () => (await get('/api/wow/guild')).json.available);
    expect((await get('/api/wow/status')).json.link.error).toBe('');
  });

  it('follows the install the player picked, not the preferred one', async () => {
    await mkdir(path.dirname(svFile('_classic_era_')), { recursive: true });
    await writeFile(svFile('_classic_era_'), savedVariables(57));
    await boot();
    await wow.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    // WoW Forever is preferred and has no saved file yet.
    expect((await get('/api/wow/guild')).json.available).toBe(false);
    expect((await post('/api/wow/settings', { flavor: addOns('_classic_era_') })).status).toBe(200);
    await until(async () => (await get('/api/wow/guild')).json.available);
    expect((await get('/api/wow/guild')).json.members[0].level).toBe(57);
  });

  it('rests while the WoW preset is off', async () => {
    await boot();
    wow.noteState({ preset: 'smite2' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await get('/api/wow/status')).json.link.watching).toBe(false);
    wow.noteState({ preset: 'wow' });
    await until(async () => (await get('/api/wow/status')).json.link.watching);
    wow.noteState({ preset: 'smite2' });
    expect((await get('/api/wow/status')).json.link.watching).toBe(false);
  });
});

describe('the addon, by itself', () => {
  it('is installed when the WoW preset starts, in the preferred install only', async () => {
    await boot();
    await wow.start();
    expect(existsSync(path.join(addOns('_classic_beta_'), 'Uncbox', 'Uncbox.toc'))).toBe(true);
    expect(existsSync(path.join(addOns('_classic_era_'), 'Uncbox'))).toBe(false);
    // The settings file is there too.
    const config = parseSavedVariables(await readFile(path.join(addOns('_classic_beta_'), 'Uncbox', 'UncboxConfig.lua'), 'utf8')).UncboxConfig;
    expect(config.modules.guild).toBe(true);

    // The page asks when it opens, and is told what happened while it wasn't looking, once.
    const first = (await post('/api/wow/auto')).json;
    expect(first.changed).toHaveLength(1);
    expect(first.changed[0].flavor).toBe('_classic_beta_');
    expect(first.changed[0].addons.find((a) => a.name === 'Uncbox').action).toBe('installed');
    expect(first.installs.map((i) => [i.flavor, i.version !== null]).sort()).toEqual([['_classic_beta_', true], ['_classic_era_', false]]);
    expect(first.preferred).toBe(addOns('_classic_beta_'));
    const second = (await post('/api/wow/auto')).json;
    expect(second.changed).toEqual([]);
  });

  it('is updated when its version differs, and told to the page', async () => {
    await boot();
    await post('/api/wow/install', { path: addOns('_classic_beta_') });
    await writeFile(path.join(addOns('_classic_beta_'), 'Uncbox', 'Uncbox.toc'), '## Version: 0.0.1\n');
    const r = (await post('/api/wow/auto')).json;
    expect(r.changed).toHaveLength(1);
    expect(r.changed[0].addons).toEqual([expect.objectContaining({ name: 'Uncbox', action: 'updated', from: '0.0.1' })]);
  });

  it('stays removed once the player removed it', async () => {
    await boot();
    await wow.start();
    const removed = await post('/api/wow/uninstall', { path: addOns('_classic_beta_') });
    expect(removed.json).toMatchObject({ ok: true, paths: [addOns('_classic_beta_')], reports: [{ addons: expect.arrayContaining([expect.objectContaining({ name: 'Uncbox', action: 'removed' })]) }] });
    expect(existsSync(path.join(addOns('_classic_beta_'), 'Uncbox'))).toBe(false);
    const again = (await post('/api/wow/auto')).json;
    expect(again).toMatchObject({ disabled: true, changed: [], autoInstall: false });
    expect(existsSync(path.join(addOns('_classic_beta_'), 'Uncbox'))).toBe(false);
    // A restart doesn't bring it back either: the choice is saved.
    wow.close();
    await stopServer();
    await boot();
    await wow.start();
    expect(existsSync(path.join(addOns('_classic_beta_'), 'Uncbox'))).toBe(false);
    // Installing it by hand turns the automatic install back on.
    await post('/api/wow/install', { path: addOns('_classic_era_') });
    expect((await get('/api/wow/settings')).json.autoInstall).toBe(true);
    expect(existsSync(path.join(addOns('_classic_era_'), 'Uncbox'))).toBe(true);
  });

  it('never touches a folder it did not find', async () => {
    await boot();
    const elsewhere = path.join(dir, 'elsewhere', 'Interface', 'AddOns');
    await mkdir(path.join(elsewhere, 'Uncbox'), { recursive: true });
    await writeFile(path.join(elsewhere, 'Uncbox', 'Uncbox.toc'), '## Version: 0.0.1\n');
    expect((await post('/api/wow/install', { path: elsewhere })).status).toBe(400);
    expect((await post('/api/wow/uninstall', { path: elsewhere })).status).toBe(400);
    expect((await post('/api/wow/settings', { flavor: elsewhere })).status).toBe(400);
    expect(await readFile(path.join(elsewhere, 'Uncbox', 'Uncbox.toc'), 'utf8')).toBe('## Version: 0.0.1\n');
  });

  it('does nothing on its own when helpers are off (a test run, or a PC without WoW)', async () => {
    await boot({ helpers: false });
    await wow.start();
    const r = (await post('/api/wow/auto')).json;
    expect(r).toMatchObject({ disabled: true, changed: [] });
    expect(existsSync(path.join(addOns('_classic_beta_'), 'Uncbox'))).toBe(false);
    // Reading what is there still works, and asking for an install is still honoured.
    expect((await get('/api/wow/installs')).json.installs.map((i) => i.flavor).sort()).toEqual(['_classic_beta_', '_classic_era_']);
    expect((await post('/api/wow/install', { path: addOns('_classic_era_') })).json.ok).toBe(true);
  });

  it('reports each shipped addon and each install in the status', async () => {
    await boot();
    await post('/api/wow/install', { path: addOns('_classic_era_') });
    const st = (await get('/api/wow/status')).json;
    expect(st.bundled).toMatch(/^\d+\.\d+\.\d+$/);
    expect(st.addons).toMatchObject({ Uncbox: st.bundled });
    const era = st.installs.find((i) => i.flavor === '_classic_era_');
    expect(era).toMatchObject({ label: 'Classic Era', version: st.bundled, addons: { Uncbox: st.bundled }, exes: ['WowClassic.exe'] });
    expect(st.installs.find((i) => i.flavor === '_classic_beta_')).toMatchObject({ label: 'WoW Forever (beta)', version: null });
    expect(st.preferred).toBe(addOns('_classic_beta_'));
  });
});

describe('the settings file', () => {
  it('is written for the addon whenever the settings change', async () => {
    await boot();
    await post('/api/wow/install', { path: addOns('_classic_beta_') });
    const r = await post('/api/wow/settings', { settings: { strip: { corner: 'TOPRIGHT' }, modules: { loot: false, guild: false } }, autoInstall: true });
    expect(r.json).toMatchObject({ ok: true, settings: { strip: { enabled: true, corner: 'TOPRIGHT' }, modules: { loot: false, guild: false, raid: true } }, written: [path.join(addOns('_classic_beta_'), 'Uncbox', 'UncboxConfig.lua')] });
    const written = parseSavedVariables(await readFile(path.join(addOns('_classic_beta_'), 'Uncbox', 'UncboxConfig.lua'), 'utf8')).UncboxConfig;
    expect(written).toMatchObject({ strip: { corner: 'TOPRIGHT' }, modules: { loot: false, guild: false, raid: true } });
    // Kept across restarts, and one setting at a time.
    wow.close();
    await stopServer();
    await boot();
    await post('/api/wow/settings', { settings: { modules: { loot: true } } });
    const now = (await get('/api/wow/settings')).json;
    expect(now.settings).toMatchObject({ strip: { corner: 'TOPRIGHT' }, modules: { loot: true, guild: false } });
    expect(now.installs.map((i) => i.flavor).sort()).toEqual(['_classic_beta_', '_classic_era_']);
    expect(JSON.parse(await readFile(path.join(data, 'wow.json'), 'utf8')).settings.strip.corner).toBe('TOPRIGHT');
  });

  it('turns junk into settings that are valid', async () => {
    await boot();
    const r = await post('/api/wow/settings', { settings: { strip: { corner: 'MIDDLE', enabled: 3 }, modules: { guild: 'yes' }, lootMinQuality: 99 } });
    expect(r.json.settings).toEqual({
      strip: { enabled: true, corner: 'TOPLEFT' },
      modules: { character: true, quests: true, party: true, guild: true, raid: true, loot: true },
      lootMinQuality: 2,
    });
  });
});

describe('raids and loot over the API', () => {
  it('gives the raid group and history in the shapes the widgets use', async () => {
    await boot();
    const world = new World();
    world.run(`
      __world.raid = { { name = "Lief", rank = 2, subgroup = 1, level = 60, class = "DRUID" }, { name = "Bumta", subgroup = 2, level = 60, class = "WARRIOR", role = "MAINTANK" } }
      __world.instance = { name = "Molten Core", kind = "raid", maxPlayers = 40, id = 409 }
    `);
    world.login();
    const sent = [...world.messages(20)];
    world.fire('ENCOUNTER_START', 663, 'Lucifron', 9, 40);
    world.advance(30);
    world.fire('ENCOUNTER_END', 663, 'Lucifron', 9, 40, 1);
    world.fire('CHAT_MSG_LOOT', 'Bumta receives loot: |cffa335ee|Hitem:16922::::::::60:::::|h[Leggings of Transcendence]|h|r.');
    sent.push(...world.messages(10));
    await post('/api/wow/live', { messages: sent.filter((m) => m.kind >= 4) });

    const raid = (await get('/api/wow/raid')).json;
    expect(raid).toMatchObject({
      inRaid: true,
      size: 2,
      counts: { online: 2, dead: 0, byClass: { DRUID: 1, WARRIOR: 1 } },
      raid: { zone: 'Molten Core', size: 40, endedAt: null, kills: 1, bosses: [{ name: 'Lucifron', success: true }] },
    });
    expect(raid.members).toEqual([
      { name: 'Lief', class: 'DRUID', level: 60, subgroup: 1, rank: 'leader', role: '', online: true, dead: false, zone: 'Molten Core', masterLooter: false },
      { name: 'Bumta', class: 'WARRIOR', level: 60, subgroup: 2, rank: 'member', role: 'tank', online: true, dead: false, zone: 'Molten Core', masterLooter: false },
    ]);
    const raids = (await get('/api/wow/raids?limit=5')).json.raids;
    expect(raids).toHaveLength(1);
    expect(raids[0].attendees.map((a) => [a.name, a.pct])).toEqual([['Bumta', 100], ['Lief', 100]]);
    expect((await get('/api/wow/loot?member=bumta')).json.loot).toMatchObject([{ who: 'Bumta', name: 'Leggings of Transcendence', quality: 4, boss: 'Lucifron', raidId: raids[0].id }]);
    expect((await get('/api/wow/attendance?last=5')).json).toMatchObject({ raids: 1, members: [{ name: 'Bumta', pct: 100 }, { name: 'Lief', pct: 100 }] });
    expect((await stat(path.join(data, 'wow.db'))).isFile()).toBe(true);
  });
});

describe('opening an item on Wowhead', () => {
  it('opens only the page of an item, by its number', async () => {
    const opened = [];
    await boot({ open: (url) => opened.push(url) });
    const ok = await post('/api/wow/open', { item: 19019 });
    expect(ok.status).toBe(200);
    expect(opened).toEqual(['https://www.wowhead.com/classic/item=19019']);
    for (const item of ['19019/../x', -1, 1.5, 0, 1e12, null, { a: 1 }]) {
      expect((await post('/api/wow/open', { item })).status, String(item)).toBe(400);
    }
    expect((await post('/api/wow/open', { url: 'https://example.com' })).status).toBe(400);
    expect(opened).toHaveLength(1);
  });

  it('is for this PC only', async () => {
    const opened = [];
    await boot({ open: (url) => opened.push(url) }, { local: false });
    expect((await post('/api/wow/open', { item: 1 })).status).toBe(403);
    expect(opened).toEqual([]);
  });
});
