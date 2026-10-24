import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSavedVariables } from '../integrations/wow/savedvars.mjs';
import { asList, createAhDb, decodePoints, encodePoints, splitRealmKey } from './wowahdb.mjs';
import { FACTION, FIXTURE_NOW as NOW, REALM, fixtureFile, savedFixture } from './wowahfixture.mjs';

let dir;
let db;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'uncbox-ah-'));
  db = createAhDb({ file: path.join(dir, 'wow-ah.db') });
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const saved = () => parseSavedVariables(fixtureFile()).UncboxAHDB;
const snap = () => db.snapshot(REALM, FACTION, { now: NOW });

describe('the fixture is what the parser reads', () => {
  it('round-trips through the SavedVariables parser', () => {
    const parsed = saved();
    expect(parsed.realms['Stalagg|Alliance'].scans).toHaveLength(3);
    expect(parsed.realms['Stalagg|Alliance'].scans[2].items['i:2589']).toEqual(savedFixture().realms['Stalagg|Alliance'].scans[2].items['i:2589']);
    expect(parsed.recipes.Alchemy['i:118'].r).toEqual(['i:2447', 1, 'i:3371', 1]);
    expect(parsed.realms['Stalagg|Alliance'].pages['i:2589'].L[1]).toEqual([95, 5, 'Lief', 4]);
  });

  it('helps with Lua’s lists and keys', () => {
    expect(asList([1, 2])).toEqual([1, 2]);
    expect(asList({})).toEqual([]);
    expect(asList(undefined)).toEqual([]);
    expect(asList({ 10: 'b', 2: 'a' })).toEqual(['a', 'b']);
    expect(encodePoints([100, 2, 110, 3])).toBe('100:2,110:3');
    expect(encodePoints({})).toBe('');
    expect(decodePoints('100:2,110:3')).toEqual([[100, 2], [110, 3]]);
    expect(decodePoints('')).toEqual([]);
    expect(splitRealmKey('Stalagg|Alliance')).toEqual({ realm: 'Stalagg', faction: 'Alliance' });
    expect(splitRealmKey('nope')).toBeNull();
    expect(splitRealmKey('|Alliance')).toBeNull();
  });
});

