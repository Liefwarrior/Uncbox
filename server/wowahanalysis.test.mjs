import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSavedVariables } from '../integrations/wow/savedvars.mjs';
import { accountingSummary, craftingProfit, deals, flips, goldOverTime, undercuts, vendorFlips, whatToSell } from './wowahanalysis.mjs';
import { createAhDb } from './wowahdb.mjs';
import { FACTION, FIXTURE_NOW as NOW, REALM, fixtureFile } from './wowahfixture.mjs';

// The fixture (see wowahfixture.mjs) gives these, worked out by hand:
//   Linen   market 88  ladder 80×20 95×5 (5 of them yours)   vendor 13   sale rate 0.4
//   Wool    market 181 ladder 100×2 240×6 (2 of them yours)  vendor 41   sale rate 1
//   Silk    market 105 ladder 100×2 110×2 200×1 210×15       vendor 120
//   Bolt of Linen Cloth 260×6 (2 Linen each)      Minor Healing Potion 150×10 (Peacebloom 20, Empty Vial from a vendor for 50)
let dir;
let db;
let snap;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'uncbox-ah-an-'));
  db = createAhDb({ file: path.join(dir, 'wow-ah.db') });
  db.ingest(parseSavedVariables(fixtureFile()).UncboxAHDB, { now: NOW });
  snap = db.snapshot(REALM, FACTION, { now: NOW });
});
afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('deals', () => {
  it('finds listings under 60% of market value', () => {
    const rows = deals(snap);
    // Wool at 100 is 55% of 181. Resold at 181 it nets 181 - 9 (cut) - 100, for both.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ item: 'i:2592', name: 'Wool Cloth', price: 100, quantity: 2, market: 181, saleRate: 1, profit: (181 - 9 - 100) * 2 });
    expect(rows[0].percent).toBeCloseTo(100 / 181, 10);
  });

  it('can be told what share of market, what sale rate and what market value to ask for', () => {
    // 95% of market: Linen at 80 (under 83.6) joins; most profit first.
    expect(deals(snap, { percent: 0.95 }).map((r) => [r.item, r.price, r.quantity, r.profit])).toEqual([['i:2592', 100, 2, 144], ['i:2589', 80, 20, (88 - 4 - 80) * 20]]);
    // Only items you have sold well: Linen (0.4) and Silk (never sold) drop out.
    expect(deals(snap, { percent: 0.95, minSaleRate: 0.5 }).map((r) => r.item)).toEqual(['i:2592']);
    // Only items worth 100 or more: Linen (88) drops out.
    expect(deals(snap, { percent: 0.95, minMarket: 100 }).map((r) => r.item)).toEqual(['i:2592']);
    expect(deals(snap, { percent: 0.95, limit: 1 })).toHaveLength(1);
  });

  it('is empty for an empty snapshot', () => {
    expect(deals({ items: new Map(), cutRate: 0.05 })).toEqual([]);
  });
});

describe('flips', () => {
  it('buys at the listed price and resells at market minus the cut and the deposit', () => {
    const rows = flips(snap);
    // Wool: market 181, cut 9, 24 h deposit 12 → 160 each; buying at 100 leaves 60, for the 2 under that.
    // Linen: market 88, cut 4, deposit 3 → 81; buying at 80 leaves 1, for the 20 at that price.
    expect(rows.map((r) => [r.item, r.price, r.quantity, r.net, r.profit, r.totalProfit])).toEqual([
      ['i:2592', 100, 2, 160, 60, 120],
      ['i:2589', 80, 20, 81, 1, 20],
    ]);
    expect(rows[0].roi).toBeCloseTo(0.6, 10);
  });

  it('asks for a minimum profit and return', () => {
    expect(flips(snap, { minProfit: 50 }).map((r) => r.item)).toEqual(['i:2592']);
    expect(flips(snap, { minRoi: 0.5 }).map((r) => r.item)).toEqual(['i:2592']);
    expect(flips(snap, { minSaleRate: 0.5 }).map((r) => r.item)).toEqual(['i:2592']);
    expect(flips(snap, { minMarket: 1000 })).toEqual([]);
    expect(flips(snap, { minProfit: 1000 })).toEqual([]);
  });

  it('keeps more at a neutral auction house', () => {
    const neutral = { ...snap, cutRate: 0.15 };
    // Wool nets 181 - 27 - 12 = 142 now: 42 profit at 100.
    expect(flips(neutral).find((r) => r.item === 'i:2592')).toMatchObject({ net: 142, profit: 42 });
    expect(flips(neutral).find((r) => r.item === 'i:2589')).toBeUndefined(); // 88 - 13 - 3 = 72 < 80
  });
});

describe('vendor flips', () => {
  it('finds auctions under what a vendor pays', () => {
    expect(vendorFlips(snap).map((r) => [r.item, r.price, r.quantity, r.vendor, r.profit, r.totalProfit])).toEqual([
      ['i:4306', 100, 2, 120, 20, 40],
      ['i:4306', 110, 2, 120, 10, 20],
    ]);
    expect(vendorFlips(snap, { limit: 1 })).toHaveLength(1);
  });
});

