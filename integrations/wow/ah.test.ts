// The UncboxAH addon's Lua, run in fengari against a fake Classic Era auction house, mail and bag API
// (ahmock.lua). See ahharness.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Game, luaTable } from './ahharness.mjs';

let game: Game;
afterEach(() => game?.close());

function fresh(layout: 'old' | 'new' = 'old') {
  game = new Game({ layout });
  game.start();
  return game;
}

const KEY = 'Stalagg|Alliance';
const realm = `UncboxAHDB.realms["${KEY}"]`;

function setup() {
  fresh();
  game.run(`
    Mock.item(2589, "Linen Cloth", { vendor = 13 })
    Mock.item(2592, "Wool Cloth", { vendor = 41 })
    Mock.item(3000, "Rune Blade", { quality = 3, vendor = 500 })
  `);
}

/** Several return values of a Lua call as a list. */
const multi = (expr: string) => game.eval<any[]>(`{${expr}}`);

/** A game with the addon loaded and a few items known, for each test of the describe block it is called in. */
function beforeEachFresh() {
  beforeEach(() => setup());
}

/** What Uncbox's data file would hold: prices and rules for this realm. */
function data(extra: Record<string, unknown> = {}) {
  game.run(`UncboxAHData = ${luaTable({
    version: 1,
    generated: 1700000000,
    realms: {
      [KEY]: {
        scanTime: 1699990000,
        cut: 0.05,
        items: {
          'i:2589': { market: 100, minBuyout: 95, historical: 110, saleRate: 0.62, avgSell: 105, vendor: 13 },
          'i:2592': { market: 300, minBuyout: 280, vendor: 41 },
        },
        rules: {},
        shopping: [],
        deals: { percent: 0.6, minMarket: 100, minSaleRate: 0, watch: [] },
        ...extra,
      },
    },
  })}`);
}

describe('helpers', () => {
  it('builds item keys from links, ids and random suffixes', () => {
    fresh();
    expect(game.eval('ns.Util.ItemKey("|cffffffff|Hitem:2589:0:0:0:0:0:0:0:60|h[Linen Cloth]|h|r")')).toBe('i:2589');
    expect(game.eval('ns.Util.ItemKey("item:3000::::::-12:0")')).toBe('i:3000:-12');
    expect(game.eval('ns.Util.ItemKey(2589)')).toBe('i:2589');
    expect(game.eval('ns.Util.ItemKey("not a link")')).toBeNull();
    expect(game.eval('ns.Util.ItemId("i:3000:-12")')).toBe(3000);
  });

  it('formats and reads money', () => {
    fresh();
    expect(game.eval('ns.Util.Money(123456)')).toBe('12g 34s 56c');
    expect(game.eval('ns.Util.Money(120000)')).toBe('12g');
    expect(game.eval('ns.Util.Money(0)')).toBe('0c');
    expect(game.eval('ns.Util.Money(-150)')).toBe('-1s 50c');
    expect(game.eval('ns.Util.ParseMoney("12g 34s 56c")')).toBe(123456);
    expect(game.eval('ns.Util.ParseMoney("1g50s")')).toBe(15000);
    expect(game.eval('ns.Util.ParseMoney("75s")')).toBe(7500);
    expect(game.eval('ns.Util.ParseMoney("250")')).toBe(250);
    expect(game.eval('ns.Util.ParseMoney("lots")')).toBeNull();
    expect(game.eval('ns.Util.ParseMoney("5g7")')).toBeNull();
  });

  it('keeps neutral auction houses apart from your faction’s', () => {
    fresh();
    expect(game.eval('ns.Util.RealmKey()')).toBe(KEY);
    game.run('Mock.zone = "Gadgetzan"');
    expect(game.eval('ns.Util.RealmKey()')).toBe('Stalagg|Neutral');
  });
});

