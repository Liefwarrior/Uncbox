import { describe, expect, it } from 'vitest';
import { contrast, over, parseColor, readThemes } from '../../contrast';
import {
  afterCut,
  ageLabel,
  type ChartSeries,
  chartX,
  dayTotals,
  feesOf,
  goldSeries,
  goldText,
  hidesGold,
  isDefaultOperation,
  isStale,
  itemLabel,
  itemNumber,
  type ItemRow,
  lineChart,
  margin,
  MASK,
  nearestTime,
  nextSort,
  perUnit,
  percent,
  priceSeries,
  QUALITY_COLORS,
  qualityColor,
  qualityName,
  scanMarket,
  shortMoney,
  sortItems,
  startOfToday,
  totalValue,
  withItem,
  withShoppingItem,
  wowheadUrl,
} from './ah';
import { cleanAuctionHouseSettings, defaultAuctionHouseSettings, auctionHouseForSharing } from './settings';

const row = (over: Partial<ItemRow>): ItemRow => ({ item: 'i:1', name: 'A', quality: 1, icon: null, market: null, minBuyout: null, historical: null, saleRate: null, avgSell: null, vendor: null, volatility: null, quantity: 0, ...over });

describe('the chart scaling', () => {
  const series: ChartSeries[] = [
    { id: 'a', points: [{ t: 100, v: 1000 }, { t: 200, v: 2000 }, { t: 300, v: 1500 }] },
    { id: 'b', points: [{ t: 100, v: 800 }, { t: 200, v: null }, { t: 300, v: 1200 }] },
  ];

  it('puts time left to right across the plot, and higher values higher up', () => {
    const c = lineChart(series);
    expect(c.empty).toBe(false);
    expect([c.xMin, c.xMax]).toEqual([100, 300]);
    const [first, second, third] = c.dots.a;
    expect(first.x).toBe(c.plot.left);
    expect(third.x).toBe(c.plot.right);
    expect(second.x).toBeGreaterThan(first.x);
    // SVG y grows downward: 2000 is above 1500 is above 1000.
    expect(second.y).toBeLessThan(third.y);
    expect(third.y).toBeLessThan(first.y);
    for (const d of Object.values(c.dots).flat()) {
      expect(d.y).toBeGreaterThanOrEqual(c.plot.top);
      expect(d.y).toBeLessThanOrEqual(c.plot.bottom);
    }
  });

  it('breaks the line where a value is missing', () => {
    const c = lineChart(series);
    expect(c.paths.a.match(/M/g)).toHaveLength(1);
    expect(c.paths.b.match(/M/g)).toHaveLength(2);
    expect(c.dots.b).toHaveLength(2);
  });

  it('starts the value axis a little under the lowest value, and never below zero for prices', () => {
    const c = lineChart(series);
    expect(c.yMin).toBeLessThan(800);
    expect(c.yMin).toBeGreaterThanOrEqual(0);
    expect(c.yMax).toBeGreaterThan(2000);
  });

  it('centres a single point and a flat line instead of dividing by zero', () => {
    const one = lineChart([{ id: 'x', points: [{ t: 50, v: 700 }] }]);
    expect(one.dots.x[0].x).toBe((one.plot.left + one.plot.right) / 2);
    expect(Number.isFinite(one.dots.x[0].y)).toBe(true);
    const flat = lineChart([{ id: 'x', points: [{ t: 1, v: 700 }, { t: 9, v: 700 }] }]);
    expect(flat.yMax).toBeGreaterThan(flat.yMin);
    expect(flat.dots.x.every((d) => Number.isFinite(d.y))).toBe(true);
  });

  it('is empty without values, and draws nothing', () => {
    expect(lineChart([]).empty).toBe(true);
    const none = lineChart([{ id: 'x', points: [{ t: 1, v: null }] }]);
    expect(none.empty).toBe(true);
    expect(none.paths).toEqual({});
  });

  it('labels the value axis and the dates', () => {
    const c = lineChart(series);
    expect(c.yTicks).toHaveLength(4);
    expect(c.yTicks[0].v).toBeLessThan(c.yTicks[3].v);
    expect(c.yTicks[0].y).toBeGreaterThan(c.yTicks[3].y);
    expect(c.xTicks.map((t) => t.t)).toEqual([100, 200, 300]);
  });

  it('finds the point nearest the pointer, for the hover readout', () => {
    const c = lineChart(series);
    expect(c.times.map((t) => t.t)).toEqual([100, 200, 300]);
    expect(nearestTime(c, c.plot.left - 30)).toBe(0);
    expect(nearestTime(c, c.times[1].x + 3)).toBe(1);
    expect(nearestTime(c, 9999)).toBe(2);
    expect(nearestTime({ times: [] }, 5)).toBe(-1);
  });

  it('turns a screen position into a chart position, which is not a number for a box with no size', () => {
    expect(chartX(150, { left: 50, width: 200 }, 480)).toBe(240);
    expect(Number.isFinite(chartX(10, { left: 0, width: 0 }))).toBe(false);
  });

  it('draws a sparkline with no margins', () => {
    const c = lineChart([{ id: 'g', points: [{ t: 1, v: 10 }, { t: 2, v: 20 }] }], { width: 120, height: 32, margin: { left: 2, right: 2, top: 3, bottom: 3 } });
    expect(c.dots.g[0].x).toBe(2);
    expect(c.dots.g[1].x).toBe(118);
  });
});

