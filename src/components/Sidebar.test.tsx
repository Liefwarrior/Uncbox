// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAutomationEditor } from '../automations/editor';
import { defaultState } from '../state/hydrate';
import { type AppState, type PresetId } from '../state/model';
import { addCustom } from '../state/presets';
import type { Mutate, MutatePreset } from '../state/useAppState';
import { dismissUndo } from '../undo';
import { Section } from './Section';
import { Sidebar } from './Sidebar';

// The sidebar, drawn for real against a state kept in a variable and a server that has nothing.

function stubEnvironment() {
  class FakeEventSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    addEventListener() {}
    close() {}
  }
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({}), { status: 404, headers: { 'Content-Type': 'application/json' } })),
  );
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number) as typeof window.requestAnimationFrame;
  Element.prototype.scrollIntoView = () => {};
}

function setup(preset: PresetId | 'custom' = 'smite2', tweak?: (state: AppState) => void) {
  const state = defaultState();
  if (preset !== 'custom') state.preset = preset;
  tweak?.(state);
  const onStreamMode = vi.fn();
  const mutate: Mutate = (recipe) => {
    act(() => recipe(state));
    view.rerender(ui());
  };
  const mutatePreset: MutatePreset = (recipe) => mutate((s) => recipe(s.presets[state.preset in s.presets ? (s.preset as PresetId) : 'smite2']));
  const ui = () => (
    <div className={`app theme-${state.preset}`}>
      <Sidebar state={state} mutate={mutate} mutatePreset={mutatePreset} status="synced" onStreamMode={onStreamMode} />
    </div>
  );
  const view = render(ui());
  return { state, onStreamMode, view };
}

beforeEach(() => {
  window.localStorage.clear();
  stubEnvironment();
});
afterEach(() => {
  cleanup();
  dismissUndo();
  vi.unstubAllGlobals();
});

describe('the game picker', () => {
  it('shows the preset you are on and its blurb, and lists them all when opened', () => {
    setup('smite2');
    const trigger = screen.getByRole('button', { name: 'Game: SMITE 2' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const list = screen.getByRole('group', { name: 'Game' });
    for (const name of ['Pokémon', 'SMITE 2', 'WoW Forever', 'Minecraft Dungeons II', 'Steam Big Picture', 'Terminal', 'Desk']) {
      expect(within(list).getByText(name), name).toBeTruthy();
    }
    expect(within(list).getByRole('button', { name: /SMITE 2/ }).getAttribute('aria-current')).toBe('true');
    expect(within(list).getByRole('button', { name: /Import a preset/ })).toBeTruthy();
    expect(within(list).getByRole('button', { name: /Browse presets/ })).toBeTruthy();
  });

  it('switches the preset, shuts, and gives focus back to the button', async () => {
    const { state } = setup('smite2');
    const trigger = screen.getByRole('button', { name: 'Game: SMITE 2' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole('group', { name: 'Game' })).getByRole('button', { name: /Steam/ }));
    expect(state.preset).toBe('steam');
    expect(screen.queryByRole('group', { name: 'Game' })).toBeNull();
    const now = screen.getByRole('button', { name: /^Game: Steam/ });
    expect(now).toBeTruthy();
    expect(document.activeElement).toBe(now);
  });

  it('lists presets of your own, and shows one when it is the one on the board', () => {
    const { state } = setup('smite2', (s) => addCustom(s, 'custom-a', 'Ranked night', 'smite2', structuredClone(s.presets.smite2)));
    expect(state.preset).toBe('custom-a');
    const trigger = screen.getByRole('button', { name: 'Game: Ranked night' });
    expect(trigger.textContent).toContain('Based on SMITE 2');
    fireEvent.click(trigger);
    const list = screen.getByRole('group', { name: 'Game' });
    expect(within(list).getByRole('button', { name: /^Ranked night/ }).getAttribute('aria-current')).toBe('true');
    expect(within(list).getByRole('button', { name: 'Options for Ranked night' })).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: /^Pokémon/ }));
    expect(state.preset).toBe('pokemon');
  });

  it('arrows move between presets, Enter picks, Esc shuts', () => {
    const { state } = setup('smite2');
    const trigger = screen.getByRole('button', { name: 'Game: SMITE 2' });
    trigger.focus();
    fireEvent.click(trigger);
    const list = screen.getByRole('group', { name: 'Game' });
    const rows = [...list.querySelectorAll<HTMLElement>('[data-nav]')];
    // Focus starts on the one that is picked.
    expect(document.activeElement).toBe(rows.find((r) => r.getAttribute('aria-current') === 'true'));
    const at = rows.indexOf(document.activeElement as HTMLElement);
    fireEvent.keyDown(rows[at], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[at + 1]);
    fireEvent.keyDown(rows[at + 1], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(rows[at]);
    fireEvent.keyDown(rows[at], { key: 'Home' });
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(rows[0], { key: 'End' });
    expect(document.activeElement).toBe(rows[rows.length - 1]);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Game' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    // A native button's Enter is a click.
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('group', { name: 'Game' }).querySelector<HTMLElement>('[data-nav]')!);
    expect(state.preset).toBe('pokemon');
  });

  it('shuts on a click outside', () => {
    setup('smite2');
    fireEvent.click(screen.getByRole('button', { name: 'Game: SMITE 2' }));
    expect(screen.getByRole('group', { name: 'Game' })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('group', { name: 'Game' })).toBeNull();
  });
});

