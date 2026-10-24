// @vitest-environment jsdom
//
// The WoW guild widgets, drawn for real against a faked guild link (src/wowMocks.ts): with data,
// with nothing set up, and in stream mode (`editing` false), where officer notes never show and
// the attendance and loot widgets hide names unless asked. The logic under them is tested next to
// each widget; this is about what is on screen.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { type ComponentType, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESETS } from '../presets';
import { defaultPresetData } from '../state/hydrate';
import { wowGuildRoute, EVENTS, WOW_NOW } from '../wowMocks';
import { AttendanceBody } from './attendance/AttendanceWidget';
import { defaultAttendanceSettings } from './attendance/settings';
import { classColor } from './shared/classColor';
import { qualityColor } from './shared/quality';
import { requestMember } from './shared/wowGuild';
import { FeedBody } from './guildfeed/FeedWidget';
import { defaultFeedSettings } from './guildfeed/settings';
import { GoalsBody } from './guildgoals/GoalsWidget';
import { defaultGoalsSettings } from './guildgoals/settings';
import { RosterBody } from './guildroster/RosterWidget';
import { defaultRosterSettings } from './guildroster/settings';
import { RaidCompBody } from './raidcomp/RaidCompWidget';
import { defaultCompSettings } from './raidcomp/settings';
import { LootBody } from './raidloot/LootWidget';
import { defaultLootSettings } from './raidloot/settings';
import { widgetDef, WIDGETS } from './registry';

// ---- the browser and the server, as far as jsdom goes ----

class FakeEventSource {
  static all: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  constructor(public url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(name: string, fn: (e: MessageEvent) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(fn);
  }
  removeEventListener() {}
  close() {}
  static emit(name: string, data: unknown) {
    for (const es of FakeEventSource.all) es.listeners.get(name)?.forEach((fn) => fn({ data: JSON.stringify(data) } as MessageEvent));
  }
}

interface Call {
  url: string;
  method: string;
  body: string;
}
let calls: Call[] = [];
let guildHasData = true;
/** Extra guild events, as if they arrived after the page loaded. */
let extraEvents: typeof EVENTS = [];

const addonInstalled = () => ({
  bundled: '1.0.0',
  addons: { Uncbox: '1.0.0' },
  preferred: 'C:\\WoW',
  installs: guildHasData ? [{ flavor: '_classic_era_', label: 'Classic Era', path: 'C:\\WoW', exes: [], version: '1.0.0', addons: {} }] : [],
  autoInstall: true,
  flavor: '',
  settings: { strip: { enabled: true, corner: 'TOPLEFT' }, modules: { character: true, quests: true, party: true, guild: true, raid: true, loot: true }, lootMinQuality: 2 },
});

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  calls.push({ url: path, method, body: String(init?.body ?? '') });
  const url = new URL(path, 'http://localhost');
  let reply: { status?: number; body: unknown } = { status: 404, body: { error: 'Not mocked' } };
  if (url.pathname === '/api/wow/status') reply = { body: addonInstalled() };
  else if (url.pathname === '/api/wow/open' && method === 'POST') reply = { body: { ok: true } };
  else if (url.pathname === '/api/wow/guild/events' && guildHasData) reply = { body: { events: [...extraEvents, ...EVENTS] } };
  else if (method === 'GET') reply = wowGuildRoute(guildHasData, url) ?? reply;
  const status = reply.status ?? 200;
  return Promise.resolve({ ok: status < 300, status, statusText: String(status), json: async () => JSON.parse(JSON.stringify(reply.body)) } as Response);
}