describe('full scan', () => {
  it('turns a getAll scan into a compact snapshot, a few hundred listings a frame', () => {
    setup();
    game.auctions([
      { id: 2589, count: 20, buyout: 2000, owner: 'Seller1' }, // 100 each
      { id: 2589, count: 10, buyout: 1200, owner: 'Seller2' }, // 120 each
      { id: 2589, count: 5, buyout: 500, owner: 'Seller3' }, // 100 each
      { id: 2589, count: 5, buyout: 600, owner: 'Lief' }, // yours, 120 each
      { id: 2589, count: 1, buyout: 0, minBid: 50, owner: 'Seller4' }, // bid only: not counted
      { id: 3000, name: 'Rune Blade', count: 1, buyout: 90000, owner: 'Seller1', suffix: -5 },
    ]);
    for (let i = 0; i < 1000; i++) game.run(`Mock.auction({ id = 2592, count = 1, buyout = ${4000 + i}, owner = "Bulk" })`);

    expect(game.eval('{ns.Scan.StartFull()}')).toEqual([true]);
    expect(game.eval('Mock.queries[1]')).toMatchObject({ text: '', page: 0, getAll: true, exact: false });
    expect(game.eval('ns.Scan.state.phase')).toBe('waiting');
    game.run('Mock.deliver()');
    expect(game.eval('ns.Scan.state.phase')).toBe('processing');
    expect(game.eval('ns.Scan.Progress()')).toBe(0);
    game.run('Mock.step()');
    expect(game.eval('ns.Scan.Progress()')).toBeCloseTo(400 / 1006, 3); // one frame's worth
    game.pump();
    expect(game.eval('ns.Scan.state')).toBeNull();

    const scans = game.eval<any[]>(`${realm}.scans`);
    expect(scans).toHaveLength(1);
    const scan = scans[0];
    expect(scan).toMatchObject({ t: 1700000000, kind: 'full', n: 1005 });
    expect(Object.keys(scan.items).sort()).toEqual(['i:2589', 'i:2592', 'i:3000:-5']);
    expect(scan.items['i:2589']).toEqual({ mb: 100, q: 40, a: 4, p: [100, 25, 120, 15], m: [120, 5] });
    expect(scan.items['i:3000:-5']).toEqual({ mb: 90000, q: 1, a: 1, p: [90000, 1] });
    // 1000 different prices: only the cheapest 20 price points are kept, but the quantity is the whole.
    expect(scan.items['i:2592'].p).toHaveLength(40);
    expect(scan.items['i:2592']).toMatchObject({ mb: 4000, q: 1000, a: 1000 });
    expect(game.eval(`${realm}.daily["i:2589"]`)).toEqual([19675, 1, 100]);
    expect(game.eval('ns.printed')).toContain('Scan finished: 3 items, 1005 auctions.');
    // The names and details of what was seen are kept for Uncbox's item table.
    expect(game.eval('UncboxAHDB.items["i:2589"]')).toMatchObject({ n: 'Linen Cloth', q: 1, v: 13, k: 20 });
  });

  it('refuses a second full scan inside the 15 minute throttle, and says when', () => {
    setup();
    game.auctions([{ id: 2589, count: 1, buyout: 100, owner: 'S' }]);
    expect(multi('ns.Scan.StartFull()')[0]).toBe(true);
    game.run('Mock.deliver()');
    game.pump();
    game.run('Mock.canAll = false; Mock.now = Mock.now + 300');
    const [ok, why] = multi('ns.Scan.StartFull()');
    expect(ok).toBe(false);
    expect(why).toBe('A full scan can run again in 10m.');
    expect(game.eval('Mock.queries')).toHaveLength(1);
  });

  it('keeps only the latest few full scans, and a daily total per item', () => {
    setup();
    game.auctions([{ id: 2589, count: 1, buyout: 100, owner: 'S' }]);
    for (let i = 0; i < 5; i++) {
      game.run(`Mock.now = Mock.now + 1000; ns.Scan.StartFull(); Mock.deliver(); Mock.pump(); Mock.auctions[1].buyout = ${100 + (i + 1) * 10}`);
    }
    const scans = game.eval<any[]>(`${realm}.scans`);
    expect(scans.map((s) => s.t)).toEqual([1700003000, 1700004000, 1700005000]);
    expect(scans[2].items['i:2589'].mb).toBe(140);
    // Five scans the same day: (day, 5 scans, 100+110+120+130+140).
    expect(game.eval(`${realm}.daily["i:2589"]`)).toEqual([19675, 5, 600]);
  });

  it('gives up when the auction house never answers', () => {
    setup();
    game.run('ns.Scan.StartFull()');
    game.run('Mock.advance(100)');
    expect(game.eval('ns.Scan.state')).toBeNull();
    expect(game.eval('ns.printed')).toContain('The full scan got no answer. Try again in a few minutes.');
  });

  it.each(['old', 'new'] as const)('sends the query in the %s argument layout', (layout) => {
    fresh(layout);
    expect(game.eval('ns.Scan.Layout()')).toBe(layout);
    game.run('ns.Scan.StartFull()'); // the fake game asserts the argument count and positions
    expect(game.eval('Mock.queries[1].getAll')).toBe(true);
  });

  it('lets /uah layout override the guess', () => {
    fresh('new');
    game.run('ns.Core.Slash("layout old")');
    expect(game.eval('ns.Scan.Layout()')).toBe('old');
  });

  it('reads the older GetAuctionItemInfo layout (no column header after the level)', () => {
    setup();
    game.run(`
      local modern = GetAuctionItemInfo
      GetAuctionItemInfo = function(t, i)
        local name, tex, count, q, canUse, level, _, minBid, inc, buyout, bid, high, _, owner, _, status, id = modern(t, i)
        return name, tex, count, q, canUse, level, minBid, inc, buyout, bid, high, owner, status, id
      end
    `);
    game.auctions([{ id: 2589, count: 10, buyout: 1200, owner: 'Seller2' }]);
    game.run('ns.Scan.StartFull(); Mock.deliver(); Mock.pump()');
    expect(game.eval(`${realm}.scans[1].items["i:2589"]`)).toEqual({ mb: 120, q: 10, a: 1, p: [120, 10] });
  });
});

