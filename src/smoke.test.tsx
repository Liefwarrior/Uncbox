// @vitest-environment jsdom
//
// Smoke tests for the page: every built-in preset, and every kind in the widget library (single
// panels and widgets alike) in every preset's theme, is drawn for real (React, the board, the
// sidebar) against a faked server, in edit mode and stream mode, empty and with data, at its
// smallest size. Nothing here checks how it looks; it catches the crash on first
// run, the React warning and the panel that comes up blank. The fakes are in ./smokeMocks.ts.

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { Board } from './components/Board';
import { PRESETS } from './presets';
import { renderPanel } from './widgets/render';
import { defaultState } from './state/hydrate';
import { type AppState, type BoardId, type GridItem, type PresetData, type PresetId, PRESET_IDS, type Widget, counter } from './state/model';
import { activePreset } from './state/presets';
import { useAppState } from './state/useAppState';
import { boardDef, newWidget, SINGLE_KINDS, MULTI_KINDS, WIDGETS } from './widgets/registry';
import { route, type Scenario } from './smokeMocks';

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

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  let reply: { status?: number; body: unknown };
  if (path.startsWith('/api/state')) reply = { body: method === 'GET' ? appState : { ok: true } };
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
  s.place = 'Austin, Texas';
  s.target = Date.now() + 90 * 60_000;
  s.text = 'Hello chat';
  s.launcherTiles = ['l1'];
  s.url = 'https://example.com';
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

function Stage({ streaming }: { streaming: boolean }) {
  const { state, mutate, mutatePreset, status } = useAppState();
  if (status === 'loading') return null;
  const { base, def, data } = activePreset(state);
  return (
    <div className={`app theme-${base} ${streaming ? 'is-stream' : 'is-editing'}`}>
      <main className="stage">
        <Board layout={data.layout} widgets={data.widgets} editing={!streaming} mutatePreset={mutatePreset} renderPanel={(id) => renderPanel(id, { state, data, def, mutate, mutatePreset })} />
      </main>
    </div>
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

async function renderStage(state: AppState, streaming: boolean, sc: Scenario) {
  appState = state;
  scenario = sc;
  render(<Stage streaming={streaming} />);
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
