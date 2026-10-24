// @vitest-environment jsdom
//
// The Auction House widget drawn for real (React, every tab) against a faked server: each tab with
// data and with none, an item opening, a formula's error, group changes reaching the right route,
// stream mode hiding gold, and new data from the server being read again.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useCallback, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Widget } from '../../state/model';
import { formatMoney } from '../../money';
import { MASK } from './ah';
import { AuctionHouseBody } from './AuctionHouseWidget';
import { type AhReply, type AhScenario, ahRoute, DETAIL, GOLD, GROUPS, STATUS_DATA } from './fixtures';
import { AH_TABS, type AhTab, type AuctionHouseSettings, defaultAuctionHouseSettings } from './settings';

// The server's live events: the test fires them by hand.
const live = vi.hoisted(() => ({ handlers: new Map<string, Set<(data: string) => void>>() }));
vi.mock('../../events', () => ({
  listen: (name: string, fn: (data: string) => void) => {
    const set = live.handlers.get(name) ?? new Set();
    set.add(fn);
    live.handlers.set(name, set);
    return () => void set.delete(fn);
  },
  onConnection: () => () => {},
}));

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}
let calls: Call[] = [];
type Override = (call: Call) => AhReply | undefined;

/** Fakes the server: the fixtures, with some answers replaced. */
function fakeServer(scenario: AhScenario, override: Override = () => undefined) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = { method: (init?.method ?? 'GET').toUpperCase(), path: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const reply = override(call) ?? ahRoute(scenario, call.path, call.method) ?? { body: { ok: true } };
      return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path.includes(path));

let current: AuctionHouseSettings = defaultAuctionHouseSettings();

function Harness({ initial = {}, editing = true }: { initial?: Partial<AuctionHouseSettings>; editing?: boolean }) {
  const [settings, setSettings] = useState<AuctionHouseSettings>({ ...defaultAuctionHouseSettings(), ...initial });
  current = settings;
  const set = useCallback((patch: Partial<AuctionHouseSettings>) => setSettings((s) => ({ ...s, ...patch })), []);
  const widget: Widget<AuctionHouseSettings> = { id: 'wdg-test', kind: 'auctionhouse', title: '', settings };
  return <AuctionHouseBody widget={widget} settings={settings} set={set} editing={editing} open={false} close={() => {}} />;
}

async function show(tab: AhTab, scenario: AhScenario = 'data', opts: { override?: Override; editing?: boolean; settings?: Partial<AuctionHouseSettings> } = {}) {
  fakeServer(scenario, opts.override);
  const view = render(<Harness initial={{ tab, ...opts.settings }} editing={opts.editing} />);
  await screen.findByRole('tablist', { name: 'Auction house sections' });
  return view;
}