describe('searching', () => {
  it('reads every page of an exact search and keeps the listings', () => {
    setup();
    for (let i = 0; i < 60; i++) game.run(`Mock.auction({ id = 2589, count = ${1 + (i % 3)}, buyout = ${(100 + i) * (1 + (i % 3))}, owner = "S${i % 4}" })`);
    game.run('Mock.auction({ id = 2592, count = 1, buyout = 999, owner = "Other" })');
    game.run('R = {}; ns.Scan.Search({ { name = "Linen Cloth", key = "i:2589", pages = 3 } }, function(req, listings, recs) R.req = req.name; R.listings = #listings; R.page2 = listings[51].page end, function() R.done = true end)');
    game.run('Mock.deliver()');
    expect(game.eval('Mock.queries[1]')).toMatchObject({ text: 'Linen Cloth', page: 0, exact: true, getAll: false });
    expect(game.eval('Mock.queries[2]')).toMatchObject({ page: 1, exact: true });
    game.run('Mock.deliver()');
    game.pump();
    expect(game.eval('R')).toEqual({ req: 'Linen Cloth', listings: 60, page2: 1, done: true });
    const rec = game.eval<any>(`${realm}.pages["i:2589"]`);
    expect(rec.a).toBe(60);
    expect(rec.mb).toBe(100);
    expect(rec.L).toHaveLength(40); // the cheapest 40 listings
    expect(rec.L[0]).toEqual([100, 1, 'S0', 3]);
    expect(rec.t).toBe(1700000000);
    expect(game.eval('ns.Scan.state')).toBeNull();
  });

  it('records that an item has no listings at all', () => {
    setup();
    game.run('ns.Scan.Search({ { name = "Linen Cloth", key = "i:2589" } })');
    game.run('Mock.deliver()');
    game.pump();
    expect(game.eval(`${realm}.pages["i:2589"]`)).toEqual({ t: 1700000000, q: 0, a: 0, p: [] });
  });

  it('waits out the query throttle', () => {
    setup();
    game.run('Mock.canQuery = false; ns.Scan.Search({ { name = "Linen Cloth", key = "i:2589" } })');
    game.run('Mock.advance(0.1)');
    expect(game.eval('Mock.queries')).toHaveLength(0);
    game.run('Mock.canQuery = true; Mock.advance(0.2)');
    expect(game.eval('Mock.queries')).toHaveLength(1);
  });

  it('refuses to start while another scan runs', () => {
    setup();
    game.run('ns.Scan.StartFull()');
    expect(multi('ns.Scan.Search({ { name = "x" } })')).toEqual([false, 'A scan is already running.']);
  });
});

describe('mail', () => {
  function inbox() {
    setup();
    game.run('ns.Collect.RecordItem("i:2589", "item:2589")'); // the addon has seen Linen Cloth
    game.run(`
      Mock.mail({ subject = "Auction successful: Linen Cloth", money = 950, daysLeft = 29.9,
        invoice = { "seller", "Linen Cloth", "Bob", 1000, 1000, 40, 50, 0, 0, "", 5 } })
      Mock.mail({ subject = "Auction won: Wool Cloth", daysLeft = 29.8, item = { id = 2592, count = 10 },
        invoice = { "buyer", "Wool Cloth", "Alice", 800, 800, 0, 0, 0, 0, "", 10 } })
      Mock.mail({ subject = "Auction expired: Rune Blade", daysLeft = 20.1, item = { id = 3000, count = 1 } })
      Mock.mail({ subject = "Auction cancelled: Linen Cloth", daysLeft = 25, item = { id = 2589, count = 7 } })
      Mock.mail({ subject = "Outbid on Wool Cloth", money = 300, daysLeft = 28 })
      Mock.mail({ subject = "Happy birthday!", daysLeft = 28 })
    `);
  }

  it('records sales, purchases, expiries, cancellations and outbids from the game text', () => {
    inbox();
    expect(game.eval('ns.Acct.ReadInbox()')).toBe(5);
    const acct = game.eval<any[]>(`${realm}.acct`);
    expect(acct.map((e) => [e.ty, e.n, e.q, e.p, e.d, e.f, e.o])).toEqual([
      ['sold', 'Linen Cloth', 5, 1000, 40, 50, 'Bob'],
      ['bought', 'Wool Cloth', 10, 800, 0, 0, 'Alice'],
      ['expired', 'Rune Blade', 1, 0, 0, 0, undefined],
      ['cancelled', 'Linen Cloth', 7, 0, 0, 0, undefined],
      ['outbid', 'Wool Cloth', 1, 300, 0, 0, undefined],
    ]);
    expect(acct.every((e) => e.c === 'Lief' && typeof e.id === 'string')).toBe(true);
    expect(acct[1].k).toBe('i:2592'); // from the attached item
    expect(acct[0].k).toBe('i:2589'); // from the items the addon has seen (by name)
    // The send time is 30 days before the mail expires.
    expect(acct[0].t).toBe(Math.floor(1700000000 + 29.9 * 86400 - 30 * 86400));
  });

  it('counts a mail once, however often the inbox is read', () => {
    inbox();
    expect(game.eval('ns.Acct.ReadInbox()')).toBe(5);
    game.run('Mock.now = Mock.now + 300; for _, m in ipairs(Mock.inbox) do m.daysLeft = m.daysLeft - 300 / 86400 end');
    expect(game.eval('ns.Acct.ReadInbox()')).toBe(0);
    game.run('Mock.fire("MAIL_INBOX_UPDATE")');
    expect(game.eval(`#${realm}.acct`)).toBe(5);
    // A second, identical sale much later is a second sale.
    game.run(`Mock.mail({ subject = "Auction successful: Linen Cloth", money = 950, daysLeft = 29.5,
      invoice = { "seller", "Linen Cloth", "Bob", 1000, 1000, 40, 50, 0, 0, "", 5 } })`);
    expect(game.eval('ns.Acct.ReadInbox()')).toBe(1);
  });

  it('understands the mail of a game in another language', () => {
    setup();
    game.run(`
      AUCTION_SOLD_MAIL_SUBJECT = "Subasta con exito: %s"
      AUCTION_EXPIRED_MAIL_SUBJECT = "Subasta expirada: %s"
      AUCTION_WON_MAIL_SUBJECT = "Subasta ganada: %1$s"
      AUCTION_OUTBID_MAIL_SUBJECT = "Pujaron mas que tu en %s"
      AUCTION_REMOVED_MAIL_SUBJECT = "Subasta cancelada: %s"
      ns.Acct.Reset()
    `);
    expect(multi('ns.Acct.Classify("Subasta con exito: Pano de lino (x)")')).toEqual(['sold', 'Pano de lino (x)']);
    expect(multi('ns.Acct.Classify("Subasta ganada: Lana")')).toEqual(['bought', 'Lana']);
    expect(multi('ns.Acct.Classify("Pujaron mas que tu en Lana")')).toEqual(['outbid', 'Lana']);
    expect(multi('ns.Acct.Classify("Auction successful: Linen Cloth")')).toEqual([]);
    expect(game.eval('ns.Acct.PatternFor("100% (sold): %s.")')).toBe('^100%% %(sold%): (.+)%.$');
  });

  it('notes posts and buys as they happen, and your gold over time', () => {
    setup();
    game.run('Mock.bags[0] = { [1] = { id = 2589, count = 20 } }');
    game.run('ns.Actions.PostOne("i:2589", 99, 5, 24)');
    game.run('Mock.auction({ id = 2592, count = 10, buyout = 800, owner = "S" }); ns.Scan.Search({{ name = "Wool Cloth" }}); Mock.deliver(); Mock.pump(); PlaceAuctionBid("list", 1, 800)');
    const acct = game.eval<any[]>(`${realm}.acct`);
    expect(acct.map((e) => [e.ty, e.k, e.q, e.p])).toEqual([
      ['post', 'i:2589', 5, 495],
      ['buy', 'i:2592', 10, 800],
    ]);
    game.run('Mock.money = 200000; ns.Acct.SnapshotGold(false)');
    game.run('Mock.now = Mock.now + 60; ns.Acct.SnapshotGold(false)'); // same gold a minute later: nothing new
    game.run('Mock.now = Mock.now + 60; Mock.money = 250000; ns.Acct.SnapshotGold(false)');
    expect(game.eval(`${realm}.gold.Lief`)).toEqual([1700000000, 200000, 1700000120, 250000]);
  });
});

