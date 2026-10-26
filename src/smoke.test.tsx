// @vitest-environment jsdom
//
// Smoke tests for the page: every built-in preset, and every kind in the widget library (single
// panels and widgets alike) in every preset's theme, is drawn for real (React, the board, the
// sidebar) against a faked server, in edit mode and stream mode, empty and with data, at its
// smallest size. Nothing here checks how it looks; it catches the crash on first
// run, the React warning and the panel that comes up blank. The fakes are in ./smokeMocks.ts.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { Board } from './components/Board';
import { openPalette } from './palette/Palette';
import { FixedPrivacy, resetOnAirForTests } from './privacy';
import { controller } from './stream/live';
import { IDLE, resetStreamStatusForTests } from './stream/status';
import { placePanel } from './layout';
import { dismissUndo, showNotice } from './undo';
import { PRESETS } from './presets';
import { renderPanel } from './widgets/render';
import { defaultState } from './state/hydrate';
import { type AppState, type BoardId, type GridItem, type PresetData, type PresetId, PRESET_IDS, type Widget, counter } from './state/model';
import { activePreset } from './state/presets';
import { useAppState } from './state/useAppState';
import { boardDef, newWidget, SINGLE_KINDS, MULTI_KINDS, WIDGETS } from './widgets/registry';
import { route, type Reply, SENTINELS, type Scenario, streamStatus } from './smokeMocks';

// ---- the browser, as far as jsdom goes ----

const BOARD = { w: 1600, h: 900 };

/** What a laid-out element would measure: the board fills the window; a grid cell has the size it was given. */
function measure(el: Element) {
  let width = 0;
  let height = 0;
  if (el.classList.contains('board') || el.classList.contains('stage')) {
    width = BOARD.w;
    height = BOARD.h;
  } else {
    const style = (el as HTMLElement).style;
    width = parseFloat(style.width) || 0;
    height = parseFloat(style.height) || 0;
  }
  return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
}

type ResizeCallback = (entries: ResizeObserverEntry[]) => void;
const observers = new Set<{ el: Element; cb: ResizeCallback }>();

class FakeResizeObserver {
  private watched = new Set<Element>();
  constructor(private cb: ResizeCallback) {}
  observe(el: Element) {
    this.watched.add(el);
    const entry = { el, cb: this.cb };
    observers.add(entry);
    // Like a real one, report the size once when observing starts.
    queueMicrotask(() => this.report(el));
  }
  unobserve(el: Element) {
    this.watched.delete(el);
  }
  disconnect() {
    for (const o of [...observers]) if (this.watched.has(o.el)) observers.delete(o);
    this.watched.clear();
  }
  report(el: Element) {
    const r = measure(el);
    this.cb([{ target: el, contentRect: r, borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] } as unknown as ResizeObserverEntry]);
  }
}

/** Fires every ResizeObserver callback with the elements' current sizes, as a real window resize would. */
async function fireResize() {
  await act(async () => {
    for (const { el, cb } of [...observers]) {
      const r = measure(el);
      cb([{ target: el, contentRect: r, borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] } as unknown as ResizeObserverEntry]);
    }
  });
}

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  private listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  constructor(public url: string) {
    FakeEventSource.last = this;
    setTimeout(() => this.onopen?.(), 0);
  }
  addEventListener(name: string, fn: (e: MessageEvent) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(fn);
  }
  removeEventListener(name: string, fn: (e: MessageEvent) => void) {
    this.listeners.get(name)?.delete(fn);
  }
  /** The server pushing a named event. */
  push(name: string, data: unknown) {
    this.listeners.get(name)?.forEach((fn) => fn({ data: JSON.stringify(data) } as MessageEvent));
  }
  close() {}
}

class FakeMediaStream {
  getTracks() {
    return [];
  }
  getVideoTracks() {
    return [];
  }
  getAudioTracks() {
    return [];
  }
  addEventListener() {}
  removeEventListener() {}
}

