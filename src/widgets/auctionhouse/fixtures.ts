import type {
  AccountingEntry,
  AccountingSummary,
  AhStatus,
  CraftRow,
  DealRow,
  DealsSettings,
  FlipRow,
  GoldSeries,
  Group,
  ItemDetail,
  ItemRow,
  Operation,
  SellRow,
  ShoppingList,
  UndercutRow,
  VendorFlipRow,
} from './ah';

// What the auction house routes answer, for the tests (and the page's smoke test, which draws
// every widget against a faked server). `empty` is a fresh install; `data` has a scanned realm.

export type AhScenario = 'empty' | 'data';
export interface AhReply {
  status?: number;
  body: unknown;
}

const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;
const DAY = 86400;

export const STATUS_EMPTY: AhStatus = { available: true, addonInstalled: false, flavor: null, dataFile: null, lastIngest: null, realm: null, faction: null, lastFullScan: null, dataAge: null, realms: [] };

export const STATUS_DATA: AhStatus = {
  available: true,
  addonInstalled: true,
  flavor: '_classic_beta_',
  dataFile: 'C:\\WoW\\Interface\\AddOns\\UncboxAH\\UncboxAHData.lua',
  lastIngest: NOW - 60,
  realm: 'Stalagg',
  faction: 'Alliance',
  lastFullScan: NOW - 2 * HOUR,
  dataAge: 2 * HOUR,
  realms: [{ realm: 'Stalagg', faction: 'Alliance', lastFullScan: NOW - 2 * HOUR, lastScan: NOW - 2 * HOUR, scans: 5, items: 3 }],
};

export const ITEMS: ItemRow[] = [
  { item: 'i:2589', name: 'Linen Cloth', quality: 1, icon: null, market: 1200, minBuyout: 1000, historical: 1100, saleRate: 0.8, avgSell: 1150, vendor: 13, volatility: 0.12, quantity: 540 },
  { item: 'i:12360', name: 'Arcanite Bar', quality: 3, icon: null, market: 520000, minBuyout: 480000, historical: 500000, saleRate: 0.3, avgSell: null, vendor: 0, volatility: 0.4, quantity: 12 },
  { item: 'i:19019', name: 'Thunderfury, Blessed Blade of the Windseeker', quality: 5, icon: null, market: null, minBuyout: 90000000, historical: null, saleRate: null, avgSell: null, vendor: null, volatility: null, quantity: 1 },
];

export const DETAIL: ItemDetail = {
  item: 'i:2589',
  info: { name: 'Linen Cloth', quality: 1, ilvl: 5, class: 'Trade Goods', vendor: 13, icon: null, stack: 20 },
  prices: { market: 1200, minBuyout: 1000, historical: 1100, saleRate: 0.8, avgSell: 1150, volatility: 0.12, crafting: null },
  ladder: [
    [1000, 40],
    [1100, 120],
    [1500, 380],
  ],
  mine: [[1100, 20]],
  scanTime: NOW - 2 * HOUR,
  history: {
    daily: [
      { t: NOW - 3 * DAY, minBuyout: 900, scans: 1 },
      { t: NOW - 2 * DAY, minBuyout: 1100, scans: 1 },
      { t: NOW - DAY, minBuyout: 1050, scans: 1 },
    ],
    scans: [
      { t: NOW - 3 * DAY, kind: 'full', minBuyout: 900, quantity: 500, auctions: 40, points: [[900, 30], [1200, 100], [1400, 370]] },
      { t: NOW - 2 * DAY, kind: 'full', minBuyout: 1100, quantity: 480, auctions: 38, points: [[1100, 50], [1300, 130], [1500, 300]] },
      { t: NOW - DAY, kind: 'full', minBuyout: 1050, quantity: 520, auctions: 41, points: [[1050, 60], [1250, 120], [1500, 340]] },
      { t: NOW - 2 * HOUR, kind: 'full', minBuyout: 1000, quantity: 540, auctions: 44, points: [[1000, 40], [1100, 120], [1500, 380]] },
    ],
  },
  listings: { t: NOW - 2 * HOUR, rows: [[1000, 20, 'Seller', 'Long']] },
};

export const DEALS: DealRow[] = [{ item: 'i:12360', name: 'Arcanite Bar', price: 250000, quantity: 3, market: 520000, percent: 0.48, saleRate: 0.3, profit: 700000 }];
export const FLIPS: FlipRow[] = [{ item: 'i:2589', name: 'Linen Cloth', price: 1000, quantity: 40, market: 1200, net: 1100, profit: 100, roi: 0.1, totalProfit: 4000 }];
export const VENDOR_FLIPS: VendorFlipRow[] = [{ item: 'i:4306', name: 'Silk Cloth', price: 300, quantity: 10, vendor: 500, profit: 200, totalProfit: 2000 }];
export const CRAFTING: CraftRow[] = [
  {
    profession: 'Tailoring',
    item: 'i:2996',
    name: 'Bolt of Linen Cloth',
    made: 1,
    reagents: [{ item: 'i:2589', name: 'Linen Cloth', quantity: 2, unitCost: 1000 }],
    cost: 2000,
    value: 3000,
    profit: 1000,
    roi: 0.5,
    saleRate: 0.5,
    complete: true,
  },
  {
    profession: 'Alchemy',
    item: 'i:3827',
    name: 'Mana Potion',
    made: 1,
    reagents: [{ item: 'i:785', name: 'Mageroyal', quantity: 1, unitCost: null }],
    cost: null,
    value: 5000,
    profit: null,
    roi: null,
    saleRate: null,
    complete: false,
  },
];
export const SELL: SellRow[] = [{ item: 'i:2589', name: 'Linen Cloth', quantity: 60, chars: { Eli: 40, Sam: 20 }, unitValue: 1200, value: 72000, minBuyout: 1000, saleRate: 0.8 }];
export const UNDERCUTS: UndercutRow[] = [{ char: 'Eli', item: 'i:2589', name: 'Linen Cloth', quantity: 20, myPrice: 1100, lowest: 1000, undercutBy: 100, seen: NOW - HOUR }];

