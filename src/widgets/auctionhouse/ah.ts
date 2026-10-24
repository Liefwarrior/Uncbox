import { formatMoney } from '../../money';
import type { AuctionHouseSettings } from './settings';

// What the Auction House widget shows, as plain functions: sorting, the profit maths, the chart's
// scaling, stream-mode hiding. The numbers come from the server (server/wowah.mjs); money is
// whole copper everywhere. The API shapes are written out here so the tabs agree on them.

// ---- what the server sends ----

export interface RealmInfo {
  realm: string;
  faction: string;
  lastFullScan: number | null;
  lastScan: number | null;
  scans: number;
  items?: number;
}

export interface AhStatus {
  available: boolean;
  addonInstalled: boolean;
  flavor: string | null;
  dataFile: string | null;
  lastIngest: number | null;
  realm: string | null;
  faction: string | null;
  lastFullScan: number | null;
  /** Seconds since the last full scan. */
  dataAge: number | null;
  realms: RealmInfo[];
}

export interface ItemRow {
  item: string;
  name: string | null;
  quality: number | null;
  icon: string | null;
  market: number | null;
  minBuyout: number | null;
  historical: number | null;
  saleRate: number | null;
  avgSell: number | null;
  vendor: number | null;
  volatility: number | null;
  quantity: number;
}

export type Ladder = [price: number, quantity: number][];

export interface ScanPoint {
  t: number;
  kind: string;
  minBuyout: number | null;
  quantity: number;
  auctions: number;
  points: Ladder;
}

export interface ItemDetail {
  item: string;
  info: { name: string | null; quality: number | null; ilvl: number | null; class: string | null; vendor: number | null; icon: string | null; stack: number | null };
  prices: {
    market: number | null;
    minBuyout: number | null;
    historical: number | null;
    saleRate: number | null;
    avgSell: number | null;
    volatility: number | null;
    crafting: number | null;
  };
  ladder: Ladder;
  mine: Ladder;
  scanTime: number | null;
  history: { daily: { t: number; minBuyout: number | null; scans: number }[]; scans: ScanPoint[] };
  listings: { t: number; rows: [price: number, count: number, seller: string | null, timeLeft: string | number | null][] } | null;
}

export interface DealRow {
  item: string;
  name: string;
  price: number;
  quantity: number;
  market: number;
  percent: number;
  saleRate: number | null;
  /** All of them, resold at market after the AH's cut. */
  profit: number;
}

export interface FlipRow {
  item: string;
  name: string;
  price: number;
  quantity: number;
  market: number;
  net: number;
  /** Per item, at the cheapest price. */
  profit: number;
  roi: number;
  totalProfit: number;
}

export interface VendorFlipRow {
  item: string;
  name: string;
  price: number;
  quantity: number;
  vendor: number;
  /** Per item. */
  profit: number;
  totalProfit: number;
}

export interface CraftRow {
  profession: string;
  item: string;
  name: string;
  made: number;
  reagents: { item: string; name: string; quantity: number; unitCost: number | null }[];
  cost: number | null;
  value: number | null;
  profit: number | null;
  roi: number | null;
  saleRate: number | null;
  complete: boolean;
}

export interface SellRow {
  item: string;
  name: string;
  quantity: number;
  chars: Record<string, number>;
  unitValue: number;
  value: number;
  minBuyout: number | null;
  saleRate: number | null;
}

export interface UndercutRow {
  char: string;
  item: string;
  name: string;
  quantity: number;
  myPrice: number;
  lowest: number;
  undercutBy: number;
  seen: number;
}

export interface AccountingEntry {
  id: string;
  t: number;
  char: string;
  type: 'sold' | 'bought' | 'expired' | 'cancelled' | 'post' | string;
  item: string | null;
  name: string | null;
  qty: number;
  price: number;
  deposit: number;
  cut: number;
  other: string | null;
}