function installBrowserFakes() {
  const g = globalThis as Record<string, unknown>;
  g.ResizeObserver = FakeResizeObserver;
  g.EventSource = FakeEventSource;
  g.MediaStream = FakeMediaStream;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  // Drawing is not tested: every canvas call does nothing.
  const context = new Proxy({}, { get: (_t, key) => (key === 'canvas' ? document.createElement('canvas') : () => ({ width: 0, data: new Uint8ClampedArray(4) })) });
  HTMLCanvasElement.prototype.getContext = (() => context) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
  Element.prototype.getBoundingClientRect = function () {
    return measure(this);
  };
  // jsdom reports "not implemented" for these through console.error.
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => {};
  HTMLMediaElement.prototype.load = () => {};
  window.scrollTo = (() => {}) as typeof window.scrollTo;
  Element.prototype.scrollIntoView = () => {};
  URL.createObjectURL = () => 'blob:fake';
  URL.revokeObjectURL = () => {};
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: async () => [],
      getUserMedia: async () => new FakeMediaStream(),
      getDisplayMedia: async () => new FakeMediaStream(),
      addEventListener() {},
      removeEventListener() {},
    },
  });
  navigator.sendBeacon = () => true;
  // The window is a browser tab: no native shell around it.
  delete (window as unknown as { chrome?: unknown }).chrome;
}

// ---- the server ----

let scenario: Scenario = 'empty';
let appState: AppState = defaultState();
const unmocked: string[] = [];
/** A test's own answer for a path, ahead of the shared fakes. */
let override: ((path: string, method: string) => Reply | undefined) | null = null;

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  let reply: { status?: number; body: unknown };
  if (path.startsWith('/api/state')) reply = { body: method === 'GET' ? appState : { ok: true } };
  else if (override?.(path, method)) reply = override(path, method)!;
  else {
    reply = route(scenario, path, method);
    if (reply.status === 404 && !path.includes('/art') && !path.includes('/thumb')) unmocked.push(`${method} ${path}`);
  }
  const status = reply.status ?? 200;
  const text = JSON.stringify(reply.body);
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => JSON.parse(text),
    text: async () => text,
  } as Response);
}

// ---- state to render ----

/** Something in every panel that has a lived-in state: names, counters, quests, a window. */
function fill(d: PresetData) {
  d.run.title = 'Any% run';
  d.run.subtitle = 'Attempt 4';
  d.slots.forEach((s, i) => {
    s.name = `Member ${i + 1}`;
    s.detail = i % 2 ? 'Druid' : 'Warrior';
    s.down = i === 1;
  });
  d.counters = [counter('Deaths', 3), counter('Wipes', 1)];
  d.milestones.items.forEach((m, i) => {
    m.name = i < 3 ? `Goal ${i + 1}` : '';
    m.done = i < 2;
  });
  d.notes = [
    { id: 'n1', text: 'Buy potions', done: false },
    { id: 'n2', text: 'Turn in quest', done: true },
  ];
  d.match = { god: 'Zeus', role: 'Mid', mode: 'Conquest', k: 5, d: 2, a: 7 };
  d.record = {
    wins: 3,
    losses: 2,
    history: [{ id: 'h1', god: 'Ra', role: 'Support', k: 1, d: 2, a: 3, win: true, at: Date.now() }],
  };
  d.character = { name: 'Eli', race: 'Human', cls: 'Mage', level: 17, maxLevel: 60, xp: 40, zone: 'Elwynn Forest', realm: 'Realm', guild: 'Guild', gold: '12g 4s', hardcore: true };
  d.quests = [{ title: 'Wolves', level: 5, state: 'open', objectives: [{ text: 'Wolves slain: 4/10', done: false }] }];
  d.wowLinkAt = Date.now();
  d.hud = [{ id: 'r1', label: 'Gold', x: 10, y: 10, w: 20, h: 10, numeric: true, value: '120', at: Date.now() }];
  for (const w of d.widgets) dressWidget(w);
}