describe('price history', () => {
  it('works out each scan’s market value the way the server does', () => {
    // A thin market takes the cheapest 30%: 10 listed, so 3 of them.
    expect(scanMarket([[100, 2], [110, 1], [500, 7]])).toBe((100 * 2 + 110) / 3);
    // A price more than 1.5x the one below ends the slice.
    expect(scanMarket([[100, 1], [200, 50]], 100)).toBe(100);
    expect(scanMarket([])).toBeNull();
    expect(scanMarket([[0, 3], [5, 0]])).toBeNull();
  });

  it('draws min buyout and market from the scans when there are two or more', () => {
    const series = priceSeries({
      daily: [],
      scans: [
        { t: 1, kind: 'full', minBuyout: 100, quantity: 10, auctions: 2, points: [[100, 5], [120, 5]] },
        { t: 2, kind: 'full', minBuyout: 90, quantity: 10, auctions: 2, points: [[90, 10]] },
      ],
    });
    expect(series.map((s) => s.id)).toEqual(['market', 'minBuyout']);
    expect(series[1].points.map((p) => p.v)).toEqual([100, 90]);
    expect(series[0].points.map((p) => p.v)).toEqual([100, 90]);
  });

  it('falls back to the daily min buyouts, which have no market value', () => {
    const series = priceSeries({ daily: [{ t: 1, minBuyout: 5, scans: 1 }, { t: 2, minBuyout: 6, scans: 1 }], scans: [] });
    expect(series[0].points).toEqual([]);
    expect(series[1].points.map((p) => p.v)).toEqual([5, 6]);
    expect(priceSeries(undefined).every((s) => s.points.length === 0)).toBe(true);
  });

  it('draws the gold history as one series', () => {
    expect(goldSeries({ total: [{ t: 1, copper: 500 }] })[0].points).toEqual([{ t: 1, v: 500 }]);
    expect(goldSeries(null)[0].points).toEqual([]);
  });
});

describe('sorting the item list', () => {
  const rows = [
    row({ item: 'i:1', name: 'Bar', market: 200, quantity: 5 }),
    row({ item: 'i:2', name: 'Apple', market: null, quantity: 9 }),
    row({ item: 'i:3', name: 'Cloth', market: 900, quantity: 1 }),
    row({ item: 'i:4', name: null, market: 50, quantity: 3 }),
  ];
  const order = (sorted: ItemRow[]) => sorted.map((r) => r.item);

  it('sorts numbers either way, with missing values always last', () => {
    expect(order(sortItems(rows, { key: 'market', order: 'desc' }))).toEqual(['i:3', 'i:1', 'i:4', 'i:2']);
    expect(order(sortItems(rows, { key: 'market', order: 'asc' }))).toEqual(['i:4', 'i:1', 'i:3', 'i:2']);
  });

  it('sorts names A to Z, falling back to the item key', () => {
    expect(order(sortItems(rows, { key: 'name', order: 'asc' }))).toEqual(['i:2', 'i:1', 'i:3', 'i:4']);
  });

  it('sorts by quantity', () => {
    expect(order(sortItems(rows, { key: 'quantity', order: 'desc' }))).toEqual(['i:2', 'i:1', 'i:4', 'i:3']);
  });

  it('leaves the list it was given alone', () => {
    const copy = [...rows];
    sortItems(rows, { key: 'quantity', order: 'asc' });
    expect(rows).toEqual(copy);
  });

  it('flips the order on the same heading and starts a new one high to low (names A to Z)', () => {
    expect(nextSort({ key: 'market', order: 'desc' }, 'market')).toEqual({ key: 'market', order: 'asc' });
    expect(nextSort({ key: 'market', order: 'asc' }, 'market')).toEqual({ key: 'market', order: 'desc' });
    expect(nextSort({ key: 'market', order: 'asc' }, 'saleRate')).toEqual({ key: 'saleRate', order: 'desc' });
    expect(nextSort({ key: 'market', order: 'asc' }, 'name')).toEqual({ key: 'name', order: 'asc' });
  });
});

