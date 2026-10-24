// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultState } from '../state/hydrate';
import { type PresetData, type PresetId } from '../state/model';
import { activePreset } from '../state/presets';
import type { MutatePreset } from '../state/useAppState';
import { dismissUndo } from '../undo';
import { UndoToast } from './UndoToast';
import { OnScreen, WidgetLibrary } from './WidgetLibrary';

// The sidebar's "On screen" and "Get More Widgets", against a preset kept in a variable.

function setup(preset: PresetId = 'smite2') {
  const state = defaultState();
  state.preset = preset;
  const mutatePreset: MutatePreset = (recipe) => {
    act(() => recipe(state.presets[preset]));
    view.rerender(ui());
  };
  const ui = () => (
    <>
      <OnScreen active={activePreset(state)} mutatePreset={mutatePreset} />
      <WidgetLibrary active={activePreset(state)} mutatePreset={mutatePreset} />
      <UndoToast />
    </>
  );
  const view = render(ui());
  return { state, data: () => state.presets[preset] as PresetData };
}

beforeEach(() => {
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number) as typeof window.requestAnimationFrame;
});
afterEach(() => {
  cleanup();
  dismissUndo();
});

describe('On screen', () => {
  it('lists what is on this preset’s board, in the preset’s own words', () => {
    const { data } = setup('smite2');
    const list = screen.getAllByRole('list')[0];
    expect(within(list).getAllByRole('listitem')).toHaveLength(data().layout.length);
    // SMITE 2 calls the slots panel "Build".
    expect(within(list).getByText('Build')).toBeTruthy();
  });

  it('takes a panel off the board, and Undo puts it back', () => {
    const { data } = setup('smite2');
    const before = data().layout.length;
    fireEvent.click(screen.getByRole('button', { name: 'Remove Teams' }));
    expect(data().layout.some((i) => i.i === 'teams')).toBe(false);
    expect(data().layout).toHaveLength(before - 1);
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    expect(data().layout.some((i) => i.i === 'teams')).toBe(true);
  });

  it('deletes a widget with its panel, and Undo brings both back', () => {
    const { data } = setup('steam');
    expect(data().widgets.map((w) => w.kind)).toContain('clock');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Clock' }));
    expect(data().widgets.map((w) => w.kind)).not.toContain('clock');
    expect(data().layout.some((i) => i.i === 'wdg-steamclock')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    expect(data().widgets.map((w) => w.kind)).toContain('clock');
    expect(data().layout.some((i) => i.i === 'wdg-steamclock')).toBe(true);
  });
});

describe('Get More Widgets', () => {
  it('lists what the preset recommends first', () => {
    setup('smite2');
    const headings = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent);
    expect(headings[0]).toBe('Recommended for SMITE 2');
    expect(screen.getByRole('button', { name: 'Add Ping & FPS' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add OBS' })).toBeTruthy();
  });

  it('adds a widget as often as you like, each fitted on the board', () => {
    const { data } = setup('smite2');
    const before = data().widgets.length;
    fireEvent.click(screen.getByRole('button', { name: 'Add Clock' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Clock' }));
    expect(data().widgets.filter((w) => w.kind === 'clock')).toHaveLength(2);
    expect(data().widgets).toHaveLength(before + 2);
    for (const w of data().widgets) expect(data().layout.some((i) => i.i === w.id)).toBe(true);
    expect(screen.getByText('2 on screen')).toBeTruthy();
    // Every panel still inside the board and clear of the others.
    const items = data().layout;
    for (const [n, a] of items.entries()) {
      expect(a.x + a.w).toBeLessThanOrEqual(24);
      expect(a.y + a.h).toBeLessThanOrEqual(24);
      for (const b of items.slice(n + 1)) {
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h, `${a.i} overlaps ${b.i}`).toBe(false);
      }
    }
  });

  it('adds an app window like any other widget', () => {
    const { data } = setup('desk');
    fireEvent.click(screen.getByRole('button', { name: 'Add App window' }));
    expect(data().widgets.filter((w) => w.kind === 'window')).toHaveLength(1);
  });

  it('shows a single panel already on the board as On screen, with Show instead of Add', () => {
    setup('smite2');
    expect(screen.queryByRole('button', { name: 'Add Teams' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show Teams' })).toBeTruthy();
    expect(screen.getAllByText('On screen').length).toBeGreaterThan(0);
  });

  it('adds a single panel that is hidden, once', () => {
    const { data } = setup('smite2');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Record' }));
    expect(data().layout.some((i) => i.i === 'record')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Add Session' }));
    expect(data().layout.filter((i) => i.i === 'record')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Add Session' })).toBeNull();
  });

  it('recommends the Auction House for WoW, where it starts on the board, so it is offered as Show', () => {
    const { data } = setup('wow');
    const headings = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent);
    expect(headings[0]).toBe('Recommended for WoW Forever');
    const made = data().widgets.filter((w) => w.kind === 'auctionhouse');
    expect(made).toHaveLength(1);
    expect(data().layout.some((i) => i.i === made[0].id)).toBe(true);
    expect(screen.queryByRole('button', { name: 'Add Auction House' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show Auction House' })).toBeTruthy();
  });

  it('searches, and says when nothing matches', () => {
    setup('desk');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search widgets' }), { target: { value: 'pomodoro' } });
    expect(screen.getByRole('button', { name: 'Add Focus timer' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add Clock' })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search widgets' }), { target: { value: 'qqqq' } });
    expect(screen.getByText('Nothing matches that.')).toBeTruthy();
  });

  it('filters by category chip, and the chip says it is pressed', () => {
    setup('desk');
    const chip = screen.getByRole('button', { name: 'WoW' });
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Add Character' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add Clock' })).toBeNull();
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Add Clock' })).toBeTruthy();
  });
});