describe('the posting price', () => {
  const post = (rule: string, others: number[], mine: number[] = []) => multi(`ns.Rules.PostPrice(${rule}, {${others}}, {${mine}})`);
  const rule = '{ min = 500, normal = 1000, max = 3000, undercut = 10 }';

  beforeEachFresh();

  it('undercuts the lowest other seller', () => {
    expect(post(rule, [950, 900, 1200])).toEqual([890, 'undercut', 890]);
  });

  it('posts the normal price when undercutting would go under the minimum', () => {
    expect(post(rule, [505])).toEqual([1000, 'below min', 495]);
    expect(post(rule, [510])).toEqual([500, 'undercut', 500]); // exactly the minimum is fine
  });

  it('caps the price at the maximum', () => {
    expect(post(rule, [5000])).toEqual([3000, 'capped', 4990]);
  });

  it('posts the normal price when nobody else sells, clamped between min and max', () => {
    expect(post(rule, [])).toEqual([1000, 'no competition']);
    expect(post('{ min = 500, normal = 9000, max = 3000, undercut = 10 }', [])).toEqual([3000, 'no competition']);
    expect(post('{ min = 2000, normal = 1000, undercut = 10 }', [])).toEqual([2000, 'no competition']);
  });

  it('matches your own lowest auction instead of undercutting it', () => {
    expect(post(rule, [900], [880])).toEqual([880, 'match', 880]);
    expect(post(rule, [900], [950])).toEqual([890, 'undercut', 890]);
  });

  it('never goes below 1 copper', () => {
    expect(post('{ normal = 50, undercut = 10 }', [5])).toEqual([1, 'undercut', 1]);
  });

  it('has nothing to say without any price', () => {
    expect(game.eval('select(2, ns.Rules.PostPrice({ undercut = 1 }, {}, {}))')).toBe('no price');
    expect(game.eval('(ns.Rules.PostPrice({ undercut = 1 }, {}, {}))')).toBeNull();
  });

  it('works out stack size and count from the rule and your bags, keeping some back', () => {
    expect(multi('ns.Rules.Stacks({ stackSize = 5, stacks = 3, keep = 10 }, 40)')).toEqual([5, 3]);
    expect(multi('ns.Rules.Stacks({ stackSize = 5, stacks = 3, keep = 10 }, 22)')).toEqual([5, 2]);
    expect(multi('ns.Rules.Stacks({ stackSize = 5, stacks = 3, keep = 10 }, 12)')).toEqual([5, 0]);
    expect(multi('ns.Rules.Stacks({}, 7)')).toEqual([1, 1]);
  });

  it('plans a post from the data file: group rule if the item has one, else a plain one from its market value', () => {
    setup();
    data({ rules: { 'i:2589': { group: 'Cloth', min: 90, normal: 120, max: 200, undercut: 5, stackSize: 20, stacks: 4, duration: 12, keep: 20 } } });
    game.run('Mock.bags[0] = { [1] = { id = 2589, count = 100 } }');
    let plan = game.eval<any>('ns.Actions.PostPlan("i:2589", 100)');
    expect(plan).toMatchObject({ fromGroup: true, price: 120, why: 'no competition', stackSize: 20, stacks: 4, duration: 12 });
    // Competition arrives (a search result): 99 each from someone else.
    game.run(`${realm}.pages["i:2589"] = { t = 1699999990, q = 3, a = 1, p = { 92, 3 } }`);
    plan = game.eval('ns.Actions.PostPlan("i:2589", 100)');
    expect(plan).toMatchObject({ price: 120, why: 'below min', lowest: 92, target: 87 });
    game.run(`${realm}.pages["i:2589"] = { t = 1699999990, q = 3, a = 1, p = { 150, 3 } }`);
    expect(game.eval<any>('ns.Actions.PostPlan("i:2589", 100)')).toMatchObject({ price: 145, why: 'undercut' });
    // Wool has no group: a plain rule (70% / 100% / 300% of market, 80% to buy).
    const plain = game.eval<any>('ns.Actions.PostPlan("i:2592", 10)');
    expect(plain).toMatchObject({ fromGroup: false, price: 300, rule: { min: 210, normal: 300, max: 900, shopMax: 240 } });
    expect(game.eval('ns.Actions.PostPlan("i:9999", 1)')).toBeNull();
  });
});

