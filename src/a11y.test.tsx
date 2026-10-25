// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { contrast, over, parseColor, readThemes } from './contrast';
import { openGallery } from './gallery';
import { focusableIn } from './useDialog';
import { openPalette } from './palette/Palette';
import { watchClip } from './clips/replay';
import { defaultState } from './state/hydrate';
import { GRID_COLS, GRID_ROWS, type GridItem } from './state/model';
import { newWidget, sizeOf, WIDGETS } from './widgets/registry';
import { isSingle } from './widgets/types';
import { dismissUndo, offerUndo, showNotice } from './undo';

// ---------- the contrast of every theme ----------

// Read from disk: vitest hands CSS imports back empty. Node's types aren't installed here.
// @ts-expect-error node:fs only exists in the test runner
const { readFileSync } = (await import('node:fs')) as { readFileSync: (path: string, encoding: string) => string };
declare const process: { cwd(): string };
const themes = readThemes(readFileSync(`${process.cwd()}/src/styles.css`, 'utf8'));

/** A token that is a plain color, or a var() of another token in the same theme. */
function colorOf(theme: Record<string, string>, name: string) {
  let v = theme[name];
  for (let n = 0; v?.startsWith('var(') && n < 5; n++) v = theme[v.slice(4, -1).trim()];
  const c = v ? parseColor(v) : null;
  if (!c) throw new Error(`${name} is not a plain color`);
  return c;
}

describe('theme contrast (WCAG 2.x)', () => {
  it('reads every theme', () => {
    expect(Object.keys(themes).sort()).toEqual(['desk', 'mcd2', 'pokemon', 'smite2', 'steam', 'terminal', 'wow']);
  });

  for (const [name, t] of Object.entries(themes)) {
    describe(name, () => {
      const bg = colorOf(t, '--bg').rgb;
      const panel = over(colorOf(t, '--panel'), bg);
      const panel2 = colorOf(t, '--panel-2').rgb;
      const ratio = (token: string, under: number[]) => contrast(colorOf(t, token).rgb, under as typeof bg);

      it('text and muted text read at 4.5:1 on the page and both panel colors', () => {
        for (const token of ['--text', '--muted']) {
          for (const [what, under] of [['page', bg], ['panel', panel], ['inset', panel2]] as const) {
            expect(ratio(token, under), `${token} on ${what}`).toBeGreaterThanOrEqual(4.5);
          }
        }
      });

      it('accent and status colors read at 4.5:1 on the page and panels, and 3:1 on insets', () => {
        for (const token of ['--accent', '--accent-2', '--good', '--bad']) {
          expect(ratio(token, bg), `${token} on page`).toBeGreaterThanOrEqual(4.5);
          expect(ratio(token, panel), `${token} on panel`).toBeGreaterThanOrEqual(4.5);
          expect(ratio(token, panel2), `${token} on inset`).toBeGreaterThanOrEqual(3);
        }
      });

      it('buttons: the ink on the accent reads at 4.5:1', () => {
        expect(contrast(colorOf(t, '--accent-ink').rgb, colorOf(t, '--accent').rgb)).toBeGreaterThanOrEqual(4.5);
      });

      it('the focus ring shows at 3:1 on everything it can sit on', () => {
        expect(t['--focus'], 'a --focus token').toBeTruthy();
        for (const under of [bg, panel, panel2]) expect(contrast(colorOf(t, '--focus').rgb, under)).toBeGreaterThanOrEqual(3);
      });
    });
  }
});

// ---------- the rendered page ----------

/** Stands in for what the browser and the local server give the page. */
function stubEnvironment(saved: unknown) {
  class FakeEventSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    addEventListener() {}
    close() {}
  }
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
    onchange: null,
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/state')) return json(saved);
      if (url.startsWith('/api/gallery')) return json({ presets: [] });
      return json({}, 404);
    }),
  );
  // The board only draws once it has a size, and jsdom has no layout.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1600,
    bottom: 900,
    width: 1600,
    height: 900,
    toJSON: () => ({}),
  });
  Element.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.scrollTo = () => {};
  window.scrollTo = () => {};
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  window.HTMLMediaElement.prototype.pause = () => {};
  window.HTMLCanvasElement.prototype.getContext = (() => null) as never;
}

/** One of every kind in the widget library, each at its smallest size, packed first-fit (a board that isn't valid is repaired on load). */
function everythingState() {
  const state = defaultState();
  const data = state.presets.pokemon;
  data.widgets = WIDGETS.filter((def) => !isSingle(def)).map((def) => newWidget(def.kind));
  const ids = [...WIDGETS.filter(isSingle).map((def) => def.kind), ...data.widgets.map((w) => w.id)];
  const sorted = ids.sort((a, b) => sizeOf(b, data.widgets).minW * sizeOf(b, data.widgets).minH - sizeOf(a, data.widgets).minW * sizeOf(a, data.widgets).minH);
  const taken = new Set<string>();
  data.layout = sorted.map((i): GridItem => {
    const { minW: w, minH: h } = sizeOf(i, data.widgets);
    for (let y = 0; y + h <= GRID_ROWS; y++) {
      for (let x = 0; x + w <= GRID_COLS; x++) {
        let free = true;
        for (let a = x; a < x + w && free; a++) for (let b = y; b < y + h && free; b++) free = !taken.has(`${a},${b}`);
        if (!free) continue;
        for (let a = x; a < x + w; a++) for (let b = y; b < y + h; b++) taken.add(`${a},${b}`);
        return { i, x, y, w, h };
      }
    }
    throw new Error(`no room for ${i}`);
  });
  return state;
}