beforeEach(() => {
  calls = [];
  guildHasData = true;
  extraEvents = [];
  vi.stubGlobal('fetch', fakeFetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---- drawing a widget the way the library does ----

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Draws a widget's body with its settings kept in state; `latest` follows the settings. */
function mount<S extends object>(Body: ComponentType<any>, initial: S, editing = true, id = 'wdg-test') {
  const latest = { settings: initial };
  function Harness() {
    const [settings, setSettings] = useState<S>(initial);
    latest.settings = settings;
    return <Body widget={{ id, kind: 'test', title: '', settings }} settings={settings} set={(patch: Partial<S>) => setSettings((s) => ({ ...s, ...patch }))} editing={editing} open={false} close={() => {}} />;
  }
  const view = render(<Harness />);
  return { ...view, latest };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const requested = (re: RegExp) => calls.filter((c) => re.test(c.url));
const colorOf = (css: string) => {
  const probe = document.createElement('div');
  probe.style.color = css;
  return probe.style.color;
};

// ---- the library ----

describe('the guild widgets in the library', () => {
  const kinds = ['guildroster', 'guildfeed', 'raidcomp', 'attendance', 'raidloot', 'guildgoals'];

  it('are all WoW widgets you can add more than once, recommended by the WoW preset', () => {
    for (const kind of kinds) {
      const def = widgetDef(kind)!;
      expect(def, kind).toBeDefined();
      expect(def.category).toBe('WoW');
      expect(def.single).not.toBe(true);
      expect(def.presets, kind).toContain('wow');
      expect(WIDGETS.filter((w) => w.kind === kind)).toHaveLength(1);
    }
  });

  it('start with the roster and the news (and the Auction House) on the WoW board', () => {
    const { layout, widgets } = defaultPresetData('wow');
    expect(widgets.map((w) => w.kind).sort()).toEqual(['auctionhouse', 'guildfeed', 'guildroster']);
    for (const w of widgets) expect(layout.some((item) => item.i === w.id)).toBe(true);
    expect(PRESETS.wow.layout.reduce((sum, item) => sum + item.w * item.h, 0)).toBe(24 * 24);
  });
});

// ---- Guild roster ----

describe('Guild roster', () => {
  it('shows who is online of how many, with class colors, status and when the offline were last seen', async () => {
    mount(RosterBody, defaultRosterSettings());
    expect(await screen.findByText('6 online of 9')).toBeTruthy();
    const lief = screen.getByText('Lief');
    expect(lief.style.color).toBe(colorOf(classColor('DRUID')));
    expect(screen.getByText('Zoë').style.color).toBe(colorOf(classColor('PRIEST')));
    expect(screen.getByText('AFK')).toBeTruthy();
    expect(screen.getByText('DND')).toBeTruthy();
    expect(screen.getByText('Seen 3 h ago')).toBeTruthy();
    expect(screen.getAllByText('Molten Core').length).toBeGreaterThan(0);
    // Online first.
    const order = [...document.querySelectorAll('.wg-row')].map((b) => b.getAttribute('title')?.split(':')[0]);
    expect(order.slice(0, 2)).toEqual(['Lief', 'Zoë']);
    expect(order.at(-1)).toBe('Torv');
  });

  it('searches, and says how many are shown', async () => {
    mount(RosterBody, defaultRosterSettings());
    await screen.findByText('6 online of 9');
    fireEvent.change(screen.getByLabelText('Find a member'), { target: { value: 'zoe' } });
    expect(screen.getByText('1 shown · 6 online of 9')).toBeTruthy();
    expect(screen.queryByText('Lief')).toBeNull();
    fireEvent.change(screen.getByLabelText('Find a member'), { target: { value: 'nobody' } });
    expect(screen.getByText('No one matches.')).toBeTruthy();
  });

  it('filters by online only, by rank, class and level, and sorts', async () => {
    const { latest } = mount(RosterBody, defaultRosterSettings());
    await screen.findByText('6 online of 9');
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }));
    fireEvent.click(screen.getByLabelText('Online only'));
    expect(screen.queryByText('Bumta')).toBeNull();
    expect(screen.getByText('Mira')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Rank'), { target: { value: '3' } });
    expect(screen.queryByText('Lief')).toBeNull();
    expect(screen.getByText('Mira')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Rank'), { target: { value: '-1' } });
    fireEvent.change(screen.getByLabelText('Class'), { target: { value: 'Mage' } });
    expect(screen.getByText('1 shown · 6 online of 9')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Class'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Lowest level'), { target: { value: '60' } });
    expect(screen.queryByText('Mira')).toBeNull();
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'name' } });
    expect(latest.settings).toMatchObject({ sort: 'name', onlineOnly: true, minLevel: 60 });
  });

  it('opens a member: rank history, play sessions, attendance, loot, and a way back', async () => {
    mount(RosterBody, defaultRosterSettings());
    fireEvent.click(await screen.findByText('Kaz'));
    expect(await screen.findByText('Promoted to Raider', { exact: false })).toBeTruthy();
    expect(screen.getByText('Raid attendance')).toBeTruthy();
    expect(screen.getByText('100%')).toBeTruthy();
    expect(screen.getByText('Arcanist Bindings')).toBeTruthy();
    expect(screen.getByText('Recent play')).toBeTruthy();
    expect(requested(/guild\/member\?name=Kaz/)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Back to the roster/ }));
    expect(await screen.findByText('6 online of 9')).toBeTruthy();
  });

  it('opens the member the command palette asked for', async () => {
    requestMember('wdg-test', 'Zoë');
    mount(RosterBody, defaultRosterSettings());
    expect(await screen.findByText('Healing lead')).toBeTruthy();
    expect(requested(/guild\/member\?name=Zo%C3%AB/)).toHaveLength(1);
  });

  it('shows public notes while editing but no officer note by default', async () => {
    mount(RosterBody, defaultRosterSettings());
    expect(await screen.findByText(/Healing lead/)).toBeTruthy();
    expect(screen.queryByText(/Owes 200g/)).toBeNull();
    expect(requested(/officer=1/)).toHaveLength(0);
  });

  it('shows the officer note only with "Show officer notes" on, and asks the server for it only then', async () => {
    mount(RosterBody, { ...defaultRosterSettings(), showOfficerNotes: true });
    expect(await screen.findByText(/Owes 200g to the bank/)).toBeTruthy();
    expect(requested(/\/api\/wow\/guild\?officer=1/).length).toBeGreaterThan(0);
  });

  it('never shows an officer note on stream, even with the setting on, and never asks for one', async () => {
    mount(RosterBody, { ...defaultRosterSettings(), showOfficerNotes: true, showNotesOnStream: true }, false);
    expect(await screen.findByText('6 online of 9')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Owes 200g');
    expect(requested(/officer=1/)).toHaveLength(0);
    // Nor in a member’s page.
    fireEvent.click(screen.getByText('Lief'));
    await screen.findByText('Raid attendance');
    expect(document.body.textContent).not.toContain('Owes 200g');
    expect(requested(/officer=1/)).toHaveLength(0);
  });

  it('hides public notes on stream unless "Show notes on stream" is on, and has no controls', async () => {
    const { unmount } = mount(RosterBody, defaultRosterSettings(), false);
    await screen.findByText('6 online of 9');
    expect(document.body.textContent).not.toContain('Healing lead');
    expect(screen.queryByLabelText('Find a member')).toBeNull();
    expect(screen.queryByLabelText('Sort by')).toBeNull();
    unmount();
    mount(RosterBody, { ...defaultRosterSettings(), showNotesOnStream: true }, false);
    expect(await screen.findByText(/Healing lead/)).toBeTruthy();
  });

  it('can be compact: the online count and a dot per online member', async () => {
    const { container } = mount(RosterBody, { ...defaultRosterSettings(), compact: true });
    await waitFor(() => expect(container.querySelector('.wg-compact__count')?.textContent).toBe('6'));
    expect(container.querySelectorAll('.wg-dots .wg-dot')).toHaveLength(6);
    expect(container.querySelector('.wg-list')).toBeNull();
  });

  it('says the addon is missing when nothing is set up, and says nothing at all on stream', async () => {
    guildHasData = false;
    const edit = mount(RosterBody, defaultRosterSettings());
    expect(await screen.findByText('WoW wasn’t found on this PC')).toBeTruthy();
    edit.unmount();
    const stream = mount(RosterBody, defaultRosterSettings(), false);
    await waitFor(() => expect(requested(/guild$/).length).toBeGreaterThan(1));
    expect(stream.container.textContent).toBe('');
  });
});