/** The settings a widget needs to show something. */
function dressWidget(w: Widget) {
  const s = w.settings;
  s.lat = 30.27;
  s.lon = -97.74;
  s.place = 'Austin SENTINEL_TOWN, Texas';
  s.target = Date.now() + 90 * 60_000;
  s.text = 'Hello chat';
  s.launcherTiles = ['l1'];
  s.url = 'https://example.com/SENTINEL_PATH?q=SENTINEL_QUERY';
  s.showBody = true;
  // Notes may be switched on, and still must not show while private.
  s.showOfficerNotes = true;
  s.timeZone = 'Europe/London';
}

function stateFor(preset: PresetId, edit: (d: PresetData) => void): AppState {
  const state = defaultState();
  state.preset = preset;
  edit(state.presets[preset]);
  return state;
}

/** A preset with just this one panel on its board. */
function stateWithPanel(id: BoardId, size: 'min' | 'default', populated: boolean, preset: PresetId, widget?: Widget): AppState {
  return stateFor(preset, (d) => {
    if (populated) fill(d);
    d.widgets = widget ? [widget] : [];
    const info = boardDef(id, d.widgets)!;
    const item: GridItem = size === 'min' ? { i: id, x: 0, y: 0, w: info.minW, h: info.minH } : { i: id, x: 0, y: 0, w: info.w, h: info.h };
    d.layout = [item];
    if (widget && populated) dressWidget(widget);
  });
}

// ---- rendering ----

/** `priv` is what the app's privacy signal says; the stream mode view is private, like in the app. */
function Stage({ streaming, priv = streaming }: { streaming: boolean; priv?: boolean }) {
  const { state, mutate, mutatePreset, status } = useAppState();
  if (status === 'loading') return null;
  const { base, def, data } = activePreset(state);
  return (
    <FixedPrivacy on={priv}>
      <div className={`app theme-${base} ${streaming ? 'is-stream' : 'is-editing'}`}>
        <main className="stage">
          <Board layout={data.layout} widgets={data.widgets} editing={!streaming} mutatePreset={mutatePreset} renderPanel={(id) => renderPanel(id, { state, data, def, mutate, mutatePreset })} />
        </main>
      </div>
    </FixedPrivacy>
  );
}

/** Lets fetches, timers and effects settle: a few turns of the event loop inside act. */
async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** Loads, draws, then resizes the window (fires every ResizeObserver) and lets the follow-ups land. */
async function settleAll() {
  await settle(3);
  await fireResize();
  await settle(1);
}

let errors: unknown[][] = [];

beforeAll(installBrowserFakes);
beforeEach(() => {
  override = null;
  dismissUndo();
  window.localStorage.clear();
  resetOnAirForTests();
  resetStreamStatusForTests();
  errors = [];
  unmocked.length = 0;
  vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args));
  vi.stubGlobal('fetch', fakeFetch);
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The test's verdicts: no console.error (React warnings are among them), no unexpected request. */
function expectClean() {
  expect(errors.map((e) => e.map(String).join(' ').slice(0, 400))).toEqual([]);
  expect(unmocked).toEqual([]);
}

/** Text or controls inside the panel's cell: it drew something. */
function expectDrawn(id: string) {
  const cell = document.querySelector(`[data-panel="${id}"]`);
  expect(cell, `${id} is on the board`).not.toBeNull();
  const drew = (cell!.textContent ?? '').trim().length > 0 || cell!.querySelector('button, input, select, textarea, svg, img, canvas, video, iframe');
  expect(drew, `${id} drew something`).toBeTruthy();
}

const MODES = [
  { name: 'edit mode, nothing set up', streaming: false, scenario: 'empty' as Scenario, populated: false, size: 'min' as const },
  { name: 'edit mode, with data', streaming: false, scenario: 'data' as Scenario, populated: true, size: 'min' as const },
  { name: 'stream mode, with data', streaming: true, scenario: 'data' as Scenario, populated: true, size: 'min' as const },
];

/** Widgets are also drawn at the size they start at, since their layouts change with room. */
const WIDGET_MODES = [...MODES, { name: 'default size, with data', streaming: false, scenario: 'data' as Scenario, populated: true, size: 'default' as const }];

