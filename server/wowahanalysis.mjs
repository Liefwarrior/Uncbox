// What the prices are good for, as pure functions over a snapshot (see snapshot() in wowahdb.mjs):
// { now, cutRate, items: Map<item, { name, vendor, points, mine, market, minBuyout, saleRate, … }>,
//   recipes, inventory, owned, vendorBuy }. Prices are copper per item.

import { DAY, ahCut, netAfterFees, withoutMine } from './wowahprice.mjs';
import { reagentUnitCost } from './wowahdb.mjs';

const byProfit = (a, b) => b.profit - a.profit;
const label = (it) => it.name ?? it.item;
const limited = (rows, limit) => (limit > 0 ? rows.slice(0, limit) : rows);

/**
 * Listings priced below a share of market value. Each result is one rung of the price ladder:
 * { item, name, price, quantity, market, percent (of market), saleRate, profit (all of them,
 * resold at market after the AH cut) }. Items need a market value of at least `minMarket` and,
 * when you ask for one, a known sale rate of at least `minSaleRate`.
 */
export function deals(snap, { percent = 0.6, minSaleRate = 0, minMarket = 0, limit = 100 } = {}) {
  const rows = [];
  for (const it of snap.items.values()) {
    if (!it.market || it.market < minMarket) continue;
    if (minSaleRate > 0 && (it.saleRate ?? 0) < minSaleRate) continue;
    for (const [price, quantity] of it.points) {
      if (price > it.market * percent) break;
      rows.push({
        item: it.item,
        name: label(it),
        price,
        quantity,
        market: it.market,
        percent: price / it.market,
        saleRate: it.saleRate,
        profit: (it.market - ahCut(it.market, snap.cutRate) - price) * quantity,
      });
    }
  }
  return limited(rows.sort(byProfit), limit);
}

/**
 * Buy now, relist at market value. The sale nets market minus the AH cut and the deposit; the
 * rungs of the ladder that still leave `minProfit` per item and `minRoi` (profit ÷ price) count.
 * { item, name, price (cheapest), quantity (of the rungs that qualify), market, net, profit (per
 * item at the cheapest), roi, totalProfit }.
 */
export function flips(snap, { minProfit = 1, minRoi = 0, minSaleRate = 0, minMarket = 0, limit = 100 } = {}) {
  const rows = [];
  for (const it of snap.items.values()) {
    if (!it.market || it.market < minMarket || !it.points.length) continue;
    if (minSaleRate > 0 && (it.saleRate ?? 0) < minSaleRate) continue;
    const net = netAfterFees(it.market, { cutRate: snap.cutRate, vendorSell: it.vendor ?? 0 });
    let quantity = 0;
    let totalProfit = 0;
    for (const [price, qty] of it.points) {
      const profit = net - price;
      if (profit < minProfit || profit / price < minRoi) break;
      quantity += qty;
      totalProfit += profit * qty;
    }
    if (!quantity) continue;
    const price = it.points[0][0];
    rows.push({ item: it.item, name: label(it), price, quantity, market: it.market, net, profit: net - price, roi: (net - price) / price, totalProfit });
  }
  return limited(rows.sort((a, b) => b.totalProfit - a.totalProfit), limit);
}

/** Auctions priced below what a vendor pays: { item, name, price, quantity, vendor, profit (per item), totalProfit }. */
export function vendorFlips(snap, { limit = 100 } = {}) {
  const rows = [];
  for (const it of snap.items.values()) {
    if (!(it.vendor > 0)) continue;
    for (const [price, quantity] of it.points) {
      if (price >= it.vendor) break;
      rows.push({ item: it.item, name: label(it), price, quantity, vendor: it.vendor, profit: it.vendor - price, totalProfit: (it.vendor - price) * quantity });
    }
  }
  return limited(rows.sort((a, b) => b.totalProfit - a.totalProfit), limit);
}

/**
 * What each known recipe earns. Reagents cost the cheaper of min buyout and market value, or the
 * vendor's price when a vendor sells them. The product sells at market value minus the AH cut.
 * { profession, item, name, made, reagents: [{ item, name, quantity, unitCost }], cost,
 *   value, profit, roi, saleRate, complete (false when a reagent has no price) }.
 */
export function craftingProfit(snap, { minProfit = -Infinity, limit = 100, includeIncomplete = false } = {}) {
  const rows = [];
  for (const rec of snap.recipes) {
    const product = snap.items.get(rec.item);
    const reagents = rec.reagents.map((re) => ({
      item: re.item,
      name: label(snap.items.get(re.item) ?? { item: re.item, name: null }),
      quantity: re.qty,
      unitCost: reagentUnitCost(snap, re.item),
    }));
    const complete = reagents.every((r) => r.unitCost !== null);
    const sellAt = product?.market ?? product?.minBuyout ?? null;
    if ((!complete || sellAt === null) && !includeIncomplete) continue;
    const cost = complete ? reagents.reduce((n, r) => n + r.unitCost * r.quantity, 0) : null;
    const value = sellAt === null ? null : (sellAt - ahCut(sellAt, snap.cutRate)) * rec.made;
    const profit = cost === null || value === null ? null : value - cost;
    if (profit !== null && profit < minProfit) continue;
    rows.push({
      profession: rec.profession, item: rec.item, name: rec.name ?? label(product ?? { item: rec.item }), made: rec.made,
      reagents, cost, value, profit, roi: profit !== null && cost > 0 ? profit / cost : null, saleRate: product?.saleRate ?? null, complete,
    });
  }
  return limited(rows.sort((a, b) => (b.profit ?? -Infinity) - (a.profit ?? -Infinity)), limit);
}