describe('cancelling', () => {
  beforeEachFresh();
  const rule = '{ min = 500, normal = 1000, max = 3000, undercut = 10 }';

  it('cancels an undercut auction whose repost price is still worth it', () => {
    expect(multi(`ns.Rules.CancelDecision({ price = 1000 }, ${rule}, { 900 })`)).toEqual(['cancel', 'undercut', 890, 890]);
  });

  it('keeps one nobody has undercut', () => {
    expect(multi(`ns.Rules.CancelDecision({ price = 1000 }, ${rule}, { 1000, 1100 })`)).toEqual(['keep', 'lowest']);
    expect(multi(`ns.Rules.CancelDecision({ price = 1000 }, ${rule}, {})`)).toEqual(['keep', 'lowest']);
  });

  it('keeps an undercut auction when matching would go below your minimum', () => {
    expect(multi(`ns.Rules.CancelDecision({ price = 1000 }, ${rule}, { 400 })`)).toEqual(['keep', 'at min', 1000, 390]);
  });

  it('lists the cancels, the most money first, using your own auctions only once', () => {
    const list = game.eval<any[]>(`ns.Rules.CancelList(
      { { key = "a", name = "A", count = 20, price = 1000, index = 1 }, { key = "b", name = "B", count = 1, price = 5000, index = 2 }, { key = "c", name = "C", count = 5, price = 700, index = 3 } },
      function() return ${rule} end,
      function(key) return ({ a = { 900 }, b = { 4000 }, c = { 800 } })[key] end)`);
    expect(list.map((c) => [c.key, c.lowest, c.newPrice])).toEqual([
      ['a', 900, 890],
      ['b', 4000, 3000],
    ]);
  });

  it('scans your auctions against fresh searches, then cancels them one click at a time', () => {
    data();
    game.auctions([
      { id: 2589, count: 20, buyout: 1800, owner: 'Rival' }, // 90 each
      { id: 2592, count: 10, buyout: 2500, owner: 'Rival' }, // 250 each
    ]);
    // Yours: Linen at 100 each (undercut by Rival's 90), Wool at 250 (matches Rival's, kept), listed as the "owner" list.
    game.run(`
      Mock.owned = {
        { id = 2589, name = "Linen Cloth", count = 20, buyout = 2000, minBid = 2000, owner = "Lief", timeLeft = 3, saleStatus = 0 },
        { id = 2592, name = "Wool Cloth", count = 10, buyout = 2500, minBid = 2500, owner = "Lief", timeLeft = 3, saleStatus = 0 },
        { id = 2592, name = "Wool Cloth", count = 1, buyout = 999, minBid = 999, owner = "Lief", timeLeft = 3, saleStatus = 1 },
      }
    `);
    game.run('ns.Actions.CancelScan(function(list) LIST = list end)');
    for (let i = 0; i < 2; i++) game.run('Mock.deliver(); Mock.pump()');
    expect(game.eval('#Mock.queries')).toBe(2);
    const list = game.eval<any[]>('LIST');
    expect(list.map((c) => [c.key, c.price, c.lowest, c.newPrice, c.count])).toEqual([['i:2589', 100, 90, 89, 20]]);
    // The sold-but-unpaid auction (saleStatus 1) is not offered, and your own owner list was saved.
    expect(game.eval(`${realm}.owned.Lief.list`)).toHaveLength(2);

    // Another of your auctions sold meanwhile, so the positions moved: it finds the auction again by what it is.
    game.run('table.remove(Mock.owned, 1); table.insert(Mock.owned, { id = 2589, name = "Linen Cloth", count = 20, buyout = 2000, minBid = 2000, owner = "Lief", timeLeft = 3, saleStatus = 0 })');
    expect(multi('ns.Actions.CancelNext()')[0]).toBe(true);
    expect(game.eval('Mock.calls[#Mock.calls]')).toEqual(['CancelAuction', 3]);
    expect(multi('ns.Actions.CancelNext()')).toEqual([false, 'Nothing left to cancel.']);
  });
});