async function renderStage(state: AppState, streaming: boolean, sc: Scenario, priv?: boolean) {
  appState = state;
  scenario = sc;
  render(<Stage streaming={streaming} priv={priv} />);
  await settleAll();
}

// ---- the tests ----

describe.each(PRESET_IDS)('preset %s', (id) => {
  const modes = [
    { name: 'edit mode, nothing set up', streaming: false, scenario: 'empty' as Scenario, populated: false },
    { name: 'edit mode, with data', streaming: false, scenario: 'data' as Scenario, populated: true },
    { name: 'stream mode, with data', streaming: true, scenario: 'data' as Scenario, populated: true },
  ];
  it.each(modes)('draws the whole app in $name', async (mode) => {
    appState = stateFor(id, mode.populated ? fill : () => {});
    scenario = mode.scenario;
    // Stream mode is a page setting: ?stream=1.
    if (mode.streaming) window.history.replaceState(null, '', '/?stream=1');
    render(<App />);
    await settleAll();
    const root = document.querySelector('.app');
    expect(root, 'app root').not.toBeNull();
    expect(root!.classList.contains(`theme-${id}`)).toBe(true);
    expect(root!.classList.contains(mode.streaming ? 'is-stream' : 'is-editing')).toBe(true);
    // Every panel the preset lays out is on the board and, while editing, drew something.
    for (const item of PRESETS[id].layout) {
      const cell = document.querySelector(`[data-panel="${item.i}"]`);
      expect(cell, `${item.i} on the board`).not.toBeNull();
      if (!mode.streaming) expectDrawn(item.i);
    }
    expectClean();
  });
});

describe.each(SINGLE_KINDS)('panel %s', (id) => {
  // The preset whose own layout has this panel (its titles and slot style), else the desk.
  const preset = PRESET_IDS.find((p) => PRESETS[p].layout.some((i) => i.i === id)) ?? 'desk';
  it.each(MODES)('draws in $name', async (mode) => {
    await renderStage(stateWithPanel(id, mode.size, mode.populated, preset), mode.streaming, mode.scenario);
    if (!mode.streaming) expectDrawn(id);
    else expect(document.querySelector(`[data-panel="${id}"]`)).not.toBeNull();
    expectClean();
  });
});

describe.each(MULTI_KINDS)('widget %s', (kind) => {
  it.each(WIDGET_MODES)('draws in $name', async (mode) => {
    const widget = newWidget(kind);
    await renderStage(stateWithPanel(widget.id, mode.size, mode.populated, 'desk', widget), mode.streaming, mode.scenario);
    if (!mode.streaming) expectDrawn(widget.id);
    else expect(document.querySelector(`[data-panel="${widget.id}"]`)).not.toBeNull();
    expectClean();
  });
});

// The fakes really reach the widgets: with data, each one shows something that only came from them.
const SHOWS: Record<string, string> = {
  media: 'Song',
  weather: '72',
  obs: 'Mic',
  twitch: 'Late night ranked',
  gmail: 'Game tonight?',
  calendar: 'Standup',
  drive: 'Stream plan',
  notifications: 'Sam',
  text: 'Hello chat',
  launcher: 'Wiki',
  system: '37%',
  guildroster: '6 online of 9',
  guildfeed: 'Mira reached level 42',
  raidcomp: '9 in the raid',
  attendance: 'Last 2 raids',
  raidloot: 'Arcanist Bindings',
  guildgoals: '3 bosses down',
};

describe.each(Object.entries(SHOWS))('widget %s with data', (kind, text) => {
  it(`shows "${text}"`, async () => {
    const widget = newWidget(kind);
    await renderStage(stateWithPanel(widget.id, 'default', true, 'desk', widget), false, 'data');
    expect(document.querySelector(`[data-panel="${widget.id}"]`)?.textContent).toContain(text);
    expectClean();
  });
});

