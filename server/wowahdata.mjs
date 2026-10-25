// UncboxAHData.lua: the prices and rules Uncbox hands to the UncboxAH addon. WoW addons can't read
// files while you play, so the addon loads this one on /reload, the way TSM's desktop app feeds
// its own AppHelper addon.
//
//   UncboxAHData = {
//     version = 1, generated = <time>,
//     realms = { ["Stalagg|Alliance"] = {
//       scanTime = <latest full scan>, cut = 0.05,
//       items = { ["i:2589"] = { market, minBuyout, historical, saleRate, avgSell, vendor } },
//       rules = { ["i:2589"] = { group, min, normal, max, undercut, stackSize, stacks, duration,
//                                keep, shopMax, shopMinRate } },       -- formulas already worked out, copper per item
//       shopping = { { name, items = { { item, name, maxPrice } } } },
//       deals = { percent, minMarket, minSaleRate, watch = { { item, name } } },
//     } } }
//
// Item keys are "i:<id>" plus ":<random suffix>" when it has one, always strings.

import { toLuaFile, parseSavedVariables } from '../integrations/wow/savedvars.mjs';
import { evalFormula } from './wowahformula.mjs';
import { parseMoney } from './money.mjs';
import { DEFAULT_POST_ID, DEFAULT_SHOP_ID } from './wowahstore.mjs';

export const DATA_FILE = 'UncboxAHData.lua';
export const DATA_VERSION = 1;

/** The variables a formula sees for one item. */
export function itemVars(it) {
  return {
    dbmarket: it.market ?? undefined,
    dbminbuyout: it.minBuyout ?? undefined,
    dbhistorical: it.historical ?? undefined,
    avgsell: it.avgSell ?? undefined,
    vendorsell: it.vendor ?? undefined,
    crafting: it.crafting ?? undefined,
  };
}

/** One formula for one item: copper, or null when the item has no data for it. */
export function priceFor(formula, it) {
  const r = evalFormula(formula, itemVars(it));
  return r.ok ? r.value : null;
}

const rate = (v) => (v === null || v === undefined ? undefined : Math.round(v * 100) / 100);
const given = (v) => (v === null || v === undefined ? undefined : v);

/** The posting and shopping numbers for an item under the operations of its group (or the defaults). */
export function rulesFor(it, postOp, shopOp, group = null) {
  const rule = {
    group: group ?? undefined,
    min: given(priceFor(postOp.minPrice, it)),
    normal: given(priceFor(postOp.normalPrice, it)),
    max: given(priceFor(postOp.maxPrice, it)),
    undercut: postOp.undercut,
    stackSize: postOp.stackSize,
    stacks: postOp.stacks,
    duration: postOp.duration,
    keep: postOp.keepQuantity,
    shopMax: given(priceFor(shopOp.maxPrice, it)),
    shopMinRate: shopOp.minSaleRate || undefined,
  };
  return rule;
}

/**
 * The data file's table for one snapshot and the saved rules (store.load()). Only items with a
 * price are listed; rules cover the items in groups and, with the default operations, what is in
 * your bags and banks.
 */
export function buildRealmData(snap, rules) {
  const ops = new Map(rules.operations.map((o) => [o.id, o]));
  const defaultPost = ops.get(DEFAULT_POST_ID);
  const defaultShop = ops.get(DEFAULT_SHOP_ID);

  const items = {};
  for (const it of snap.items.values()) {
    if (it.market === null && it.minBuyout === null && it.historical === null) continue;
    items[it.item] = {
      market: given(it.market),
      minBuyout: given(it.minBuyout),
      historical: given(it.historical),
      saleRate: rate(it.saleRate),
      avgSell: given(it.avgSell),
      vendor: it.vendor || undefined,
    };
  }

  const ruleTable = {};
  for (const g of rules.groups) {
    const post = ops.get(g.postOperation) ?? defaultPost;
    const shop = ops.get(g.shopOperation) ?? defaultShop;
    for (const item of g.items) {
      if (ruleTable[item]) continue; // an item in two groups follows the first
      ruleTable[item] = rulesFor(snap.items.get(item) ?? { item }, post, shop, g.name);
    }
  }
  for (const row of snap.inventory) {
    if (ruleTable[row.item] || !snap.items.has(row.item)) continue;
    ruleTable[row.item] = rulesFor(snap.items.get(row.item), defaultPost, defaultShop);
  }

  const itemName = (item) => snap.items.get(item)?.name ?? undefined;
  const byName = new Map([...snap.items.values()].filter((i) => i.name).map((i) => [i.name.toLowerCase(), i]));
  const shopping = rules.shopping.map((list) => ({
    name: list.name,
    items: list.items.map((e) => {
      const known = e.item ? snap.items.get(e.item) : byName.get((e.name ?? '').toLowerCase());
      const key = e.item ?? known?.item;
      const name = e.name ?? itemName(e.item);
      let maxPrice;
      if (e.maxPrice) maxPrice = parseMoney(e.maxPrice) ?? (known ? priceFor(e.maxPrice, known) : null);
      else if (known) maxPrice = priceFor(defaultShop.maxPrice, known);
      return { item: key, name, maxPrice: given(maxPrice) };
    }),
  }));

  const dealSettings = rules.deals;
  const watch = [...snap.items.values()]
    .filter((i) => i.name && i.market >= dealSettings.minMarket && (i.saleRate ?? 1) >= dealSettings.minSaleRate)
    .sort((a, b) => b.market - a.market)
    .slice(0, dealSettings.watch)
    .map((i) => ({ item: i.item, name: i.name }));

  return {
    scanTime: given(snap.lastFullScan),
    cut: snap.cutRate,
    items,
    rules: ruleTable,
    shopping,
    deals: { percent: dealSettings.percent, minMarket: dealSettings.minMarket, minSaleRate: dealSettings.minSaleRate, watch },
  };
}

/** The whole file's text, from { 'Realm|Faction': realm table }. */
export function renderDataFile(realms, now = Math.floor(Date.now() / 1000)) {
  return toLuaFile(
    { UncboxAHData: { version: DATA_VERSION, generated: now, realms } },
    'Written by Uncbox. Prices and rules for the UncboxAH addon; it loads on /reload.\nChanges here are overwritten.',
  );
}

/** Reads a data file back: the UncboxAHData table. */
export const readDataFile = (text) => parseSavedVariables(text).UncboxAHData;
