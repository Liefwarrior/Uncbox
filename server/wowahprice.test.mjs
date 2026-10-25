import { describe, expect, it } from 'vitest';
import {
  DAY,
  ahCut,
  deposit,
  historicalPrice,
  marketValue,
  minBuyout,
  netAfterFees,
  normalizePoints,
  saleStats,
  scanMarketValue,
  sliceFraction,
  totalQuantity,
  volatility,
  withoutMine,
} from './wowahprice.mjs';

const NOW = 1_700_000_000;

describe('a scan’s market value', () => {
  it('takes the cheapest slice of a thin market (30% of the quantity) and averages it by quantity', () => {
    // 20 listed → the cheapest 6 units: 2 at 100, 2 at 110, then 200 is more than 1.5 × 110, so it ends there.
    // (2 × 100 + 2 × 110) / 4 = 105.
    expect(scanMarketValue([[100, 2], [110, 2], [200, 1], [210, 15]])).toBe(105);
  });

  it('stops at the slice, partway through a price if that is where it ends', () => {
    // 10 listed → the cheapest 3 units: 1 at 100 and 2 of the 8 at 120. (100 + 240) / 3.
    expect(scanMarketValue([[100, 1], [120, 8], [500, 1]])).toBeCloseTo(340 / 3, 10);
  });

  it('drops a price more than 1.5 times the one below it, and everything above', () => {
    // 30 listed → 9 units. 100 × 3, 150 (exactly 1.5×: kept) × 3, then 226 (> 1.5 × 150): out.
    expect(scanMarketValue([[100, 3], [150, 3], [226, 4], [230, 20]])).toBeCloseTo((300 + 450) / 6, 10);
    // 225 is exactly 1.5 × 150: kept.
    expect(scanMarketValue([[100, 3], [150, 3], [225, 4], [230, 20]])).toBeCloseTo((300 + 450 + 225 * 3) / 9, 10);
  });

  it('looks at a smaller slice of a deep market', () => {
    expect(sliceFraction(5)).toBe(0.3);
    expect(sliceFraction(20)).toBe(0.3);
    expect(sliceFraction(110)).toBeCloseTo(0.225, 10);
    expect(sliceFraction(200)).toBe(0.15);
    expect(sliceFraction(5000)).toBe(0.15);
    // 1000 listed → 150 units of the 400 at 50 ... all at 50.
    expect(scanMarketValue([[50, 400], [60, 600]])).toBe(50);
    // 200 listed → 30 units: 20 at 10 and 10 of the 40 at 14.
    expect(scanMarketValue([[10, 20], [14, 40], [90, 140]])).toBeCloseTo((200 + 140) / 30, 10);
  });

  it('is the one price when there is one, and nothing when nothing is listed', () => {
    expect(scanMarketValue([[777, 1]])).toBe(777);
    expect(scanMarketValue([[777, 50]])).toBe(777);
    expect(scanMarketValue([])).toBeNull();
    expect(scanMarketValue(undefined)).toBeNull();
    expect(scanMarketValue([[0, 5], [-3, 2], [10, 0]])).toBeNull();
  });

  it('counts the whole quantity when only the cheapest points were kept', () => {
    // Two points of 10 listed, but 100 on the house in all → the slice is 15 units, so both points are inside it.
    expect(scanMarketValue([[100, 10], [110, 10]], 100)).toBe(105);
    // Without the total, the 20 seen would give the 30% slice (6 units).
    expect(scanMarketValue([[100, 10], [110, 10]])).toBe(100);
  });

  it('merges the same price listed twice and sorts', () => {
    expect(normalizePoints([[110, 1], [100, 2], [110, 3], ['x', 1], null])).toEqual([[100, 2], [110, 4]]);
    expect(minBuyout([[110, 1], [100, 2]])).toBe(100);
    expect(minBuyout([])).toBeNull();
    expect(totalQuantity([[110, 1], [100, 2]])).toBe(3);
  });
});