describe('shopping', () => {
  beforeEachFresh();

  const listing = (o: Record<string, unknown>) => luaTable({ key: 'i:2589', name: 'Linen Cloth', count: 1, ...o });

  it('picks listings under a max price, cheapest first, never your own', () => {
    const r = game.eval<any[]>(`ns.Rules.ShopMatches({
      ${listing({ price: 120, buyout: 120, seller: 'A' })}, ${listing({ price: 90, buyout: 90, seller: 'B' })},
      ${listing({ price: 80, buyout: 80, seller: 'Lief' })}, ${listing({ price: 100, buyout: 100, seller: 'C' })},
      ${listing({ price: 100, buyout: 1000, count: 10, seller: 'D' })},
    }, { maxPrice = 100, isMine = ns.Db.IsMine })`);
    expect(r.map((m) => [m.listing.seller, m.price])).toEqual([['B', 90], ['D', 100], ['C', 100]]);
  });

  it('picks listings under a share of market value, with how much of market they are', () => {
    const r = game.eval<any[]>(`ns.Rules.ShopMatches({ ${listing({ price: 55 })}, ${listing({ price: 61 })}, ${listing({ price: 30 })} }, { percent = 0.6, market = 100 })`);
    expect(r.map((m) => [m.price, m.percent])).toEqual([[30, 0.3], [55, 0.55]]);
  });

  it('buys nothing without a price to compare with', () => {
    expect(game.eval(`ns.Rules.ShopMatches({ ${listing({ price: 1 })} }, {})`)).toEqual([]);
    expect(game.eval(`ns.Rules.ShopMatches({ ${listing({ price: 0 })} }, { maxPrice = 100 })`)).toEqual([]);
  });

  it('runs a shopping list through searches and lists what is worth buying', () => {
    data({
      shopping: [{ name: 'Cloth', items: [{ item: 'i:2589', name: 'Linen Cloth', maxPrice: 100 }, { item: 'i:2592', name: 'Wool Cloth' }] }],
    });
    game.auctions([
      { id: 2589, count: 5, buyout: 450, owner: 'A' }, // 90
      { id: 2589, count: 5, buyout: 600, owner: 'B' }, // 120: over the max
      { id: 2589, count: 1, buyout: 70, owner: 'Lief' }, // yours
      { id: 2592, count: 1, buyout: 230, owner: 'C' }, // 230: under the rule's default (80% of 300 = 240)
      { id: 2592, count: 1, buyout: 260, owner: 'D' },
    ]);
    expect(multi('ns.Actions.Shop(1, function(r) DONE = #r end)')[0]).toBe(true);
    for (let i = 0; i < 2; i++) game.run('Mock.deliver(); Mock.pump()');
    expect(game.eval('DONE')).toBe(2);
    const r = game.eval<any[]>('ns.Actions.results');
    expect(r.map((x) => [x.name, x.price, x.listing.seller])).toEqual([
      ['Wool Cloth', 230, 'C'], // best deals first: 77% of market against 90%
      ['Linen Cloth', 90, 'A'],
    ]);
    expect(multi('ns.Actions.Shop(7)')).toEqual([false, "There's no such shopping list."]);
  });

  it('looks for deals below a share of market value among the items Uncbox says to watch', () => {
    data({ deals: { percent: 0.6, minMarket: 100, minSaleRate: 0, watch: [{ item: 'i:2592', name: 'Wool Cloth' }] } });
    game.auctions([
      { id: 2592, count: 2, buyout: 340, owner: 'A' }, // 170 each: 57% of 300
      { id: 2592, count: 1, buyout: 200, owner: 'B' }, // 67%: not a deal
    ]);
    game.run('ns.Actions.Shop("deals")');
    game.run('Mock.deliver(); Mock.pump()');
    const r = game.eval<any[]>('ns.Actions.results');
    expect(r.map((x) => [x.price, Math.round(x.percent * 100)])).toEqual([[170, 57]]);
  });

  it('buys with one click when the list still shows the listing, otherwise looks it up again first', () => {
    data({ shopping: [{ name: 'Cloth', items: [{ item: 'i:2589', name: 'Linen Cloth', maxPrice: 100 }] }] });
    game.auctions([{ id: 2589, count: 5, buyout: 450, owner: 'A' }]);
    game.run('ns.Actions.Shop(1)');
    game.run('Mock.deliver(); Mock.pump()');
    expect(game.eval('ns.Actions.Buy(ns.Actions.results[1])')).toBe('bought');
    expect(game.eval('Mock.calls[#Mock.calls]')).toEqual(['PlaceAuctionBid', 'list', 1, 450]);
    expect(game.eval('#ns.Actions.results')).toBe(0);

    // The window now shows something else (another search), so a buy has to look the listing up again.
    game.run('ns.Actions.Shop(1)');
    game.run('Mock.deliver(); Mock.pump()');
    game.run('Mock.auction({ id = 2592, count = 1, buyout = 5, owner = "Z" }); ns.Scan.Search({{ name = "Wool Cloth" }}); Mock.deliver(); Mock.pump()');
    const before = game.eval<number>('#Mock.calls');
    expect(game.eval('ns.Actions.Buy(ns.Actions.results[1])')).toBe('searching');
    expect(game.eval('#Mock.calls')).toBe(before); // nothing bought yet
    game.run('Mock.deliver(); Mock.pump()');
    expect(game.eval('ns.Actions.results[1].ready')).toBe(true);
    expect(game.eval('ns.Actions.Buy(ns.Actions.results[1])')).toBe('bought');
    expect(game.eval('Mock.calls[#Mock.calls]')).toEqual(['PlaceAuctionBid', 'list', 1, 450]);
  });
});

describe('posting', () => {
  beforeEachFresh();

  it('posts one stack per call, picking up the right stack and using the auction length the game wants', () => {
    game.run('Mock.bags[0] = { [1] = { id = 2589, count = 5 }, [2] = { id = 2589, count = 20 }, [3] = { id = 2589, count = 12 } }');
    expect(multi('ns.Actions.PostOne("i:2589", 99, 10, 24)')).toEqual([true, 10]);
    // The smallest stack that is big enough: the 12.
    expect(game.eval<any[]>('Mock.calls').slice(0, 3)).toEqual([['PickupContainerItem', 0, 3], ['ClickAuctionSellItemButton'], ['StartAuction', 990, 990, 2, 10, 1]]);
    // A game whose auction length is in minutes.
    game.run('AuctionFrameAuctions = { duration = 1440 }; Mock.calls = {}');
    game.run('ns.Actions.PostOne("i:2589", 99, 50, 48)'); // no stack of 50: the biggest, 20
    expect(game.eval('Mock.calls[3]')).toEqual(['StartAuction', 1980, 1980, 2880, 20, 1]);
  });

  it('says why it could not post', () => {
    expect(multi('ns.Actions.PostOne("i:2589", 99, 1, 24)')).toEqual([false, "That item isn't in your bags."]);
    game.run('Mock.bags[0] = { [1] = { id = 2589, count = 5 } }');
    expect(multi('ns.Actions.PostOne("i:2589", nil, 1, 24)')).toEqual([false, "There's no price to post at."]);
    game.run('ClickAuctionSellItemButton = function() end');
    expect(multi('ns.Actions.PostOne("i:2589", 5, 1, 24)')).toEqual([false, "The game hadn't loaded the item yet. Click again."]);
  });
});