// ---- Guild news ----

describe('Guild news', () => {
  it('lists the news in plain words, with the noisy kind off to start with', async () => {
    mount(FeedBody, defaultFeedSettings());
    expect(await screen.findByText('Mira reached level 42')).toBeTruthy();
    expect(screen.getByText('Sela was promoted to Raider by Lief')).toBeTruthy();
    expect(screen.getByText('Vex joined the guild')).toBeTruthy();
    expect(screen.getByText('Grim left the guild')).toBeTruthy();
    expect(screen.getByText('Torv was demoted to Initiate by Lief')).toBeTruthy();
    // Once for each raid that killed him.
    expect(screen.getAllByText('Lucifron was defeated in Molten Core')).toHaveLength(2);
    expect(screen.getByText('Kaz got Arcanist Bindings from Magmadar')).toBeTruthy();
    expect(screen.queryByText('Kaz came online')).toBeNull();
    // The rare Band of Accuria is below the epic default.
    expect(document.body.textContent).not.toContain('Band of Accuria');
  });

  it('turns kinds on and off with chips', async () => {
    const { latest } = mount(FeedBody, defaultFeedSettings());
    await screen.findByText('Mira reached level 42');
    const online = screen.getByRole('button', { name: 'Online / offline' });
    expect(online.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(online);
    expect(await screen.findByText('Kaz came online')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Level-ups' }));
    expect(screen.queryByText('Mira reached level 42')).toBeNull();
    expect(latest.settings.kinds).toContain('online');
    expect(latest.settings.kinds).not.toContain('level');
  });

  it('has no chips on stream, and leaves out who left or was demoted unless asked', async () => {
    const stream = mount(FeedBody, defaultFeedSettings(), false);
    expect(await screen.findByText('Mira reached level 42')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'What to show' })).toBeNull();
    expect(screen.queryByText('Grim left the guild')).toBeNull();
    expect(screen.queryByText(/was demoted/)).toBeNull();
    stream.unmount();
    mount(FeedBody, { ...defaultFeedSettings(), showDeparturesOnStream: true }, false);
    expect(await screen.findByText('Grim left the guild')).toBeTruthy();
  });

  it('stands still while the mouse is over it, then catches up', async () => {
    const { container } = mount(FeedBody, defaultFeedSettings());
    await screen.findByText('Mira reached level 42');
    const feed = container.querySelector('.wg-feed')!;
    fireEvent.mouseEnter(feed);
    expect(screen.getByText(/Paused while you read/)).toBeTruthy();
    extraEvents = [{ id: 7, at: WOW_NOW, type: 'join', name: 'Newcomer', a: '', b: '' }];
    await act(async () => FakeEventSource.emit('wowguild', { at: WOW_NOW, what: ['events'] }));
    await waitFor(() => expect(requested(/guild\/events/).length).toBeGreaterThan(1));
    expect(screen.queryByText('Newcomer joined the guild')).toBeNull();
    expect(await screen.findByText(/1 new/)).toBeTruthy();
    fireEvent.mouseLeave(feed);
    expect(await screen.findByText('Newcomer joined the guild')).toBeTruthy();
    expect(screen.queryByText(/Paused while you read/)).toBeNull();
  });

  it('fades in a line that arrives after the first draw, but not the ones there from the start', async () => {
    const { container } = mount(FeedBody, defaultFeedSettings());
    await screen.findByText('Mira reached level 42');
    expect(container.querySelectorAll('.is-new')).toHaveLength(0);
    extraEvents = [{ id: 8, at: WOW_NOW, type: 'join', name: 'Newcomer', a: '', b: '' }];
    await act(async () => FakeEventSource.emit('wowguild', { at: WOW_NOW, what: ['events'] }));
    const line = (await screen.findByText('Newcomer joined the guild')).closest('li')!;
    expect(line.classList.contains('is-new')).toBe(true);
  });

  it('only refetches for news it shows', async () => {
    mount(FeedBody, defaultFeedSettings());
    await screen.findByText('Mira reached level 42');
    const before = requested(/guild\/events/).length;
    await act(async () => FakeEventSource.emit('wowguild', { at: WOW_NOW, what: ['readychecks'] }));
    expect(requested(/guild\/events/)).toHaveLength(before);
    await act(async () => FakeEventSource.emit('wowguild', { at: WOW_NOW, what: ['events'] }));
    await waitFor(() => expect(requested(/guild\/events/)).toHaveLength(before + 1));
  });

  it('explains when nothing is set up, and says nothing on stream', async () => {
    guildHasData = false;
    const edit = mount(FeedBody, defaultFeedSettings());
    expect(await screen.findByText('WoW wasn’t found on this PC')).toBeTruthy();
    edit.unmount();
    const stream = mount(FeedBody, defaultFeedSettings(), false);
    await waitFor(() => expect(requested(/guild\/events/).length).toBeGreaterThan(1));
    expect(stream.container.textContent).toBe('');
  });
});