export interface AccountingSummary {
  sales: number;
  purchases: number;
  expired: number;
  cancelled: number;
  posts: number;
  gross: number;
  cuts: number;
  spent: number;
  depositsLost: number;
  profit: number;
  items: { item: string | null; name: string | null; sold: number; soldMoney: number; bought: number; boughtMoney: number }[];
  days: { day: string; income: number; spent: number }[];
}

export interface GoldSeries {
  total: { t: number; copper: number }[];
  chars: Record<string, { t: number; copper: number }[]>;
  current: number;
}

export interface Group {
  id: string;
  name: string;
  items: string[];
  postOperation: string;
  shopOperation: string;
}

export interface PostOperation {
  id: string;
  name: string;
  kind: 'post';
  minPrice: string;
  normalPrice: string;
  maxPrice: string;
  undercut: number;
  stackSize: number;
  stacks: number;
  duration: number;
  keepQuantity: number;
}

export interface ShopOperation {
  id: string;
  name: string;
  kind: 'shop';
  maxPrice: string;
  minSaleRate: number;
}

export type Operation = PostOperation | ShopOperation;

export interface ShoppingEntry {
  item?: string;
  name?: string;
  maxPrice?: string;
}

export interface ShoppingList {
  id: string;
  name: string;
  items: ShoppingEntry[];
}

export interface DealsSettings {
  percent: number;
  minSaleRate: number;
  minMarket: number;
  watch: number;
}

export interface FormulaResult {
  ok: boolean;
  value?: number | null;
  text?: string | null;
  error?: string;
}

// ---- items ----

/** WoW's quality names, by number (0 poor … 5 legendary). */
export const QUALITY_NAMES = ['Poor', 'Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'] as const;

/**
 * The game's quality colors, lightened where the game's own are too dark to read on the dashboard's
 * dark panels (rare blue, epic purple). Common follows the theme's own text color.
 */
export const QUALITY_COLORS: Record<number, string> = {
  0: '#9d9d9d',
  1: 'var(--text)',
  2: '#1eff00',
  3: '#5aa9ff',
  4: '#c77dff',
  5: '#ff8000',
};

export const qualityColor = (quality: number | null | undefined): string => QUALITY_COLORS[quality ?? 1] ?? QUALITY_COLORS[1];
export const qualityName = (quality: number | null | undefined): string => QUALITY_NAMES[quality ?? 1] ?? QUALITY_NAMES[1];

/** "i:2589" or "i:2589:-45" → 2589; null for anything else. */
export function itemNumber(key: string | null | undefined): number | null {
  const m = /^i:(\d+)(?::-?\d+)?$/.exec(key ?? '');
  return m ? Number(m[1]) : null;
}

/** What to call an item: its name, else "Item 2589". */
export const itemLabel = (name: string | null | undefined, key: string): string => name || (itemNumber(key) !== null ? `Item ${itemNumber(key)}` : key);

/** The Wowhead page of an item, or null when the key isn't an item. */
export const wowheadUrl = (key: string): string | null => {
  const n = itemNumber(key);
  return n === null ? null : `https://www.wowhead.com/classic/item=${n}`;
};

// ---- sorting ----

export type SortKey = 'name' | 'market' | 'minBuyout' | 'historical' | 'saleRate' | 'volatility' | 'quantity';
export type SortOrder = 'asc' | 'desc';
export interface Sort {
  key: SortKey;
  order: SortOrder;
}

/** Numbers start high-to-low, names A-to-Z. */
export const firstOrder = (key: SortKey): SortOrder => (key === 'name' ? 'asc' : 'desc');

/** Clicking a column heading: the same column flips its order, a new one starts at its first. */
export const nextSort = (current: Sort, key: SortKey): Sort => (current.key === key ? { key, order: current.order === 'asc' ? 'desc' : 'asc' } : { key, order: firstOrder(key) });

/** The rows in order. Rows with no value for the column come last either way. Does not change the list given. */
export function sortItems(rows: readonly ItemRow[], { key, order }: Sort): ItemRow[] {
  const value = (r: ItemRow): number | string | null => (key === 'name' ? (r.name ?? r.item) : r[key]);
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === y) return 0;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    const cmp = typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number);
    return order === 'asc' ? cmp : -cmp;
  });
}

