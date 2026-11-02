import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The page's side of the shell's web view messages, against a fake window.chrome.webview. native.ts
// reads the bridge when it loads, so each test loads a fresh copy.

type Listener = (e: unknown) => void;

function fakeShell() {
  const sent: unknown[] = [];
  const byType = new Map<string, Set<Listener>>();
  const on = (type: string) => byType.get(type) ?? byType.set(type, new Set()).get(type)!;
  const released: ArrayBuffer[] = [];
  const webview = {
    postMessage: (m: unknown) => void sent.push(m),
    addEventListener: (type: string, l: Listener) => void on(type).add(l),
    removeEventListener: (type: string, l: Listener) => void on(type).delete(l),
    releaseBuffer: (b: ArrayBuffer) => void released.push(b),
  };
  return {
    sent,
    released,
    listeners: on('message'),
    webview,
    receive: (data: unknown) => on('message').forEach((l) => l({ data })),
    /** WebView2 handing over a shared buffer. */
    receiveBuffer: (buffer: ArrayBuffer, additionalData: unknown) => on('sharedbufferreceived').forEach((l) => l({ additionalData, getBuffer: () => buffer })),
  };
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

describe('the sound for a clip', () => {
  /** Three tracks of `frames` stereo frames: the game all 1s, Discord all 2s, the mic all 3s, as the app lays them out. */
  const layout = (frames: number) => {
    const all = new Int16Array(frames * 2 * 3);
    all.fill(1, 0, frames * 2);
    all.fill(2, frames * 2, frames * 4);
    all.fill(3, frames * 4);
    return all.buffer;
  };

  it('asks the app for the stretch and copies each track out of the shared buffer, then gives it back', async () => {
    const s = fakeShell();
    const { requestClipAudio } = await load(s.webview);
    const pending = requestClipAudio(61_000, 1_000);
    expect(s.sent).toEqual([{ type: 'clipaudioget', id: expect.any(Number), fromMs: 61_000, toMs: 1_000 }]);
    const { id } = s.sent[0] as { id: number };

    const buffer = layout(4);
    s.receiveBuffer(buffer, { type: 'clipaudio', id, frames: 4, rate: 48000 });
    const pcm = await pending;
    expect(pcm.frames).toBe(4);
    expect(pcm.rate).toBe(48000);
    expect([...pcm.game]).toEqual(new Array(8).fill(1));
    expect([...pcm.discord]).toEqual(new Array(8).fill(2));
    expect([...pcm.mic]).toEqual(new Array(8).fill(3));
    expect(s.released).toEqual([buffer]);
    // Copies: the shared memory is the app's to take back.
    new Int16Array(buffer).fill(9);
    expect(pcm.game[0]).toBe(1);
  });

  it('ignores a buffer meant for another request', async () => {
    const s = fakeShell();
    const { requestClipAudio } = await load(s.webview);
    const pending = requestClipAudio(5000, 0);
    const { id } = s.sent[0] as { id: number };
    s.receiveBuffer(layout(2), { type: 'clipaudio', id: id + 100, frames: 2, rate: 48000 });
    expect(s.released).toEqual([]);
    s.receiveBuffer(layout(2), { type: 'clipaudio', id, frames: 2, rate: 48000 });
    expect((await pending).frames).toBe(2);
  });

  it('turns the app’s error into words', async () => {
    const s = fakeShell();
    const { requestClipAudio } = await load(s.webview);
    const pending = requestClipAudio(5000, 0);
    const { id } = s.sent[0] as { id: number };
    s.receive({ type: 'clipaudio', id: id + 1, error: 'someone else’s' });
    s.receive({ type: 'clipaudio', id, error: 'Sound isn’t being recorded.' });
    await expect(pending).rejects.toThrow('Sound isn’t being recorded.');
  });

  it('rejects a buffer that is shorter than it says, and still gives it back', async () => {
    const s = fakeShell();
    const { requestClipAudio } = await load(s.webview);
    const pending = requestClipAudio(5000, 0);
    const { id } = s.sent[0] as { id: number };
    const short = new Int16Array(10).buffer;
    s.receiveBuffer(short, { type: 'clipaudio', id, frames: 100, rate: 48000 });
    await expect(pending).rejects.toThrow('cut short');
    expect(s.released).toEqual([short]);
  });

  it('gives up when the app never answers', async () => {
    vi.useFakeTimers();
    try {
      const s = fakeShell();
      const { requestClipAudio } = await load(s.webview);
      const pending = requestClipAudio(5000, 0);
      const caught = expect(pending).rejects.toThrow('didn’t send the sound');
      await vi.advanceTimersByTimeAsync(16_000);
      await caught;
    } finally {
      vi.useRealTimers();
    }
  });

  it('needs the app', async () => {
    const { requestClipAudio } = await load(null);
    await expect(requestClipAudio(5000, 0)).rejects.toThrow('needs the Uncbox app');
  });
});
