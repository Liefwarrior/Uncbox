// The Uncbox auction house engine: reads what the UncboxAH addon saved, works out prices, and
// answers the dashboard (the auction house widget comes later) over /api/wow/ah/*.
//
//   WoW addon  --UncboxAH.lua (SavedVariables, on /reload or logout)-->  this module  --> data/wow-ah.db
//   this module  --UncboxAHData.lua (prices and rules, loaded on /reload)-->  WoW addon
//
// All routes are local-only. Prices are copper per item; money text is "12g 34s 56c" (money.mjs).
// Every route takes ?realm=&faction= and defaults to the realm scanned most recently. Items are
// written i:<id> (plus :<random suffix>), e.g. i:2589.
//
//   GET    /api/wow/ah/status           { available, addonInstalled, flavor, savedVariables[], dataFile,
//                                         lastIngest, realm, faction, lastFullScan, dataAge (seconds),
//                                         realms: [{ realm, faction, lastFullScan, lastScan, scans, items }] }
//   GET    /api/wow/ah/items            ?q=&sort=market|minBuyout|name|quantity|saleRate|volatility|historical|avgSell
//                                       &order=asc|desc&limit=100
//                                       { realm, faction, total, items: [{ item, name, quality, icon, market, minBuyout,
//                                         historical, saleRate, avgSell, vendor, volatility, quantity }] }
//   GET    /api/wow/ah/item/<item>      { item, info, prices, ladder: [[price, qty]], mine, scanTime,
//                                         history: { daily: [{ t, minBuyout, scans }], scans: [{ t, kind, minBuyout,
//                                         quantity, auctions, points }] }, listings: { t, rows: [[price, count, seller, timeLeft]] } | null }
//   GET    /api/wow/ah/deals            ?percent=0.6&minSaleRate=0&minMarket=5000&limit=100
//   GET    /api/wow/ah/flips            ?minProfit=1&minRoi=0&minSaleRate=0&minMarket=0&limit=100
//   GET    /api/wow/ah/vendor-flips     ?limit=100
//   GET    /api/wow/ah/crafting         ?minProfit=&includeIncomplete=1&limit=100
//   GET    /api/wow/ah/sell             ?limit=100
//   GET    /api/wow/ah/undercuts
//   GET    /api/wow/ah/accounting       ?days=30  { days, summary: {…totals, items, days}, entries: [last 500] }
//   GET    /api/wow/ah/gold             { total: [{ t, copper }], chars: { name: [{ t, copper }] }, current }
//   GET/POST /api/wow/ah/groups, PUT/DELETE /api/wow/ah/groups/<id>
//   GET/POST /api/wow/ah/operations, PUT/DELETE /api/wow/ah/operations/<id>
//   GET/POST /api/wow/ah/shopping,  PUT/DELETE /api/wow/ah/shopping/<id>
//   GET/PUT  /api/wow/ah/deals-settings
//   POST   /api/wow/ah/formula/test     { formula, item? } → { ok, value, text, error?, vars }
//   POST   /api/wow/ah/refresh          reads the saved files again and rewrites UncboxAHData.lua
//
// The deals, flips, vendor-flips, crafting, sell and undercuts routes answer { realm, faction, rows: [...] }
// (see wowahanalysis.mjs for the row shapes); money fields are copper. SSE: "wowah" with
// { realms, scans, accounting, at } after the addon's file was ingested.

import path from 'node:path';
import { stat } from 'node:fs/promises';
import { parseSavedVariables } from '../integrations/wow/savedvars.mjs';
import { findInstalls as defaultFindInstalls } from '../integrations/wow/install.mjs';
import { writeFileAtomic } from './datafile.mjs';
import { createAhDb } from './wowahdb.mjs';
import { accountingSummary, craftingProfit, deals, flips, goldOverTime, undercuts, vendorFlips, whatToSell } from './wowahanalysis.mjs';
import { buildRealmData, DATA_FILE, itemVars, renderDataFile } from './wowahdata.mjs';
import { evalFormula } from './wowahformula.mjs';
import { formatMoney } from './money.mjs';
import { createAhStore } from './wowahstore.mjs';
import { createWatcher } from './wowahwatch.mjs';
import { noHelpers, offline } from './switches.mjs';