describe('crafting profit', () => {
  it('prices reagents at the cheaper of min buyout and market, or the vendor’s price, against the product sold at market minus the cut', () => {
    const rows = craftingProfit(snap);
    expect(rows.map((r) => r.item)).toEqual(['i:2996', 'i:118']); // most profit first
    // Bolt of Linen Cloth: 2 Linen at 80 = 160; sells at 260 - 13 = 247 → 87.
    expect(rows[0]).toMatchObject({ profession: 'Tailoring', name: 'Bolt of Linen Cloth', made: 1, cost: 160, value: 247, profit: 87, complete: true });
    expect(rows[0].reagents).toEqual([{ item: 'i:2589', name: 'Linen Cloth', quantity: 2, unitCost: 80 }]);
    expect(rows[0].roi).toBeCloseTo(87 / 160, 10);
    // Minor Healing Potion: Peacebloom 20 + Empty Vial 50 (vendor, not the 80 on the AH) = 70; sells at 150 - 7 = 143 → 73.
    expect(rows[1]).toMatchObject({ profession: 'Alchemy', cost: 70, value: 143, profit: 73 });
    expect(rows[1].reagents.map((r) => [r.name, r.unitCost])).toEqual([['Peacebloom', 20], ['Empty Vial', 50]]);
  });

  it('filters by profit', () => {
    expect(craftingProfit(snap, { minProfit: 80 }).map((r) => r.item)).toEqual(['i:2996']);
    expect(craftingProfit(snap, { limit: 1 })).toHaveLength(1);
  });

  it('skips recipes it can’t price, unless asked to show them', () => {
    const items = new Map(snap.items);
    items.set('i:999', { item: 'i:999', name: 'Mystery', points: [], market: null, minBuyout: null, historical: null, vendor: null });
    const withMystery = { ...snap, items, recipes: [...snap.recipes, { profession: 'Tailoring', item: 'i:2996', name: 'Bolt', made: 1, reagents: [{ item: 'i:999', qty: 1 }] }] };
    expect(craftingProfit(withMystery)).toHaveLength(2);
    const shown = craftingProfit(withMystery, { includeIncomplete: true });
    expect(shown).toHaveLength(3);
    expect(shown.at(-1)).toMatchObject({ complete: false, cost: null, profit: null });
  });

  it('counts how many a craft makes', () => {
    const recipe = { profession: 'Alchemy', item: 'i:2592', name: 'Wool x3', made: 3, reagents: [{ item: 'i:2589', qty: 1 }] };
    const [row] = craftingProfit({ ...snap, recipes: [recipe] });
    expect(row).toMatchObject({ cost: 80, value: (181 - 9) * 3 });
  });
});

describe('what to sell', () => {
  it('values everything in bags and banks, across characters, most valuable first', () => {
    const rows = whatToSell(snap);
    expect(rows.map((r) => [r.item, r.quantity, r.unitValue, r.value])).toEqual([
      ['i:2589', 40, 88, 3520],
      ['i:2592', 12, 181, 2172],
      ['i:4306', 3, 105, 315],
    ]);
    expect(rows[0]).toMatchObject({ name: 'Linen Cloth', chars: { Lief: 35, Alt: 5 }, minBuyout: 80, saleRate: 0.4 });
    expect(whatToSell(snap, { limit: 2 })).toHaveLength(2);
  });

  it('leaves out what has no price', () => {
    const items = new Map(snap.items);
    const rows = whatToSell({ items, inventory: [{ char: 'A', item: 'i:777', bags: 5, bank: 0 }, { char: 'A', item: 'i:2589', bags: 0, bank: 0 }] });
    expect(rows).toEqual([]);
  });
});

describe('undercut alerts', () => {
  it('lists your last-seen auctions that someone else is cheaper than now, ignoring your own auctions in the ladder', () => {
    expect(undercuts(snap)).toEqual([
      { char: 'Lief', item: 'i:2592', name: 'Wool Cloth', quantity: 2, myPrice: 240, lowest: 100, undercutBy: 140, seen: NOW - 900 },
      { char: 'Lief', item: 'i:2589', name: 'Linen Cloth', quantity: 5, myPrice: 95, lowest: 80, undercutBy: 15, seen: NOW - 900 },
    ]);
    // Tigerseye: yours alone on the ladder, so not undercut.
  });
});

describe('accounting', () => {
  it('adds up sales, buys, cuts, lost deposits and profit', () => {
    const s = accountingSummary(db.accounting(REALM, FACTION, NOW - 30 * 86400));
    expect(s).toMatchObject({
      sales: 11,
      purchases: 10,
      expired: 10,
      cancelled: 5,
      posts: 1,
      gross: 600 + 550 + 300,
      cuts: 30 + 28 + 15,
      spent: 2000,
      depositsLost: 15,
      profit: 1450 - 73 - 2000 - 15,
    });
    expect(s.items.find((i) => i.item === 'i:2589')).toMatchObject({ sold: 10, soldMoney: 1150 - 58 });
    expect(s.items.find((i) => i.item === 'i:2592')).toMatchObject({ bought: 10, boughtMoney: 2000 });
    expect(s.days).toHaveLength(5);
    expect(s.days.every((d, i, a) => i === 0 || a[i - 1].day < d.day)).toBe(true);
  });

  it('is zero for no records', () => {
    expect(accountingSummary([])).toMatchObject({ sales: 0, profit: 0, items: [], days: [] });
  });
});

describe('gold over time', () => {
  it('totals the characters, each holding its last known gold between its own readings', () => {
    const { total, chars } = goldOverTime(db.goldHistory(REALM, FACTION));
    expect(total).toEqual([
      { t: NOW - 172800, copper: 100000 },
      { t: NOW - 86400, copper: 150000 + 20000 },
      { t: NOW - 3600, copper: 180000 + 20000 },
      { t: NOW - 1800, copper: 180000 + 25000 },
    ]);
    expect(chars.Alt).toEqual([{ t: NOW - 86400, copper: 20000 }, { t: NOW - 1800, copper: 25000 }]);
    expect(goldOverTime({})).toEqual({ total: [], chars: {} });
  });
});
