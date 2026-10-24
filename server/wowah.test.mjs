// The auction house engine end to end: a fake WoW folder with the addon installed and a saved
// UncboxAH.lua in it, the watcher that reads it, the database, the data file written back, and the
// HTTP routes. Also the real addon's Lua (run in fengari) producing the file that is read.
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Game } from '../integrations/wow/ahharness.mjs';
import { findInstalls } from '../integrations/wow/install.mjs';
import { parseSavedVariables } from '../integrations/wow/savedvars.mjs';
import { createWowAh } from './wowah.mjs';
import { chooseInstall } from './wowahwatch.mjs';
import { readDataFile } from './wowahdata.mjs';
import { FIXTURE_NOW as NOW, REALM_KEY, fixtureFile, savedFixture, toSavedVariables } from './wowahfixture.mjs';

let temp;
let wow; // the "World of Warcraft" folder
let dataDir;
let engine;
let server;
let events;
let port;

const addOns = (flavor = '_classic_beta_') => path.join(wow, flavor, 'Interface', 'AddOns');
const savedVars = (flavor = '_classic_beta_', account = 'ACCOUNT1') => path.join(wow, flavor, 'WTF', 'Account', account, 'SavedVariables', 'UncboxAH.lua');
const dataFile = (flavor = '_classic_beta_') => path.join(addOns(flavor), 'UncboxAH', 'UncboxAHData.lua');

async function installAddon(flavor = '_classic_beta_') {
  await mkdir(path.join(addOns(flavor), 'UncboxAH'), { recursive: true });
  await writeFile(path.join(addOns(flavor), 'UncboxAH', 'UncboxAH.toc'), '## Interface: 16001\n');
}