const num = (url, name, fallback) => {
  const v = url.searchParams.get(name);
  if (v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const quantity = (it) => it.points.reduce((n, [, q]) => n + q, 0);

const itemRow = (it) => ({
  item: it.item,
  name: it.name,
  quality: it.quality,
  icon: it.icon,
  market: it.market,
  minBuyout: it.minBuyout,
  historical: it.historical,
  saleRate: it.saleRate,
  avgSell: it.avgSell,
  vendor: it.vendor,
  volatility: it.volatility,
  quantity: quantity(it),
});

const SORTS = new Set(['market', 'minBuyout', 'name', 'quantity', 'saleRate', 'volatility', 'historical', 'avgSell']);

export function createWowAh({
  broadcastEvent = () => {},
  sendJson,
  isLocal,
  readJson,
  dataDir,
  findInstalls = defaultFindInstalls,
  enabled = !(noHelpers() || offline()),
  watch = {}, // intervalMs and settleMs of the file watcher, for tests
  now = () => Math.floor(Date.now() / 1000),
}) {
  const db = createAhDb({ file: path.join(dataDir, 'wow-ah.db') });
  const store = createAhStore({ file: path.join(dataDir, 'wow-ah.json') });
  let lastIngest = null;
  let lastDataHash = null;
  let writing = Promise.resolve();
  let ensureTimer = null;

  const watcher = createWatcher({
    findInstalls,
    known: (file) => db.sourceHash(file),
    onFile: (file, text, hash) => ingestText(text, { file, hash }),
    onError: (err) => console.warn('Uncbox: the auction house data:', err.message),
    ...watch,
  });

  /** Ingests the text of an UncboxAH.lua. Returns what was added. */
  async function ingestText(text, { file = null, hash = null } = {}) {
    const saved = parseSavedVariables(text).UncboxAHDB;
    const added = db.ingest(saved, { now: now() });
    if (file) db.setSourceHash(file, hash, now());
    lastIngest = now();
    if (added.scans || added.accounting || added.scanItems) {
      broadcastEvent('wowah', { realms: added.realms, scans: added.scans, accounting: added.accounting, at: lastIngest });
    }
    await writeDataFile();
    return added;
  }

  /** Where UncboxAHData.lua goes: the chosen flavor's UncboxAH folder, if the addon is installed there. */
  function dataFilePath() {
    const cur = watcher.current();
    if (!cur?.addon) return null;
    return path.join(cur.install.path, 'UncboxAH', DATA_FILE);
  }

  /** Writes UncboxAHData.lua for every realm in the database (one write at a time). */
  function writeDataFile({ force = false } = {}) {
    writing = writing.then(async () => {
      const target = dataFilePath();
      if (!target || !db.exists()) return null;
      const rules = await store.load();
      const realms = {};
      for (const r of db.realms()) realms[`${r.realm}|${r.faction}`] = buildRealmData(db.snapshot(r.realm, r.faction, { now: now() }), rules);
      if (!Object.keys(realms).length) return null;
      // The text without its timestamp, so an unchanged database doesn't rewrite the file on every look.
      const body = renderDataFile(realms, 0);
      if (!force && body === lastDataHash && (await stat(target).then(() => true, () => false))) return target;
      await writeFileAtomic(target, renderDataFile(realms, now()));
      lastDataHash = body;
      return target;
    }).catch((err) => {
      console.warn('Uncbox: couldn’t write the auction house data file:', err.message);
      return null;
    });
    return writing;
  }

  async function start() {
    if (!enabled) return;
    await watcher.start();
    // After the addon is reinstalled its folder is fresh and has no data file; put it back.
    ensureTimer = setInterval(() => void writeDataFile(), 60_000);
    ensureTimer.unref?.();
    void writeDataFile();
  }

  function close() {
    clearInterval(ensureTimer);
    watcher.stop();
    db.close();
  }

  /** The realm a request asks about (or the most recently scanned): { realm, faction } or null. */
  function pick(url) {
    const realm = url.searchParams.get('realm');
    const faction = url.searchParams.get('faction');
    if (realm && faction) return { realm, faction };
    const first = db.realms().find((r) => !realm || r.realm === realm);
    return first ? { realm: first.realm, faction: first.faction } : null;
  }

  const snapshotOf = (url) => {
    const where = pick(url);
    return where ? { where, snap: db.snapshot(where.realm, where.faction, { now: now() }) } : { where: null, snap: null };
  };

  async function status() {
    const cur = watcher.current();
    const realms = db.realms();
    const top = realms[0] ?? null;
    return {
      available: Boolean(process.getBuiltinModule?.('node:sqlite')),
      addonInstalled: Boolean(cur?.addon),
      flavor: cur?.install.flavor ?? null,
      savedVariables: cur?.files ?? [],
      dataFile: dataFilePath(),
      lastIngest,
      realm: top?.realm ?? null,
      faction: top?.faction ?? null,
      lastFullScan: top?.lastFullScan ?? null,
      dataAge: top?.lastFullScan ? Math.max(0, now() - top.lastFullScan) : null,
      realms,
    };
  }

  function items(url) {
    const { where, snap } = snapshotOf(url);
    if (!snap) return { realm: null, faction: null, total: 0, items: [] };
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const sort = SORTS.has(url.searchParams.get('sort')) ? url.searchParams.get('sort') : 'market';
    const order = url.searchParams.get('order') ?? (sort === 'name' ? 'asc' : 'desc');
    let rows = [...snap.items.values()].filter((it) => it.market !== null || it.minBuyout !== null || it.historical !== null);
    if (q) rows = rows.filter((it) => (it.name ?? '').toLowerCase().includes(q) || it.item === q);
    const key = (it) => (sort === 'quantity' ? quantity(it) : sort === 'name' ? (it.name ?? '') : it[sort]);
    rows.sort((a, b) => {
      const x = key(a);
      const y = key(b);
      if (x === y) return 0;
      if (x === null || x === undefined) return 1; // no data sorts last either way
      if (y === null || y === undefined) return -1;
      const cmp = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return order === 'asc' ? cmp : -cmp;
    });
    const limit = Math.min(500, Math.max(1, num(url, 'limit', 100)));
    return { ...where, total: rows.length, items: rows.slice(0, limit).map(itemRow) };
  }

  function item(url, id) {
    const { where, snap } = snapshotOf(url);
    const it = snap?.items.get(id);
    if (!it) return null;
    const history = db.itemHistory(where.realm, where.faction, id, { now: now(), days: Math.min(60, num(url, 'days', 30)) });
    return {
      ...where,
      item: id,
      info: { name: it.name, quality: it.quality, ilvl: it.ilvl, class: it.class, vendor: it.vendor, icon: it.icon, stack: it.stack },
      prices: { market: it.market, minBuyout: it.minBuyout, historical: it.historical, saleRate: it.saleRate, avgSell: it.avgSell, volatility: it.volatility, crafting: it.crafting },
      ladder: it.points,
      mine: it.mine,
      scanTime: it.scanTime,
      history: { daily: history.daily, scans: history.scans },
      listings: history.listings,
    };
  }

  const rowsOf = (url, build) => {
    const { where, snap } = snapshotOf(url);
    return { realm: where?.realm ?? null, faction: where?.faction ?? null, rows: snap ? build(snap) : [] };
  };

  /** The shared create / replace / delete routes of groups, operations and shopping lists. */
  async function crud(req, res, url, name, rest) {
    const col = store[name];
    if (req.method === 'GET' && !rest) return sendJson(res, 200, { [name]: await col.list() });
    if (req.method === 'POST' && !rest) return sendJson(res, 200, await col.put(await readJson(req)));
    if (req.method === 'PUT' && rest) return sendJson(res, 200, await col.put(await readJson(req), rest));
    if (req.method === 'DELETE' && rest) {
      await col.remove(rest);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  /** Routes under /api/wow/ah/. Mutations rewrite the data file so the addon has the new rules at its next /reload. */
  async function handle(req, res, url) {
    if (!isLocal(req)) return sendJson(res, 403, { error: 'Run this on the PC WoW is on.' });
    const [route, ...tail] = url.pathname.slice('/api/wow/ah/'.length).split('/');
    const rest = tail.length ? decodeURIComponent(tail.join('/')) : '';
    try {
      if (req.method === 'GET') {
        if (route === 'status' && !rest) return sendJson(res, 200, await status());
        if (route === 'items' && !rest) return sendJson(res, 200, items(url));
        if (route === 'item' && rest) {
          const found = item(url, rest);
          return found ? sendJson(res, 200, found) : sendJson(res, 404, { error: 'Uncbox hasn’t seen that item.' });
        }
        if (route === 'deals' && !rest) {
          const d = await store.deals();
          return sendJson(res, 200, rowsOf(url, (s) => deals(s, {
            percent: num(url, 'percent', d.percent),
            minSaleRate: num(url, 'minSaleRate', d.minSaleRate),
            minMarket: num(url, 'minMarket', d.minMarket),
            limit: num(url, 'limit', 100),
          })));
        }
        if (route === 'flips' && !rest) {
          return sendJson(res, 200, rowsOf(url, (s) => flips(s, {
            minProfit: num(url, 'minProfit', 1),
            minRoi: num(url, 'minRoi', 0),
            minSaleRate: num(url, 'minSaleRate', 0),
            minMarket: num(url, 'minMarket', 0),
            limit: num(url, 'limit', 100),
          })));
        }
        if (route === 'vendor-flips' && !rest) return sendJson(res, 200, rowsOf(url, (s) => vendorFlips(s, { limit: num(url, 'limit', 100) })));
        if (route === 'crafting' && !rest) {
          return sendJson(res, 200, rowsOf(url, (s) => craftingProfit(s, {
            minProfit: num(url, 'minProfit', -Infinity),
            includeIncomplete: url.searchParams.get('includeIncomplete') === '1',
            limit: num(url, 'limit', 100),
          })));
        }
        if (route === 'sell' && !rest) return sendJson(res, 200, rowsOf(url, (s) => whatToSell(s, { limit: num(url, 'limit', 100) })));
        if (route === 'undercuts' && !rest) return sendJson(res, 200, rowsOf(url, (s) => undercuts(s)));
        if (route === 'accounting' && !rest) {
          const where = pick(url);
          const days = Math.min(365, Math.max(1, num(url, 'days', 30)));
          const entries = where ? db.accounting(where.realm, where.faction, now() - days * 86400) : [];
          return sendJson(res, 200, { ...(where ?? { realm: null, faction: null }), days, summary: accountingSummary(entries), entries: entries.slice(0, 500) });
        }
        if (route === 'gold' && !rest) {
          const where = pick(url);
          const series = goldOverTime(where ? db.goldHistory(where.realm, where.faction) : {});
          return sendJson(res, 200, { ...(where ?? { realm: null, faction: null }), ...series, current: series.total.at(-1)?.copper ?? 0 });
        }
        if (route === 'deals-settings' && !rest) return sendJson(res, 200, await store.deals());
      }
      if (route === 'groups' || route === 'operations' || route === 'shopping') {
        const out = await crud(req, res, url, route, rest);
        if (req.method !== 'GET') void writeDataFile();
        return out;
      }
      if (route === 'deals-settings' && req.method === 'PUT') {
        const out = await store.setDeals(await readJson(req));
        void writeDataFile();
        return sendJson(res, 200, out);
      }
      if (route === 'formula' && rest === 'test' && req.method === 'POST') {
        const body = await readJson(req);
        const { snap } = snapshotOf(url);
        const it = typeof body.item === 'string' ? snap?.items.get(body.item) : null;
        const vars = it ? itemVars(it) : {};
        const result = evalFormula(String(body.formula ?? ''), vars);
        return sendJson(res, result.ok ? 200 : 400, { ...result, text: result.ok && result.value !== null ? formatMoney(result.value) : null, vars });
      }
      if (route === 'refresh' && !rest && req.method === 'POST') {
        await watcher.check();
        const target = await writeDataFile({ force: true });
        return sendJson(res, 200, { ok: true, dataFile: target });
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.status ? err.message : `Auction house error: ${err.message}` });
    }
  }

  // Exposed for tests and for the other WoW modules.
  return { handle, start, close, ingestText, writeDataFile, status, db, store, watcher };
}