// ---- Raid composition ----

describe('Raid composition', () => {
  it('shows the groups, roles, buffs, who is down and the ready check', async () => {
    mount(RaidCompBody, defaultCompSettings());
    expect(await screen.findByText('9 in the raid')).toBeTruthy();
    for (const g of [1, 2, 3]) expect(screen.getByRole('region', { name: `Group ${g}` })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Group 4' })).toBeNull();
    expect(screen.getByText('1 tank')).toBeTruthy();
    expect(screen.getByText('4 healers (est.)')).toBeTruthy();
    expect(screen.getByText('4 damage')).toBeTruthy();
    expect(screen.getByText('No Paladin (Blessings)')).toBeTruthy();
    expect(screen.getByText(/Dead: Zoë/)).toBeTruthy();
    expect(screen.getByText(/Offline: Sela/)).toBeTruthy();
    expect(screen.getByText('Ready check 4 min ago: 6 ready · not ready: Mira · away: Zoë')).toBeTruthy();
    const group1 = within(screen.getByRole('region', { name: 'Group 1' }));
    expect(group1.getByText('Bumta').style.color).toBe(colorOf(classColor('WARRIOR')));
    expect(group1.getByText('Dead')).toBeTruthy();
    expect(group1.getByText('ML')).toBeTruthy();
    // Class tally.
    expect(screen.getAllByText('Priest').length).toBeGreaterThan(0);
  });

  it('lets you set a role by hand, remembering it in the settings, and cycles back to the guess', async () => {
    const { latest } = mount(RaidCompBody, defaultCompSettings());
    await screen.findByText('9 in the raid');
    const kaz = () => screen.getByRole('button', { name: /^Kaz:/ });
    expect(kaz().getAttribute('aria-label')).toBe('Kaz: Healer (guess). Change role');
    fireEvent.click(kaz());
    expect(kaz().getAttribute('aria-label')).toBe('Kaz: Tank. Change role');
    expect(screen.getByText('2 tanks')).toBeTruthy();
    fireEvent.click(kaz());
    fireEvent.click(kaz());
    expect(kaz().getAttribute('aria-label')).toBe('Kaz: Damage. Change role');
    expect(latest.settings.roles).toEqual([{ name: 'Kaz', role: 'dps' }]);
    expect(screen.getByText('3 healers (est.)')).toBeTruthy();
    fireEvent.click(kaz());
    expect(kaz().getAttribute('aria-label')).toBe('Kaz: Healer (guess). Change role');
    expect(latest.settings.roles).toEqual([]);
  });

  it('has no role buttons on stream', async () => {
    mount(RaidCompBody, defaultCompSettings(), false);
    await screen.findByText('9 in the raid');
    expect(screen.queryByRole('button', { name: /Change role/ })).toBeNull();
  });

  it('out of a raid, shows the last one and who came', async () => {
    guildHasData = false;
    // Raids and the guild are there, but no one is in a group.
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith('/api/wow/raid') && !path.startsWith('/api/wow/raids')) return fakeFetch(input, init);
      guildHasData = true;
      const out = fakeFetch(input, init);
      guildHasData = false;
      return out;
    });
    mount(RaidCompBody, defaultCompSettings());
    expect(await screen.findByText('Not in a raid')).toBeTruthy();
    expect(await screen.findByText('Molten Core')).toBeTruthy();
    expect(screen.getByText(/4 there · 3 bosses down/)).toBeTruthy();
    expect(screen.getByText('Lucifron, Magmadar, Gehennas')).toBeTruthy();
    expect(screen.getByText('Lief').style.color).toBe(colorOf(classColor('DRUID')));
  });

  it('explains when nothing is set up, and says nothing on stream', async () => {
    guildHasData = false;
    const edit = mount(RaidCompBody, defaultCompSettings());
    expect(await screen.findByText('WoW wasn’t found on this PC')).toBeTruthy();
    edit.unmount();
    const stream = mount(RaidCompBody, defaultCompSettings(), false);
    await waitFor(() => expect(requested(/\/raids\?/).length).toBeGreaterThan(1));
    expect(stream.container.textContent).toBe('');
  });
});