async function saveFile(text, flavor, account) {
  await mkdir(path.dirname(savedVars(flavor, account)), { recursive: true });
  await writeFile(savedVars(flavor, account), text);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

async function boot({ start = true, local = true, flavor } = {}) {
  engine = createWowAh({
    broadcastEvent: (name, data) => events.push([name, data]),
    sendJson,
    isLocal: () => local,
    readJson,
    dataDir,
    findInstalls: () => findInstalls([wow]),
    enabled: true,
    now: () => NOW,
    watch: { settleMs: 30, intervalMs: 60_000 },
  });
  server = http.createServer((req, res) => engine.handle(req, res, new URL(req.url, 'http://localhost')));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  if (start) await engine.start();
  void flavor;
}

async function api(method, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/wow/ah/${route}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}
const get = (route) => api('GET', route);

beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'uncbox-ah-api-'));
  wow = path.join(temp, 'World of Warcraft');
  dataDir = path.join(temp, 'data');
  events = [];
  await mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  engine?.close();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  server?.closeAllConnections?.();
  engine = server = undefined;
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Waits for a condition (the watcher works in the background). */
async function until(check, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('finding the right WoW', () => {
  const installs = [
    { flavor: '_retail_', path: 'r' },
    { flavor: '_classic_era_', path: 'e' },
    { flavor: '_classic_beta_', path: 'b' },
  ];

  it('prefers WoW Forever (the classic beta), then Classic Era, unless the addon already saved data somewhere else', () => {
    const none = () => ({ saved: false, addon: false });
    expect(chooseInstall(installs, none).flavor).toBe('_classic_beta_');
    expect(chooseInstall(installs.slice(0, 2), none).flavor).toBe('_classic_era_');
    expect(chooseInstall(installs, (i) => ({ saved: i.flavor === '_classic_era_', addon: true })).flavor).toBe('_classic_era_');
    expect(chooseInstall(installs, (i) => ({ saved: false, addon: i.flavor === '_classic_era_' })).flavor).toBe('_classic_era_');
    expect(chooseInstall(installs.slice(0, 1), none).flavor).toBe('_retail_');
    expect(chooseInstall([], none)).toBeNull();
  });
});

describe('reading what the addon saved', () => {
  it('ingests the saved file, reports it, and writes the data file into the addon folder', async () => {
    await installAddon();
    await saveFile(fixtureFile());
    await boot();
    expect(events).toEqual([['wowah', { realms: [REALM_KEY], scans: 3, accounting: 7, at: NOW }]]);

    const status = (await get('status')).json;
    expect(status).toMatchObject({
      available: true,
      addonInstalled: true,
      flavor: '_classic_beta_',
      savedVariables: [savedVars()],
      dataFile: dataFile(),
      realm: 'Stalagg',
      faction: 'Alliance',
      lastFullScan: NOW - 3600,
      dataAge: 3600,
      lastIngest: NOW,
    });
    expect(status.realms).toEqual([{ realm: 'Stalagg', faction: 'Alliance', lastFullScan: NOW - 3600, lastScan: NOW - 3600, scans: 3, items: 8 }]);

    const data = readDataFile(await readFile(dataFile(), 'utf8'));
    expect(data.realms[REALM_KEY].items['i:2589'].market).toBe(88);
    expect(data.realms[REALM_KEY].rules['i:2589'].normal).toBe(88);
  });

  it('is idempotent: the same file again, or rewritten with the same content, changes nothing and tells nobody', async () => {
    await installAddon();
    await saveFile(fixtureFile());
    await boot();
    const before = (await get('items?limit=500')).json;
    await engine.watcher.check();
    await saveFile(fixtureFile()); // WoW rewrites the file on every /reload
    await engine.watcher.check();
    expect(events).toHaveLength(1);
    expect((await get('items?limit=500')).json).toEqual(before);
    // Another start of Uncbox reads the same file and adds nothing either.
    engine.close();
    server.close();
    events = [];
    await boot();
    expect(events).toEqual([]);
    expect((await get('items?limit=500')).json).toEqual(before);
  });

  it('picks up a rewritten file by itself, while it runs', async () => {
    await installAddon();
    await saveFile(fixtureFile());
    await boot();
    const later = savedFixture();
    later.realms[REALM_KEY].scans.push({ t: NOW - 60, kind: 'full', n: 1, items: { 'i:2589': { mb: 70, q: 10, a: 1, p: [70, 10] } } });
    await saveFile(toSavedVariables('UncboxAHDB', later));
    await until(() => events.length >= 2, 'the second ingest');
    expect(events[1][1]).toMatchObject({ scans: 1, accounting: 0 });
    expect((await get('item/i%3A2589')).json.prices.minBuyout).toBe(70);
    // The data file followed.
    await engine.writeDataFile();
    expect(readDataFile(await readFile(dataFile(), 'utf8')).realms[REALM_KEY].items['i:2589'].minBuyout).toBe(70);
  });

  it('copes with a file WoW is still writing, and reads it once it is whole', async () => {
    await installAddon();
    await saveFile('UncboxAHDB = {\n["version"] = 1,\n["realms"] = {');
    await boot();
    expect(events).toEqual([]);
    expect((await get('status')).json.realms).toEqual([]);
    await saveFile(fixtureFile());
    await until(() => events.length === 1, 'the finished file');
  });

  it('waits for the addon to be installed before it writes the data file, and puts it back when the folder is reinstalled', async () => {
    await mkdir(addOns(), { recursive: true });
    await saveFile(fixtureFile());
    await boot();
    expect((await get('status')).json).toMatchObject({ addonInstalled: false, dataFile: null });
    await expect(stat(path.join(addOns(), 'UncboxAH'))).rejects.toThrow(); // nothing was created for it
    await installAddon();
    await engine.watcher.check();
    const target = await engine.writeDataFile();
    expect(target).toBe(dataFile());
    await stat(dataFile());
    // A reinstall wipes the folder; the next look puts the prices back.
    await rm(path.join(addOns(), 'UncboxAH'), { recursive: true });
    await installAddon();
    expect(await engine.writeDataFile()).toBe(dataFile());
    await stat(dataFile());
  });

  it('leaves the file alone when nothing changed', async () => {
    await installAddon();
    await saveFile(fixtureFile());
    await boot();
    const first = (await stat(dataFile())).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await engine.writeDataFile();
    expect((await stat(dataFile())).mtimeMs).toBe(first);
    await engine.writeDataFile({ force: true });
    expect((await stat(dataFile())).mtimeMs).toBeGreaterThan(first);
  });

  it('uses the flavor that has the saved data, and every account in it', async () => {
    await installAddon('_classic_era_');
    await installAddon('_classic_beta_');
    await saveFile(fixtureFile(), '_classic_era_', 'ACCOUNT1');
    const second = savedFixture();
    second.realms['Other|Horde'] = { scans: [{ t: NOW - 10, kind: 'full', n: 1, items: { 'i:2589': { mb: 5, q: 1, a: 1, p: [5, 1] } } }] };
    delete second.realms[REALM_KEY];
    await saveFile(toSavedVariables('UncboxAHDB', second), '_classic_era_', 'ACCOUNT2');
    await boot();
    const status = (await get('status')).json;
    expect(status.flavor).toBe('_classic_era_');
    expect(status.savedVariables).toEqual([savedVars('_classic_era_', 'ACCOUNT1'), savedVars('_classic_era_', 'ACCOUNT2')]);
    expect(status.realms.map((r) => `${r.realm}|${r.faction}`).sort()).toEqual(['Other|Horde', REALM_KEY]);
    await stat(dataFile('_classic_era_'));
    await expect(stat(dataFile('_classic_beta_'))).rejects.toThrow();
  });
});

describe('the routes', () => {
  beforeEach(async () => {
    await installAddon();
    await saveFile(fixtureFile());
    await boot();
  });

  it('lists and finds items', async () => {
    const all = (await get('items')).json;
    expect(all).toMatchObject({ realm: 'Stalagg', faction: 'Alliance', total: 8 });
    expect(all.items[0]).toMatchObject({ item: 'i:818', name: 'Tigerseye', market: 500 }); // most valuable first
    const linen = (await get('items?q=LINEN&sort=name&order=asc')).json;
    expect(linen.items.map((i) => i.name)).toEqual(['Bolt of Linen Cloth', 'Linen Cloth']);
    expect(linen.items[1]).toEqual({
      item: 'i:2589', name: 'Linen Cloth', quality: 1, icon: 132889, market: 88, minBuyout: 80, historical: 115, saleRate: 0.4, avgSell: 115, vendor: 13,
      volatility: expect.any(Number), quantity: 25,
    });
    expect((await get('items?sort=quantity&limit=2')).json.items.map((i) => i.item)).toEqual(['i:2447', 'i:2589']); // 50 and 25 listed
    expect((await get('items?sort=saleRate&limit=3')).json.items.map((i) => i.item).slice(0, 2)).toEqual(['i:2592', 'i:2589']);
    expect((await get('items?limit=2')).json.items).toHaveLength(2);
    expect((await get('items?realm=Nowhere&faction=Horde')).json).toMatchObject({ total: 0, items: [] });
  });

  it('shows an item with its history and listings', async () => {
    const r = (await get('item/i%3A2589')).json;
    expect(r).toMatchObject({
      item: 'i:2589',
      realm: 'Stalagg',
      info: { name: 'Linen Cloth', vendor: 13, stack: 20 },
      prices: { market: 88, minBuyout: 80, historical: 115, saleRate: 0.4, avgSell: 115, crafting: null },
      ladder: [[80, 20], [95, 5]],
      mine: [[95, 5]],
      scanTime: NOW - 1800,
    });
    expect(r.history.daily.map((d) => d.minBuyout)).toEqual([150, 140, 130, 100, 90, 80]);
    expect(r.history.scans).toHaveLength(4);
    expect(r.listings.rows[0]).toEqual([80, 20, 'Rival', 3]);
    expect((await get('item/i%3A999999')).status).toBe(404);
    expect((await get('item/i%3A2996')).json.prices.crafting).toBe(160);
  });

  it('answers the analyses', async () => {
    expect((await get('deals')).json.rows).toEqual([]); // the default only looks at items worth 50s or more
    expect((await get('deals?minMarket=0')).json.rows.map((r) => [r.item, r.price])).toEqual([['i:2592', 100]]);
    expect((await get('deals?percent=0.95&minSaleRate=0.5&minMarket=0')).json.rows.map((r) => r.item)).toEqual(['i:2592']);
    expect((await get('flips')).json.rows.map((r) => r.item)).toEqual(['i:2592', 'i:2589']);
    expect((await get('vendor-flips')).json.rows).toHaveLength(2);
    expect((await get('crafting')).json.rows.map((r) => [r.item, r.profit])).toEqual([['i:2996', 87], ['i:118', 73]]);
    expect((await get('crafting?minProfit=80')).json.rows).toHaveLength(1);
    expect((await get('sell')).json.rows.map((r) => [r.item, r.value])).toEqual([['i:2589', 3520], ['i:2592', 2172], ['i:4306', 315]]);
    expect((await get('undercuts')).json.rows.map((r) => [r.item, r.undercutBy])).toEqual([['i:2592', 140], ['i:2589', 15]]);
    const acct = (await get('accounting?days=30')).json;
    expect(acct).toMatchObject({ days: 30, summary: { sales: 11, spent: 2000 } });
    expect(acct.entries).toHaveLength(7);
    expect((await get('accounting?days=2')).json.entries.length).toBeLessThan(7);
    const gold = (await get('gold')).json;
    expect(gold.total.at(-1)).toEqual({ t: NOW - 1800, copper: 205000 });
    expect(gold).toMatchObject({ current: 205000, chars: { Lief: expect.any(Array) } });
  });

  it('keeps groups, operations and shopping lists, and rewrites the data file when they change', async () => {
    const op = (await api('POST', 'operations', { kind: 'post', name: 'Cloth', normalPrice: '1g', undercut: 7, stackSize: 20 })).json;
    expect(op).toMatchObject({ kind: 'post', undercut: 7, stackSize: 20, minPrice: expect.any(String) });
    const group = (await api('POST', 'groups', { name: 'Cloth', items: ['i:2589'], postOperation: op.id })).json;
    expect((await get('groups')).json.groups).toEqual([group]);
    await engine.writeDataFile();
    const rules = () => readFile(dataFile(), 'utf8').then((t) => readDataFile(t).realms[REALM_KEY].rules['i:2589']);
    await until(async () => (await rules())?.group === 'Cloth', 'the data file to follow');
    expect(await rules()).toMatchObject({ group: 'Cloth', normal: 10000, undercut: 7, stackSize: 20 });

    const renamed = (await api('PUT', `groups/${group.id}`, { name: 'Cloths', items: ['i:2589', 'i:2592'] })).json;
    expect(renamed).toMatchObject({ id: group.id, name: 'Cloths', items: ['i:2589', 'i:2592'], postOperation: op.id });
    const list = (await api('POST', 'shopping', { name: 'Mats', items: [{ item: 'i:2589', maxPrice: '50c' }] })).json;
    expect((await get('shopping')).json.shopping).toEqual([list]);
    expect((await api('PUT', 'deals-settings', { percent: 0.5 })).json).toMatchObject({ percent: 0.5 });
    expect((await get('deals-settings')).json.percent).toBe(0.5);

    expect((await api('DELETE', `groups/${group.id}`)).json).toEqual({ ok: true });
    expect((await get('groups')).json.groups).toEqual([]);
    expect((await api('DELETE', `groups/${group.id}`)).status).toBe(404);
    expect((await api('DELETE', 'operations/default-post')).status).toBe(400);
    expect((await api('PUT', 'groups/nope', { name: 'x' })).status).toBe(404);
  });

  it('turns bad rules down with a message', async () => {
    const bad = await api('POST', 'operations', { kind: 'post', name: 'x', minPrice: 'dbmarket *' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/Min price: The formula ends too soon/);
    expect((await api('POST', 'groups', { name: 'g', items: ['nope'] })).status).toBe(400);
    expect((await api('POST', 'groups', { name: 'g', items: 'nope' })).status).toBe(400);
    expect((await api('PATCH', 'groups')).status).toBe(405);
  });

  it('tests a formula for an item', async () => {
    expect((await api('POST', 'formula/test', { formula: 'max(vendorsell, 85% dbmarket)', item: 'i:2589' })).json).toMatchObject({
      ok: true,
      value: 75,
      text: '75c',
      vars: { dbmarket: 88, dbminbuyout: 80, dbhistorical: 115, avgsell: 115, vendorsell: 13 },
    });
    expect((await api('POST', 'formula/test', { formula: '2g50s' })).json).toMatchObject({ ok: true, value: 25000, text: '2g 50s' });
    expect((await api('POST', 'formula/test', { formula: 'dbmarket', item: 'i:99999' })).json).toMatchObject({ ok: true, value: null, text: null });
    const bad = await api('POST', 'formula/test', { formula: 'dbmarket +' });
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ ok: false, error: 'The formula ends too soon (at 11)' });
    expect((await api('POST', 'formula/test', {})).status).toBe(400);
  });

  it('reads the files again when told to', async () => {
    const r = await api('POST', 'refresh');
    expect(r.json).toEqual({ ok: true, dataFile: dataFile() });
    expect((await api('GET', 'nope')).status).toBe(404);
    expect((await api('POST', 'status')).status).toBe(404);
  });
});

