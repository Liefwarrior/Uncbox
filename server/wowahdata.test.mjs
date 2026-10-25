import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseSavedVariables } from '../integrations/wow/savedvars.mjs';
import { createAhDb } from './wowahdb.mjs';
import { FACTION, FIXTURE_NOW as NOW, REALM, REALM_KEY, fixtureFile } from './wowahfixture.mjs';
import { buildRealmData, priceFor, readDataFile, renderDataFile, rulesFor } from './wowahdata.mjs';
import { DEFAULT_POST, DEFAULT_SHOP, createAhStore } from './wowahstore.mjs';

let dir;
let db;
let snap;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'uncbox-ah-data-'));
  db = createAhDb({ file: path.join(dir, 'wow-ah.db') });
  db.ingest(parseSavedVariables(fixtureFile()).UncboxAHDB, { now: NOW });
  snap = db.snapshot(REALM, FACTION, { now: NOW });
});
afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

let store;
beforeEach(async () => {
  store = createAhStore({ file: path.join(dir, `rules-${Math.random().toString(36).slice(2)}.json`) });
});

/** Lua turns empty lists into empty tables and drops missing keys: compare ignoring both. */
function same(actual, expected, where = '') {
  if (Array.isArray(expected) && expected.length === 0) {
    expect(actual && Object.keys(actual).length, where).toBe(0);
  } else if (expected && typeof expected === 'object') {
    const keys = Object.keys(expected).filter((k) => expected[k] !== undefined);
    expect(Object.keys(actual).sort(), where).toEqual(keys.sort());
    for (const k of keys) same(actual[k], expected[k], `${where}.${k}`);
  } else expect(actual, where).toEqual(expected);
}