// ---- Raid attendance ----

/** The bytes of the Blob the page last offered as a download, and its text. */
function lastDownload(create: ReturnType<typeof vi.fn>): Promise<{ text: string; bytes: number[] }> {
  const blob = create.mock.calls.at(-1)![0] as Blob;
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const bytes = [...new Uint8Array(reader.result as ArrayBuffer)];
      resolve({ bytes, text: new TextDecoder().decode(new Uint8Array(bytes.slice(3))) });
    };
    reader.readAsArrayBuffer(blob);
  });
}

describe('Raid attendance', () => {
  it('shows a table of members against the last raids, with percentages', async () => {
    mount(AttendanceBody, defaultAttendanceSettings());
    expect(await screen.findByText('Last 2 raids')).toBeTruthy();
    expect(screen.getByText('average 64%')).toBeTruthy();
    const table = within(screen.getByRole('table'));
    const row = (name: string) => table.getByText(name).closest('tr')!;
    expect(within(row('Lief')).getByText('100%')).toBeTruthy();
    expect(within(row('Mira')).getByText('0%')).toBeTruthy();
    expect(within(row('Bumta')).getAllByText('Was there')).toHaveLength(1);
    expect(within(row('Bumta')).getAllByText('Missed it')).toHaveLength(1);
    // The best attendance first.
    const names = table.getAllByRole('rowheader').map((h) => h.textContent!.trim());
    expect(names.slice(0, 3).sort()).toEqual(['Kaz', 'Lief', 'Zoë']);
    expect(names.at(-1)).toBe('Mira');
  });

  it('sorts and filters by rank', async () => {
    mount(AttendanceBody, defaultAttendanceSettings());
    await screen.findByText('Last 2 raids');
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'name' } });
    expect(within(screen.getByRole('table')).getAllByRole('rowheader')[0].textContent!.trim()).toBe('Bumta');
    fireEvent.change(screen.getByLabelText('Rank'), { target: { value: '3' } });
    const names = within(screen.getByRole('table')).getAllByRole('rowheader').map((h) => h.textContent!.trim());
    expect(names).toEqual(['Mira']);
  });

  it('shows a raid’s date, zone, bosses and size when you pick its column', async () => {
    mount(AttendanceBody, defaultAttendanceSettings());
    await screen.findByText('Last 2 raids');
    const columns = screen.getAllByRole('button', { name: /show details/ });
    fireEvent.click(columns[1]);
    const detail = within(await screen.findByRole('region', { name: 'Raid details' }));
    expect(detail.getByText(/Molten Core/)).toBeTruthy();
    expect(detail.getByText(/4 there \(a 40-player raid\) · 3 bosses down: Lucifron, Magmadar, Gehennas/)).toBeTruthy();
    expect(detail.getByText(/Missed it: .*Bumta/)).toBeTruthy();
  });

  it('exports a CSV with accents kept', async () => {
    const create = vi.fn(() => 'blob:fake');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: () => {} }));
    mount(AttendanceBody, defaultAttendanceSettings());
    await screen.findByText('Last 2 raids');
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    expect(create).toHaveBeenCalledTimes(1);
    const { text, bytes } = await lastDownload(create);
    // A byte order mark first, so Excel reads the accents.
    expect(bytes.slice(0, 3)).toEqual([0xef, 0xbb, 0xbf]);
    expect(text).toContain('Name,Class,Rank,Attendance %,Raids attended,Raids counted,');
    expect(text).toContain('Zoë,Priest,Officer,100,2,2,Yes,Yes');
    expect(text).toContain('Mira,Mage,Initiate,0,0,2,No,No');
  });

  it('hides names on stream (and the export), unless "Show names on stream" is on', async () => {
    const hidden = mount(AttendanceBody, defaultAttendanceSettings(), false);
    await screen.findByText('Last 2 raids');
    expect(document.body.textContent).not.toMatch(/Lief|Zoë|Kaz|Bumta|Mira|Rook|Sela/);
    expect(screen.getAllByText(/^Member \d+$/).length).toBe(7);
    expect(screen.queryByRole('button', { name: /Export CSV/ })).toBeNull();
    expect(screen.queryByLabelText('Sort by')).toBeNull();
    hidden.unmount();
    mount(AttendanceBody, { ...defaultAttendanceSettings(), showNamesOnStream: true }, false);
    expect(await screen.findByText('Lief')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Export CSV/ })).toBeNull();
  });

  it('hides names in a raid’s details on stream too', async () => {
    mount(AttendanceBody, defaultAttendanceSettings(), false);
    await screen.findByText('Last 2 raids');
    fireEvent.click(screen.getAllByRole('button', { name: /show details/ })[1]);
    const detail = await screen.findByRole('region', { name: 'Raid details' });
    expect(detail.textContent).not.toMatch(/Bumta|Mira|Rook/);
    expect(detail.textContent).toMatch(/Missed it: Member/);
  });

  it('explains when there are no raids yet or nothing is set up, and says nothing on stream', async () => {
    guildHasData = false;
    const edit = mount(AttendanceBody, defaultAttendanceSettings());
    expect(await screen.findByText('WoW wasn’t found on this PC')).toBeTruthy();
    edit.unmount();
    const stream = mount(AttendanceBody, defaultAttendanceSettings(), false);
    await waitFor(() => expect(requested(/attendance/).length).toBeGreaterThan(1));
    expect(stream.container.textContent).toBe('');
  });
});

