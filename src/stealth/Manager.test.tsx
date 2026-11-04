// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultState } from '../state/hydrate';

// Stealth mode's manager page and the sidebar's way into it, drawn for real inside a fake Uncbox app
// (window.chrome.webview) and against a server that answers the saved state and little else.

const sent: { type: string; [key: string]: unknown }[] = [];
const fromApp = new Set<(e: { data: unknown }) => void>();

function stubEnvironment(search: string) {
  class FakeEventSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    addEventListener() {}
    close() {}
  }
  vi.stubGlobal('EventSource', FakeEventSource);
  const state = { ...defaultState(), preset: 'wow' as const };
  state.stream.with = 'uncbox';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) =>
      path === '/api/state'
        ? new Response(JSON.stringify(state), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response(JSON.stringify({}), { status: 404, headers: { 'Content-Type': 'application/json' } }),
    ),
  );
  window.history.replaceState(null, '', `/${search}`);
  (window as unknown as { chrome: unknown }).chrome = {
    webview: {
      postMessage: (m: { type: string }) => void sent.push(m),
      addEventListener: (_: string, l: (e: { data: unknown }) => void) => void fromApp.add(l),
      removeEventListener: (_: string, l: (e: { data: unknown }) => void) => void fromApp.delete(l),
      releaseBuffer: () => {},
    },
  };
  // What jsdom lacks and the dashboard draws with.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.matchMedia = ((media: string) => ({ matches: false, media, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  const context = new Proxy({}, { get: (_t, key) => (key === 'canvas' ? document.createElement('canvas') : () => ({ width: 0, data: new Uint8ClampedArray(4) })) });
  HTMLCanvasElement.prototype.getContext = (() => context) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => {};
  window.scrollTo = (() => {}) as typeof window.scrollTo;
  navigator.sendBeacon = () => true;
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof window.cancelAnimationFrame;
  Element.prototype.scrollIntoView = () => {};
}

const app = (data: unknown) => act(() => fromApp.forEach((l) => l({ data })));

/** A fresh copy of the page's modules, which read the app's bridge and the address when they load. */
async function loadApp() {
  vi.resetModules();
  return (await import('../App')).App;
}

beforeEach(() => {
  sent.length = 0;
  fromApp.clear();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { chrome?: unknown }).chrome;
});

describe('the manager page', () => {
  it('shows what viewers see, the stream’s controls, the presets as scenes and the sidebar, and no board', async () => {
    stubEnvironment('?native=1&view=manager');
    const App = await loadApp();
    const { container } = render(<App />);
    expect(await screen.findByRole('img', { name: 'Live preview: what viewers see' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Go live/ })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Scenes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'WoW Forever', pressed: true })).toBeTruthy();
    expect(container.querySelector('.board')).toBeNull();
    // The sidebar's way back, instead of Stream mode.
    expect(screen.getAllByRole('button', { name: /Full dashboard/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Stream mode/ })).toBeNull();
    // It asks the app whether stealth mode is on, and the dashboard how its stream is going.
    expect(sent).toContainEqual({ type: 'stealth' });
    expect(sent).toContainEqual({ type: 'relay', message: { type: 'streamcommand', action: 'state' } });
    const results = await axe.run(container, { runOnly: ['wcag2a', 'wcag2aa'], rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
  });

  it('hands Go live, Save clip and Full dashboard to the app, and shows the dashboard’s stream', async () => {
    stubEnvironment('?native=1&view=manager');
    const App = await loadApp();
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Go live/ }));
    fireEvent.click(screen.getByRole('button', { name: /Go live\?/ }));
    expect(sent).toContainEqual({ type: 'relay', message: { type: 'streamcommand', action: 'start' } });
    fireEvent.click(screen.getByRole('button', { name: /Save clip/ }));
    expect(sent).toContainEqual({ type: 'relay', message: { type: 'clipsave' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Full dashboard/ })[0]);
    expect(sent).toContainEqual({ type: 'stealth', on: false });
    // The dashboard's controller says it is starting: the manager shows it.
    app({ type: 'streamstate', state: { phase: 'preparing', test: false, error: '', note: '', retries: 0, retryIn: null } });
    expect(await screen.findByText('Starting the stream…')).toBeTruthy();
    expect(screen.getByRole('button', { name: /End stream/ })).toBeTruthy();
  });

  it('switches scenes by switching the preset', async () => {
    stubEnvironment('?native=1&view=manager');
    const App = await loadApp();
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'SMITE 2', pressed: false }));
    expect(screen.getByRole('button', { name: 'SMITE 2', pressed: true })).toBeTruthy();
  });
});

describe('the dashboard in the Uncbox app', () => {
  it('offers stealth mode, and goes into stream mode when it comes on', async () => {
    stubEnvironment('?native=1');
    const App = await loadApp();
    const { container } = render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Stealth mode/ }));
    expect(sent).toContainEqual({ type: 'stealth', on: true });
    expect(container.querySelector('.app.is-editing')).toBeTruthy();
    app({ type: 'stealth', on: true });
    expect(container.querySelector('.app.is-stream')).toBeTruthy();
  });

  it('answers the manager: Go live there is done here, where the stream is', async () => {
    stubEnvironment('?native=1');
    const App = await loadApp();
    render(<App />);
    await screen.findByRole('button', { name: /Stealth mode/ });
    app({ type: 'stealth', on: true });
    sent.length = 0;
    app({ type: 'streamcommand', action: 'state' });
    expect(sent.find((m) => m.type === 'relay')).toMatchObject({ message: { type: 'streamstate', state: { phase: 'idle' } } });
    // Going live opens the sound first, as it always does with the app.
    app({ type: 'streamcommand', action: 'start' });
    expect(sent).toContainEqual(expect.objectContaining({ type: 'streamaudio', on: true }));
  });

  it('has no stealth mode in a browser', async () => {
    stubEnvironment('');
    delete (window as unknown as { chrome?: unknown }).chrome;
    const App = await loadApp();
    render(<App />);
    await screen.findByRole('button', { name: /Stream mode/ });
    expect(screen.queryByRole('button', { name: /Stealth mode/ })).toBeNull();
  });
});
