// The auction house price maths, as pure functions (no database, no files), so the numbers can be
// checked by hand. Prices are copper per item. A "point" is [price, quantity]: how many of the
// item are listed at that buyout price; a scan's points for an item are its whole price ladder.
//
//   Market value  what the item usually goes for: per scan the cheapest slice of the ladder with
//                 outliers dropped, then the scans of the last 14 days blended, today counting most.
//   Min buyout    the cheapest buyout in the latest scan.
//   Historical    the average of the daily min buyouts over 60 days.
//   Sale rate     of your own auctions for the item, the share of the quantity that sold.
//   Volatility    how much the daily min buyout jumps about (standard deviation ÷ mean).

export const DAY = 86400;
export const MARKET_DAYS = 14;
export const HISTORICAL_DAYS = 60;
/** A price more than this many times the one below it ends the slice (it is an outlier). */
export const OUTLIER_FACTOR = 1.5;
/** A day's weight halves every this many days. */
export const HALF_LIFE_DAYS = 3;

/** Sorted points with equal prices merged, junk dropped. */
export function normalizePoints(points) {
  const byPrice = new Map();
  for (const pt of points ?? []) {
    const price = Number(pt?.[0]);
    const qty = Number(pt?.[1]);
    if (!(price > 0) || !(qty > 0)) continue;
    byPrice.set(price, (byPrice.get(price) ?? 0) + qty);
  }
  return [...byPrice].sort((a, b) => a[0] - b[0]);
}

/** The cheapest slice of the ladder market value looks at: 30% of a thin market, 15% of a deep one (200 or more listed). */
export function sliceFraction(total) {
  if (total <= 20) return 0.3;
  if (total >= 200) return 0.15;
  return 0.3 - (0.15 * (total - 20)) / 180;
}

/**
 * One scan's market value. Takes the cheapest slice of the listed quantity (see sliceFraction),
 * walking up the price ladder and stopping at the first price more than 1.5× the one below it,
 * then averages what is left weighted by quantity. `total` is the quantity listed in all, for when
 * the points are only the cheapest ones. Null when nothing is listed.
 */
export function scanMarketValue(points, total) {
  const pts = normalizePoints(points);
  if (!pts.length) return null;
  const listed = Math.max(Number(total) || 0, pts.reduce((n, [, q]) => n + q, 0));
  const limit = Math.max(1, Math.ceil(sliceFraction(listed) * listed));
  let taken = 0;
  let sum = 0;
  let previous = null;
  for (const [price, qty] of pts) {
    if (taken >= limit) break;
    if (previous !== null && price > OUTLIER_FACTOR * previous) break;
    const take = Math.min(qty, limit - taken);
    taken += take;
    sum += price * take;
    previous = price;
  }
  return sum / taken;
}

/**
 * Market value from several scans: [{ t, points, total? }]. Scans within a day are averaged, then
 * days up to 14 old are blended with a weight that halves every 3 days, so today counts most.
 * Rounded to whole copper; null when no scan in range listed the item.
 */
export function marketValue(observations, now, { days = MARKET_DAYS, halfLife = HALF_LIFE_DAYS } = {}) {
  const buckets = new Map();
  for (const ob of observations ?? []) {
    const age = Math.max(0, Math.floor((now - ob.t) / DAY));
    if (age >= days) continue;
    const mv = scanMarketValue(ob.points, ob.total);
    if (mv === null) continue;
    const b = buckets.get(age) ?? { sum: 0, n: 0 };
    b.sum += mv;
    b.n++;
    buckets.set(age, b);
  }
  let weighted = 0;
  let weights = 0;
  for (const [age, b] of buckets) {
    const w = 0.5 ** (age / halfLife);
    weighted += (w * b.sum) / b.n;
    weights += w;
  }
  return weights ? Math.round(weighted / weights) : null;
}

/** The cheapest price in a ladder, or null. */
export function minBuyout(points) {
  const pts = normalizePoints(points);
  return pts.length ? pts[0][0] : null;
}

/** Quantity in a ladder. */
export function totalQuantity(points) {
  return normalizePoints(points).reduce((n, [, q]) => n + q, 0);
}

/** The ladder without your own auctions ([[price, qty]] you have listed there). */
export function withoutMine(points, mine) {
  const left = new Map(normalizePoints(points));
  for (const [price, qty] of normalizePoints(mine)) {
    if (!left.has(price)) continue;
    const rest = left.get(price) - qty;
    if (rest > 0) left.set(price, rest);
    else left.delete(price);
  }
  return [...left].sort((a, b) => a[0] - b[0]);
}

/**
 * The average daily min buyout over `days`: [{ day (whole days since 1970), scans, minSum }], where
 * minSum is the min buyouts of that day's scans added up. Rounded; null with no data.
 */
export function historicalPrice(daily, now, days = HISTORICAL_DAYS) {
  const first = Math.floor(now / DAY) - days + 1;
  let sum = 0;
  let scans = 0;
  for (const d of daily ?? []) {
    if (d.day < first || !(d.scans > 0)) continue;
    sum += d.minSum;
    scans += d.scans;
  }
  return scans ? Math.round(sum / scans) : null;
}

/** Standard deviation ÷ mean of the values (0 for a steady price), or null with fewer than 2. */
export function volatility(values) {
  const v = (values ?? []).filter((x) => Number.isFinite(x) && x > 0);
  if (v.length < 2) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length;
  return Math.sqrt(variance) / mean;
}

/**
 * From your own sales records: { sold, expired, cancelled } quantities and the money for what
 * sold, as { saleRate, avgSell, sold, failed }. saleRate = sold ÷ (sold + expired + cancelled),
 * avgSell = money ÷ quantity sold. Both null with no history.
 */
export function saleStats({ sold = 0, expired = 0, cancelled = 0, soldMoney = 0 } = {}) {
  const failed = expired + cancelled;
  return {
    saleRate: sold + failed > 0 ? sold / (sold + failed) : null,
    avgSell: sold > 0 ? Math.round(soldMoney / sold) : null,
    sold,
    failed,
  };
}

/** What the auction house keeps from a sale (5%; 15% at a neutral house). */
export function ahCut(price, rate = 0.05) {
  return Math.floor(price * rate);
}

/** The deposit for a stack: 15% of the vendor sell price per 12 hours, for the whole stack. */
export function deposit(vendorSell, count = 1, hours = 24) {
  return Math.floor((vendorSell ?? 0) * 0.15 * (hours / 12)) * count;
}

/** What a sale really leaves you with per item: the price minus the cut, minus the deposit. */
export function netAfterFees(price, { cutRate = 0.05, vendorSell = 0, hours = 24 } = {}) {
  return price - ahCut(price, cutRate) - deposit(vendorSell, 1, hours);
}