// Every kind in the library, in every preset's theme (fonts, colors and shapes differ per theme).
describe.each(WIDGETS.map((def) => def.kind))('%s in every preset theme', (kind) => {
  it.each(PRESET_IDS)('draws in %s', async (preset) => {
    const widget = MULTI_KINDS.includes(kind) ? newWidget(kind) : undefined;
    await renderStage(stateWithPanel(widget?.id ?? kind, 'min', true, preset, widget), false, 'data');
    expectDrawn(widget?.id ?? kind);
    expect(document.querySelector('.app')?.classList.contains(`theme-${preset}`)).toBe(true);
    expectClean();
  });
});

// ---- private (on air): nothing personal on screen ----

/** Everything a viewer could read: text, every attribute, typed values. The page inside a web panel is its own. */
function onScreen(): string {
  const parts = [document.body.textContent ?? ''];
  for (const el of document.body.querySelectorAll('*')) {
    for (const a of Array.from(el.attributes)) if (!(el.tagName === 'IFRAME' && a.name === 'src')) parts.push(a.value);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) parts.push(el.value);
  }
  return parts.join('\n');
}

const leaks = (text: string, found: readonly string[] = SENTINELS) => found.filter((s) => text.includes(s));

/** Private on, with the mocks full of sentinels, in the editor and in the stream mode view: none is drawn. */
describe.each(WIDGETS.map((def) => def.kind))('%s while private', (kind) => {
  it.each([
    { name: 'in the editor (left stream mode)', streaming: false },
    { name: 'in the stream mode view', streaming: true },
  ])('draws no personal text $name', async ({ streaming }) => {
    const widget = MULTI_KINDS.includes(kind) ? newWidget(kind) : undefined;
    await renderStage(stateWithPanel(widget?.id ?? kind, 'default', true, 'desk', widget), streaming, 'data', true);
    expect(leaks(onScreen())).toEqual([]);
    expectClean();
  });
});

// The same fakes do reach each widget when it is not private, so the test above means something.
const PERSONAL: Record<string, string[]> = {
  gmail: ['SENTINEL_SUBJECT', 'SENTINEL_SENDER'],
  calendar: ['SENTINEL_EVENT', 'SENTINEL_PLACE'],
  drive: ['SENTINEL_FILE', 'SENTINEL_OWNER', 'SENTINEL_ACCOUNT'],
  notifications: ['SENTINEL_TITLE', 'SENTINEL_BODY'],
  media: ['SENTINEL_TRACK'],
  web: ['SENTINEL_PATH', 'SENTINEL_QUERY'],
  weather: ['SENTINEL_TOWN'],
  downloads: ['SENTINEL_VIDEO', 'SENTINEL_URL'],
  guildroster: ['Raid leader', 'Owes 200g to the bank'],
};

describe.each(Object.entries(PERSONAL))('%s when not private', (kind, texts) => {
  it('shows what it was given', async () => {
    const widget = newWidget(kind);
    await renderStage(stateWithPanel(widget.id, 'default', true, 'desk', widget), false, 'data', false);
    const text = onScreen();
    for (const t of texts) expect(text, t).toContain(t);
    expectClean();
  });
});

describe('private keeps the counts and the status', () => {
  it('Gmail still says how many are unread; Calendar still says busy or free', async () => {
    const mail = newWidget('gmail');
    await renderStage(stateWithPanel(mail.id, 'default', true, 'desk', mail), false, 'data', true);
    expect(document.querySelector(`[data-panel="${mail.id}"]`)?.textContent).toContain('3');
    cleanup();
    const cal = newWidget('calendar');
    await renderStage(stateWithPanel(cal.id, 'default', true, 'desk', cal), false, 'data', true);
    expect(document.querySelector(`[data-panel="${cal.id}"]`)?.textContent).toMatch(/Busy until|Free/);
  });

  it('Notifications still say which app', async () => {
    const w = newWidget('notifications');
    await renderStage(stateWithPanel(w.id, 'default', true, 'desk', w), false, 'data', true);
    expect(document.querySelector(`[data-panel="${w.id}"]`)?.textContent).toContain('Discord');
  });

  it('the Web widget shows only the site', async () => {
    const w = newWidget('web');
    await renderStage(stateWithPanel(w.id, 'default', true, 'desk', w), false, 'data', true);
    const address = document.querySelector<HTMLInputElement>('.web-bar__address');
    expect(address?.value).toBe('example.com');
  });

  it('a Show on stream opt-in still wins', async () => {
    const w = newWidget('gmail');
    const state = stateWithPanel(w.id, 'default', true, 'desk', w);
    state.presets.desk.widgets[0].settings.showOnStream = true;
    await renderStage(state, false, 'data', true);
    expect(onScreen()).toContain('SENTINEL_SUBJECT');
  });
});