const SUMMARY: AccountingSummary = {
  sales: 12,
  purchases: 5,
  expired: 2,
  cancelled: 1,
  posts: 6,
  gross: 150000,
  cuts: 7500,
  spent: 40000,
  depositsLost: 500,
  profit: 102000,
  items: [],
  days: [],
};
export const ENTRIES: AccountingEntry[] = [
  { id: 'a1', t: NOW - HOUR, char: 'Eli', type: 'sold', item: 'i:2589', name: 'Linen Cloth', qty: 20, price: 24000, deposit: 100, cut: 1200, other: null },
  { id: 'a2', t: NOW - 3 * HOUR, char: 'Eli', type: 'bought', item: 'i:12360', name: 'Arcanite Bar', qty: 1, price: 480000, deposit: 0, cut: 0, other: null },
];
export const GOLD: GoldSeries = {
  total: [
    { t: NOW - 2 * DAY, copper: 1000000 },
    { t: NOW - DAY, copper: 1200000 },
    { t: NOW - HOUR, copper: 1500000 },
  ],
  chars: { Eli: [{ t: NOW - HOUR, copper: 1500000 }] },
  current: 1500000,
};

export const OPERATIONS: Operation[] = [
  { id: 'default-post', name: 'Default posting', kind: 'post', minPrice: 'first(70% dbmarket, 70% dbhistorical)', normalPrice: 'first(dbmarket, dbminbuyout, dbhistorical)', maxPrice: '300% dbmarket', undercut: 1, stackSize: 1, stacks: 1, duration: 24, keepQuantity: 0 },
  { id: 'default-shop', name: 'Default shopping', kind: 'shop', maxPrice: 'first(80% dbmarket, 80% dbhistorical)', minSaleRate: 0 },
];
export const GROUPS: Group[] = [{ id: 'g1', name: 'Cloth', items: ['i:2589'], postOperation: 'default-post', shopOperation: 'default-shop' }];
export const SHOPPING: ShoppingList[] = [{ id: 's1', name: 'Flask stuff', items: [{ item: 'i:2589', maxPrice: '1s' }] }];
export const DEALS_SETTINGS: DealsSettings = { percent: 0.6, minMarket: 5000, minSaleRate: 0, watch: 40 };

/** The answer to a request under /api/wow/ah/, or null when it isn't a route. */
export function ahRoute(scenario: AhScenario, path: string, method: string): AhReply | null {
  const url = new URL(path, 'http://localhost');
  if (!url.pathname.startsWith('/api/wow/ah/')) return null;
  const route = url.pathname.slice('/api/wow/ah/'.length);
  const data = scenario === 'data';
  const rows = (list: unknown[]) => ({ body: { realm: data ? 'Stalagg' : null, faction: data ? 'Alliance' : null, rows: data ? list : [] } });

  if (method === 'GET') {
    if (route === 'status') return { body: data ? STATUS_DATA : STATUS_EMPTY };
    if (route === 'items') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const found = data ? ITEMS.filter((i) => !q || (i.name ?? '').toLowerCase().includes(q)) : [];
      return { body: { realm: 'Stalagg', faction: 'Alliance', total: found.length, items: found } };
    }
    if (route.startsWith('item/')) return data ? { body: { ...DETAIL, item: decodeURIComponent(route.slice(5)) } } : { status: 404, body: { error: 'Uncbox hasn’t seen that item.' } };
    if (route === 'deals') return rows(DEALS);
    if (route === 'flips') return rows(FLIPS);
    if (route === 'vendor-flips') return rows(VENDOR_FLIPS);
    if (route === 'crafting') return rows(url.searchParams.get('includeIncomplete') === '1' ? CRAFTING : CRAFTING.filter((r) => r.complete));
    if (route === 'sell') return rows(SELL);
    if (route === 'undercuts') return rows(UNDERCUTS);
    if (route === 'accounting') return { body: { realm: 'Stalagg', faction: 'Alliance', days: Number(url.searchParams.get('days') ?? 30), summary: data ? SUMMARY : { ...SUMMARY, sales: 0, purchases: 0, expired: 0, cancelled: 0, posts: 0, gross: 0, cuts: 0, spent: 0, depositsLost: 0, profit: 0 }, entries: data ? ENTRIES : [] } };
    if (route === 'gold') return { body: data ? GOLD : { total: [], chars: {}, current: 0 } };
    if (route === 'groups') return { body: { groups: data ? GROUPS : [] } };
    if (route === 'operations') return { body: { operations: OPERATIONS } };
    if (route === 'shopping') return { body: { shopping: data ? SHOPPING : [] } };
    if (route === 'deals-settings') return { body: DEALS_SETTINGS };
  }
  if (method === 'POST' && route === 'formula/test') return { body: { ok: true, value: 1200, text: '12s', vars: {} } };
  if (method === 'POST' && route === 'refresh') return { body: { ok: true, dataFile: data ? STATUS_DATA.dataFile : null } };
  // Saving a group, rule or list, or the deal thresholds, is accepted.
  if (method !== 'GET') return { body: { ok: true } };
  return { status: 404, body: { error: 'Not found' } };
}