/**
 * What to sell: everything in your bags and banks that has a price, most valuable first.
 * { item, name, quantity, chars: { name: count }, unitValue (market, else min buyout, else
 * historical), value, minBuyout, saleRate }.
 */
export function whatToSell(snap, { limit = 100 } = {}) {
  const per = new Map();
  for (const row of snap.inventory) {
    const n = (row.bags ?? 0) + (row.bank ?? 0);
    if (n <= 0) continue;
    const rec = per.get(row.item) ?? { quantity: 0, chars: {} };
    rec.quantity += n;
    rec.chars[row.char] = (rec.chars[row.char] ?? 0) + n;
    per.set(row.item, rec);
  }
  const rows = [];
  for (const [item, rec] of per) {
    const it = snap.items.get(item);
    const unitValue = it?.market ?? it?.minBuyout ?? it?.historical ?? null;
    if (unitValue === null) continue;
    rows.push({ item, name: label(it ?? { item }), quantity: rec.quantity, chars: rec.chars, unitValue, value: unitValue * rec.quantity, minBuyout: it?.minBuyout ?? null, saleRate: it?.saleRate ?? null });
  }
  return limited(rows.sort((a, b) => b.value - a.value), limit);
}

/**
 * Your last-seen auctions that someone has since undercut: the latest listing of each against the
 * cheapest rung other sellers hold now (your own auctions in the latest scan taken out).
 * { char, item, name, quantity, myPrice, lowest, undercutBy, seen (when you last saw your auctions) }.
 */
export function undercuts(snap) {
  const rows = [];
  for (const owner of snap.owned) {
    for (const a of owner.list) {
      const it = snap.items.get(a.k);
      if (!it || !(a.b > 0)) continue;
      const others = withoutMine(it.points, it.mine);
      if (!others.length) continue;
      const lowest = others[0][0];
      if (lowest < a.b) rows.push({ char: owner.char, item: a.k, name: label(it), quantity: a.q ?? 1, myPrice: a.b, lowest, undercutBy: a.b - lowest, seen: owner.t });
    }
  }
  return rows.sort((a, b) => b.undercutBy - a.undercutBy);
}

/** Totals for the accounting rows: { sold, bought, expired, cancelled, posted, gross, cuts, deposits… }. */
export function accountingSummary(rows) {
  const s = { sales: 0, purchases: 0, expired: 0, cancelled: 0, posts: 0, gross: 0, cuts: 0, spent: 0, depositsLost: 0, profit: 0 };
  const perItem = new Map();
  const perDay = new Map();
  for (const r of rows) {
    const bucket = (r.item ?? r.name ?? '?');
    const rec = perItem.get(bucket) ?? { item: r.item, name: r.name, sold: 0, soldMoney: 0, bought: 0, boughtMoney: 0 };
    const day = new Date((r.t ?? 0) * 1000).toISOString().slice(0, 10);
    const d = perDay.get(day) ?? { day, income: 0, spent: 0 };
    if (r.type === 'sold') {
      s.sales += r.qty;
      s.gross += r.price;
      s.cuts += r.cut;
      rec.sold += r.qty;
      rec.soldMoney += r.price - r.cut;
      d.income += r.price - r.cut;
    } else if (r.type === 'bought') {
      s.purchases += r.qty;
      s.spent += r.price;
      rec.bought += r.qty;
      rec.boughtMoney += r.price;
      d.spent += r.price;
    } else if (r.type === 'expired') {
      s.expired += r.qty;
      s.depositsLost += r.deposit;
    } else if (r.type === 'cancelled') s.cancelled += r.qty;
    else if (r.type === 'post') s.posts += 1;
    perItem.set(bucket, rec);
    perDay.set(day, d);
  }
  s.profit = s.gross - s.cuts - s.spent - s.depositsLost;
  return {
    ...s,
    items: [...perItem.values()].filter((r) => r.sold || r.bought).sort((a, b) => b.soldMoney - a.soldMoney),
    days: [...perDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

/**
 * Gold over time from per-character history ({ char: [[t, copper], …] }): the account total at
 * every moment any character's gold was recorded (each character holds its last known gold).
 * { total: [{ t, copper }], chars: { name: [{ t, copper }] } }.
 */
export function goldOverTime(history) {
  const times = new Set();
  const chars = {};
  for (const [name, points] of Object.entries(history)) {
    chars[name] = points.map(([t, copper]) => ({ t, copper }));
    for (const [t] of points) times.add(t);
  }
  const total = [];
  const last = Object.fromEntries(Object.keys(history).map((n) => [n, 0]));
  const at = Object.fromEntries(Object.keys(history).map((n) => [n, 0]));
  for (const t of [...times].sort((a, b) => a - b)) {
    for (const [name, points] of Object.entries(history)) {
      while (at[name] < points.length && points[at[name]][0] <= t) last[name] = points[at[name]++][1];
    }
    total.push({ t, copper: Object.values(last).reduce((a, b) => a + b, 0) });
  }
  return { total, chars };
}

/** Days between two timestamps, for the "data age" the status shows. */
export const ageDays = (now, t) => (t === null || t === undefined ? null : Math.max(0, (now - t) / DAY));

