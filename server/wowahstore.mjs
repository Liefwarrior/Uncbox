// The auction house rules you set up, saved in data/wow-ah.json (written atomically):
//
//   operations  named rules. A posting operation says how to price and post (min, normal and max
//               price formulas, undercut, stack size, number of stacks, duration, quantity to
//               keep). A shopping operation says what to pay at most (a formula) and the lowest
//               sale rate worth buying for.
//   groups      named lists of items, each with a posting operation and a shopping operation.
//   shopping    shopping lists: items to look for with a max price each (a formula or money).
//   deals       the settings of the "deals" search.
//
// Formulas are checked when they are saved, so a rule that gets in is a rule that parses.

import { randomUUID } from 'node:crypto';
import { readJsonSafe, writeJsonAtomic } from './datafile.mjs';
import { checkFormula } from './wowahformula.mjs';
import { parseMoney } from './money.mjs';

export const DEFAULT_POST_ID = 'default-post';
export const DEFAULT_SHOP_ID = 'default-shop';

export const DEFAULT_POST = {
  id: DEFAULT_POST_ID,
  name: 'Default posting',
  kind: 'post',
  minPrice: 'max(first(vendorsell, 0), first(70% dbmarket, 70% dbhistorical))',
  normalPrice: 'first(dbmarket, dbminbuyout, dbhistorical)',
  maxPrice: '300% first(dbmarket, dbhistorical, dbminbuyout)',
  undercut: 1,
  stackSize: 1,
  stacks: 1,
  duration: 24,
  keepQuantity: 0,
};

export const DEFAULT_SHOP = {
  id: DEFAULT_SHOP_ID,
  name: 'Default shopping',
  kind: 'shop',
  maxPrice: 'first(80% dbmarket, 80% dbhistorical)',
  minSaleRate: 0,
};

export const DEFAULT_DEALS = { percent: 0.6, minMarket: 5000, minSaleRate: 0, watch: 40 };

class InvalidInput extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const bad = (message) => {
  throw new InvalidInput(message);
};

const text = (v, what, max = 80) => {
  if (typeof v !== 'string' || !v.trim()) bad(`${what} needs a name.`);
  return v.trim().slice(0, max);
};

function formula(v, what) {
  if (typeof v !== 'string' || !v.trim()) bad(`${what} needs a price formula.`);
  const problem = checkFormula(v);
  if (problem) bad(`${what}: ${problem}`);
  return v.trim();
}

function integer(v, what, min, max, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) bad(`${what} must be a whole number from ${min} to ${max}.`);
  return n;
}

const itemKey = (v) => typeof v === 'string' && /^i:\d+(?::-?\d+)?$/.test(v);

/** A posting or shopping operation as the store keeps it; throws a 400 error saying what is wrong. */
export function normalizeOperation(input, existing = null) {
  if (!input || typeof input !== 'object') bad('That isn’t an operation.');
  const kind = input.kind ?? existing?.kind;
  const id = existing?.id ?? (typeof input.id === 'string' && /^[\w-]{1,40}$/.test(input.id) ? input.id : randomUUID().slice(0, 8));
  const name = text(input.name ?? existing?.name, 'The operation');
  if (kind === 'post') {
    const base = { ...DEFAULT_POST, ...existing };
    const duration = Number(input.duration ?? base.duration);
    if (![12, 24, 48].includes(duration)) bad('Duration must be 12, 24 or 48 hours.');
    return {
      id,
      name,
      kind,
      minPrice: formula(input.minPrice ?? base.minPrice, 'Min price'),
      normalPrice: formula(input.normalPrice ?? base.normalPrice, 'Normal price'),
      maxPrice: formula(input.maxPrice ?? base.maxPrice, 'Max price'),
      undercut: integer(input.undercut, 'Undercut', 0, 1_000_000, base.undercut),
      stackSize: integer(input.stackSize, 'Stack size', 1, 200, base.stackSize),
      stacks: integer(input.stacks, 'Number of stacks', 1, 100, base.stacks),
      duration,
      keepQuantity: integer(input.keepQuantity, 'Quantity to keep', 0, 100_000, base.keepQuantity),
    };
  }
  if (kind === 'shop') {
    const base = { ...DEFAULT_SHOP, ...existing };
    const rate = Number(input.minSaleRate ?? base.minSaleRate);
    if (!(rate >= 0 && rate <= 1)) bad('Min sale rate must be between 0 and 1.');
    return { id, name, kind, maxPrice: formula(input.maxPrice ?? base.maxPrice, 'Max price'), minSaleRate: rate };
  }
  return bad('An operation is either "post" or "shop".');
}

export function normalizeGroup(input, existing = null, operations = []) {
  if (!input || typeof input !== 'object') bad('That isn’t a group.');
  const given = input.items ?? existing?.items ?? [];
  if (!Array.isArray(given)) bad('Items must be a list.');
  const items = [...new Set(given.map(String))];
  if (items.some((i) => !itemKey(i))) bad('Items are written like i:2589.');
  if (items.length > 5000) bad('A group holds up to 5000 items.');
  const op = (v, kind, fallback) => {
    const id = v ?? fallback;
    if (!operations.some((o) => o.id === id && o.kind === kind)) bad(`There is no ${kind === 'post' ? 'posting' : 'shopping'} operation "${id}".`);
    return id;
  };
  return {
    id: existing?.id ?? (typeof input.id === 'string' && /^[\w-]{1,40}$/.test(input.id) ? input.id : randomUUID().slice(0, 8)),
    name: text(input.name ?? existing?.name, 'The group'),
    items,
    postOperation: op(input.postOperation ?? existing?.postOperation, 'post', DEFAULT_POST_ID),
    shopOperation: op(input.shopOperation ?? existing?.shopOperation, 'shop', DEFAULT_SHOP_ID),
  };
}