// ---- profit and percentages ----

/** What one item earns out of a total (a deal's "profit" is for every item in the row). */
export const perUnit = (total: number, quantity: number): number => (quantity > 0 ? Math.round(total / quantity) : 0);

/** Profit as a share of what the product sells for, or null when either is unknown. */
export const margin = (profit: number | null, value: number | null): number | null => (profit === null || value === null || value <= 0 ? null : profit / value);

/** 0.253 → "25%", 1 → "100%", null → "-". */
export const percent = (share: number | null | undefined, digits = 0): string => (share === null || share === undefined || !Number.isFinite(share) ? '-' : `${(share * 100).toFixed(digits)}%`);

/** What is left of an auction after the AH's cut: the sale price less the share it keeps. */
export const afterCut = (price: number, cutRate = 0.05): number => Math.round(price - price * cutRate);

/** Total value of the things to sell. */
export const totalValue = (rows: readonly { value: number }[]): number => rows.reduce((n, r) => n + r.value, 0);

/** The AH fees an accounting summary paid: its cut of every sale and the deposits of auctions that expired. */
export const feesOf = (s: Pick<AccountingSummary, 'cuts' | 'depositsLost'>): number => s.cuts + s.depositsLost;

/**
 * Money, shortest sensible: 123456 → "12.3g", 4500 → "45s", 72 → "72c". For the axes of a chart.
 */
export function shortMoney(copper: number): string {
  const abs = Math.abs(copper);
  const sign = copper < 0 ? '-' : '';
  if (abs >= 10000) {
    const g = abs / 10000;
    return `${sign}${g >= 100 ? Math.round(g) : Math.round(g * 10) / 10}g`;
  }
  if (abs >= 100) return `${sign}${Math.round(abs / 100)}s`;
  return `${sign}${Math.round(abs)}c`;
}

/** The rows' parts that happened at or after `since` (seconds), as the day's sales and purchases. */
export function dayTotals(entries: readonly AccountingEntry[], since: number) {
  let sold = 0;
  let income = 0;
  let bought = 0;
  let spent = 0;
  for (const e of entries) {
    if (e.t < since) continue;
    if (e.type === 'sold') {
      sold += e.qty;
      income += e.price - e.cut;
    } else if (e.type === 'bought') {
      bought += e.qty;
      spent += e.price;
    }
  }
  return { sold, income, bought, spent };
}

/** Midnight at the start of today in this PC's time zone, in seconds. */
export const startOfToday = (nowMs: number): number => {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
};

// ---- how fresh the data is ----

/** A full scan older than this has stopped telling you what things cost. */
export const STALE_SECONDS = 12 * 3600;

export const isStale = (ageSeconds: number | null): boolean => ageSeconds === null || ageSeconds > STALE_SECONDS;

/** 45 → "just now", 600 → "10 min ago", 7300 → "2 hours ago", 200000 → "2 days ago". */
export function ageLabel(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'never';
  if (seconds < 90) return 'just now';
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return plural(Math.round(seconds / 3600), 'hour');
  return plural(Math.round(seconds / 86400), 'day');
}

// ---- stream mode ----

/** What stands in for a hidden amount. */
export const MASK = '•••';

/** Stream mode (the board is not being edited) hides gold unless the widget's setting says to show it. */
export const hidesGold = (editing: boolean, settings: Pick<AuctionHouseSettings, 'showGoldOnStream'>): boolean => !editing && !settings.showGoldOnStream;

/** Money as text, or the mask while gold is hidden. */
export const goldText = (copper: number | null | undefined, hide: boolean): string => {
  if (copper === null || copper === undefined) return '-';
  return hide ? MASK : formatMoney(copper);
};

// ---- the price chart ----

export interface ChartPoint {
  t: number;
  v: number | null;
}

