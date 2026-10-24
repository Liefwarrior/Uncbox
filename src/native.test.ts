import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The page's side of the shell's web view messages, against a fake window.chrome.webview. native.ts
// reads the bridge when it loads, so each test loads a fresh copy.

type Listener = (e: { data: unknown }) => void;

function fakeShell() {
  const sent: unknown[] = [];
  const listeners = new Set<Listener>();
  const webview = {
    postMessage: (m: unknown) => void sent.push(m),
    addEventListener: (_: string, l: Listener) => void listeners.add(l),
    removeEventListener: (_: string, l: Listener) => void listeners.delete(l),
  };
  return { sent, listeners, webview, receive: (data: unknown) => listeners.forEach((l) => l({ data })) };
}

async function load(webview: unknown, devicePixelRatio = 1) {
  vi.resetModules();
  vi.stubGlobal('window', { chrome: webview ? { webview } : undefined, devicePixelRatio });
  return import('./native');
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('the web view messages', () => {
  it('sends each message with the widget’s id', async () => {
    const s = fakeShell();
    const { web } = await load(s.webview);
    web.open('wdg-1', 'https://example.com/');
    web.rect('wdg-1', { x: 10, y: 20, w: 300, h: 200 }, true);
    web.nav('wdg-1', 'back');
    web.nav('wdg-1', 'forward');
    web.nav('wdg-1', 'reload');
    web.zoom('wdg-1', 1.25);
    web.close('wdg-1');
    expect(s.sent).toEqual([
      { type: 'web', id: 'wdg-1', url: 'https://example.com/' },
      { type: 'webrect', id: 'wdg-1', x: 10, y: 20, w: 300, h: 200, visible: true },
      { type: 'webnav', id: 'wdg-1', action: 'back' },
      { type: 'webnav', id: 'wdg-1', action: 'forward' },
      { type: 'webnav', id: 'wdg-1', action: 'reload' },
      { type: 'webzoom', id: 'wdg-1', factor: 1.25 },
      { type: 'webclose', id: 'wdg-1' },
    ]);
  });

  it('does nothing in a browser, where there is no shell', async () => {
    const { web, shell } = await load(null);
    expect(shell).toBeNull();
    expect(() => {
      web.open('wdg-1', 'https://example.com/');
      web.close('wdg-1');
    }).not.toThrow();
  });

  it('measures a box in device pixels, the way the game’s rect is', async () => {
    const s = fakeShell();
    const { deviceBox } = await load(s.webview, 1.5);
    const el = { getBoundingClientRect: () => ({ left: 100, top: 40, width: 400, height: 300 }) } as Element;
    expect(deviceBox(el)).toEqual({ x: 150, y: 60, w: 600, h: 450 });
    expect(deviceBox(el, 2)).toEqual({ x: 200, y: 80, w: 800, h: 600 });
  });

  it('hears where the page went', async () => {
    const s = fakeShell();
    const { shell } = await load(s.webview);
    const heard: unknown[] = [];
    shell?.addEventListener('message', (e) => heard.push(e.data));
    const state = { type: 'webstate', id: 'wdg-1', url: 'https://example.com/next', title: 'Next', canGoBack: true, canGoForward: false, loading: false };
    s.receive(state);
    expect(heard).toEqual([state]);
  });
});