/** Runs axe on the page and fails on anything serious or critical. jsdom has no layout or paint, so the rules that need those are off. */
async function expectNoSeriousViolations(root: Element, label: string) {
  const result = await axe.run(root, {
    rules: {
      'color-contrast': { enabled: false },
      'color-contrast-enhanced': { enabled: false },
      region: { enabled: false },
      'scrollable-region-focusable': { enabled: false },
    },
    resultTypes: ['violations'],
  });
  const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const text = bad
    .map((v) => `${v.id} (${v.impact}): ${v.help}\n${v.nodes.slice(0, 4).map((n) => `    ${n.target.join(' ')}\n      ${n.html.slice(0, 160)}`).join('\n')}`)
    .join('\n');
  expect(text, `${label}: serious or critical accessibility problems`).toBe('');
}

describe('accessibility of the page', () => {
  beforeAll(() => {
    stubEnvironment(everythingState());
  });
  afterEach(() => {
    dismissUndo();
  });

  it('has no serious problems: the sidebar, a board with every panel and widget, a menu, the palette, the gallery, the clip player and toasts', async () => {
    const view = render(<App />);
    await screen.findByRole('complementary', {}, { timeout: 5000 }).catch(() => undefined);
    await waitFor(() => expect(document.querySelector('.board .panel')).not.toBeNull(), { timeout: 5000 });
    const root = view.container;

    // Every panel is a named section.
    const panels = root.querySelectorAll('section.panel');
    expect(panels.length).toBeGreaterThanOrEqual(WIDGETS.length);
    for (const p of panels) expect(p.getAttribute('aria-labelledby') ?? p.getAttribute('aria-label'), p.className).toBeTruthy();

    await expectNoSeriousViolations(root, 'the board and sidebar');

    // A menu.
    const options = screen.getAllByRole('button', { name: /options$/i })[0];
    options.focus();
    fireEvent.click(options);
    const menu = await screen.findByRole('menu');
    await expectNoSeriousViolations(menu, 'a menu');
    expect(menu.contains(document.activeElement), 'the first item is focused').toBe(true);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(options);

    // The command palette.
    act(() => openPalette());
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    await expectNoSeriousViolations(palette, 'the command palette');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull());

    // The gallery.
    act(() => openGallery());
    const gallery = await screen.findByRole('dialog', { name: 'Preset gallery' });
    await expectNoSeriousViolations(gallery, 'the gallery');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Preset gallery' })).toBeNull());

    // The clip player.
    act(() => watchClip('Clip one.mp4'));
    const player = await screen.findByRole('dialog', { name: /Clip/ });
    await expectNoSeriousViolations(player, 'the clip player');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Clip/ })).toBeNull());

    // Toasts.
    act(() => offerUndo('Chat hidden', () => {}));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringContaining('Chat hidden'));
    await expectNoSeriousViolations(root, 'a toast');
    act(() => showNotice('Couldn’t read that file.', true));
    const alert = await screen.findByRole('alert');
    expect(alert.getAttribute('aria-live')).toBe('assertive');
    cleanup();
  }, 60_000);

  it('menus: arrows, Home and End move between items; Esc closes and returns focus', async () => {
    const view = render(<App />);
    await waitFor(() => expect(view.container.querySelector('.board .panel')).not.toBeNull(), { timeout: 5000 });
    // The camera's has several items.
    const trigger = screen.getByRole('button', { name: 'Camera options' });
    trigger.focus();
    fireEvent.click(trigger);
    const menu = await screen.findByRole('menu');
    const items = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
    expect(items.length).toBeGreaterThan(1);
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(items[items.length - 1], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(trigger);
    cleanup();
  });

  it('dialogs: focus goes in, Tab stays inside, and focus returns to the opener on close', async () => {
    const view = render(<App />);
    await waitFor(() => expect(view.container.querySelector('.board .panel')).not.toBeNull(), { timeout: 5000 });
    const opener = screen.getAllByRole('button', { name: /options$/i })[0];
    opener.focus();
    act(() => openGallery());
    const gallery = await screen.findByRole('dialog', { name: 'Preset gallery' });
    expect(gallery.getAttribute('aria-modal')).toBe('true');
    expect(gallery.contains(document.activeElement)).toBe(true);
    const inside = focusableIn(gallery);
    inside[inside.length - 1].focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(inside[0]);
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(inside[inside.length - 1]);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Preset gallery' })).toBeNull());
    expect(document.activeElement).toBe(opener);
    cleanup();
  });

  it('the board: the arrow keys on a panel handle move it, Shift and the arrows resize it', async () => {
    // Just the notes panel, with room around it.
    const small = defaultState();
    small.presets.pokemon.widgets = [];
    small.presets.pokemon.layout = [{ i: 'notes', x: 4, y: 4, w: 6, h: 6 }];
    stubEnvironment(small);
    const view = render(<App />);
    await waitFor(() => expect(view.container.querySelector('.board .panel')).not.toBeNull(), { timeout: 5000 });
    const grip = screen.getAllByRole('button', { name: /^Move or resize Notes/ })[0];
    const cell = grip.closest('.board__cell') as HTMLElement;
    const box = () => cell.getAttribute('style') ?? '';
    const before = box();
    fireEvent.keyDown(grip, { key: 'ArrowRight' });
    await waitFor(() => expect(box()).not.toBe(before));
    const moved = box();
    fireEvent.keyDown(grip, { key: 'ArrowDown', shiftKey: true });
    await waitFor(() => expect(box()).not.toBe(moved));
    cleanup();
  });
});