describe('private, with other data', () => {
  it('Now playing hides a browser tab but not a music app', async () => {
    const w = newWidget('media');
    const song = (app: string): Reply => ({ body: { playing: true, app, title: 'Song SENTINEL_TRACK', artist: 'Band', album: '', art: '', position: 1, age: 0, duration: 100, controls: { playPause: true, next: true, previous: true, seek: true } } });
    override = (path) => (path.startsWith('/api/media') && !path.includes('/art') ? song('Chrome') : undefined);
    await renderStage(stateWithPanel(w.id, 'default', true, 'desk', w), false, 'data', true);
    expect(onScreen()).not.toContain('SENTINEL_TRACK');
    cleanup();
    override = (path) => (path.startsWith('/api/media') && !path.includes('/art') ? song('Spotify') : undefined);
    await renderStage(stateWithPanel(w.id, 'default', true, 'desk', w), false, 'data', true);
    expect(onScreen()).toContain('SENTINEL_TRACK');
  });

  it('Steam hides the account name when between games', async () => {
    override = (path) => (path === '/api/steam' ? { body: { available: true, user: { name: 'Eli SENTINEL_STEAMER' }, playing: null, recent: [], commons: [] } } : undefined);
    await renderStage(stateWithPanel('steam', 'default', true, 'desk'), false, 'data', true);
    expect(onScreen()).not.toContain('SENTINEL_STEAMER');
    cleanup();
    await renderStage(stateWithPanel('steam', 'default', true, 'desk'), false, 'data', false);
    expect(onScreen()).toContain('SENTINEL_STEAMER');
  });

  it('the Guild roster, loot, attendance and feed keep names and notes to themselves', async () => {
    for (const [kind, name] of [['guildroster', 'Raid leader'], ['raidloot', 'Kaz'], ['attendance', 'Kaz'], ['guildfeed', 'Grim']] as const) {
      const w = newWidget(kind);
      await renderStage(stateWithPanel(w.id, 'default', true, 'desk', w), false, 'data', true);
      expect(onScreen(), `${kind} while private`).not.toContain(name);
      expect(onScreen(), `${kind} while private`).not.toContain('Owes 200g');
      cleanup();
      await renderStage(stateWithPanel(w.id, 'default', true, 'desk', w), false, 'data', false);
      expect(onScreen(), `${kind} when not private`).toContain(name);
      cleanup();
    }
  });
});

// ---- the whole app ----

/** The desk with one of every widget on it. */
function stateWithEverything(): AppState {
  return stateFor('desk', (d) => {
    fill(d);
    d.widgets = MULTI_KINDS.map((kind) => newWidget(kind));
    d.widgets.forEach(dressWidget);
    d.layout = [];
    for (const w of d.widgets) d.layout.push(placePanel(d.layout, w.id, d.widgets));
  });
}

const offline = (): Reply | undefined => undefined;
const obsOffline = (path: string): Reply | undefined =>
  path === '/api/obs' ? { body: { status: 'offline', connected: false, stream: { active: false, reconnecting: false, timecode: '', bitrate: null, congestion: 0, dropped: 0, total: 0 }, record: { active: false, paused: false, timecode: '' }, scene: '', scenes: [], stats: { cpu: 0, fps: 0, renderSkipped: 0, renderTotal: 0, outputSkipped: 0, outputTotal: 0 }, inputs: [], studioMode: false, virtualCam: false, replayBuffer: false, replaySavedAt: 0 } } : offline();

