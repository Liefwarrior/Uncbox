// A UncboxAH.lua as the addon saves it, for the auction house tests: the UncboxAHDB table (the
// layout is described in integrations/wow/addon/UncboxAH/Db.lua) and the text WoW writes for it.
//
// The numbers are small enough to check by hand:
//   Linen Cloth (i:2589)  3 full scans; market 88, min buyout 80, historical 115, sale rate 0.4, avg sale 115
//   Silk Cloth (i:4306)   one scan, ladder 100×2 110×2 200×1 210×15 → market 105 (a vendor sells it for 120)
//   Wool Cloth (i:2592)   a bargain at 100 against a market near 250

export const FIXTURE_NOW = 1_700_000_000;
export const DAY = 86400;
export const REALM = 'Stalagg';
export const FACTION = 'Alliance';
export const REALM_KEY = `${REALM}|${FACTION}`;

/** The UncboxAHDB table. `now` is the time of the newest scan's morning-after. */
export function savedFixture(now = FIXTURE_NOW) {
  const day = (n) => Math.floor((now - n * DAY) / DAY);
  return {
    version: 1,
    options: { scans: 3, maxPoints: 20, queryLayout: 'auto', tooltip: true },
    chars: { 'Lief-Stalagg': true, 'Alt-Stalagg': true },
    items: {
      'i:2589': { n: 'Linen Cloth', q: 1, l: 5, c: 7, s: 5, v: 13, i: 132889, k: 20 },
      'i:2592': { n: 'Wool Cloth', q: 1, l: 10, c: 7, s: 5, v: 41, i: 132889, k: 20 },
      'i:4306': { n: 'Silk Cloth', q: 1, l: 20, c: 7, s: 5, v: 120, i: 132889, k: 20 },
      'i:2996': { n: 'Bolt of Linen Cloth', q: 1, l: 5, c: 7, s: 5, v: 40, i: 132889, k: 20 },
      'i:2447': { n: 'Peacebloom', q: 1, l: 1, c: 7, s: 9, v: 10, i: 133939, k: 20 },
      'i:3371': { n: 'Empty Vial', q: 1, l: 1, c: 7, s: 11, v: 2, i: 133939, k: 20 },
      'i:118': { n: 'Minor Healing Potion', q: 1, l: 1, c: 0, s: 1, v: 5, i: 133939, k: 5 },
      'i:818': { n: 'Tigerseye', q: 2, l: 15, c: 7, s: 7, v: 400, i: 133939, k: 20 },
    },
    vendorBuy: { 'i:3371': 50 },
    recipes: {
      Tailoring: { 'i:2996': { n: 'Bolt of Linen Cloth', m: 1, r: ['i:2589', 2] } },
      Alchemy: { 'i:118': { n: 'Minor Healing Potion', m: 1, r: ['i:2447', 1, 'i:3371', 1] } },
    },
    realms: {
      [REALM_KEY]: {
        scans: [
          {
            t: now - 3 * DAY,
            kind: 'full',
            n: 6,
            items: {
              'i:2589': { mb: 100, q: 40, a: 4, p: [100, 10, 110, 10, 300, 20] },
              'i:2592': { mb: 250, q: 5, a: 2, p: [250, 3, 260, 2] },
            },
          },
          {
            t: now - DAY,
            kind: 'full',
            n: 6,
            items: {
              'i:2589': { mb: 90, q: 30, a: 3, p: [90, 10, 100, 10, 250, 10] },
              'i:2592': { mb: 240, q: 6, a: 2, p: [240, 6] },
            },
          },
          {
            t: now - 3600,
            kind: 'full',
            n: 12,
            items: {
              'i:2589': { mb: 80, q: 40, a: 4, p: [80, 20, 95, 5, 400, 15], m: [95, 5] },
              'i:2592': { mb: 100, q: 8, a: 2, p: [100, 2, 240, 6], m: [240, 2] },
              'i:4306': { mb: 100, q: 20, a: 4, p: [100, 2, 110, 2, 200, 1, 210, 15] },
              'i:2996': { mb: 260, q: 6, a: 2, p: [260, 6] },
              'i:2447': { mb: 20, q: 50, a: 5, p: [20, 50] },
              'i:3371': { mb: 80, q: 12, a: 2, p: [80, 12] },
              'i:118': { mb: 150, q: 10, a: 3, p: [150, 10] },
              'i:818': { mb: 500, q: 1, a: 1, p: [500, 1], m: [500, 1] },
            },
          },
        ],
        pages: {
          'i:2589': {
            t: now - 1800,
            mb: 80,
            q: 25,
            a: 2,
            p: [80, 20, 95, 5],
            m: [95, 5],
            L: [
              [80, 20, 'Rival', 3],
              [95, 5, 'Lief', 4],
            ],
          },
        },
        daily: {
          // Days the server never saw (and one it did, 3 days back: the server's own number wins).
          'i:2589': [day(10), 1, 150, day(8), 1, 140, day(5), 1, 130, day(3), 1, 999],
        },
        acct: [
          { id: 'Lief:sold:1:a', t: now - 5 * DAY, c: 'Lief', ty: 'sold', k: 'i:2589', n: 'Linen Cloth', q: 5, p: 600, d: 20, f: 30, o: 'Bob' },
          { id: 'Lief:sold:2:b', t: now - 4 * DAY, c: 'Lief', ty: 'sold', k: 'i:2589', n: 'Linen Cloth', q: 5, p: 550, d: 20, f: 28, o: 'Cy' },
          { id: 'Lief:expired:3:c', t: now - 3 * DAY, c: 'Lief', ty: 'expired', k: 'i:2589', n: 'Linen Cloth', q: 10, p: 0, d: 15, f: 0 },
          { id: 'Lief:cancelled:4:d', t: now - 2 * DAY, c: 'Lief', ty: 'cancelled', k: 'i:2589', n: 'Linen Cloth', q: 5, p: 0, d: 0, f: 0 },
          { id: 'Lief:bought:5:e', t: now - 2 * DAY, c: 'Lief', ty: 'bought', k: 'i:2592', n: 'Wool Cloth', q: 10, p: 2000, d: 0, f: 0, o: 'Dee' },
          { id: 'Lief:sold:6:f', t: now - DAY, c: 'Lief', ty: 'sold', n: 'Wool Cloth', q: 1, p: 300, d: 10, f: 15, o: 'Eve' },
          { id: 'Lief:post:7:g', t: now - 2 * DAY, c: 'Lief', ty: 'post', k: 'i:2589', n: 'Linen Cloth', q: 5, p: 500, d: 0, f: 0 },
        ],
        inv: {
          Lief: { t: now - 100, bags: { 'i:2589': 35, 'i:4306': 3 }, bank: { 'i:2592': 12 }, bankT: now - 5000 },
          Alt: { t: now - 200, bags: { 'i:2589': 5 } },
        },
        owned: {
          Lief: {
            t: now - 900,
            list: [
              { k: 'i:2589', q: 5, b: 95, mb: 475, tl: 3, n: 'Linen Cloth' },
              { k: 'i:2592', q: 2, b: 240, mb: 480, tl: 4, n: 'Wool Cloth' },
              { k: 'i:818', q: 1, b: 500, mb: 500, tl: 2, n: 'Tigerseye' },
            ],
          },
        },
        gold: {
          Lief: [now - 2 * DAY, 100000, now - DAY, 150000, now - 3600, 180000],
          Alt: [now - DAY, 20000, now - 1800, 25000],
        },
      },
    },
  };
}

const str = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

/** Lua text the way WoW writes a SavedVariables file: `Name = { … }` with `-- [n]` after array values. */
export function toSavedVariables(name, value) {
  const write = (v, indent) => {
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'string') return str(v);
    const inner = `${indent}\t`;
    if (Array.isArray(v)) {
      if (!v.length) return '{\n' + indent + '}';
      return `{\n${v.map((x, i) => `${inner}${write(x, inner)}, -- [${i + 1}]`).join('\n')}\n${indent}}`;
    }
    const keys = Object.keys(v);
    if (!keys.length) return '{\n' + indent + '}';
    // Integer-looking keys are Lua number keys.
    return `{\n${keys.map((k) => `${inner}${/^-?\d+$/.test(k) ? `[${k}]` : `[${str(k)}]`} = ${write(v[k], inner)},`).join('\n')}\n${indent}}`;
  };
  return `${name} = ${write(value, '')}\n`;
}

/** The whole UncboxAH.lua for the fixture. */
export const fixtureFile = (now = FIXTURE_NOW) => toSavedVariables('UncboxAHDB', savedFixture(now));