describe('who may ask', () => {
  it('turns away anyone but this PC', async () => {
    await boot({ start: false, local: false });
    expect((await get('status')).status).toBe(403);
    expect((await api('POST', 'groups', { name: 'x', items: [] })).status).toBe(403);
  });

  it('does not watch anything when helpers are off, but still answers', async () => {
    await installAddon();
    await saveFile(fixtureFile());
    engine = createWowAh({ sendJson, isLocal: () => true, readJson, dataDir, findInstalls: () => findInstalls([wow]), enabled: false });
    await engine.start();
    server = http.createServer((req, res) => engine.handle(req, res, new URL(req.url, 'http://localhost')));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    expect((await get('status')).json).toMatchObject({ addonInstalled: false, realms: [] });
    await expect(stat(path.join(dataDir, 'wow-ah.db'))).rejects.toThrow();
  });
});

describe('the real addon feeding the real engine', () => {
  let game;
  afterEach(() => game?.close());

  it('reads a scan, mail, bags and recipes exactly as the addon saves them, and the addon reads the prices back', async () => {
    game = new Game();
    game.start();
    game.run(`
      Mock.item(2589, "Linen Cloth", { vendor = 13 }); Mock.item(2592, "Wool Cloth", { vendor = 41 }); Mock.item(2996, "Bolt of Linen Cloth", { vendor = 40 })
      Mock.bags[0] = { [1] = { id = 2589, count = 30 } }
    `);
    game.auctions([
      { id: 2589, count: 20, buyout: 2000, owner: 'Seller' },
      { id: 2589, count: 10, buyout: 1200, owner: 'Seller' },
      { id: 2589, count: 5, buyout: 600, owner: 'Lief' },
      { id: 2592, count: 1, buyout: 4000, owner: 'Seller' },
    ]);
    game.run('ns.Scan.StartFull(); Mock.deliver(); Mock.pump()');
    game.run('ns.Collect.RecordItem("i:2589", "item:2589"); ns.Collect.Inventory(false)');
    game.run(`Mock.mail({ subject = "Auction successful: Linen Cloth", money = 950, invoice = { "seller", "Linen Cloth", "Bob", 1000, 1000, 40, 50, 0, 0, "", 5 } }); ns.Acct.ReadInbox()`);
    game.run(`
      Mock.skill = { name = "Tailoring", rows = { { name = "Bolt of Linen Cloth", id = 2996, made = 1, reagents = { { 2589, 2 } } } } }
      Mock.fire("TRADE_SKILL_SHOW"); Mock.advance(1)
    `);
    await installAddon();
    await saveFile(game.saved());
    await boot();

    // The addon's real output was read.
    const items = (await get('items')).json;
    expect(items.items.map((i) => i.item).sort()).toEqual(['i:2589', 'i:2592']);
    const linen = (await get('item/i%3A2589')).json;
    expect(linen).toMatchObject({ ladder: [[100, 20], [120, 15]], prices: { minBuyout: 100, crafting: null } });
    expect(linen.mine).toEqual([[120, 5]]);
    expect(linen.info).toMatchObject({ name: 'Linen Cloth', vendor: 13 });
    const acct = (await get('accounting')).json;
    expect(acct.entries).toHaveLength(1);
    expect(acct.entries[0]).toMatchObject({ type: 'sold', item: 'i:2589', qty: 5, price: 1000, cut: 50, deposit: 40, other: 'Bob', char: 'Lief' });
    expect((await get('sell')).json.rows[0]).toMatchObject({ item: 'i:2589', quantity: 30, chars: { Lief: 30 } });
    expect((await get('crafting?includeIncomplete=1')).json.rows[0]).toMatchObject({ profession: 'Tailoring', item: 'i:2996' });
    expect((await get('gold')).json.chars.Lief).toEqual([{ t: NOW, copper: 123456 }]);

    // …and the data file Uncbox wrote loads in the addon: tooltip lines and a posting plan.
    await engine.writeDataFile();
    game.run(`${await readFile(dataFile(), 'utf8')}`);
    expect(game.eval('ns.Tooltip.Lines("i:2589", 1)')[0]).toEqual(['Uncbox Market Value', '1s']);
    game.run('Mock.faction = "Alliance"');
    const plan = game.eval('ns.Actions.PostPlan("i:2589", 30)');
    expect(plan).toMatchObject({ fromGroup: false, stackSize: 1 });
    expect(plan.rule.normal).toBe(100);
  });

  it('survives a second /reload: the addon appends, the engine adds only the new', async () => {
    game = new Game();
    game.start();
    game.run('Mock.item(2589, "Linen Cloth")');
    game.auctions([{ id: 2589, count: 10, buyout: 1000, owner: 'Seller' }]);
    game.run('ns.Scan.StartFull(); Mock.deliver(); Mock.pump()');
    await installAddon();
    await saveFile(game.saved());
    await boot();
    expect(events).toHaveLength(1);
    game.run('Mock.now = Mock.now + 4000; Mock.auctions[1].buyout = 900; ns.Scan.StartFull(); Mock.deliver(); Mock.pump()');
    await saveFile(game.saved());
    await engine.watcher.check();
    expect(events).toHaveLength(2);
    expect(events[1][1]).toMatchObject({ scans: 1 });
    expect((await get('status')).json.realms[0]).toMatchObject({ scans: 2 });
    expect(parseSavedVariables(game.saved()).UncboxAHDB.realms[REALM_KEY].scans).toHaveLength(2);
  });
});