describe('the whole app', () => {
  async function startApp(url = '/') {
    appState = stateWithEverything();
    scenario = 'data';
    window.history.replaceState(null, '', url);
    render(<App />);
    await settleAll();
  }
  const pill = () => document.querySelector<HTMLElement>('.onair')!;

  it('is public when the On air switch is on, and shows everything when it is off', async () => {
    override = obsOffline;
    await startApp();
    // Off air: a person at the screen sees their own mail.
    expect(pill().textContent).toBe('Off air');
    expect(onScreen()).toContain('SENTINEL_SUBJECT');
    fireEvent.click(pill());
    await settle(1);
    expect(pill().textContent).toBe('On air: personal info hidden');
    expect(leaks(onScreen())).toEqual([]);
    // It is remembered.
    expect(window.localStorage.getItem('uncbox.onAir')).toBe('1');
    fireEvent.click(pill());
    await settle(1);
    expect(pill().textContent).toBe('Off air');
    expect(onScreen()).toContain('SENTINEL_SUBJECT');
  });

  it('stays private by itself while OBS is streaming, even outside the stream mode view', async () => {
    // The default fake OBS is live.
    await startApp();
    expect(pill().textContent).toContain('On air');
    expect(pill().getAttribute('aria-disabled')).toBe('true');
    expect(leaks(onScreen())).toEqual([]);
    fireEvent.click(pill());
    await settle(1);
    expect(leaks(onScreen())).toEqual([]);
  });

  it('is private in the stream mode view', async () => {
    override = obsOffline;
    await startApp('/?stream=1');
    expect(leaks(onScreen())).toEqual([]);
  });

  it('shortens paths and addresses in a toast while private, but not otherwise', async () => {
    override = obsOffline;
    await startApp();
    act(() => showNotice('Saved to C:\\Users\\SENTINEL\\clip.mp4 for SENTINEL_ACCOUNT@example.com'));
    expect(onScreen()).toContain('C:\\Users\\SENTINEL\\clip.mp4');
    fireEvent.click(pill());
    await settle(1);
    expect(leaks(onScreen())).toEqual([]);
    expect(screen.getByRole('status').textContent).toContain('a folder on this PC');
  });

  it('keeps Drive results out of the palette while private', async () => {
    override = obsOffline;
    await startApp();
    const search = async () => {
      act(() => openPalette());
      const box = await screen.findByRole('combobox', { name: 'Search commands' });
      fireEvent.change(box, { target: { value: 'stream' } });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 500));
      });
    };
    await search();
    expect(onScreen()).toContain('SENTINEL_FILE');
    fireEvent.keyDown(window, { key: 'Escape' });
    await settle(1);
    fireEvent.click(pill());
    await settle(1);
    await search();
    expect(onScreen()).not.toContain('SENTINEL_FILE');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(leaks(onScreen())).toEqual([]);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull());
  });
});

// ---- streaming from Uncbox ----