/** A shopping list item's max price: a formula, money ("2g50s"), or nothing (then the shopping operation's). */
function shoppingPrice(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim();
  if (parseMoney(s) !== null) return s;
  const problem = checkFormula(s);
  if (problem) bad(`Max price: ${problem}`);
  return s;
}

export function normalizeShopping(input, existing = null) {
  if (!input || typeof input !== 'object') bad('That isn’t a shopping list.');
  const raw = input.items ?? existing?.items ?? [];
  if (!Array.isArray(raw) || raw.length > 500) bad('A shopping list holds up to 500 items.');
  const items = raw.map((e) => {
    if (typeof e === 'string') e = { item: itemKey(e) ? e : undefined, name: itemKey(e) ? undefined : e };
    if (!e || typeof e !== 'object') bad('A shopping list item needs an item or a name.');
    if (e.item !== undefined && !itemKey(e.item)) bad('Items are written like i:2589.');
    const name = typeof e.name === 'string' && e.name.trim() ? e.name.trim().slice(0, 80) : undefined;
    if (!e.item && !name) bad('A shopping list item needs an item or a name.');
    const maxPrice = shoppingPrice(e.maxPrice);
    return { ...(e.item ? { item: e.item } : {}), ...(name ? { name } : {}), ...(maxPrice ? { maxPrice } : {}) };
  });
  return {
    id: existing?.id ?? (typeof input.id === 'string' && /^[\w-]{1,40}$/.test(input.id) ? input.id : randomUUID().slice(0, 8)),
    name: text(input.name ?? existing?.name, 'The list'),
    items,
  };
}

export function normalizeDeals(input) {
  const base = { ...DEFAULT_DEALS, ...input };
  const percent = Number(base.percent);
  if (!(percent > 0 && percent <= 1)) bad('Percent of market must be between 0 and 1.');
  const minSaleRate = Number(base.minSaleRate);
  if (!(minSaleRate >= 0 && minSaleRate <= 1)) bad('Min sale rate must be between 0 and 1.');
  return {
    percent,
    minSaleRate,
    minMarket: integer(base.minMarket, 'Min market value', 0, 1_000_000_000, DEFAULT_DEALS.minMarket),
    watch: integer(base.watch, 'Items to watch', 0, 200, DEFAULT_DEALS.watch),
  };
}

/** The rules file. load() always has the two default operations and the deals settings. */
export function createAhStore({ file }) {
  let data = null;

  async function load() {
    if (data) return data;
    const saved = await readJsonSafe(file, {});
    const operations = Array.isArray(saved.operations) ? saved.operations.filter((o) => o && (o.kind === 'post' || o.kind === 'shop')) : [];
    if (!operations.some((o) => o.id === DEFAULT_SHOP_ID)) operations.unshift({ ...DEFAULT_SHOP });
    if (!operations.some((o) => o.id === DEFAULT_POST_ID)) operations.unshift({ ...DEFAULT_POST });
    data = {
      version: 1,
      operations,
      groups: Array.isArray(saved.groups) ? saved.groups : [],
      shopping: Array.isArray(saved.shopping) ? saved.shopping : [],
      deals: { ...DEFAULT_DEALS, ...(saved.deals && typeof saved.deals === 'object' ? saved.deals : {}) },
    };
    return data;
  }

  const save = async () => writeJsonAtomic(file, data, { pretty: true });

  const collection = (name, normalize) => ({
    async list() {
      return (await load())[name];
    },
    async get(id) {
      return (await load())[name].find((e) => e.id === id) ?? null;
    },
    /** Creates (no id) or replaces (an id that exists) one. */
    async put(input, id) {
      const d = await load();
      const list = d[name];
      const at = list.findIndex((e) => e.id === (id ?? input?.id));
      if (id && at < 0) throw Object.assign(new Error('There is nothing with that id.'), { status: 404 });
      const entry = normalize(input, at >= 0 ? list[at] : null, d.operations);
      if (at >= 0) list[at] = entry;
      else list.push(entry);
      await save();
      return entry;
    },
    async remove(id) {
      const d = await load();
      const at = d[name].findIndex((e) => e.id === id);
      if (at < 0) throw Object.assign(new Error('There is nothing with that id.'), { status: 404 });
      if (name === 'operations' && (id === DEFAULT_POST_ID || id === DEFAULT_SHOP_ID)) {
        throw Object.assign(new Error('The default operations stay.'), { status: 400 });
      }
      d[name].splice(at, 1);
      if (name === 'operations') {
        // Groups using a deleted operation go back to the default.
        for (const g of d.groups) {
          if (g.postOperation === id) g.postOperation = DEFAULT_POST_ID;
          if (g.shopOperation === id) g.shopOperation = DEFAULT_SHOP_ID;
        }
      }
      await save();
    },
  });

  return {
    load,
    operations: collection('operations', normalizeOperation),
    groups: collection('groups', normalizeGroup),
    shopping: collection('shopping', normalizeShopping),
    async deals() {
      return (await load()).deals;
    },
    async setDeals(input) {
      const d = await load();
      d.deals = normalizeDeals(input);
      await save();
      return d.deals;
    },
  };
}
