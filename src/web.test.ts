import { describe, expect, it } from 'vitest';
import { defaultState, hydrate } from './state/hydrate';
import { newWidget } from './widgets/catalog';
import {
  canGoBack,
  canGoForward,
  clampZoom,
  cleanUrl,
  currentOf,
  goBack,
  goForward,
  isWebUrl,
  resolveAddress,
  sandboxFor,
  searchUrl,
  startHistory,
  visit,
} from './web';

describe('resolveAddress', () => {
  const url = (text: string) => {
    const a = resolveAddress(text);
    return a.kind === 'url' ? a.url : a.kind;
  };

  it('opens web addresses, adding https when it was left off', () => {
    expect(url('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(url('example.com')).toBe('https://example.com/');
    expect(url('  www.youtube.com/watch?v=abc  ')).toBe('https://www.youtube.com/watch?v=abc');
    expect(url('en.wikipedia.org/wiki/Cat')).toBe('https://en.wikipedia.org/wiki/Cat');
    expect(url('HTTP://Example.com')).toBe('http://example.com/');
  });

  it('uses plain http for this PC and home networks', () => {
    expect(url('localhost:3000')).toBe('http://localhost:3000/');
    expect(url('192.168.1.20:8080/stream')).toBe('http://192.168.1.20:8080/stream');
  });

  it('searches for anything else', () => {
    expect(resolveAddress('cute cats')).toEqual({ kind: 'search', url: 'https://www.google.com/search?q=cute%20cats' });
    expect(resolveAddress('wow classic', 'duckduckgo')).toEqual({ kind: 'search', url: 'https://duckduckgo.com/?q=wow%20classic' });
    expect(resolveAddress('weather')).toMatchObject({ kind: 'search' });
    expect(resolveAddress('what is 3.5 + 2')).toMatchObject({ kind: 'search' });
    expect(resolveAddress('v1.2')).toMatchObject({ kind: 'search' });
    expect(resolveAddress('a&b=c d')).toEqual({ kind: 'search', url: 'https://www.google.com/search?q=a%26b%3Dc%20d' });
  });

  it('falls back to Google for an unknown search engine', () => {
    expect(searchUrl('cats', 'nope')).toBe('https://www.google.com/search?q=cats');
  });

  it('only ever opens http and https', () => {
    const bad = [
      'file:///C:/Windows/win.ini',
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,hi',
      'ftp://example.com',
      'mailto:a@b.co',
      'about:blank',
      'chrome://settings',
      'view-source:https://example.com',
      'blob:https://example.com/x',
    ];
    for (const text of bad) expect(resolveAddress(text).kind).toBe('blocked');
  });

  it('says there is nothing to open for an empty box', () => {
    expect(resolveAddress('   ').kind).toBe('empty');
  });
});

describe('isWebUrl and cleanUrl', () => {
  it('allows web pages only', () => {
    expect(isWebUrl('https://example.com')).toBe(true);
    expect(isWebUrl('http://localhost:5170/')).toBe(true);
    for (const bad of ['', 'example.com', 'file:///x', 'javascript:1', 'https://', 'ws://example.com']) expect(isWebUrl(bad)).toBe(false);
  });

  it('cleans a saved address to a web page or nothing', () => {
    expect(cleanUrl(' https://example.com/x ')).toBe('https://example.com/x');
    expect(cleanUrl('javascript:alert(1)')).toBe('');
    expect(cleanUrl(42)).toBe('');
  });
});

describe('the widget’s own history', () => {
  it('goes back and forward through the pages opened', () => {
    let h = startHistory('https://a.example/');
    h = visit(h, 'https://b.example/');
    h = visit(h, 'https://c.example/');
    expect(currentOf(h)).toBe('https://c.example/');
    expect(canGoBack(h)).toBe(true);
    expect(canGoForward(h)).toBe(false);
    h = goBack(goBack(h));
    expect(currentOf(h)).toBe('https://a.example/');
    expect(canGoBack(h)).toBe(false);
    expect(canGoForward(h)).toBe(true);
    expect(currentOf(goForward(h))).toBe('https://b.example/');
  });

  it('drops the pages ahead when a new one is opened from the middle', () => {
    let h = visit(visit(startHistory('https://a.example/'), 'https://b.example/'), 'https://c.example/');
    h = visit(goBack(h), 'https://d.example/');
    expect(h.stack).toEqual(['https://a.example/', 'https://b.example/', 'https://d.example/']);
    expect(canGoForward(h)).toBe(false);
  });

  it('adds nothing for the page it is already on, and starts empty without one', () => {
    const h = startHistory('https://a.example/');
    expect(visit(h, 'https://a.example/')).toBe(h);
    const empty = startHistory('');
    expect(currentOf(empty)).toBe('');
    expect(canGoBack(empty) || canGoForward(empty)).toBe(false);
    expect(currentOf(visit(empty, 'https://a.example/'))).toBe('https://a.example/');
  });
});

describe('zoom and the frame', () => {
  it('keeps zoom between 50 and 200', () => {
    expect(clampZoom(10)).toBe(50);
    expect(clampZoom(500)).toBe(200);
    expect(clampZoom(125.4)).toBe(125);
    expect(clampZoom(Number.NaN)).toBe(100);
  });

  it('gives a page of Uncbox’s own origin no same-origin rights', () => {
    expect(sandboxFor('https://example.com/', 'http://localhost:5170')).toContain('allow-same-origin');
    expect(sandboxFor('http://localhost:5170/', 'http://localhost:5170')).not.toContain('allow-same-origin');
    expect(sandboxFor('https://example.com/', 'http://localhost:5170')).toContain('allow-scripts');
  });
});

describe('web widgets in a saved file', () => {
  const withWidgets = (widgets: ReturnType<typeof newWidget>[]) => {
    const state = defaultState();
    state.presets.terminal.widgets = widgets;
    return state;
  };

  it('start empty on Google, at 100%', () => {
    expect(newWidget('web').settings).toMatchObject({ url: '', homeUrl: '', searchEngine: 'google', hideToolbar: false, zoom: 100 });
  });

  it('come back as saved, but never open anything but a web page', () => {
    const good = newWidget('web');
    good.settings = { ...good.settings, url: 'https://example.com/a', homeUrl: 'https://wiki.example.org/', searchEngine: 'bing', hideToolbar: true, zoom: 150 };
    const bad = newWidget('web');
    bad.settings = { ...bad.settings, url: 'javascript:alert(1)', homeUrl: 'file:///C:/x', searchEngine: 'nope', zoom: 9000 };
    const state = withWidgets([good, bad]);
    const back = hydrate(JSON.parse(JSON.stringify(state))).presets.terminal.widgets;
    expect(back[0].settings).toMatchObject({ url: 'https://example.com/a', homeUrl: 'https://wiki.example.org/', searchEngine: 'bing', hideToolbar: true, zoom: 150 });
    expect(back[1].settings).toMatchObject({ url: '', homeUrl: '', searchEngine: 'google', zoom: 200 });
  });

  it('fill in the web settings an older save leaves out', () => {
    const state = withWidgets([newWidget('web')]);
    const saved = JSON.parse(JSON.stringify(state));
    const settings = saved.presets.terminal.widgets[0].settings;
    delete settings.zoom;
    delete settings.url;
    expect(hydrate(saved).presets.terminal.widgets[0].settings).toMatchObject({ url: '', zoom: 100 });
  });
});