export interface ChartSeries {
  id: string;
  points: ChartPoint[];
}

export interface Chart {
  width: number;
  height: number;
  /** The plot area inside the margins that hold the labels. */
  plot: { left: number; right: number; top: number; bottom: number };
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  /** Each series as SVG path data, with a break wherever a value is missing. */
  paths: Record<string, string>;
  /** Where each series' real values sit, for dots. */
  dots: Record<string, { x: number; y: number; t: number; v: number }[]>;
  /** Every moment any series has a value, oldest first, with where it sits across. */
  times: { t: number; x: number }[];
  yTicks: { y: number; v: number }[];
  xTicks: { x: number; t: number }[];
  empty: boolean;
}

export const CHART_W = 480;
export const CHART_H = 180;
const MARGIN = { left: 46, right: 10, top: 8, bottom: 22 };

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * Scales series of (time, value) onto a chart of `width` by `height`. The value axis starts a
 * little under the lowest value (never below 0 when all values are positive) so a calm price still
 * shows its wobble; a single flat value is centred. Missing values break the line.
 */
export function lineChart(
  series: readonly ChartSeries[],
  { width = CHART_W, height = CHART_H, margin = {} }: { width?: number; height?: number; margin?: Partial<typeof MARGIN> } = {},
): Chart {
  const m = { ...MARGIN, ...margin };
  const plot = { left: m.left, right: width - m.right, top: m.top, bottom: height - m.bottom };
  const real = series.flatMap((s) => s.points.filter((p): p is { t: number; v: number } => p.v !== null && Number.isFinite(p.v)));
  const base: Chart = { width, height, plot, xMin: 0, xMax: 0, yMin: 0, yMax: 0, paths: {}, dots: {}, times: [], yTicks: [], xTicks: [], empty: real.length === 0 };
  if (real.length === 0) return base;

  const xMin = Math.min(...real.map((p) => p.t));
  const xMax = Math.max(...real.map((p) => p.t));
  let lo = Math.min(...real.map((p) => p.v));
  let hi = Math.max(...real.map((p) => p.v));
  if (hi === lo) {
    const room = Math.max(1, Math.abs(hi) * 0.1);
    lo -= room;
    hi += room;
  } else {
    const room = (hi - lo) * 0.08;
    lo -= room;
    hi += room;
  }
  if (real.every((p) => p.v >= 0)) lo = Math.max(0, lo);
  const yMin = lo;
  const yMax = hi;

  const x = (t: number) => (xMax === xMin ? (plot.left + plot.right) / 2 : plot.left + ((t - xMin) / (xMax - xMin)) * (plot.right - plot.left));
  const y = (v: number) => plot.bottom - ((v - yMin) / (yMax - yMin)) * (plot.bottom - plot.top);

  const paths: Record<string, string> = {};
  const dots: Chart['dots'] = {};
  for (const s of series) {
    let d = '';
    let pen = false;
    dots[s.id] = [];
    for (const p of [...s.points].sort((a, b) => a.t - b.t)) {
      if (p.v === null || !Number.isFinite(p.v)) {
        pen = false;
        continue;
      }
      const px = round(x(p.t));
      const py = round(y(p.v));
      d += `${pen ? 'L' : 'M'}${px} ${py}`;
      pen = true;
      dots[s.id].push({ x: px, y: py, t: p.t, v: p.v });
    }
    paths[s.id] = d;
  }

  const times = [...new Set(real.map((p) => p.t))].sort((a, b) => a - b).map((t) => ({ t, x: round(x(t)) }));
  const yTicks = [0, 1, 2, 3].map((i) => {
    const v = yMin + ((yMax - yMin) * i) / 3;
    return { y: round(y(v)), v: Math.round(v) };
  });
  const xTicks = xMax === xMin ? [{ x: round(x(xMin)), t: xMin }] : [0, 1, 2].map((i) => ({ x: round(plot.left + ((plot.right - plot.left) * i) / 2), t: Math.round(xMin + ((xMax - xMin) * i) / 2) }));
  return { ...base, xMin, xMax, yMin, yMax, paths, dots, times, yTicks, xTicks, empty: false };
}