describe('the data file and tooltips', () => {
  beforeEachFresh();

  it('reads prices, rules and age from UncboxAHData', () => {
    data({ rules: { 'i:2589': { group: 'Cloth', min: 1, normal: 2, max: 3 } } });
    expect(game.eval('ns.Rules.Item("i:2589")')).toMatchObject({ market: 100, minBuyout: 95, saleRate: 0.62 });
    expect(game.eval('ns.Rules.Item("i:1")')).toBeNull();
    expect(game.eval('ns.Rules.RuleFor("i:2589")')).toEqual({ group: 'Cloth', min: 1, normal: 2, max: 3 });
    expect(game.eval('ns.Rules.DataAge(1699993600)')).toBe(3600);
    game.run('Mock.faction = "Horde"');
    expect(game.eval('ns.Rules.Item("i:2589")')).toBeNull(); // another faction's prices are not yours
  });

  it('copes with no data file at all', () => {
    game.run('UncboxAHData = nil');
    expect(game.eval('ns.Rules.Item("i:2589")')).toBeNull();
    expect(game.eval('ns.Rules.DataAge(5)')).toBeNull();
    expect(game.eval('ns.Tooltip.Lines("i:2589", 1)')).toEqual([]);
    expect(game.eval('ns.UI.Status()')).toContain('none yet');
  });

  it('adds the price lines to a tooltip, with the stack total over a stack', () => {
    data();
    expect(game.eval('ns.Tooltip.Lines("i:2589", 1)')).toEqual([
      ['Uncbox Market Value', '1s'],
      ['Uncbox Min Buyout', '95c'],
      ['Uncbox Your Avg Sale', '1s 5c'],
      ['Uncbox Sale Rate', '62%'],
      ['Uncbox Vendor', '13c'],
    ]);
    expect(game.eval<string[][]>('ns.Tooltip.Lines("i:2589", 20)')[0]).toEqual(['Uncbox Market Value', '1s  (x20: 20s)']);
    // Hooked onto the game's tooltip, over a bag slot holding 20.
    game.run(`
      local bagFrame = CreateFrame("Frame"); bagFrame.GetID = function() return 0 end
      local slot = CreateFrame("Button"); slot.GetID = function() return 1 end; slot.GetParent = function() return bagFrame end
      Mock.bags[0] = { [1] = { id = 2589, count = 20 } }
      GameTooltip = Mock.tooltip(Mock.link(2589), slot)
      ns.Tooltip.hooked = nil
      ns.Tooltip.Hook()
      GameTooltip.hooks.OnTooltipSetItem[1](GameTooltip)
      GameTooltip.hooks.OnTooltipSetItem[1](GameTooltip) -- fired twice by the game: only decorated once
    `);
    const lines = game.eval<string[][]>('GameTooltip.lines');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toEqual(['Uncbox Market Value', '1s  (x20: 20s)']);
    game.run('Mock.fire("ADDON_LOADED", "UncboxAH"); ns.Core.Slash("tooltip")');
    expect(game.eval('UncboxAHDB.options.tooltip')).toBe(false);
  });
});

describe('what the addon notes about you', () => {
  beforeEachFresh();

  it('saves what is in your bags, and the bank when you are at it', () => {
    game.run(`
      Mock.bags[0] = { [1] = { id = 2589, count = 20 }, [2] = { id = 2589, count = 15 }, [3] = { id = 2592, count = 3 } }
      Mock.bags[5] = { size = 8, [1] = { id = 3000, count = 1 } }
      Mock.bags[-1] = { size = 8, [2] = { id = 2592, count = 7 } }
    `);
    game.run('ns.Collect.Inventory(false)');
    expect(game.eval(`${realm}.inv.Lief`)).toMatchObject({ t: 1700000000, bags: { 'i:2589': 35, 'i:2592': 3 } });
    expect(game.eval(`${realm}.inv.Lief.bank`)).toBeNull();
    game.run('Mock.now = Mock.now + 10; ns.Collect.Inventory(true)');
    expect(game.eval(`${realm}.inv.Lief`)).toMatchObject({ t: 1700000010, bankT: 1700000010, bank: { 'i:2592': 7, 'i:3000': 1 } });
    expect(game.eval('UncboxAHDB.items["i:3000"]')).toMatchObject({ n: 'Rune Blade', q: 3, v: 500 });
  });

  it('records every recipe in an open profession, opening collapsed headers and closing them again', () => {
    game.run(`
      Mock.item(118, "Minor Healing Potion"); Mock.item(2447, "Peacebloom"); Mock.item(3371, "Empty Vial")
      Mock.skill = { name = "Alchemy", rows = {
        { name = "Potions", header = true, expanded = false },
        { name = "Minor Healing Potion", id = 118, made = 1, reagents = { { 2447, 1 }, { 3371, 1 } } },
        { name = "Elixirs", header = true, expanded = true },
        { name = "Transmute", id = nil },
      } }
    `);
    game.run('Mock.fire("TRADE_SKILL_SHOW"); Mock.advance(1)');
    expect(game.eval('UncboxAHDB.recipes.Alchemy')).toEqual({ 'i:118': { n: 'Minor Healing Potion', m: 1, r: ['i:2447', 1, 'i:3371', 1] } });
    expect(game.eval('Mock.skill.rows[1].expanded')).toBe(false);
    expect(game.eval('Mock.skill.rows[3].expanded')).toBe(true);
  });

  it('notes what vendors always have in stock and charge for it', () => {
    game.run(`
      Mock.item(3371, "Empty Vial"); Mock.item(2592, "Wool Cloth")
      Mock.merchant = { { id = 3371, price = 50, quantity = 1 }, { id = 2592, price = 200, quantity = 5 }, { id = 3000, price = 9, available = 3 } }
    `);
    game.run('Mock.fire("MERCHANT_SHOW")');
    expect(game.eval('UncboxAHDB.vendorBuy')).toEqual({ 'i:3371': 50, 'i:2592': 40 });
  });
});