beforeEach(() => {
  live.handlers.clear();
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const panel = () => screen.getByRole('tabpanel');

describe('every tab with data', () => {
  const EXPECT: Record<AhTab, string[]> = {
    overview: ['Last full scan', '2 hours ago', 'Top deals', 'Arcanite Bar', 'Top flips', 'Undercut alerts'],
    search: ['Linen Cloth', 'Arcanite Bar', 'Thunderfury'],
    deals: ['Arcanite Bar', 'Profit each', 'Profit total'],
    crafting: ['Bolt of Linen Cloth', 'Margin'],
    selling: ['What to sell', 'Linen Cloth', 'Cancel these in game:', '/uah cancel'],
    accounting: ['Sales', 'Purchases', 'Fees', 'Net', 'Entries'],
    rules: ['Cloth', 'New group'],
  };
  it.each(AH_TABS.map((t) => t.id))('%s', async (tab) => {
    await show(tab);
    for (const text of EXPECT[tab]) expect((await within(panel()).findAllByText(new RegExp(text.replace(/[/.]/g, '\\$&'), 'i'), undefined, { timeout: 2000 })).length).toBeGreaterThan(0);
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe(AH_TABS.find((t) => t.id === tab)!.label);
  });
});

describe('every tab with nothing set up', () => {
  it.each(AH_TABS.map((t) => t.id).filter((t) => t !== 'rules'))('%s asks for the addon to be installed', async (tab) => {
    await show(tab, 'empty');
    expect(await within(panel()).findByRole('heading', { name: 'Install the WoW addons' })).toBeTruthy();
    expect(within(panel()).getByRole('button', { name: /Install the WoW addons/ })).toBeTruthy();
  });

  it('installs the addons from the empty state, then reads again', async () => {
    await show('overview', 'empty', { override: (c) => (c.path === '/api/wow/install' ? { body: { ok: true, paths: ['C:\\WoW\\Interface\\AddOns'] } } : undefined) });
    fireEvent.click(await within(panel()).findByRole('button', { name: /Install the WoW addons/ }));
    expect(await within(panel()).findByText(/Type \/reload in WoW/)).toBeTruthy();
    expect(callsTo('POST', '/api/wow/install')).toHaveLength(1);
    // Status was asked for again, so the next screen can show.
    await waitFor(() => expect(callsTo('GET', '/api/wow/ah/status').length).toBeGreaterThan(1));
  });

  it('with the addon installed but nothing scanned, says what to type in game', async () => {
    await show('overview', 'empty', { override: (c) => (c.path === '/api/wow/ah/status' ? { body: { ...STATUS_DATA, realms: [], lastFullScan: null, dataAge: null } } : undefined) });
    expect(await within(panel()).findByText(/No auction house data yet/)).toBeTruthy();
    expect(panel().textContent).toContain('/uah scan');
    expect(panel().textContent).toContain('/reload');
  });

  it('says so when the engine cannot run', async () => {
    await show('overview', 'empty', { override: (c) => (c.path === '/api/wow/ah/status' ? { body: { ...STATUS_DATA, available: false, realms: [] } } : undefined) });
    expect(await within(panel()).findByText(/need a newer Node/)).toBeTruthy();
  });

  it('shows the server’s message when it can’t be reached from here', async () => {
    await show('overview', 'data', { override: (c) => (c.path === '/api/wow/ah/status' ? { status: 403, body: { error: 'Run this on the PC WoW is on.' } } : undefined) });
    expect(await within(panel()).findByText('Run this on the PC WoW is on.')).toBeTruthy();
  });

  it('still lets you write rules before anything is scanned', async () => {
    await show('rules', 'empty');
    expect(await within(panel()).findByText('New group')).toBeTruthy();
  });
});

describe('friendly empty lists', () => {
  const none = (route: string): Override => (c) => (c.path.startsWith(`/api/wow/ah/${route}`) ? { body: { realm: 'Stalagg', faction: 'Alliance', rows: [] } } : undefined);
  it('deals', async () => {
    await show('deals', 'data', { override: none('deals') });
    expect(await within(panel()).findByText(/Nothing qualifies/)).toBeTruthy();
  });
  it('crafting', async () => {
    await show('crafting', 'data', { override: none('crafting') });
    expect(await within(panel()).findByText(/No recipe has prices for everything yet/)).toBeTruthy();
  });
  it('selling', async () => {
    await show('selling', 'data', { override: (c) => none('sell')(c) ?? none('undercuts')(c) });
    expect(await within(panel()).findByText(/Nothing in your bags or bank has a price yet/)).toBeTruthy();
    expect(await within(panel()).findByText(/Nobody has undercut/)).toBeTruthy();
  });
  it('search', async () => {
    await show('search', 'data', { settings: { query: 'zzz' } });
    expect(await within(panel()).findByText(/Nothing in your scans matches/)).toBeTruthy();
  });
});

describe('the tabs', () => {
  it('remember the last one open, and move with the arrow keys', async () => {
    await show('overview');
    const overview = screen.getByRole('tab', { name: 'Overview' });
    overview.focus();
    fireEvent.keyDown(overview, { key: 'ArrowRight' });
    expect(current.tab).toBe('search');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Search' }));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(current.tab).toBe('rules');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(current.tab).toBe('overview');
    fireEvent.click(screen.getByRole('tab', { name: 'Deals' }));
    expect(current.tab).toBe('deals');
    // Only the open tab can be reached with Tab.
    expect(screen.getByRole('tab', { name: 'Deals' }).getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('tabindex')).toBe('-1');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(screen.getByRole('tab', { name: 'Deals' }).id);
  });

  it('links from the overview to the tab with the rest', async () => {
    await show('overview');
    fireEvent.click(await within(panel()).findByRole('button', { name: 'All deals' }));
    expect(current.tab).toBe('deals');
  });

  it('shows the realm picker only when several realms were scanned, and reads the one picked', async () => {
    await show('overview');
    await within(panel()).findByText('Last full scan');
    expect(within(panel()).queryByLabelText('Realm')).toBeNull();
    cleanup();

    const second = { realm: 'Mirage Raceway', faction: 'Horde', lastFullScan: 1, lastScan: 1, scans: 1, items: 1 };
    await show('overview', 'data', { override: (c) => (c.path === '/api/wow/ah/status' ? { body: { ...STATUS_DATA, realms: [...STATUS_DATA.realms, second] } } : undefined) });
    const picker = await within(panel()).findByLabelText('Realm');
    fireEvent.change(picker, { target: { value: 'Mirage Raceway|Horde' } });
    expect(current.realm).toBe('Mirage Raceway');
    expect(current.faction).toBe('Horde');
    await waitFor(() => expect(calls.some((c) => c.path.includes('/gold') && c.path.includes('realm=Mirage%20Raceway&faction=Horde'))).toBe(true));
  });

  it('warns when the last full scan is old', async () => {
    const old = { ...STATUS_DATA.realms[0], lastFullScan: Math.floor(Date.now() / 1000) - 3 * 86400 };
    await show('overview', 'data', { override: (c) => (c.path === '/api/wow/ah/status' ? { body: { ...STATUS_DATA, realms: [old], dataAge: 3 * 86400 } } : undefined) });
    expect(await within(panel()).findByText(/prices are getting old/)).toBeTruthy();
    expect(panel().textContent).toContain('/uah scan');
  });
});

describe('search', () => {
  it('sorts by a column heading, flipping on the second click', async () => {
    await show('search');
    const names = () => within(panel()).getAllByRole('rowheader').map((r) => r.textContent);
    await within(panel()).findByText(/Linen Cloth/);
    // Market, high to low, is where it starts; items with no value last.
    expect(names()[0]).toContain('Arcanite Bar');
    expect(names().at(-1)).toContain('Thunderfury');
    fireEvent.click(within(panel()).getByRole('button', { name: /^Qty/ }));
    expect(names()[0]).toContain('Linen Cloth');
    expect(within(panel()).getByRole('columnheader', { name: /Qty/ }).getAttribute('aria-sort')).toBe('descending');
    fireEvent.click(within(panel()).getByRole('button', { name: /^Qty/ }));
    expect(names()[0]).toContain('Thunderfury');
    expect(within(panel()).getByRole('columnheader', { name: /Qty/ }).getAttribute('aria-sort')).toBe('ascending');
    expect(within(panel()).getByRole('columnheader', { name: /Market/ }).getAttribute('aria-sort')).toBe('none');
  });

  it('asks the server for what was typed', async () => {
    await show('search');
    fireEvent.change(await within(panel()).findByLabelText('Search items'), { target: { value: 'arc' } });
    await waitFor(() => expect(calls.some((c) => c.path.includes('/items') && c.path.includes('q=arc'))).toBe(true));
  });

  it('colors a name by its quality and says the quality in words', async () => {
    await show('search');
    const epic = await within(panel()).findByText(/Thunderfury/);
    expect(epic.closest('.ah-itemtitle')?.getAttribute('style')).toContain('rgb(255, 128, 0)');
    expect(epic.closest('.ah-itemtitle')?.textContent).toContain('Legendary');
  });

  describe('an item', () => {
    const open = async (override?: Override) => {
      await show('search', 'data', { override });
      fireEvent.click(await within(panel()).findByRole('button', { name: /Linen Cloth/ }));
      await within(panel()).findByText('On the auction house');
    };

    it('opens with its history, ladder, own auctions, numbers and buttons, and goes back', async () => {
      await open();
      expect(callsTo('GET', `/item/${encodeURIComponent('i:2589')}`)).toHaveLength(1);
      // The ladder: price each and how many are listed.
      const ladder = within(panel()).getByRole('region', { name: 'Price ladder' });
      expect(within(ladder).getAllByRole('row')).toHaveLength(1 + DETAIL.ladder.length);
      expect(ladder.textContent).toContain(formatMoney(1000));
      // Your own auction is marked.
      expect(within(panel()).getByRole('region', { name: 'Your auctions' }).textContent).toContain(formatMoney(1100));
      expect(ladder.querySelector('tr.is-mine')?.textContent).toContain(formatMoney(1100));
      // The numbers.
      const numbers = within(panel()).getByRole('region', { name: 'Numbers' });
      expect(numbers.textContent).toContain('Market value');
      expect(numbers.textContent).toContain('80%');
      expect(within(panel()).getByRole('button', { name: /Add to group/ })).toBeTruthy();
      expect(within(panel()).getByRole('button', { name: /Add to shopping list/ })).toBeTruthy();
      // Back to the list.
      fireEvent.click(within(panel()).getByRole('button', { name: /All items/ }));
      expect(await within(panel()).findByLabelText('Search items')).toBeTruthy();
    });

    it('draws the price chart with a legend and a readout for each point', async () => {
      await open();
      const chart = within(panel()).getByRole('region', { name: 'Price history' });
      expect(chart.querySelectorAll('g.ah-line path')).toHaveLength(2);
      expect(chart.textContent).toContain('Market');
      expect(chart.textContent).toContain('Min buyout');
      const plot = chart.querySelector<HTMLElement>('.ah-chart__plot')!;
      expect(plot.getAttribute('tabindex')).toBe('0');
      plot.focus();
      fireEvent.keyDown(plot, { key: 'End' });
      const readout = chart.querySelector('.ah-chart__readout')!;
      // The newest scan's min buyout was 1000 copper.
      expect(readout.textContent).toContain(`Min buyout ${formatMoney(1000)}`);
      fireEvent.keyDown(plot, { key: 'ArrowLeft' });
      expect(readout.textContent).toContain(`Min buyout ${formatMoney(1050)}`);
      fireEvent.keyDown(plot, { key: 'Escape' });
      expect(readout.textContent).toContain('Hover the chart');
    });

    it('reads the hover position from the pointer', async () => {
      await open();
      const chart = within(panel()).getByRole('region', { name: 'Price history' });
      const svg = chart.querySelector('.ah-chart__plot svg') as SVGSVGElement;
      vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 480, bottom: 180, width: 480, height: 180, x: 0, y: 0, toJSON: () => ({}) });
      fireEvent.mouseMove(svg, { clientX: 5 });
      expect(chart.querySelector('.ah-chart__readout')!.textContent).toContain(formatMoney(900));
      fireEvent.mouseLeave(svg);
      expect(chart.querySelector('.ah-chart__readout')!.textContent).toContain('Hover the chart');
    });

    it('opens Wowhead through the server, not a new window', async () => {
      const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
      await open();
      fireEvent.click(within(panel()).getByRole('button', { name: /Wowhead/ }));
      await waitFor(() => expect(callsTo('POST', '/api/open')).toHaveLength(1));
      expect(callsTo('POST', '/api/open')[0].body).toEqual({ target: 'wowhead-item', item: 2589 });
      expect(windowOpen).not.toHaveBeenCalled();
    });

    it('adds the item to a group, and to a shopping list', async () => {
      const bare = (c: Call): AhReply | undefined =>
        c.method === 'GET' && c.path.endsWith('/groups') ? { body: { groups: [{ ...GROUPS[0], items: ['i:12360'] }] } } : c.method === 'GET' && c.path.endsWith('/shopping') ? { body: { shopping: [{ id: 's1', name: 'Flask stuff', items: [{ name: 'Mageroyal' }] }] } } : undefined;
      await open(bare);
      await waitFor(() => expect((within(panel()).getByRole('button', { name: /Add to group/ }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(within(panel()).getByRole('button', { name: /Add to group/ }));
      await waitFor(() => expect(callsTo('PUT', '/api/wow/ah/groups/g1')).toHaveLength(1));
      expect(callsTo('PUT', '/groups/g1')[0].body).toEqual({ items: ['i:12360', 'i:2589'] });
      expect(await within(panel()).findByText('Added to Cloth.')).toBeTruthy();

      fireEvent.click(within(panel()).getByRole('button', { name: /Add to shopping list/ }));
      await waitFor(() => expect(callsTo('PUT', '/api/wow/ah/shopping/s1')).toHaveLength(1));
      expect(callsTo('PUT', '/shopping/s1')[0].body).toEqual({ items: [{ name: 'Mageroyal' }, { item: 'i:2589' }] });
    });

    it('says what to do when there are no groups yet, and says the server’s refusal', async () => {
      await open((c) => (c.method === 'GET' && c.path.endsWith('/groups') ? { body: { groups: [] } } : undefined));
      expect((within(panel()).getByRole('button', { name: /Add to group/ }) as HTMLButtonElement).disabled).toBe(true);
      expect(within(panel()).getByRole('button', { name: 'Rules' })).toBeTruthy();
      cleanup();

      await open((c) => (c.method === 'PUT' ? { status: 400, body: { error: 'A group holds up to 5000 items.' } } : undefined));
      await waitFor(() => expect((within(panel()).getByRole('button', { name: /Add to group/ }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(within(panel()).getByRole('button', { name: /Add to group/ }));
      expect(await within(panel()).findByText('A group holds up to 5000 items.')).toBeTruthy();
    });

    it('opens from a link in another tab', async () => {
      await show('deals');
      fireEvent.click(await within(panel()).findByRole('button', { name: 'Arcanite Bar' }));
      expect(current.tab).toBe('search');
      expect(await within(panel()).findByText('On the auction house')).toBeTruthy();
      expect(callsTo('GET', `/item/${encodeURIComponent('i:12360')}`)).toHaveLength(1);
    });
  });
});

describe('deals', () => {
  it('shows profit per unit and in total, and flips and vendor flips as their own views', async () => {
    await show('deals');
    const deals = await within(panel()).findByRole('region', { name: 'Deals' });
    const cells = within(deals).getAllByRole('cell').map((c) => c.textContent);
    // 3 at 25g under a 52g market: 70g in all, which is 23g 33s 33c each.
    expect(cells).toContain(formatMoney(700000));
    expect(cells).toContain(formatMoney(233333));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Flips' }));
    const flips = await within(panel()).findByRole('region', { name: 'Flips' });
    expect(flips.textContent).toContain(formatMoney(4000));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Vendor flips' }));
    const vendor = await within(panel()).findByRole('region', { name: 'Vendor flips' });
    expect(vendor.textContent).toContain('Silk Cloth');
    expect(vendor.textContent).toContain(formatMoney(2000));
  });

  it('saves the thresholds (keeping the setting it doesn’t show) and reads the deals again with them', async () => {
    await show('deals');
    const percent = await within(panel()).findByLabelText('Under % of market');
    expect((percent as HTMLInputElement).value).toBe('60');
    fireEvent.change(percent, { target: { value: '50' } });
    fireEvent.change(within(panel()).getByLabelText('Min sale rate %'), { target: { value: '25' } });
    fireEvent.change(within(panel()).getByLabelText('Min market value'), { target: { value: '1g 50s' } });
    fireEvent.click(within(panel()).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(callsTo('PUT', '/deals-settings')).toHaveLength(1));
    expect(callsTo('PUT', '/deals-settings')[0].body).toEqual({ percent: 0.5, minSaleRate: 0.25, minMarket: 15000, watch: 40 });
    expect(await within(panel()).findByText('Saved.')).toBeTruthy();
  });

  it('says what is wrong with a threshold instead of sending it', async () => {
    await show('deals');
    fireEvent.change(await within(panel()).findByLabelText('Under % of market'), { target: { value: '500' } });
    fireEvent.click(within(panel()).getByRole('button', { name: 'Apply' }));
    expect(await within(panel()).findByText(/between 1 and 100/)).toBeTruthy();
    fireEvent.change(within(panel()).getByLabelText('Under % of market'), { target: { value: '50' } });
    fireEvent.change(within(panel()).getByLabelText('Min market value'), { target: { value: 'lots' } });
    fireEvent.click(within(panel()).getByRole('button', { name: 'Apply' }));
    expect(await within(panel()).findByText(/Write min market value like/)).toBeTruthy();
    expect(callsTo('PUT', '/deals-settings')).toHaveLength(0);
  });
});

describe('crafting', () => {
  it('lists recipes with their cost, value, profit and margin, filters by profession, and can include the ones missing prices', async () => {
    await show('crafting');
    const table = await within(panel()).findByRole('region', { name: 'Recipes by profit' });
    expect(table.textContent).toContain('Bolt of Linen Cloth');
    expect(table.textContent).toContain(formatMoney(2000));
    expect(table.textContent).toContain(formatMoney(3000));
    expect(table.textContent).toContain(formatMoney(1000));
    // 1s profit on 30s sold: a third.
    expect(table.textContent).toContain('33%');
    expect(table.textContent).not.toContain('Mana Potion');

    fireEvent.click(within(panel()).getByLabelText(/Include recipes with missing prices/));
    await within(panel()).findByText('Mana Potion');
    expect(calls.some((c) => c.path.includes('/crafting') && c.path.includes('includeIncomplete=1'))).toBe(true);

    fireEvent.change(within(panel()).getByLabelText('Profession'), { target: { value: 'Alchemy' } });
    expect(within(panel()).queryByText('Bolt of Linen Cloth')).toBeNull();
    expect(within(panel()).getByText('Mana Potion')).toBeTruthy();
    // An unknown cost is shown as unknown, not as a free recipe.
    expect(within(panel()).getAllByText('?').length).toBeGreaterThan(0);
  });

  it('shows the reagents of a recipe when it is opened', async () => {
    await show('crafting');
    const open = await within(panel()).findByRole('button', { name: /Bolt of Linen Cloth/ });
    expect(open.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(open);
    expect(open.getAttribute('aria-expanded')).toBe('true');
    expect(within(panel()).getByText(/2 ×/)).toBeTruthy();
  });
});

describe('selling', () => {
  it('values what is in your bags and lists the undercut auctions with the in-game command', async () => {
    await show('selling');
    const sell = await within(panel()).findByRole('region', { name: 'What to sell' });
    expect(sell.textContent).toContain('Linen Cloth');
    expect(sell.textContent).toContain(formatMoney(72000));
    expect(sell.textContent).toContain('Eli 40, Sam 20');
    const under = await within(panel()).findByRole('region', { name: 'Undercut auctions' });
    expect(under.textContent).toContain(formatMoney(100));
    expect(within(panel()).getByRole('note').textContent).toBe('Cancel these in game: /uah cancel (at the auction house window).');
  });
});

describe('accounting', () => {
  it('summarises a span, lists the entries, and changes span', async () => {
    await show('accounting');
    await within(panel()).findByText('Fees');
    expect(panel().textContent).toContain('12 sold');
    expect(panel().textContent).toContain(formatMoney(150000));
    // 7500 of cuts and 500 of lost deposits.
    expect(panel().textContent).toContain(formatMoney(8000));
    expect(panel().textContent).toContain(formatMoney(102000));
    const entries = within(panel()).getByRole('region', { name: 'Accounting entries' });
    expect(within(entries).getAllByRole('row')).toHaveLength(3);
    expect(entries.textContent).toContain('Sold');
    expect(entries.textContent).toContain('Bought');
    // The gold chart.
    expect(within(panel()).getByRole('region', { name: 'Gold over time' }).querySelectorAll('g.ah-line path').length).toBe(1);
    fireEvent.click(within(panel()).getByRole('button', { name: '90 days' }));
    await waitFor(() => expect(calls.some((c) => c.path.includes('/accounting?days=90'))).toBe(true));
    expect(within(panel()).getByRole('button', { name: '90 days' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('says what to do when nothing was recorded', async () => {
    await show('accounting', 'empty');
    expect(await within(panel()).findByRole('heading', { name: 'Install the WoW addons' })).toBeTruthy();
    cleanup();
    await show('accounting', 'data', { override: (c) => (c.path.startsWith('/api/wow/ah/accounting') ? { body: { days: 30, summary: { sales: 0, purchases: 0, expired: 0, cancelled: 0, posts: 0, gross: 0, cuts: 0, spent: 0, depositsLost: 0, profit: 0, items: [], days: [] }, entries: [] } } : c.path.startsWith('/api/wow/ah/gold') ? { body: { total: [], chars: {}, current: 0 } } : undefined) });
    expect(await within(panel()).findByText(/Open your mailbox in WoW/)).toBeTruthy();
  });
});

describe('stream mode', () => {
  it('hides gold totals and accounting by default', async () => {
    await show('overview', 'data', { editing: false });
    await within(panel()).findByText('Gold now');
    await within(panel()).findByText('Arcanite Bar');
    await waitFor(() => expect(within(panel()).getAllByRole('img', { name: 'Hidden while streaming' }).length).toBeGreaterThan(0));
    const text = panel().textContent ?? '';
    // Your gold, and today's sales, are masked or left out…
    expect(text).not.toContain(formatMoney(GOLD.current));
    expect(text).toContain('Hidden while streaming');
    // …but item prices are not.
    expect(text).toContain(formatMoney(250000));
    // Nothing about your gold or accounting was even asked for.
    expect(calls.some((c) => c.path.includes('/accounting') || c.path.includes('/gold'))).toBe(false);

    fireEvent.click(screen.getByRole('tab', { name: 'Accounting' }));
    expect(await within(panel()).findByText('Hidden while streaming')).toBeTruthy();
    expect(calls.some((c) => c.path.includes('/accounting') || c.path.includes('/gold'))).toBe(false);
  });

  it('hides what you would sell worth in stream mode too, but not item prices', async () => {
    await show('selling', 'data', { editing: false });
    const sell = await within(panel()).findByRole('region', { name: 'What to sell' });
    expect(sell.textContent).toContain(formatMoney(1200));
    expect(sell.textContent).not.toContain(formatMoney(72000));
    expect(panel().textContent).toContain(`Worth about ${MASK}`);
  });

  it('shows it all when the widget is set to show gold on stream', async () => {
    await show('overview', 'data', { editing: false, settings: { showGoldOnStream: true } });
    expect(await within(panel()).findByText(formatMoney(GOLD.current))).toBeTruthy();
    cleanup();
    await show('accounting', 'data', { editing: false, settings: { showGoldOnStream: true } });
    expect(await within(panel()).findByText('Fees')).toBeTruthy();
    expect(calls.some((c) => c.path.includes('/accounting'))).toBe(true);
  });

  it('shows everything while editing the board, whatever the setting', async () => {
    await show('overview', 'data', { editing: true });
    expect(await within(panel()).findByText(formatMoney(GOLD.current))).toBeTruthy();
  });
});

describe('rules', () => {
  const rules = async (part?: string, override?: Override) => {
    await show('rules', 'data', { override });
    await within(panel()).findByRole('group', { name: 'Rules section' });
    if (part) fireEvent.click(within(panel()).getByRole('button', { name: part }));
  };

  it('previews a formula against a chosen item, and shows its error right there', async () => {
    await rules('Posting and shopping rules', (c) => {
      if (c.method === 'POST' && c.path.includes('/formula/test')) {
        const formula = String(c.body?.formula);
        return formula.includes('nonsense') ? { status: 400, body: { ok: false, error: 'Unknown price "nonsense".', vars: {} } } : { body: { ok: true, value: 1234, text: '12s 34c', vars: {} } };
      }
      return undefined;
    });
    fireEvent.click(await within(panel()).findByRole('button', { name: 'Edit Default posting' }));

    // Pick the item the previews use.
    fireEvent.change(within(panel()).getByLabelText('Preview formulas against an item'), { target: { value: 'linen' } });
    fireEvent.click(await within(panel()).findByRole('button', { name: /Linen Cloth/ }));
    expect(within(panel()).getByText(/Formula previews use:/).textContent).toContain('Linen Cloth');

    // The saved formulas show their value.
    expect((await within(panel()).findAllByText('= 12s 34c')).length).toBeGreaterThanOrEqual(3);
    const sent = calls.filter((c) => c.path.includes('/formula/test')).at(-1)!;
    expect(sent.body).toMatchObject({ item: 'i:2589' });

    // A bad one shows the engine's message, inline.
    fireEvent.change(within(panel()).getByLabelText(/^Normal price/), { target: { value: 'nonsense + 1' } });
    expect(await within(panel()).findByText('Unknown price "nonsense".')).toBeTruthy();
    expect(calls.some((c) => c.path.includes('/formula/test') && (c.body as { formula: string }).formula === 'nonsense + 1')).toBe(true);
    // And saving it is the server's call: its refusal is shown too.
  });

  it('asks for an item when the formula needs one', async () => {
    await rules('Posting and shopping rules', (c) => (c.method === 'POST' && c.path.includes('/formula/test') ? { body: { ok: true, value: null, text: null, vars: {} } } : undefined));
    fireEvent.click(await within(panel()).findByRole('button', { name: 'Edit Default shopping' }));
    expect((await within(panel()).findAllByText(/Pick an item above/)).length).toBeGreaterThan(0);
  });

  it('saves a posting rule with the right body, and shows the server’s message when it refuses', async () => {
    await rules('Posting and shopping rules', (c) => (c.method === 'PUT' && c.path.endsWith('/operations/default-post') ? { status: 400, body: { error: 'Min price: Unknown price "x".' } } : undefined));
    fireEvent.click(await within(panel()).findByRole('button', { name: 'Edit Default posting' }));
    fireEvent.change(within(panel()).getByLabelText('Undercut by'), { target: { value: '2s' } });
    fireEvent.change(within(panel()).getByLabelText(/^Duration/), { target: { value: '48' } });
    fireEvent.click(within(panel()).getByRole('button', { name: 'Save rule' }));
    await waitFor(() => expect(callsTo('PUT', '/operations/default-post')).toHaveLength(1));
    expect(callsTo('PUT', '/operations/default-post')[0].body).toMatchObject({ kind: 'post', name: 'Default posting', undercut: 200, duration: 48, stackSize: 1, stacks: 1, keepQuantity: 0 });
    expect(await within(panel()).findByText('Min price: Unknown price "x".')).toBeTruthy();
  });

  it('makes a new shopping rule, and the default rules cannot be deleted', async () => {
    await rules('Posting and shopping rules');
    const shopping = within(panel()).getByRole('region', { name: 'Shopping rules' });
    fireEvent.click(within(shopping).getByRole('button', { name: /New/ }));
    fireEvent.change(within(panel()).getByLabelText('Name'), { target: { value: 'Bargains' } });
    fireEvent.change(within(panel()).getByLabelText(/Only items that sell/), { target: { value: '40' } });
    fireEvent.click(within(panel()).getByRole('button', { name: 'Save rule' }));
    await waitFor(() => expect(callsTo('POST', '/api/wow/ah/operations')).toHaveLength(1));
    expect(callsTo('POST', '/api/wow/ah/operations')[0].body).toMatchObject({ kind: 'shop', name: 'Bargains', minSaleRate: 0.4 });
    fireEvent.click(await within(panel()).findByRole('button', { name: 'Edit Default shopping' }));
    expect(within(panel()).queryByRole('button', { name: /Delete rule/ })).toBeNull();
  });

  describe('groups', () => {
    it('lists them with their rules', async () => {
      await rules();
      expect(await within(panel()).findByText('Cloth')).toBeTruthy();
      expect(panel().textContent).toContain('1 item');
      await waitFor(() => expect(panel().textContent).toContain('posts with Default posting'));
    });

    it('creates one with the items picked from the search', async () => {
      await rules();
      fireEvent.click(await within(panel()).findByRole('button', { name: /New group/ }));
      expect((within(panel()).getByRole('button', { name: 'Save group' }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(within(panel()).getByLabelText('Name'), { target: { value: 'Herbs' } });
      fireEvent.change(within(panel()).getByLabelText('Add an item'), { target: { value: 'linen' } });
      fireEvent.click(await within(panel()).findByRole('button', { name: /Linen Cloth/ }));
      const chips = within(panel()).getByRole('list', { name: 'Items in this group' });
      await waitFor(() => expect(chips.textContent).toContain('Linen Cloth'));
      fireEvent.click(within(panel()).getByRole('button', { name: 'Save group' }));
      await waitFor(() => expect(callsTo('POST', '/api/wow/ah/groups')).toHaveLength(1));
      expect(callsTo('POST', '/api/wow/ah/groups')[0].body).toEqual({ name: 'Herbs', items: ['i:2589'], postOperation: 'default-post', shopOperation: 'default-shop' });
      // Back to the list, which was read again.
      expect(await within(panel()).findByText('Saved Herbs.')).toBeTruthy();
      expect(callsTo('GET', '/api/wow/ah/groups').length).toBeGreaterThan(1);
    });

    it('changes one: a rename and a removed item go to that group’s own route', async () => {
      await rules();
      fireEvent.click(await within(panel()).findByRole('button', { name: 'Edit Cloth' }));
      fireEvent.change(within(panel()).getByLabelText('Name'), { target: { value: 'Cloth and leather' } });
      fireEvent.click(await within(panel()).findByRole('button', { name: /^Remove/ }));
      fireEvent.click(within(panel()).getByRole('button', { name: 'Save group' }));
      await waitFor(() => expect(callsTo('PUT', '/api/wow/ah/groups/g1')).toHaveLength(1));
      expect(callsTo('PUT', '/api/wow/ah/groups/g1')[0].body).toEqual({ name: 'Cloth and leather', items: [], postOperation: 'default-post', shopOperation: 'default-shop' });
    });

    it('deletes one only on the second click', async () => {
      await rules();
      fireEvent.click(await within(panel()).findByRole('button', { name: 'Edit Cloth' }));
      fireEvent.click(within(panel()).getByRole('button', { name: /Delete group/ }));
      expect(callsTo('DELETE', '/groups/g1')).toHaveLength(0);
      fireEvent.click(within(panel()).getByRole('button', { name: /Click again to delete/ }));
      await waitFor(() => expect(callsTo('DELETE', '/api/wow/ah/groups/g1')).toHaveLength(1));
      expect(await within(panel()).findByText('Deleted.')).toBeTruthy();
    });

    it('shows the server’s refusal and keeps the editor open', async () => {
      await rules(undefined, (c) => (c.method === 'POST' && c.path.endsWith('/groups') ? { status: 400, body: { error: 'The group needs a name.' } } : undefined));
      fireEvent.click(await within(panel()).findByRole('button', { name: /New group/ }));
      fireEvent.change(within(panel()).getByLabelText('Name'), { target: { value: ' x ' } });
      fireEvent.click(within(panel()).getByRole('button', { name: 'Save group' }));
      expect(await within(panel()).findByText('The group needs a name.')).toBeTruthy();
      expect(within(panel()).getByRole('button', { name: 'Save group' })).toBeTruthy();
    });
  });

  describe('shopping lists', () => {
    it('makes one from an item and a typed name, with a price formula checked live', async () => {
      await rules('Shopping lists');
      fireEvent.click(await within(panel()).findByRole('button', { name: /New list/ }));
      fireEvent.change(within(panel()).getByLabelText('Name'), { target: { value: 'Elixirs' } });
      fireEvent.change(within(panel()).getByLabelText('Add an item'), { target: { value: 'arc' } });
      fireEvent.click(await within(panel()).findByRole('button', { name: /Arcanite Bar/ }));
      fireEvent.change(within(panel()).getByLabelText('Or a name to search for'), { target: { value: 'Elixir of the Mongoose' } });
      fireEvent.click(within(panel()).getByRole('button', { name: 'Add name' }));
      fireEvent.change(await within(panel()).findByLabelText(/Most to pay for Arcanite Bar/), { target: { value: '90% dbmarket' } });
      expect(await within(panel()).findByText('= 12s')).toBeTruthy();
      fireEvent.click(within(panel()).getByRole('button', { name: 'Save list' }));
      await waitFor(() => expect(callsTo('POST', '/api/wow/ah/shopping')).toHaveLength(1));
      expect(callsTo('POST', '/api/wow/ah/shopping')[0].body).toEqual({ name: 'Elixirs', items: [{ item: 'i:12360', maxPrice: '90% dbmarket' }, { name: 'Elixir of the Mongoose' }] });
    });

    it('edits and deletes one', async () => {
      await rules('Shopping lists');
      fireEvent.click(await within(panel()).findByRole('button', { name: 'Edit Flask stuff' }));
      fireEvent.click(within(panel()).getByRole('button', { name: 'Save list' }));
      await waitFor(() => expect(callsTo('PUT', '/api/wow/ah/shopping/s1')).toHaveLength(1));
      expect(callsTo('PUT', '/api/wow/ah/shopping/s1')[0].body).toEqual({ name: 'Flask stuff', items: [{ item: 'i:2589', maxPrice: '1s' }] });
      fireEvent.click(await within(panel()).findByRole('button', { name: 'Edit Flask stuff' }));
      fireEvent.click(within(panel()).getByRole('button', { name: /Delete list/ }));
      fireEvent.click(within(panel()).getByRole('button', { name: /Click again/ }));
      await waitFor(() => expect(callsTo('DELETE', '/api/wow/ah/shopping/s1')).toHaveLength(1));
    });
  });

  it('explains the /reload and has a refresh button that writes the game file', async () => {
    await rules('Send to game');
    expect(panel().textContent).toContain('/reload');
    fireEvent.click(within(panel()).getByRole('button', { name: /Refresh and write/ }));
    await waitFor(() => expect(callsTo('POST', '/api/wow/ah/refresh')).toHaveLength(1));
    expect(await within(panel()).findByText(/Type \/reload in WoW/)).toBeTruthy();
  });

  it('says so when there is no addon folder to write to', async () => {
    await rules('Send to game', (c) => (c.path.endsWith('/refresh') ? { body: { ok: true, dataFile: null } } : undefined));
    fireEvent.click(within(panel()).getByRole('button', { name: /Refresh and write/ }));
    expect(await within(panel()).findByText(/no UncboxAH addon folder/)).toBeTruthy();
  });
});

describe('live data', () => {
  it('reads again when the server says new auction house data arrived', async () => {
    await show('overview');
    await within(panel()).findByText('Last full scan');
    const before = callsTo('GET', '/api/wow/ah/status').length;
    const deals = callsTo('GET', '/api/wow/ah/deals').length;
    expect(live.handlers.get('wowah')?.size).toBe(1);
    act(() => live.handlers.get('wowah')!.forEach((fn) => fn(JSON.stringify({ scans: 1 }))));
    await waitFor(() => expect(callsTo('GET', '/api/wow/ah/status').length).toBeGreaterThan(before));
    await waitFor(() => expect(callsTo('GET', '/api/wow/ah/deals').length).toBeGreaterThan(deals));
  });

  it('polls lightly, and only while the page is showing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await show('overview');
      await within(panel()).findByText('Last full scan');
      const asked = callsTo('GET', '/api/wow/ah/status').length;
      await act(async () => void vi.advanceTimersByTime(61_000));
      await waitFor(() => expect(callsTo('GET', '/api/wow/ah/status').length).toBeGreaterThan(asked));

      let state = 'hidden';
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      const whileHidden = callsTo('GET', '/api/wow/ah/status').length;
      await act(async () => void vi.advanceTimersByTime(180_000));
      expect(callsTo('GET', '/api/wow/ah/status').length).toBe(whileHidden);
      state = 'visible';
      await act(async () => void document.dispatchEvent(new Event('visibilitychange')));
      await waitFor(() => expect(callsTo('GET', '/api/wow/ah/status').length).toBeGreaterThan(whileHidden));
    } finally {
      delete (document as unknown as { visibilityState?: string }).visibilityState;
      vi.useRealTimers();
    }
  });
});