// ---- Raid loot ----

describe('Raid loot', () => {
  it('lists the drops with their quality colors, and opens an item on Wowhead through the server', async () => {
    mount(LootBody, { ...defaultLootSettings(), days: 0 });
    const item = await screen.findByRole('button', { name: /Arcanist Bindings, open on Wowhead/ });
    expect(item.style.color).toBe(colorOf(qualityColor(4)));
    expect(screen.getByText('3 drops')).toBeTruthy();
    fireEvent.click(item);
    const open = calls.find((c) => c.url === '/api/wow/open');
    expect(open?.method).toBe('POST');
    expect(JSON.parse(open!.body)).toEqual({ item: 16799 });
  });

  it('filters by player, raid and quality', async () => {
    mount(LootBody, { ...defaultLootSettings(), days: 0 });
    await screen.findByText('3 drops');
    fireEvent.change(screen.getByLabelText('Filter by player'), { target: { value: 'zoe' } });
    expect(screen.getByText('1 drop')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Band of Accuria/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter by player'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Raid'), { target: { value: '201' } });
    expect(screen.getByText('1 drop')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Arcanist Crown/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Raid'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Quality'), { target: { value: '4' } });
    expect(screen.getByText('2 drops')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Band of Accuria/ })).toBeNull();
  });

  it('shows who has had the fewest drops lately', async () => {
    mount(LootBody, { ...defaultLootSettings(), view: 'fair', minQuality: 3, days: 30 });
    const table = within(await screen.findByRole('table'));
    const rows = table.getAllByRole('rowheader').map((h) => h.textContent!.trim());
    expect(rows.slice(0, 3)).toEqual(['Lief', 'Rook', 'Sela']);
    expect(within(table.getByText('Lief').closest('tr')!).getAllByText('0').length).toBeGreaterThan(0);
    expect(screen.getByText(/Fewest drops first in the last 30 days/)).toBeTruthy();
  });

  it('exports the drops shown as a CSV', async () => {
    const create = vi.fn(() => 'blob:fake');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: () => {} }));
    mount(LootBody, { ...defaultLootSettings(), days: 0 });
    await screen.findByText('3 drops');
    fireEvent.change(screen.getByLabelText('Filter by player'), { target: { value: 'zoe' } });
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    const { text } = await lastDownload(create);
    expect(text).toContain('Date,Raid,Boss,Player,Item,Item ID,Quality,Count');
    expect(text).toContain(',Molten Core,Lucifron,Zoë,Band of Accuria,17063,Rare,1');
    expect(text).not.toContain('Kaz');
  });

  it('hides player names on stream unless "Show names on stream" is on, but keeps the items', async () => {
    const hidden = mount(LootBody, { ...defaultLootSettings(), days: 0 }, false);
    expect(await screen.findByRole('button', { name: /Arcanist Bindings/ })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Kaz|Zoë|Bumta/);
    expect(document.body.textContent).toMatch(/Member \d/);
    expect(screen.queryByRole('button', { name: /Export CSV/ })).toBeNull();
    expect(screen.queryByLabelText('Filter by player')).toBeNull();
    hidden.unmount();
    mount(LootBody, { ...defaultLootSettings(), days: 0, showNamesOnStream: true }, false);
    expect(await screen.findByText('Kaz')).toBeTruthy();
  });

  it('hides names in the fair share table on stream too', async () => {
    mount(LootBody, { ...defaultLootSettings(), view: 'fair', minQuality: 3 }, false);
    const table = await screen.findByRole('table');
    expect(table.textContent).not.toMatch(/Lief|Rook|Sela|Kaz/);
    expect(table.textContent).toMatch(/Member 1/);
  });

  it('explains when there is no loot or nothing is set up, and says nothing on stream', async () => {
    guildHasData = false;
    const edit = mount(LootBody, defaultLootSettings());
    expect(await screen.findByText('WoW wasn’t found on this PC')).toBeTruthy();
    edit.unmount();
    const stream = mount(LootBody, defaultLootSettings(), false);
    await waitFor(() => expect(requested(/\/loot/).length).toBeGreaterThan(1));
    expect(stream.container.textContent).toBe('');
  });
});