describe('rules store', () => {
  it('starts with the two default operations and sensible deal settings', async () => {
    const ops = await store.operations.list();
    expect(ops.map((o) => o.id)).toEqual([DEFAULT_POST.id, DEFAULT_SHOP.id]);
    expect(ops[0]).toMatchObject({ kind: 'post', undercut: 1, stackSize: 1, stacks: 1, duration: 24, keepQuantity: 0 });
    expect(ops[1]).toMatchObject({ kind: 'shop', minSaleRate: 0 });
    expect(await store.deals()).toEqual({ percent: 0.6, minMarket: 5000, minSaleRate: 0, watch: 40 });
    expect(await store.groups.list()).toEqual([]);
  });

  it('saves operations, groups and shopping lists, and finds them after a restart', async () => {
    const op = await store.operations.put({ kind: 'post', name: 'Cloth posting', minPrice: '50% dbmarket', normalPrice: 'dbmarket', maxPrice: '2g', undercut: 5, stackSize: 20, stacks: 3, duration: 12, keepQuantity: 10 });
    expect(op).toMatchObject({ kind: 'post', name: 'Cloth posting', undercut: 5, duration: 12 });
    expect(op.id).toMatch(/^[\w-]{8}$/);
    const group = await store.groups.put({ name: 'Cloth', items: ['i:2589', 'i:2592', 'i:2589'], postOperation: op.id });
    expect(group).toMatchObject({ name: 'Cloth', items: ['i:2589', 'i:2592'], postOperation: op.id, shopOperation: DEFAULT_SHOP.id });
    const list = await store.shopping.put({ name: 'Mats', items: [{ item: 'i:2589', maxPrice: '1g' }, { name: 'Wool Cloth' }, 'i:3000'] });
    expect(list.items).toEqual([{ item: 'i:2589', maxPrice: '1g' }, { name: 'Wool Cloth' }, { item: 'i:3000' }]);
    expect(await store.setDeals({ percent: 0.5, minSaleRate: 0.2 })).toEqual({ percent: 0.5, minMarket: 5000, minSaleRate: 0.2, watch: 40 });
  });

  it('keeps what it saved in its file, atomically, and reads it back', async () => {
    const file = path.join(dir, 'persist.json');
    const a = createAhStore({ file });
    const op = await a.operations.put({ kind: 'shop', name: 'Cheap', maxPrice: '50% dbmarket', minSaleRate: 0.25 });
    await a.groups.put({ name: 'G', items: ['i:1'], shopOperation: op.id });
    await a.setDeals({ percent: 0.45 });
    const b = createAhStore({ file });
    expect((await b.operations.list()).map((o) => o.name)).toEqual(['Default posting', 'Default shopping', 'Cheap']);
    expect((await b.groups.list())[0]).toMatchObject({ name: 'G', shopOperation: op.id });
    expect((await b.deals()).percent).toBe(0.45);
  });

  it('changes an operation in place, and 404s for ones that are not there', async () => {
    const op = await store.operations.put({ kind: 'post', name: 'One' });
    const changed = await store.operations.put({ name: 'One renamed', undercut: 9 }, op.id);
    expect(changed).toMatchObject({ id: op.id, kind: 'post', name: 'One renamed', undercut: 9, stackSize: 1 });
    expect((await store.operations.list()).filter((o) => o.id === op.id)).toHaveLength(1);
    await expect(store.operations.put({ name: 'x' }, 'nope')).rejects.toMatchObject({ status: 404 });
    await expect(store.groups.remove('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('refuses nonsense with a message that says what is wrong', async () => {
    const bad = (promise, message) => expect(promise).rejects.toMatchObject({ status: 400, message: expect.stringContaining(message) });
    await bad(store.operations.put({ kind: 'what', name: 'x' }), 'either "post" or "shop"');
    await bad(store.operations.put({ kind: 'post', name: '' }), 'needs a name');
    await bad(store.operations.put({ kind: 'post', name: 'x', minPrice: 'dbmarket +' }), 'Min price: The formula ends too soon');
    await bad(store.operations.put({ kind: 'post', name: 'x', maxPrice: 'bogus' }), 'Unknown price "bogus"');
    await bad(store.operations.put({ kind: 'post', name: 'x', duration: 7 }), '12, 24 or 48');
    await bad(store.operations.put({ kind: 'post', name: 'x', stackSize: 0 }), 'Stack size must be a whole number');
    await bad(store.operations.put({ kind: 'post', name: 'x', undercut: -1 }), 'Undercut must be');
    await bad(store.operations.put({ kind: 'shop', name: 'x', minSaleRate: 2 }), 'between 0 and 1');
    await bad(store.groups.put({ name: 'g', items: ['2589'] }), 'written like i:2589');
    await bad(store.groups.put({ name: 'g', items: [], postOperation: 'nope' }), 'no posting operation "nope"');
    await bad(store.groups.put({ name: 'g', items: [], shopOperation: DEFAULT_POST.id }), 'no shopping operation');
    await bad(store.shopping.put({ name: 'l', items: [{}] }), 'needs an item or a name');
    await bad(store.shopping.put({ name: 'l', items: [{ name: 'x', maxPrice: '1 +' }] }), 'Max price');
    await bad(store.setDeals({ percent: 5 }), 'between 0 and 1');
    await bad(store.operations.put(null), 'isn’t an operation');
  });

  it('keeps the default operations, and moves groups off an operation that is deleted', async () => {
    await expect(store.operations.remove(DEFAULT_POST.id)).rejects.toMatchObject({ status: 400 });
    const op = await store.operations.put({ kind: 'post', name: 'Mine' });
    const g = await store.groups.put({ name: 'G', items: [], postOperation: op.id });
    await store.operations.remove(op.id);
    expect((await store.groups.get(g.id)).postOperation).toBe(DEFAULT_POST.id);
  });
});

describe('the prices and rules handed to the addon', () => {
  it('works formulas out to copper for an item', () => {
    const linen = snap.items.get('i:2589'); // market 88, min buyout 80, historical 115, vendor 13
    expect(priceFor('dbmarket', linen)).toBe(88);
    expect(priceFor('max(vendorsell, 70% dbmarket)', linen)).toBe(62); // 61.6 rounded
    expect(priceFor('dbhistorical', snap.items.get('i:4306'))).toBe(100);
    expect(priceFor('avgsell', snap.items.get('i:4306'))).toBeNull(); // never sold
    expect(priceFor('crafting', snap.items.get('i:2996'))).toBe(160);
    expect(priceFor('nonsense', linen)).toBeNull();
    const rule = rulesFor(linen, DEFAULT_POST, DEFAULT_SHOP, 'Cloth');
    expect(rule).toEqual({ group: 'Cloth', min: 62, normal: 88, max: 264, undercut: 1, stackSize: 1, stacks: 1, duration: 24, keep: 0, shopMax: 70, shopMinRate: undefined });
  });

  it('lists prices for items with any, rules for grouped and carried items, shopping lists and deal watches', async () => {
    const op = await store.operations.put({ kind: 'post', name: 'Cloth', minPrice: '50c', normalPrice: '1g', maxPrice: '2g', undercut: 5, stackSize: 20, stacks: 3, duration: 12, keepQuantity: 10 });
    await store.groups.put({ name: 'Cloth', items: ['i:2589', 'i:2592'], postOperation: op.id });
    await store.groups.put({ name: 'Also linen', items: ['i:2589', 'i:2996'] }); // linen is in the first group already
    await store.shopping.put({
      name: 'Mats',
      items: [{ item: 'i:2589', maxPrice: '2g50s' }, { name: 'wool cloth', maxPrice: '90% dbmarket' }, { item: 'i:4306' }, { name: 'Unknown thing' }],
    });
    await store.setDeals({ minMarket: 100, watch: 3 });
    const data = buildRealmData(snap, await store.load());

    expect(data.scanTime).toBe(NOW - 3600);
    expect(data.cut).toBe(0.05);
    expect(data.items['i:2589']).toEqual({ market: 88, minBuyout: 80, historical: 115, saleRate: 0.4, avgSell: 115, vendor: 13 });
    expect(Object.keys(data.items)).toHaveLength(8);
    // Linen follows the first group's operation; the bolt (second group only) the default.
    expect(data.rules['i:2589']).toMatchObject({ group: 'Cloth', min: 50, normal: 10000, max: 20000, undercut: 5, stackSize: 20, stacks: 3, duration: 12, keep: 10, shopMax: 70 });
    expect(data.rules['i:2996']).toMatchObject({ group: 'Also linen', min: 182, normal: 260, max: 780, undercut: 1 });
    // Carried items without a group get the default operations.
    expect(data.rules['i:4306']).toMatchObject({ min: 120, normal: 105, max: 315 }); // the vendor price beats 70% of market
    expect(data.rules['i:4306'].group).toBeUndefined();
    expect(Object.keys(data.rules).sort()).toEqual(['i:2589', 'i:2592', 'i:2996', 'i:4306']);

    expect(data.shopping).toEqual([
      {
        name: 'Mats',
        items: [
          { item: 'i:2589', name: 'Linen Cloth', maxPrice: 25000 },
          { item: 'i:2592', name: 'wool cloth', maxPrice: 163 }, // 90% of 181.14 → 163
          { item: 'i:4306', name: 'Silk Cloth', maxPrice: 84 }, // the default shopping rule: 80% of 105
          { name: 'Unknown thing' },
        ],
      },
    ]);
    expect(data.deals.watch).toEqual([
      { item: 'i:818', name: 'Tigerseye' },
      { item: 'i:2996', name: 'Bolt of Linen Cloth' },
      { item: 'i:2592', name: 'Wool Cloth' },
    ]);
    expect(data.deals).toMatchObject({ percent: 0.6, minMarket: 100, minSaleRate: 0 });
  });

  it('writes a file the addon’s Lua can load, which parses back to the same tables', async () => {
    await store.groups.put({ name: 'Cloth', items: ['i:2589'] });
    await store.shopping.put({ name: 'Mats', items: [{ item: 'i:2589', maxPrice: '1g' }] });
    const realm = buildRealmData(snap, await store.load());
    const text = renderDataFile({ [REALM_KEY]: realm }, NOW);
    expect(text).toMatch(/^-- Written by Uncbox/);
    expect(text).toContain('UncboxAHData = {');
    expect(text).not.toMatch(/undefined|NaN|function/);
    const parsed = readDataFile(text);
    expect(parsed).toMatchObject({ version: 1, generated: NOW });
    same(parsed.realms[REALM_KEY], JSON.parse(JSON.stringify(realm)), 'realm');
    // Item keys stay text (they are not numbers), and every number is a whole number of copper or a rate.
    expect(Object.keys(parsed.realms[REALM_KEY].items)).toContain('i:2589');
    expect(parseSavedVariables(text).UncboxAHData.realms[REALM_KEY].items['i:2589'].market).toBe(88);
  });

  it('writes an empty file for no realms', () => {
    expect(readDataFile(renderDataFile({}, 5))).toMatchObject({ version: 1, generated: 5 });
  });
});