describe('streaming from Uncbox', () => {
  async function startApp(sc: Scenario, picked: 'obs' | 'uncbox' = 'uncbox') {
    appState = defaultState();
    appState.stream.with = picked;
    scenario = sc;
    // The Streaming section starts shut; people open it once and it stays open.
    window.localStorage.setItem('uncbox.sidebar.streaming', '1');
    render(<App />);
    await settleAll();
  }
  const pill = () => document.querySelector<HTMLElement>('.onair')!;
  const status = (over: object): Reply => ({ body: { ...streamStatus(true), ...over } });
  const live = (test = false): Reply => status({ state: 'live', test, startedAt: Date.now() - 62 * 60_000 - 33_000, stats: { fps: 59.9, kbps: 5900, dropped: 0, frames: 1000, speed: 1 } });

  afterEach(async () => {
    // The controller outlives the app: a stream it took over must not leak into the next test.
    override = (path) => (path.startsWith('/api/stream') ? status({ state: 'off' }) : undefined);
    await act(async () => {
      await controller.end();
    });
  });

  it('offers only the choice while OBS is the one that streams', async () => {
    override = obsOffline;
    await startApp('data', 'obs');
    expect(screen.getByLabelText('Stream with')).toHaveProperty('value', 'obs');
    expect(onScreen()).toContain('OBS does the streaming, as before.');
    expect(screen.queryByRole('button', { name: /Go live/ })).toBeNull();
    expect(onScreen()).not.toContain('Paste stream key');
    expectClean();
  });

  it('sets up the stream: key, screen, quality, sound, and says it is ready', async () => {
    override = obsOffline;
    await startApp('data');
    const text = onScreen();
    expect(text).toContain('Stream key set ····q9z7');
    expect(screen.getByLabelText('Screen')).toHaveProperty('value', '0');
    expect(screen.getByLabelText('Quality')).toHaveProperty('value', '1080p60');
    expect(text).toContain('Ready: NVENC on your graphics card');
    // A browser has no app to make the sound.
    expect(text).toContain('Sound needs the Uncbox app.');
    expect(screen.getByRole('button', { name: 'Replace key' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Get it from Twitch' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Forget' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Test stream (not public)' })).toHaveProperty('disabled', false);
    expectClean();
  });

  it('asks twice before going live', async () => {
    override = obsOffline;
    await startApp('data');
    const go = screen.getByRole('button', { name: 'Go live' });
    expect(go).toHaveProperty('disabled', false);
    fireEvent.click(go);
    expect(screen.getByRole('button', { name: 'Go live?' })).toBeTruthy();
  });

  it('says what is missing when nothing is set up', async () => {
    override = obsOffline;
    await startApp('empty');
    const text = onScreen();
    expect(text).toContain('No stream key yet');
    expect(text).toContain('FFmpeg isn’t installed: install it from the Downloads widget.');
    expect(screen.getByRole('button', { name: 'Paste stream key' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Install FFmpeg' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Go live' })).toHaveProperty('disabled', true);
    expect(text).toContain('Add your stream key under Streaming below first.');
    expectClean();
  });

  it('keeps the key’s last characters off the screen while private', async () => {
    override = obsOffline;
    await startApp('data');
    expect(onScreen()).toContain('····q9z7');
    fireEvent.click(pill());
    await settle(1);
    expect(onScreen()).not.toContain('q9z7');
    expect(onScreen()).toContain('Stream key set');
  });

  it('shows the live line, forces private, and ends only after a second click', async () => {
    override = (path) => (path === '/api/stream' ? live() : obsOffline(path));
    await startApp('data');
    expect(onScreen()).toMatch(/● Live 1:02:3\d · 5\.9 Mbps · 0 dropped/);
    expect(screen.getByLabelText('Stream with')).toHaveProperty('disabled', true);
    expect(pill().textContent).toContain('Streaming from Uncbox, so it stays on');
    expect(pill().getAttribute('aria-disabled')).toBe('true');
    expect(leaks(onScreen())).toEqual([]);
    expect(onScreen()).not.toContain('q9z7');
    expect(screen.queryByRole('button', { name: 'Go live' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'End stream' }));
    expect(screen.getByRole('button', { name: 'End stream?' })).toBeTruthy();
    expectClean();
  });

  it('labels a test stream as a test', async () => {
    override = (path) => (path === '/api/stream' ? live(true) : obsOffline(path));
    await startApp('data');
    expect(onScreen()).toMatch(/● Test 1:02:3\d/);
  });

  it('goes back to public once the stream has ended', async () => {
    override = (path) => (path === '/api/stream' ? live() : obsOffline(path));
    await startApp('data');
    expect(pill().textContent).toContain('Streaming from Uncbox');
    override = obsOffline;
    await act(async () => {
      FakeEventSource.last?.push('stream', { ...IDLE, state: 'off' });
    });
    await settle(1);
    expect(pill().textContent).toBe('Off air');
  });
});