// ---- Guild goals ----

describe('Guild goals', () => {
  it('ticks off the bosses killed in each raid', async () => {
    mount(GoalsBody, defaultGoalsSettings());
    expect(await screen.findByText('3 bosses down')).toBeTruthy();
    expect(screen.getByText('3 of 10')).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'Molten Core: 3 of 10 bosses' });
    expect(bar.getAttribute('value')).toBe('3');
    expect(screen.getByText('Lucifron').closest('li')!.className).toContain('is-down');
    expect(screen.getByText('Ragnaros').closest('li')!.className).not.toContain('is-down');
  });

  it('explains when nothing is set up, and says nothing on stream', async () => {
    guildHasData = false;
    const edit = mount(GoalsBody, defaultGoalsSettings());
    expect(await screen.findByText('WoW wasn’t found on this PC')).toBeTruthy();
    edit.unmount();
    const stream = mount(GoalsBody, defaultGoalsSettings(), false);
    await waitFor(() => expect(requested(/\/raids\?/).length).toBeGreaterThan(1));
    expect(stream.container.textContent).toBe('');
  });
});

// ---- accessibility ----

describe('accessibility of the guild widgets with data', () => {
  const cases: [string, ComponentType<any>, object, string][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    ['Guild roster', RosterBody, defaultRosterSettings(), '6 online of 9'],
    ['Guild news', FeedBody, defaultFeedSettings(), 'Mira reached level 42'],
    ['Raid composition', RaidCompBody, defaultCompSettings(), '9 in the raid'],
    ['Raid attendance', AttendanceBody, defaultAttendanceSettings(), 'Last 2 raids'],
    ['Raid loot', LootBody, { ...defaultLootSettings(), days: 0 }, '3 drops'],
    ['Guild goals', GoalsBody, defaultGoalsSettings(), '3 bosses down'],
  ];

  it.each(cases)('%s has no serious problems, while editing or on stream', async (_name, Body, settings, ready) => {
    for (const editing of [true, false]) {
      const view = mount(Body, settings, editing);
      await screen.findByText(ready);
      const result = await axe.run(view.container, {
        // jsdom has no layout or paint, so the rules that need them are off, as in a11y.test.tsx.
        rules: { 'color-contrast': { enabled: false }, 'color-contrast-enhanced': { enabled: false }, region: { enabled: false }, 'scrollable-region-focusable': { enabled: false } },
        resultTypes: ['violations'],
      });
      const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(bad.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`), `${_name}, ${editing ? 'editing' : 'stream'}`).toEqual([]);
      view.unmount();
    }
  });
});