describe('profit maths', () => {
  it('divides a total over its quantity, rounded, and is 0 for none', () => {
    expect(perUnit(1000, 4)).toBe(250);
    expect(perUnit(100, 3)).toBe(33);
    expect(perUnit(100, 0)).toBe(0);
    expect(perUnit(-90, 3)).toBe(-30);
  });

  it('is profit over what it sells for, or null when either is unknown', () => {
    expect(margin(500, 2000)).toBe(0.25);
    expect(margin(-500, 2000)).toBe(-0.25);
    expect(margin(null, 2000)).toBeNull();
    expect(margin(500, null)).toBeNull();
    expect(margin(500, 0)).toBeNull();
  });

  it('keeps what is left after the AH’s cut', () => {
    expect(afterCut(10000)).toBe(9500);
    expect(afterCut(10000, 0.15)).toBe(8500);
  });

  it('writes percentages, with a dash for nothing', () => {
    expect(percent(0.253)).toBe('25%');
    expect(percent(1)).toBe('100%');
    expect(percent(0.2534, 1)).toBe('25.3%');
    expect(percent(null)).toBe('-');
    expect(percent(Number.NaN)).toBe('-');
  });

  it('adds up what to sell and what the AH took', () => {
    expect(totalValue([{ value: 100 }, { value: 250 }])).toBe(350);
    expect(totalValue([])).toBe(0);
    expect(feesOf({ cuts: 7500, depositsLost: 500 })).toBe(8000);
  });

  it('counts only today’s sales (after the cut) and purchases', () => {
    const entry = (t: number, type: string, qty: number, price: number, cut = 0) => ({ id: `${t}${type}`, t, char: 'Eli', type, item: 'i:1', name: 'A', qty, price, deposit: 0, cut, other: null });
    const midnight = 1_000;
    const totals = dayTotals(
      [entry(1_500, 'sold', 3, 10_000, 500), entry(1_200, 'sold', 1, 2_000, 100), entry(900, 'sold', 9, 99_999, 1), entry(1_100, 'bought', 2, 3_000), entry(1_100, 'expired', 5, 1), entry(1_100, 'post', 1, 0)],
      midnight,
    );
    expect(totals).toEqual({ sold: 4, income: 9_500 + 1_900, bought: 2, spent: 3_000 });
  });

  it('finds the start of today on this PC', () => {
    const noon = new Date(2026, 5, 15, 12, 30).getTime();
    expect(startOfToday(noon)).toBe(new Date(2026, 5, 15, 0, 0).getTime() / 1000);
  });

  it('writes money short for the chart axes', () => {
    expect(shortMoney(123_456)).toBe('12.3g');
    expect(shortMoney(10_000)).toBe('1g');
    expect(shortMoney(1_250_000)).toBe('125g');
    expect(shortMoney(4_500)).toBe('45s');
    expect(shortMoney(72)).toBe('72c');
    expect(shortMoney(-50_000)).toBe('-5g');
  });
});

describe('stream mode', () => {
  it('hides gold while private (on air), unless the widget is set to show it', () => {
    expect(hidesGold(true, { showGoldOnStream: false })).toBe(true);
    expect(hidesGold(true, { showGoldOnStream: true })).toBe(false);
    // Not on air is not private.
    expect(hidesGold(false, { showGoldOnStream: false })).toBe(false);
  });

  it('replaces an amount with the mask, and leaves "no value" as a dash', () => {
    expect(goldText(123_456, false)).toBe('12g 34s 56c');
    expect(goldText(123_456, true)).toBe(MASK);
    expect(goldText(0, true)).toBe(MASK);
    expect(goldText(null, true)).toBe('-');
    expect(goldText(undefined, false)).toBe('-');
    expect(MASK).not.toMatch(/\d/);
  });
});

describe('how fresh the data is', () => {
  it('calls a scan stale after half a day, and no scan stale', () => {
    expect(isStale(null)).toBe(true);
    expect(isStale(3600)).toBe(false);
    expect(isStale(13 * 3600)).toBe(true);
  });

  it('says how long ago in plain words', () => {
    expect(ageLabel(null)).toBe('never');
    expect(ageLabel(30)).toBe('just now');
    expect(ageLabel(600)).toBe('10 min ago');
    expect(ageLabel(3600)).toBe('1 hour ago');
    expect(ageLabel(7300)).toBe('2 hours ago');
    expect(ageLabel(200_000)).toBe('2 days ago');
  });
});