describe('market value over time', () => {
  // Three scans of one item, 1 hour, 1 day and 3 days old, as in the fixture:
  //   today:  80 × 20, 95 × 5, 400 × 15 → 12 units of 80                 = 80
  //   1 day:  90 × 10, 100 × 10, 250 × 10 → 9 units, all at 90            = 90
  //   3 days: 100 × 10, 110 × 10, 300 × 20 → 12 units: 10 at 100, 2 at 110 = 101.667
  const scans = [
    { t: NOW - 3 * DAY, points: [[100, 10], [110, 10], [300, 20]] },
    { t: NOW - DAY, points: [[90, 10], [100, 10], [250, 10]] },
    { t: NOW - 3600, points: [[80, 20], [95, 5], [400, 15]] },
  ];

  it('weights each day by 0.5 ^ (age ÷ 3 days), so today counts most', () => {
    const w1 = 0.5 ** (1 / 3);
    const w3 = 0.5;
    const expected = (80 + w1 * 90 + w3 * (1220 / 12)) / (1 + w1 + w3);
    expect(marketValue(scans, NOW)).toBe(Math.round(expected));
    expect(marketValue(scans, NOW)).toBe(88);
  });

  it('averages the scans of one day before weighing the days', () => {
    const two = [
      { t: NOW - 7200, points: [[100, 1]] },
      { t: NOW - 3600, points: [[200, 1]] },
    ];
    expect(marketValue(two, NOW)).toBe(150);
  });

  it('ignores scans older than 14 days, and scans where the item was not listed', () => {
    const old = [{ t: NOW - 14 * DAY, points: [[5000, 1]] }, { t: NOW - 3600, points: [[100, 1]] }, { t: NOW - 1800, points: [] }];
    expect(marketValue(old, NOW)).toBe(100);
    expect(marketValue([{ t: NOW - 13 * DAY - 3600, points: [[500, 1]] }], NOW)).toBe(500); // 13 days old: still in
    expect(marketValue([{ t: NOW - 20 * DAY, points: [[500, 1]] }], NOW)).toBeNull();
    expect(marketValue([], NOW)).toBeNull();
    expect(marketValue(undefined, NOW)).toBeNull();
  });

  it('can be told another window', () => {
    const obs = [{ t: NOW - 5 * DAY, points: [[100, 1]] }];
    expect(marketValue(obs, NOW, { days: 3 })).toBeNull();
    expect(marketValue(obs, NOW, { days: 7 })).toBe(100);
  });
});

describe('historical, volatility and your sales', () => {
  const today = Math.floor(NOW / DAY);

  it('averages the daily min buyouts over 60 days, weighted by how many scans each day had', () => {
    const daily = [
      { day: today - 10, scans: 1, minSum: 150 },
      { day: today - 5, scans: 2, minSum: 200 }, // two scans: 100 each
      { day: today, scans: 1, minSum: 80 },
      { day: today - 60, scans: 1, minSum: 99999 }, // 61 days back: out
    ];
    expect(historicalPrice(daily, NOW)).toBe(Math.round((150 + 200 + 80) / 4));
    expect(historicalPrice(daily, NOW, 6)).toBe(Math.round((200 + 80) / 3)); // only the last 6 days
    expect(historicalPrice([], NOW)).toBeNull();
    expect(historicalPrice([{ day: today, scans: 0, minSum: 0 }], NOW)).toBeNull();
  });

  it('is the standard deviation over the mean', () => {
    expect(volatility([100, 100, 100])).toBe(0);
    // mean 100, deviations ±50 → variance 2500, sd 50
    expect(volatility([50, 150])).toBeCloseTo(0.5, 10);
    expect(volatility([100])).toBeNull();
    expect(volatility([])).toBeNull();
    expect(volatility([100, 0, -5, NaN, 300])).toBeCloseTo(1 / 2, 10); // only 100 and 300 count
  });

  it('works out sale rate and average sale from sold, expired and cancelled', () => {
    expect(saleStats({ sold: 10, expired: 10, cancelled: 5, soldMoney: 1150 })).toEqual({ saleRate: 0.4, avgSell: 115, sold: 10, failed: 15 });
    expect(saleStats({ sold: 3, soldMoney: 301 })).toEqual({ saleRate: 1, avgSell: 100, sold: 3, failed: 0 });
    expect(saleStats({ expired: 4 })).toEqual({ saleRate: 0, avgSell: null, sold: 0, failed: 4 });
    expect(saleStats({})).toEqual({ saleRate: null, avgSell: null, sold: 0, failed: 0 });
    expect(saleStats()).toEqual({ saleRate: null, avgSell: null, sold: 0, failed: 0 });
  });
});

describe('fees and your own auctions', () => {
  it('knows the AH cut and the deposit', () => {
    expect(ahCut(1000)).toBe(50);
    expect(ahCut(1000, 0.15)).toBe(150);
    expect(ahCut(19)).toBe(0);
    // 15% of the vendor price per 12 hours: 24 hours of a 400 copper item.
    expect(deposit(400)).toBe(120);
    expect(deposit(400, 3, 12)).toBe(180);
    expect(deposit(null)).toBe(0);
    expect(netAfterFees(1000, { vendorSell: 400 })).toBe(1000 - 50 - 120);
    expect(netAfterFees(1000)).toBe(950);
  });

  it('takes your own auctions out of the ladder', () => {
    expect(withoutMine([[80, 20], [95, 5], [400, 15]], [[95, 5]])).toEqual([[80, 20], [400, 15]]);
    expect(withoutMine([[80, 20]], [[80, 5]])).toEqual([[80, 15]]);
    expect(withoutMine([[80, 20]], [[70, 5]])).toEqual([[80, 20]]);
    expect(withoutMine([[80, 20]], undefined)).toEqual([[80, 20]]);
  });
});