/** The index in `chart.times` closest to a position across the chart (in the chart's own units), or -1 with no data. */
export function nearestTime(chart: Pick<Chart, 'times'>, x: number): number {
  let best = -1;
  let gap = Infinity;
  chart.times.forEach((p, i) => {
    const g = Math.abs(p.x - x);
    if (g < gap) {
      gap = g;
      best = i;
    }
  });
  return best;
}

/** Where on the chart (its own units) a pointer is, given the svg's box on screen. Not finite when the box has no size. */
export const chartX = (clientX: number, box: { left: number; width: number }, chartWidth = CHART_W): number => ((clientX - box.left) / box.width) * chartWidth;

// ---- price history ----

const SLICE = (total: number) => (total <= 20 ? 0.3 : total >= 200 ? 0.15 : 0.3 - (0.15 * (total - 20)) / 180);

/**
 * One scan's market value, worked out the way the server does it: the cheapest slice of what is
 * listed (30% of a thin market, 15% of a deep one), stopping at the first price more than 1.5 times
 * the one below, averaged by quantity. `total` is how many were listed when the points are only the
 * cheapest ones. Null when nothing is listed.
 */
export function scanMarket(points: Ladder, total = 0): number | null {
  const pts = points.filter(([p, q]) => p > 0 && q > 0).sort((a, b) => a[0] - b[0]);
  if (!pts.length) return null;
  const listed = Math.max(total, pts.reduce((n, [, q]) => n + q, 0));
  const limit = Math.max(1, Math.ceil(SLICE(listed) * listed));
  let taken = 0;
  let sum = 0;
  let previous: number | null = null;
  for (const [price, qty] of pts) {
    if (taken >= limit) break;
    if (previous !== null && price > 1.5 * previous) break;
    const take = Math.min(qty, limit - taken);
    taken += take;
    sum += price * take;
    previous = price;
  }
  return sum / taken;
}

/**
 * An item's price over time as two series: min buyout and market value. From its scans when it has
 * two or more; otherwise from the daily min buyouts (which have no market value).
 */
export function priceSeries(history: ItemDetail['history'] | undefined): ChartSeries[] {
  const scans = (history?.scans ?? []).filter((s) => s.minBuyout !== null || s.points.length > 0);
  const daily = history?.daily ?? [];
  if (scans.length < 2 && daily.length >= 2) {
    return [
      { id: 'market', points: [] },
      { id: 'minBuyout', points: daily.map((d) => ({ t: d.t, v: d.minBuyout })) },
    ];
  }
  return [
    { id: 'market', points: scans.map((s) => ({ t: s.t, v: scanMarket(s.points, s.quantity) })) },
    { id: 'minBuyout', points: scans.map((s) => ({ t: s.t, v: s.minBuyout })) },
  ];
}

/** The gold chart's one series, from the server's gold history. */
export const goldSeries = (gold: Pick<GoldSeries, 'total'> | null | undefined): ChartSeries[] => [{ id: 'gold', points: (gold?.total ?? []).map((p) => ({ t: p.t, v: p.copper })) }];

/** "Mar 3" for a time in seconds. */
export const shortDate = (t: number): string => new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** "Mar 3, 14:05" for a time in seconds. */
export const shortDateTime = (t: number): string => new Date(t * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// ---- groups and shopping lists ----

/** The group's items with this one added (once). */
export const withItem = (items: readonly string[], item: string): string[] => (items.includes(item) ? [...items] : [...items, item]);

/** A shopping list's entries with this item added (once). */
export const withShoppingItem = (entries: readonly ShoppingEntry[], item: string): ShoppingEntry[] => (entries.some((e) => e.item === item) ? [...entries] : [...entries, { item }]);

/** The default operations come with the engine and stay. */
export const isDefaultOperation = (id: string): boolean => id === 'default-post' || id === 'default-shop';