describe('ingest', () => {
  it('reads everything the addon saved, per realm and faction', () => {
    const added = db.ingest(saved(), { now: NOW });
    expect(added).toMatchObject({ scans: 3, scanItems: 3 * 0 + 2 + 2 + 8 + 1, accounting: 7, realms: ['Stalagg|Alliance'] });
    expect(db.realms()).toEqual([{ realm: 'Stalagg', faction: 'Alliance', lastFullScan: NOW - 3600, lastScan: NOW - 3600, scans: 3, items: 8 }]);
    expect(db.accounting(REALM, FACTION, 0)).toHaveLength(7);
    expect(db.goldHistory(REALM, FACTION)).toEqual({
      Lief: [[NOW - 172800, 100000], [NOW - 86400, 150000], [NOW - 3600, 180000]],
      Alt: [[NOW - 86400, 20000], [NOW - 1800, 25000]],
    });
  });

  it('adds nothing when the same file is read again', () => {
    db.ingest(saved(), { now: NOW });
    const before = JSON.stringify({ realms: db.realms(), snap: [...snap().items.values()], acct: db.accounting(REALM, FACTION, 0), gold: db.goldHistory(REALM, FACTION) });
    const again = db.ingest(saved(), { now: NOW });
    expect(again).toMatchObject({ scans: 0, scanItems: 0, accounting: 0 });
    expect(JSON.stringify({ realms: db.realms(), snap: [...snap().items.values()], acct: db.accounting(REALM, FACTION, 0), gold: db.goldHistory(REALM, FACTION) })).toBe(before);
  });

  it('adds only what is new when the addon has saved more since', () => {
    db.ingest(saved(), { now: NOW });
    const later = savedFixture();
    const realm = later.realms['Stalagg|Alliance'];
    realm.scans.shift(); // the addon keeps the latest few, so the oldest is gone from the file
    realm.scans.push({ t: NOW - 60, kind: 'full', n: 1, items: { 'i:2589': { mb: 70, q: 10, a: 1, p: [70, 10] } } });
    realm.acct.push({ id: 'Lief:sold:8:h', t: NOW - 30, c: 'Lief', ty: 'sold', k: 'i:2589', n: 'Linen Cloth', q: 1, p: 100, d: 0, f: 5 });
    realm.gold.Lief.push(NOW - 10, 190000);
    const added = db.ingest(later, { now: NOW });
    expect(added).toMatchObject({ scans: 1, scanItems: 1, accounting: 1 });
    expect(db.realms()[0]).toMatchObject({ scans: 4, lastFullScan: NOW - 60 });
    expect(db.goldHistory(REALM, FACTION).Lief.at(-1)).toEqual([NOW - 10, 190000]);
  });

  it('keeps realms and factions apart', () => {
    const file = saved();
    file.realms['Stalagg|Horde'] = { scans: [{ t: NOW - 100, kind: 'full', n: 1, items: { 'i:2589': { mb: 5, q: 1, a: 1, p: [5, 1] } } }] };
    db.ingest(file, { now: NOW });
    expect(db.realms().map((r) => `${r.realm}|${r.faction}`).sort()).toEqual(['Stalagg|Alliance', 'Stalagg|Horde']);
    expect(db.snapshot('Stalagg', 'Horde', { now: NOW }).items.get('i:2589').minBuyout).toBe(5);
    expect(snap().items.get('i:2589').minBuyout).toBe(80);
  });

  it('survives a file with nothing, or odd things, in it', () => {
    expect(db.ingest(undefined)).toMatchObject({ scans: 0, realms: [] });
    expect(db.ingest({})).toMatchObject({ scans: 0 });
    expect(db.ingest({ realms: { 'bad key': {}, 'A|B': { scans: [{ kind: 'full' }, { t: 'x' }, 5], acct: [{ id: 5 }, {}], gold: { C: [1] } } } })).toMatchObject({ scans: 0, accounting: 0, realms: ['A|B'] });
    expect(db.realms()).toEqual([]);
  });

  it('drops scan rows after 30 days but keeps the daily numbers', () => {
    const file = savedFixture(NOW);
    file.realms['Stalagg|Alliance'].scans = [{ t: NOW - 40 * 86400, kind: 'full', n: 1, items: { 'i:2589': { mb: 70, q: 10, a: 1, p: [70, 10] } } }];
    db.ingest(file, { now: NOW });
    const history = db.itemHistory(REALM, FACTION, 'i:2589', { now: NOW, days: 60 });
    expect(history.scans.filter((s) => s.kind === 'full')).toEqual([]);
    expect(history.daily.find((d) => d.t === Math.floor((NOW - 40 * 86400) / 86400) * 86400)).toMatchObject({ minBuyout: 70 });
  });

  it('remembers which file text it has read', () => {
    expect(db.sourceHash('x.lua')).toBeNull();
    db.ingest(saved(), { now: NOW });
    db.setSourceHash('x.lua', 'abc', NOW);
    expect(db.sourceHash('x.lua')).toBe('abc');
    db.setSourceHash('x.lua', 'def', NOW);
    expect(db.sourceHash('x.lua')).toBe('def');
  });

  it('answers with nothing, and makes no file, before anything was ingested', () => {
    expect(db.exists()).toBe(false);
    expect(db.realms()).toEqual([]);
    expect(db.accounting(REALM, FACTION, 0)).toEqual([]);
    expect(db.goldHistory(REALM, FACTION)).toEqual({});
    expect(snap().items.size).toBe(0);
    expect(db.sourceHash('x')).toBeNull();
    expect(db.exists()).toBe(false);
  });
});