describe('items', () => {
  it('reads item numbers out of keys', () => {
    expect(itemNumber('i:2589')).toBe(2589);
    expect(itemNumber('i:2589:-45')).toBe(2589);
    expect(itemNumber('x:1')).toBeNull();
    expect(itemNumber(null)).toBeNull();
  });

  it('links to Wowhead Classic by item number only', () => {
    expect(wowheadUrl('i:2589')).toBe('https://www.wowhead.com/classic/item=2589');
    expect(wowheadUrl('i:2589:-45')).toBe('https://www.wowhead.com/classic/item=2589');
    expect(wowheadUrl('../etc')).toBeNull();
  });

  it('names an item by its name, else its number', () => {
    expect(itemLabel('Linen Cloth', 'i:2589')).toBe('Linen Cloth');
    expect(itemLabel(null, 'i:2589')).toBe('Item 2589');
    expect(itemLabel('', 'weird')).toBe('weird');
  });

  it('adds an item to a group or list once', () => {
    expect(withItem(['i:1'], 'i:2')).toEqual(['i:1', 'i:2']);
    expect(withItem(['i:1'], 'i:1')).toEqual(['i:1']);
    expect(withShoppingItem([{ item: 'i:1', maxPrice: '1s' }], 'i:2')).toEqual([{ item: 'i:1', maxPrice: '1s' }, { item: 'i:2' }]);
    expect(withShoppingItem([{ item: 'i:1' }], 'i:1')).toEqual([{ item: 'i:1' }]);
  });

  it('knows the default rules, which stay', () => {
    expect(isDefaultOperation('default-post')).toBe(true);
    expect(isDefaultOperation('default-shop')).toBe(true);
    expect(isDefaultOperation('abc')).toBe(false);
  });
});

describe('quality colors', () => {
  it('names and colors every quality, and falls back to common', () => {
    expect([0, 1, 2, 3, 4, 5].map(qualityName)).toEqual(['Poor', 'Common', 'Uncommon', 'Rare', 'Epic', 'Legendary']);
    expect(qualityColor(null)).toBe(QUALITY_COLORS[1]);
    expect(qualityColor(99)).toBe(QUALITY_COLORS[1]);
    expect(qualityName(null)).toBe('Common');
  });

  it('reads at 4.5:1 on the page, panels and insets of every theme', async () => {
    // Read from disk: vitest hands CSS imports back empty. Node's types aren't installed here.
    // @ts-expect-error node:fs only exists in the test runner
    const { readFileSync } = (await import('node:fs')) as { readFileSync: (path: string, encoding: string) => string };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const themes = readThemes(readFileSync(`${cwd}/src/styles.css`, 'utf8'));
    expect(Object.keys(themes).length).toBeGreaterThan(0);
    const plain = (theme: Record<string, string>, name: string) => {
      let v = theme[name];
      for (let n = 0; v?.startsWith('var(') && n < 5; n++) v = theme[v.slice(4, -1).trim()];
      const c = parseColor(v ?? '');
      if (!c) throw new Error(`${name} is not a plain color`);
      return c;
    };
    for (const [name, theme] of Object.entries(themes)) {
      const bg = plain(theme, '--bg').rgb;
      const panel = over(plain(theme, '--panel'), bg);
      const inset = plain(theme, '--panel-2').rgb;
      for (const [quality, color] of Object.entries(QUALITY_COLORS)) {
        // Common follows the theme's own text color, which the theme tests already cover.
        const fg = color.startsWith('var(') ? plain(theme, '--text').rgb : parseColor(color)!.rgb;
        for (const [what, under] of [['page', bg], ['panel', panel], ['inset', inset]] as const) {
          expect(contrast(fg, under), `quality ${quality} on the ${what} of ${name}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});

describe('the widget’s settings', () => {
  it('starts on the overview, with gold hidden on stream', () => {
    expect(defaultAuctionHouseSettings()).toEqual({ tab: 'overview', query: '', realm: '', faction: '', showGoldOnStream: false });
  });

  it('puts a tab it does not know back to the overview and keeps text short', () => {
    const cleaned = cleanAuctionHouseSettings({ ...defaultAuctionHouseSettings(), tab: 'nope' as never, query: 'x'.repeat(500) });
    expect(cleaned.tab).toBe('overview');
    expect(cleaned.query).toHaveLength(80);
    expect(cleanAuctionHouseSettings({ ...defaultAuctionHouseSettings(), tab: 'rules' }).tab).toBe('rules');
  });

  it('leaves the realm, the search and (as the tab’s place) nothing personal in a shared preset', () => {
    const shared = auctionHouseForSharing({ tab: 'deals', query: 'linen', realm: 'Stalagg', faction: 'Alliance', showGoldOnStream: true });
    expect(shared).toEqual({ tab: 'deals', query: '', realm: '', faction: '', showGoldOnStream: true });
  });
});
