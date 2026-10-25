// The auction house database (data/wow-ah.db, node:sqlite): what the UncboxAH addon saved, kept
// per realm and faction, and the prices worked out from it.
//
// ingest() takes the UncboxAHDB table the addon saves (see integrations/wow/addon/UncboxAH/Db.lua
// for its shape) and adds only what is new, so reading the same file twice changes nothing:
//
//   scan_items  one row per item per scan: min buyout, quantity, the price ladder ("price:qty,…")
//   daily       per item per day: scans, sum of their min buyouts (the addon's own daily numbers
//               fill days Uncbox wasn't there for; the server's own win where both exist)
//   accounting  your sales, purchases, expired and cancelled auctions and posts, keyed by the id
//               the addon gave them
//   inventory, owned, gold, recipes, items, vendor_buy: the latest of each
//
// Scan rows older than 30 days are dropped; daily rows stay.

import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DAY, HISTORICAL_DAYS, MARKET_DAYS, historicalPrice, marketValue, normalizePoints, saleStats, volatility } from './wowahprice.mjs';

const SCAN_KEEP_DAYS = 30;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  item TEXT PRIMARY KEY, name TEXT, quality INTEGER, ilvl INTEGER, class INTEGER, subclass INTEGER,
  vendor INTEGER, icon INTEGER, stack INTEGER
);
CREATE INDEX IF NOT EXISTS items_name ON items (name);
CREATE TABLE IF NOT EXISTS scans (
  realm TEXT NOT NULL, faction TEXT NOT NULL, t INTEGER NOT NULL, kind TEXT NOT NULL, items INTEGER, listings INTEGER,
  PRIMARY KEY (realm, faction, t, kind)
);
CREATE TABLE IF NOT EXISTS scan_items (
  realm TEXT NOT NULL, faction TEXT NOT NULL, item TEXT NOT NULL, t INTEGER NOT NULL, kind TEXT NOT NULL,
  min_buyout INTEGER, qty INTEGER, auctions INTEGER, points TEXT, mine TEXT, listings TEXT,
  PRIMARY KEY (realm, faction, item, t)
);
CREATE INDEX IF NOT EXISTS scan_items_t ON scan_items (realm, faction, t);
CREATE TABLE IF NOT EXISTS daily (
  realm TEXT NOT NULL, faction TEXT NOT NULL, item TEXT NOT NULL, day INTEGER NOT NULL, src TEXT NOT NULL,
  scans INTEGER, min_sum INTEGER,
  PRIMARY KEY (realm, faction, item, day, src)
);
CREATE TABLE IF NOT EXISTS accounting (
  realm TEXT NOT NULL, faction TEXT NOT NULL, id TEXT NOT NULL, t INTEGER, char TEXT, type TEXT, item TEXT, name TEXT,
  qty INTEGER, price INTEGER, deposit INTEGER, cut INTEGER, other TEXT,
  PRIMARY KEY (realm, faction, id)
);
CREATE INDEX IF NOT EXISTS accounting_t ON accounting (realm, faction, t);
CREATE TABLE IF NOT EXISTS inventory (
  realm TEXT NOT NULL, faction TEXT NOT NULL, char TEXT NOT NULL, item TEXT NOT NULL, bags INTEGER, bank INTEGER,
  PRIMARY KEY (realm, faction, char, item)
);
CREATE TABLE IF NOT EXISTS inventory_meta (
  realm TEXT NOT NULL, faction TEXT NOT NULL, char TEXT NOT NULL, t INTEGER, bank_t INTEGER,
  PRIMARY KEY (realm, faction, char)
);
CREATE TABLE IF NOT EXISTS owned (
  realm TEXT NOT NULL, faction TEXT NOT NULL, char TEXT NOT NULL, t INTEGER, list TEXT,
  PRIMARY KEY (realm, faction, char)
);
CREATE TABLE IF NOT EXISTS gold (
  realm TEXT NOT NULL, faction TEXT NOT NULL, char TEXT NOT NULL, t INTEGER NOT NULL, copper INTEGER,
  PRIMARY KEY (realm, faction, char, t)
);
CREATE TABLE IF NOT EXISTS recipes (
  profession TEXT NOT NULL, item TEXT NOT NULL, name TEXT, made REAL, reagents TEXT,
  PRIMARY KEY (profession, item)
);
CREATE TABLE IF NOT EXISTS vendor_buy (item TEXT PRIMARY KEY, price INTEGER);
CREATE TABLE IF NOT EXISTS sources (path TEXT PRIMARY KEY, hash TEXT, ingested INTEGER);
`;

/** A Lua list as a JS array: a real list, or the {} an empty one parses to, or a table with number keys. */
export function asList(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    return Object.keys(v)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => v[k]);
  }
  return [];
}

/** A Lua table with names as keys, or {} for anything else. */
export function asMap(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' ? v : null);

/** [p1, q1, p2, q2] → "p1:q1,p2:q2". */
export function encodePoints(flat) {
  const list = asList(flat);
  const out = [];
  for (let i = 0; i + 1 < list.length; i += 2) out.push(`${list[i]}:${list[i + 1]}`);
  return out.join(',');
}

/** "p1:q1,p2:q2" → [[p1, q1], [p2, q2]]. */
export function decodePoints(text) {
  if (!text) return [];
  return text.split(',').map((pair) => pair.split(':').map(Number));
}

/** "Stalagg|Alliance" → { realm, faction }, or null. */
export function splitRealmKey(key) {
  const i = key.lastIndexOf('|');
  return i > 0 && i < key.length - 1 ? { realm: key.slice(0, i), faction: key.slice(i + 1) } : null;
}

export function createAhDb({ file }) {
  let db = null;
  let version = 0;
  const cache = new Map();

  function sqlite() {
    const mod = process.getBuiltinModule?.('node:sqlite');
    if (!mod) throw new Error('This needs Node 22.5 or newer (node:sqlite).');
    return mod;
  }

  /** The open database; read-only callers pass create = false and get null when there is none yet. */
  function open(create = true) {
    if (db) return db;
    if (!existsSync(file)) {
      if (!create) return null;
      mkdirSync(path.dirname(file), { recursive: true });
    }
    db = new (sqlite().DatabaseSync)(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    db.exec(SCHEMA);
    return db;
  }

  const all = (sql, ...params) => open(false)?.prepare(sql).all(...params) ?? [];
  const get = (sql, ...params) => open(false)?.prepare(sql).get(...params) ?? null;

  function transaction(fn) {
    const d = open();
    d.exec('BEGIN');
    try {
      const out = fn(d);
      d.exec('COMMIT');
      return out;
    } catch (err) {
      d.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Adds what is new in a saved UncboxAHDB table. Returns what was added:
   * { scans, scanItems, accounting, realms: ['Stalagg|Alliance', …] }.
   */
  function ingest(saved, { now = Math.floor(Date.now() / 1000) } = {}) {
    const added = { scans: 0, scanItems: 0, accounting: 0, realms: [] };
    const root = asMap(saved);
    transaction((d) => {
      const upItem = d.prepare(
        `INSERT INTO items (item, name, quality, ilvl, class, subclass, vendor, icon, stack) VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(item) DO UPDATE SET name = COALESCE(excluded.name, name), quality = COALESCE(excluded.quality, quality),
           ilvl = COALESCE(excluded.ilvl, ilvl), class = COALESCE(excluded.class, class), subclass = COALESCE(excluded.subclass, subclass),
           vendor = COALESCE(excluded.vendor, vendor), icon = COALESCE(excluded.icon, icon), stack = COALESCE(excluded.stack, stack)`,
      );
      for (const [item, info] of Object.entries(asMap(root.items))) {
        const i = asMap(info);
        upItem.run(item, str(i.n), num(i.q), num(i.l), num(i.c), num(i.s), num(i.v), num(i.i), num(i.k));
      }

      const upVendor = d.prepare('INSERT INTO vendor_buy (item, price) VALUES (?, ?) ON CONFLICT(item) DO UPDATE SET price = excluded.price');
      for (const [item, price] of Object.entries(asMap(root.vendorBuy))) if (num(price) !== null) upVendor.run(item, price);

      const upRecipe = d.prepare(
        `INSERT INTO recipes (profession, item, name, made, reagents) VALUES (?,?,?,?,?)
         ON CONFLICT(profession, item) DO UPDATE SET name = excluded.name, made = excluded.made, reagents = excluded.reagents`,
      );
      for (const [profession, recipes] of Object.entries(asMap(root.recipes))) {
        for (const [item, r] of Object.entries(asMap(recipes))) {
          const rec = asMap(r);
          const flat = asList(rec.r);
          const reagents = [];
          for (let i = 0; i + 1 < flat.length; i += 2) reagents.push({ item: flat[i], qty: flat[i + 1] });
          if (!reagents.length) continue;
          upRecipe.run(profession, item, str(rec.n), num(rec.m) ?? 1, JSON.stringify(reagents));
        }
      }

      for (const [key, realmData] of Object.entries(asMap(root.realms))) {
        const parts = splitRealmKey(key);
        if (!parts) continue;
        added.realms.push(key);
        ingestRealm(d, parts, asMap(realmData), added, now);
      }
      d.prepare('DELETE FROM scan_items WHERE t < ?').run(now - SCAN_KEEP_DAYS * DAY);
    });
    if (added.scanItems || added.accounting || added.scans) version++;
    cache.clear();
    return added;
  }

  function ingestRealm(d, { realm, faction }, data, added, now) {
    const insScan = d.prepare('INSERT OR IGNORE INTO scans (realm, faction, t, kind, items, listings) VALUES (?,?,?,?,?,?)');
    const insRow = d.prepare(
      `INSERT OR IGNORE INTO scan_items (realm, faction, item, t, kind, min_buyout, qty, auctions, points, mine, listings)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const bumpDaily = d.prepare(
      `INSERT INTO daily (realm, faction, item, day, src, scans, min_sum) VALUES (?,?,?,?, 'scan', 1, ?)
       ON CONFLICT(realm, faction, item, day, src) DO UPDATE SET scans = scans + 1, min_sum = min_sum + excluded.min_sum`,
    );

    const addRow = (kind, item, t, rec) => {
      const r = asMap(rec);
      const mb = num(r.mb);
      const listings = r.L === undefined ? null : JSON.stringify(asList(r.L).map((l) => asList(l)));
      const res = insRow.run(realm, faction, item, t, kind, mb, num(r.q) ?? 0, num(r.a) ?? 0, encodePoints(r.p), encodePoints(r.m), listings);
      if (res.changes) {
        added.scanItems++;
        if (kind === 'full' && mb !== null) bumpDaily.run(realm, faction, item, Math.floor(t / DAY), mb);
      }
    };

    // Newest scans last, so the latest of each kind is what a "latest" query finds.
    for (const scan of asList(data.scans)) {
      const s = asMap(scan);
      const t = num(s.t);
      if (t === null) continue;
      const kind = s.kind === 'page' ? 'page' : 'full';
      const items = Object.entries(asMap(s.items));
      const res = insScan.run(realm, faction, t, kind, items.length, num(s.n) ?? 0);
      if (!res.changes) continue; // this scan is in already
      added.scans++;
      for (const [item, rec] of items) addRow(kind, item, t, rec);
    }
    for (const [item, rec] of Object.entries(asMap(data.pages))) {
      const t = num(asMap(rec).t);
      if (t !== null) addRow('page', item, t, rec);
    }

    const upAddonDaily = d.prepare(
      `INSERT INTO daily (realm, faction, item, day, src, scans, min_sum) VALUES (?,?,?,?, 'addon', ?, ?)
       ON CONFLICT(realm, faction, item, day, src) DO UPDATE SET scans = excluded.scans, min_sum = excluded.min_sum`,
    );
    for (const [item, flat] of Object.entries(asMap(data.daily))) {
      const list = asList(flat);
      for (let i = 0; i + 2 < list.length; i += 3) upAddonDaily.run(realm, faction, item, list[i], list[i + 1], list[i + 2]);
    }

    const insAcct = d.prepare(
      `INSERT OR IGNORE INTO accounting (realm, faction, id, t, char, type, item, name, qty, price, deposit, cut, other)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const entry of asList(data.acct)) {
      const e = asMap(entry);
      if (!str(e.id) || !str(e.ty)) continue;
      const res = insAcct.run(realm, faction, e.id, num(e.t), str(e.c), e.ty, str(e.k), str(e.n), num(e.q) ?? 1, num(e.p) ?? 0, num(e.d) ?? 0, num(e.f) ?? 0, str(e.o));
      added.accounting += res.changes;
    }

    for (const [char, rec] of Object.entries(asMap(data.inv))) {
      const r = asMap(rec);
      const t = num(r.t) ?? 0;
      const have = d.prepare('SELECT t, bank_t FROM inventory_meta WHERE realm = ? AND faction = ? AND char = ?').get(realm, faction, char);
      if (have && have.t >= t) continue;
      d.prepare('DELETE FROM inventory WHERE realm = ? AND faction = ? AND char = ?').run(realm, faction, char);
      const bags = asMap(r.bags);
      const bank = asMap(r.bank);
      const ins = d.prepare('INSERT INTO inventory (realm, faction, char, item, bags, bank) VALUES (?,?,?,?,?,?)');
      for (const item of new Set([...Object.keys(bags), ...Object.keys(bank)])) ins.run(realm, faction, char, item, num(bags[item]) ?? 0, num(bank[item]) ?? 0);
      d.prepare('INSERT OR REPLACE INTO inventory_meta (realm, faction, char, t, bank_t) VALUES (?,?,?,?,?)').run(realm, faction, char, t, num(r.bankT));
    }

    for (const [char, rec] of Object.entries(asMap(data.owned))) {
      const r = asMap(rec);
      const t = num(r.t) ?? 0;
      const have = d.prepare('SELECT t FROM owned WHERE realm = ? AND faction = ? AND char = ?').get(realm, faction, char);
      if (have && have.t >= t) continue;
      d.prepare('INSERT OR REPLACE INTO owned (realm, faction, char, t, list) VALUES (?,?,?,?,?)').run(realm, faction, char, t, JSON.stringify(asList(r.list).map((a) => asMap(a))));
    }

    const insGold = d.prepare('INSERT OR IGNORE INTO gold (realm, faction, char, t, copper) VALUES (?,?,?,?,?)');
    for (const [char, flat] of Object.entries(asMap(data.gold))) {
      const list = asList(flat);
      for (let i = 0; i + 1 < list.length; i += 2) insGold.run(realm, faction, char, list[i], list[i + 1]);
    }
    void now;
  }

  // ---- reading ----

  /** [{ realm, faction, lastFullScan, lastScan, scans, items }] for every realm the addon saved. */
  function realms() {
    return all(
      `SELECT realm, faction, MAX(CASE WHEN kind = 'full' THEN t END) AS lastFullScan, MAX(t) AS lastScan,
              SUM(kind = 'full') AS scans FROM scans GROUP BY realm, faction ORDER BY lastScan DESC`,
    ).map((r) => ({ ...r, scans: Number(r.scans), items: get('SELECT COUNT(DISTINCT item) AS n FROM scan_items WHERE realm = ? AND faction = ?', r.realm, r.faction)?.n ?? 0 }));
  }

  function itemInfo() {
    const out = new Map();
    for (const r of all('SELECT * FROM items')) out.set(r.item, r);
    return out;
  }

  /**
   * Everything the analyses and the data file need for one realm and faction, at time `now`:
   * { now, realm, faction, lastFullScan, cutRate, items: Map<item, {...}>, recipes, inventory, owned, vendorBuy }.
   * Each item: { item, name, quality, vendor, points (the latest ladder, [] when none is listed
   * now), mine, scanTime, market, minBuyout, historical, saleRate, avgSell, volatility, crafting }.
   */
  function snapshot(realm, faction, { now = Math.floor(Date.now() / 1000) } = {}) {
    const key = `${realm}|${faction}|${now}|${version}`;
    const hit = cache.get(key);
    if (hit) return hit;
    cache.clear();

    const info = itemInfo();
    const lastFull = get("SELECT MAX(t) AS t FROM scans WHERE realm = ? AND faction = ? AND kind = 'full'", realm, faction)?.t ?? null;

    const latest = new Map();
    for (const r of all(
      `SELECT s.* FROM scan_items s JOIN (SELECT item, MAX(t) AS mt FROM scan_items WHERE realm = ? AND faction = ? GROUP BY item) m
         ON s.item = m.item AND s.t = m.mt WHERE s.realm = ? AND s.faction = ?`,
      realm, faction, realm, faction,
    )) latest.set(r.item, r);

    const obs = new Map();
    for (const r of all('SELECT item, t, qty, points FROM scan_items WHERE realm = ? AND faction = ? AND t >= ?', realm, faction, now - MARKET_DAYS * DAY)) {
      let list = obs.get(r.item);
      if (!list) obs.set(r.item, (list = []));
      list.push({ t: r.t, points: decodePoints(r.points), total: r.qty });
    }

    const daily = new Map();
    const dayRows = all(
      'SELECT item, day, src, scans, min_sum FROM daily WHERE realm = ? AND faction = ? AND day >= ?',
      realm, faction, Math.floor(now / DAY) - HISTORICAL_DAYS,
    );
    const best = new Map(); // item|day → the server's own row, or else the addon's
    for (const r of dayRows) {
      const k = `${r.item}|${r.day}`;
      if (!best.has(k) || r.src === 'scan') best.set(k, r);
    }
    for (const r of best.values()) {
      let list = daily.get(r.item);
      if (!list) daily.set(r.item, (list = []));
      list.push({ day: r.day, scans: r.scans, minSum: r.min_sum });
    }

    const byName = new Map();
    for (const i of info.values()) if (i.name) byName.set(i.name, i.item);
    const sales = new Map();
    for (const r of all(
      `SELECT item, name, type, SUM(qty) AS qty, SUM(price) AS price FROM accounting
       WHERE realm = ? AND faction = ? AND type IN ('sold','expired','cancelled') AND t >= ? GROUP BY item, name, type`,
      realm, faction, now - HISTORICAL_DAYS * DAY,
    )) {
      const item = r.item ?? byName.get(r.name);
      if (!item) continue;
      const s = sales.get(item) ?? { sold: 0, expired: 0, cancelled: 0, soldMoney: 0 };
      s[r.type] += r.qty;
      if (r.type === 'sold') s.soldMoney += r.price;
      sales.set(item, s);
    }

    const vendorBuy = new Map(all('SELECT item, price FROM vendor_buy').map((r) => [r.item, r.price]));
    const items = new Map();
    const ids = new Set([...latest.keys(), ...obs.keys(), ...daily.keys()]);
    for (const item of ids) {
      const row = latest.get(item);
      // Gone from the newest full scan: nothing is listed now.
      const current = row && (lastFull === null || row.t >= lastFull) ? decodePoints(row.points) : [];
      const days = daily.get(item) ?? [];
      const dayMeans = days.map((d) => d.minSum / d.scans);
      const meta = info.get(item);
      items.set(item, {
        item,
        name: meta?.name ?? null,
        quality: meta?.quality ?? null,
        ilvl: meta?.ilvl ?? null,
        class: meta?.class ?? null,
        vendor: meta?.vendor ?? null,
        icon: meta?.icon ?? null,
        stack: meta?.stack ?? null,
        points: normalizePoints(current),
        mine: decodePoints(row?.mine),
        scanTime: row?.t ?? null,
        market: marketValue(obs.get(item), now),
        minBuyout: current.length ? normalizePoints(current)[0][0] : null,
        historical: historicalPrice(days, now),
        volatility: volatility(dayMeans.slice(-MARKET_DAYS)),
        ...(() => {
          const s = saleStats(sales.get(item));
          return { saleRate: s.saleRate, avgSell: s.avgSell };
        })(),
        crafting: null,
      });
    }
    // Items known only from your bags, recipes or accounting still get a row, with no prices.
    const need = (item) => {
      if (items.has(item)) return;
      const meta = info.get(item);
      items.set(item, {
        item, name: meta?.name ?? null, quality: meta?.quality ?? null, ilvl: meta?.ilvl ?? null, class: meta?.class ?? null,
        vendor: meta?.vendor ?? null, icon: meta?.icon ?? null, stack: meta?.stack ?? null, points: [], mine: [], scanTime: null,
        market: null, minBuyout: null, historical: null, volatility: null, saleRate: null, avgSell: null, crafting: null,
      });
    };

    const recipes = all('SELECT * FROM recipes').map((r) => ({
      profession: r.profession, item: r.item, name: r.name ?? info.get(r.item)?.name ?? null, made: r.made || 1, reagents: JSON.parse(r.reagents),
    }));
    for (const rec of recipes) {
      need(rec.item);
      for (const re of rec.reagents) need(re.item);
    }
    const inventory = all(
      'SELECT i.char, i.item, i.bags, i.bank, m.t, m.bank_t AS bankT FROM inventory i JOIN inventory_meta m USING (realm, faction, char) WHERE i.realm = ? AND i.faction = ?',
      realm, faction,
    );
    for (const row of inventory) need(row.item);
    const owned = all('SELECT char, t, list FROM owned WHERE realm = ? AND faction = ?', realm, faction).map((r) => ({ char: r.char, t: r.t, list: JSON.parse(r.list) }));
    for (const o of owned) for (const a of o.list) if (a.k) need(a.k);

    const snap = {
      now, realm, faction, lastFullScan: lastFull, cutRate: faction === 'Neutral' ? 0.15 : 0.05,
      items, recipes, inventory, owned, vendorBuy,
    };
    // Crafting cost per item made: the cheapest recipe for it (reagents at the cheaper of min buyout and market).
    for (const rec of recipes) {
      let cost = 0;
      let known = true;
      for (const re of rec.reagents) {
        const price = reagentUnitCost(snap, re.item);
        if (price === null) known = false;
        else cost += price * re.qty;
      }
      if (!known) continue;
      const each = Math.round(cost / rec.made);
      const it = items.get(rec.item);
      if (it && (it.crafting === null || each < it.crafting)) it.crafting = each;
    }
    cache.set(key, snap);
    return snap;
  }

  /** The price history of one item: daily rows, each scan's numbers and the latest ladder. */
  function itemHistory(realm, faction, item, { now = Math.floor(Date.now() / 1000), days = 30 } = {}) {
    const since = now - days * DAY;
    const scans = all(
      'SELECT t, kind, min_buyout, qty, auctions, points FROM scan_items WHERE realm = ? AND faction = ? AND item = ? AND t >= ? ORDER BY t',
      realm, faction, item, since,
    ).map((r) => ({
      t: r.t, kind: r.kind, minBuyout: r.min_buyout, quantity: r.qty, auctions: r.auctions, points: decodePoints(r.points),
    }));
    const dailyRows = all(
      'SELECT day, src, scans, min_sum FROM daily WHERE realm = ? AND faction = ? AND item = ? AND day >= ? ORDER BY day',
      realm, faction, item, Math.floor(since / DAY),
    );
    const byDay = new Map();
    for (const r of dailyRows) if (!byDay.has(r.day) || r.src === 'scan') byDay.set(r.day, r);
    const daily = [...byDay.values()].sort((a, b) => a.day - b.day).map((r) => ({ day: r.day, t: r.day * DAY, minBuyout: Math.round(r.min_sum / r.scans), scans: r.scans }));
    const listing = get(
      "SELECT t, listings FROM scan_items WHERE realm = ? AND faction = ? AND item = ? AND listings IS NOT NULL ORDER BY t DESC LIMIT 1",
      realm, faction, item,
    );
    return { scans, daily, listings: listing ? { t: listing.t, rows: JSON.parse(listing.listings) } : null };
  }

  /** Accounting rows since `since` (seconds), newest first. */
  function accounting(realm, faction, since) {
    return all(
      `SELECT id, t, char, type, item, name, qty, price, deposit, cut, other FROM accounting
       WHERE realm = ? AND faction = ? AND t >= ? ORDER BY t DESC`,
      realm, faction, since,
    );
  }

  /** { char: [[t, copper], …] } for every character, oldest first. */
  function goldHistory(realm, faction) {
    const out = {};
    for (const r of all('SELECT char, t, copper FROM gold WHERE realm = ? AND faction = ? ORDER BY t', realm, faction)) (out[r.char] ??= []).push([r.t, r.copper]);
    return out;
  }

  function sourceHash(file) {
    return get('SELECT hash FROM sources WHERE path = ?', file)?.hash ?? null;
  }

  function setSourceHash(file, hash, at = Math.floor(Date.now() / 1000)) {
    open().prepare('INSERT OR REPLACE INTO sources (path, hash, ingested) VALUES (?,?,?)').run(file, hash, at);
  }

  function close() {
    db?.close();
    db = null;
  }

  return { ingest, realms, snapshot, itemHistory, accounting, goldHistory, sourceHash, setSourceHash, close, file, exists: () => existsSync(file) };
}

/** What one of a reagent costs to buy: the vendor's price if a vendor sells it, else the lower of min buyout and market. Null when unknown. */
export function reagentUnitCost(snap, item) {
  const vendor = snap.vendorBuy.get(item);
  const it = snap.items.get(item);
  const ah = [it?.minBuyout, it?.market].filter((v) => typeof v === 'number');
  const ahCost = ah.length ? Math.min(...ah) : null;
  if (vendor !== undefined && ahCost !== null) return Math.min(vendor, ahCost);
  return vendor ?? ahCost;
}