describe('the prices it works out', () => {
  beforeEach(() => db.ingest(saved(), { now: NOW }));

  it('gives the numbers worked out by hand in the fixture', () => {
    const linen = snap().items.get('i:2589');
    expect(linen).toMatchObject({
      name: 'Linen Cloth',
      market: 88, // 80 today, 90 yesterday, 101.67 three days ago, weighted 1 : 0.79 : 0.5
      minBuyout: 80,
      historical: 115, // (150 + 140 + 130 + 100 + 90 + 80) ÷ 6
      saleRate: 0.4, // 10 sold, 10 expired, 5 cancelled
      avgSell: 115, // (600 + 550) ÷ 10
      vendor: 13,
      points: [[80, 20], [95, 5]], // from the search half an hour ago, newer than the full scan
      mine: [[95, 5]],
    });
    expect(linen.volatility).toBeGreaterThan(0);
    const silk = snap().items.get('i:4306');
    expect(silk).toMatchObject({ market: 105, minBuyout: 100, historical: 100, saleRate: null, avgSell: null, vendor: 120 });
  });

  it('knows an item that has gone from the newest full scan has nothing listed now', () => {
    const file = savedFixture();
    file.realms['Stalagg|Alliance'].scans.push({ t: NOW - 60, kind: 'full', n: 1, items: { 'i:2589': { mb: 70, q: 10, a: 1, p: [70, 10] } } });
    db.ingest(file, { now: NOW });
    const wool = snap().items.get('i:2592');
    expect(wool.points).toEqual([]);
    expect(wool.minBuyout).toBeNull();
    expect(wool.market).toBeGreaterThan(0); // it still has a market value from the days before
    expect(snap().items.get('i:2589').minBuyout).toBe(70);
  });

  it('a search newer than the full scan is the latest word on an item', () => {
    const file = savedFixture();
    file.realms['Stalagg|Alliance'].pages['i:2592'] = { t: NOW - 60, mb: 90, q: 1, a: 1, p: [90, 1] };
    db.ingest(file, { now: NOW });
    expect(snap().items.get('i:2592').points).toEqual([[90, 1]]);
  });

  it('sale rate and average sale use sales matched by item name when the mail had no item', () => {
    const wool = snap().items.get('i:2592');
    expect(wool.saleRate).toBe(1);
    expect(wool.avgSell).toBe(300);
  });

  it('works out what crafting costs, with vendor prices where a vendor sells the reagent', () => {
    const s = snap();
    // Bolt of Linen Cloth: 2 Linen Cloth at min(min buyout 80, market 88) = 80 each.
    expect(s.items.get('i:2996').crafting).toBe(160);
    // Minor Healing Potion: Peacebloom 20 (AH) + Empty Vial 50 (vendor, cheaper than 80 on the AH).
    expect(s.items.get('i:118').crafting).toBe(70);
    expect(s.vendorBuy.get('i:3371')).toBe(50);
    expect(s.recipes.map((r) => r.item).sort()).toEqual(['i:118', 'i:2996']);
  });

  it('uses 15% for a neutral auction house', () => {
    expect(snap().cutRate).toBe(0.05);
    const file = savedFixture();
    file.realms['Booty|Neutral'] = { scans: [{ t: NOW - 10, kind: 'full', n: 1, items: { 'i:2589': { mb: 9, q: 1, a: 1, p: [9, 1] } } }] };
    db.ingest(file, { now: NOW });
    expect(db.snapshot('Booty', 'Neutral', { now: NOW }).cutRate).toBe(0.15);
  });

  it('shows an item’s price history, daily and per scan', () => {
    const h = db.itemHistory(REALM, FACTION, 'i:2589', { now: NOW, days: 30 });
    expect(h.scans.map((s) => [s.t, s.kind, s.minBuyout, s.quantity])).toEqual([
      [NOW - 3 * 86400, 'full', 100, 40],
      [NOW - 86400, 'full', 90, 30],
      [NOW - 3600, 'full', 80, 40],
      [NOW - 1800, 'page', 80, 25],
    ]);
    expect(h.daily.map((d) => d.minBuyout)).toEqual([150, 140, 130, 100, 90, 80]);
    expect(h.listings).toEqual({ t: NOW - 1800, rows: [[80, 20, 'Rival', 3], [95, 5, 'Lief', 4]] });
    expect(db.itemHistory(REALM, FACTION, 'i:9999', { now: NOW })).toEqual({ scans: [], daily: [], listings: null });
  });
});