describe('the auction tab', () => {
  beforeEachFresh();

  function openAuctionHouse() {
    game.run(`
      function PanelTemplates_SetNumTabs() end
      function PanelTemplates_EnableTab() end
      function AuctionFrameTab_OnClick() end
      ITEM_QUALITY_COLORS = { [1] = { hex = "|cffffffff" }, [3] = { hex = "|cff0070dd" } }
      AuctionFrame = CreateFrame("Frame", "AuctionFrame"); AuctionFrame.numTabs = 3; AuctionFrame:Show()
      AuctionFrameTab3 = CreateFrame("Button", "AuctionFrameTab3")
    `);
    game.run('Mock.fire("AUCTION_HOUSE_SHOW")');
    expect(game.eval('ns.errors')).toEqual([]);
    expect(game.eval('ns.printed')).toEqual([]);
  }

  it('builds a tab and shows the post, cancel and shopping panels without errors', () => {
    data({ shopping: [{ name: 'Cloth', items: [{ item: 'i:2589', name: 'Linen Cloth', maxPrice: 100 }] }] });
    game.run('Mock.bags[0] = { [1] = { id = 2589, count = 20 } }');
    openAuctionHouse();
    expect(game.eval('ns.UI.tab.text')).toBe('Uncbox');
    expect(game.eval('ns.UI.tab.id')).toBe(4);
    expect(game.eval('ns.UI.panel.shown')).toBe(false);
    game.run('AuctionFrameTab_OnClick(ns.UI.tab)'); // the game's click handler, then ours
    expect(game.eval('ns.UI.panel.shown')).toBe(true);
    expect(game.eval('ns.UI.post.shown')).toBe(true);
    expect(game.eval('#ns.UI.post.items')).toBe(1);

    game.run('ns.UI.SelectItem(ns.UI.post.items[1])');
    expect(game.eval('ns.UI.post.info.text')).toContain('Suggested:');
    expect(game.eval('ns.UI.post.price.text')).toBe('1s'); // 100 copper
    game.run('ns.UI.PostSelected()');
    expect(game.eval('Mock.calls[#Mock.calls]')).toEqual(['StartAuction', 100, 100, 2, 1, 1]);
    expect(game.eval('ns.UI.post.result.text')).toContain('Posted 1 at');

    game.run('ns.UI.Show("shop")');
    expect(game.eval('ns.UI.shop.shown')).toBe(true);
    expect(game.eval('ns.UI.post.shown')).toBe(false);
    expect(game.eval('#ns.UI.shop.buttons')).toBe(2); // the list and Deals
    game.run('ns.UI.Show("cancel")');
    expect(game.eval('ns.UI.cancel.shown')).toBe(true);
    expect(game.eval('ns.UI.Status()')).toMatch(/Last full scan: never.*Prices from Uncbox: 2h 46m old.*full scan ready/);
    expect(game.eval('ns.errors')).toEqual([]);
  });

  it('runs the slash commands', () => {
    openAuctionHouse();
    game.auctions([{ id: 2589, count: 1, buyout: 100, owner: 'S' }]);
    game.run('ns.Core.Slash("scan")');
    expect(game.eval('ns.printed')).toContain('Full scan started. Don\'t close the auction house.');
    game.run('Mock.deliver(); Mock.pump()');
    game.run('ns.Core.Slash("status")');
    expect(game.eval<string[]>('ns.printed').at(-1)).toContain('Last full scan: 0s ago');
    game.run('ns.Core.Slash("help")');
    expect(game.eval<string[]>('ns.printed').filter((l) => l.startsWith('/uah')).length).toBeGreaterThanOrEqual(5);
    game.run('Mock.canAll = false; ns.Core.Slash("scan")');
    expect(game.eval<string[]>('ns.printed').at(-1)).toMatch(/^A full scan can run again in/);
    game.run('AuctionFrame:Hide(); ns.printed = {}; ns.Core.Slash("post")');
    expect(game.eval('ns.printed')).toEqual(['Open the auction house first.']);
  });
});

describe('what it saves', () => {
  it('writes only plain numbers, strings and tables, in the shape the server reads', () => {
    setup();
    game.auctions([{ id: 2589, count: 5, buyout: 500, owner: 'A' }]);
    game.run('ns.Scan.StartFull(); Mock.deliver(); Mock.pump()');
    const text = game.saved();
    expect(text).toMatch(/^UncboxAHDB = \{/);
    expect(text).not.toMatch(/function|userdata|thread/);
    expect(text).toContain('["Stalagg|Alliance"]');
  });
});