describe('the sidebar, in order', () => {
  it('is brand, game, Stream mode, then On screen and the button for more widgets, with the settings folded away', () => {
    const { onStreamMode } = setup('smite2');
    const side = screen.getByRole('complementary');
    const order = [...side.querySelectorAll('button, h3')].map((el) => el.getAttribute('aria-label') ?? el.textContent ?? '');
    const at = (text: string) => order.findIndex((t) => t.includes(text));
    expect(at('Game: SMITE 2')).toBeGreaterThanOrEqual(0);
    expect(at('Stream mode')).toBeGreaterThan(at('Game: SMITE 2'));
    expect(at('On screen')).toBeGreaterThan(at('Stream mode'));
    expect(at('Get More Widgets')).toBeGreaterThan(at('On screen'));
    expect(at('Clips')).toBeGreaterThan(at('Get More Widgets'));
    expect(at('Layout')).toBeGreaterThan(at('Clips'));
    // The widget library is not inline any more.
    expect(screen.queryByRole('searchbox', { name: 'Search widgets' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Stream mode/ }));
    expect(onStreamMode).toHaveBeenCalled();
  });

  it('opens the widget library in a dialog from the button, and Esc closes it and returns focus', async () => {
    setup('smite2');
    const button = screen.getByRole('button', { name: /Get More Widgets/ });
    button.focus();
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Get More Widgets' });
    expect(within(dialog).getByRole('combobox', { name: 'Category' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Show Build' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(button);
  });

  it('shuts the library when the page goes into stream mode', async () => {
    const { view } = setup('smite2');
    fireEvent.click(screen.getByRole('button', { name: /Get More Widgets/ }));
    await screen.findByRole('dialog');
    const app = view.container.querySelector('.app') as HTMLElement;
    act(() => app.classList.add('is-stream'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('has no serious accessibility problems, closed and with the game list open', async () => {
    const { view } = setup('smite2');
    const run = async (root: Element) => {
      const result = await axe.run(root, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } }, resultTypes: ['violations'] });
      const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(bad.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
    };
    await run(view.container);
    fireEvent.click(screen.getByRole('button', { name: 'Game: SMITE 2' }));
    await run(screen.getByRole('group', { name: 'Game' }));
  });
});

describe('folding sections', () => {
  it('start shut, open on click, and remember it', () => {
    setup('smite2');
    const clips = screen.getByRole('button', { name: /^Clips/ });
    expect(clips.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(clips);
    expect(clips.getAttribute('aria-expanded')).toBe('true');
    expect(window.localStorage.getItem('uncbox.sidebar.clips')).toBe('1');
    cleanup();
    // A new visit: it comes back open, the others still shut.
    setup('smite2');
    expect(screen.getByRole('button', { name: /^Clips/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /^Automations/ }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: /^Clips/ }));
    expect(window.localStorage.getItem('uncbox.sidebar.clips')).toBe('0');
  });

  it('keeps layout actions and the background list in one section', () => {
    setup('smite2');
    const layout = screen.getByRole('button', { name: /^Layout/ });
    fireEvent.click(layout);
    const body = document.getElementById(layout.getAttribute('aria-controls') as string) as HTMLElement;
    expect(within(body).getByRole('button', { name: /Reset layout/ })).toBeTruthy();
    expect(within(body).getByRole('button', { name: /Save as a new preset/ })).toBeTruthy();
    expect(within(body).getByRole('button', { name: /Export this preset/ })).toBeTruthy();
    const background = within(body).getByRole('combobox', { name: 'Background' }) as HTMLSelectElement;
    expect(background.value).toBe('plain');
    expect(within(background).getAllByRole('option')).toHaveLength(9);
  });

  it('shows the WoW section only on WoW', () => {
    setup('smite2');
    expect(screen.queryByRole('button', { name: /^WoW addon/ })).toBeNull();
    cleanup();
    setup('wow');
    expect(screen.getByRole('button', { name: /^WoW addon/ })).toBeTruthy();
  });

  it('opens Automations when the command palette asks for the editor', () => {
    setup('smite2');
    const button = screen.getByRole('button', { name: /^Automations/ });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    act(() => openAutomationEditor());
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('works without storage', () => {
    const real = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = () => {
      throw new Error('blocked');
    };
    Storage.prototype.setItem = () => {
      throw new Error('blocked');
    };
    try {
      render(
        <Section id="x" title="Thing">
          <p>inside</p>
        </Section>,
      );
      const button = screen.getByRole('button', { name: 'Thing' });
      expect(button.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(button);
      expect(button.getAttribute('aria-expanded')).toBe('true');
    } finally {
      Storage.prototype.getItem = real;
      Storage.prototype.setItem = set;
    }
  });

  it('honors defaultOpen until you choose', () => {
    render(
      <Section id="y" title="Thing" defaultOpen>
        <p>inside</p>
      </Section>,
    );
    const button = screen.getByRole('button', { name: 'Thing' });
    expect(button.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the setup list', () => {
  it('is one line, "Get set up" with how far along you are, and opens to the steps', () => {
    setup('smite2');
    const line = screen.getByRole('button', { name: /^Get set up/ });
    expect(line.textContent).toMatch(/0 of \d/);
    // Nothing done yet: open.
    expect(line.getAttribute('aria-expanded')).toBe('true');
    const body = document.getElementById(line.getAttribute('aria-controls') as string) as HTMLElement;
    expect(within(body).getByRole('button', { name: /Show your game/ })).toBeTruthy();
  });

  it('folds once the first step is done', () => {
    setup('smite2', (s) => {
      s.camera.enabled = true;
    });
    const line = screen.getByRole('button', { name: /^Get set up/ });
    expect(line.textContent).toMatch(/1 of \d/);
    expect(line.getAttribute('aria-expanded')).toBe('false');
  });

  it('goes away when everything is done', () => {
    setup('smite2', (s) => {
      s.camera.enabled = true;
      s.twitch.channel = 'liefwarrior';
      s.presets.smite2.game.source = 'window';
      // Discord needs the server; take its panel off the board instead, which drops its step.
      s.presets.smite2.layout = s.presets.smite2.layout.filter((i) => i.i !== 'discord');
    });
    expect(screen.queryByRole('button', { name: /^Get set up/ })).toBeNull();
  });
});
