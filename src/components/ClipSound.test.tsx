// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultState } from '../state/hydrate';
import type { AppState } from '../state/model';

// The Sound row of the Clips section, against a fake window.chrome.webview (the Uncbox app).

type Listener = (e: { data: unknown }) => void;
let sent: { type: string; [key: string]: unknown }[];
let listeners: Set<Listener>;
const hear = (data: unknown) => act(() => listeners.forEach((l) => l({ data })));

async function load(app: boolean) {
  vi.resetModules();
  sent = [];
  listeners = new Set();
  Object.assign(window, {
    chrome: app
      ? {
          webview: {
            postMessage: (m: never) => void sent.push(m),
            addEventListener: (_: string, l: Listener) => void listeners.add(l),
            removeEventListener: (_: string, l: Listener) => void listeners.delete(l),
          },
        }
      : undefined,
  });
  const { ClipSound } = await import('./Clips');
  const { FixedPrivacy } = await import('../privacy');
  let state: AppState = defaultState();
  const mutate = vi.fn((recipe: (d: AppState) => void) => {
    state = structuredClone(state);
    recipe(state);
  });
  const view = (recording = true, priv = false) => (
    <FixedPrivacy on={priv}>
      <ClipSound settings={state.clips} mutate={mutate} recording={recording} />
    </FixedPrivacy>
  );
  return { view, mutate, state: () => state.clips };
}

beforeEach(() => vi.stubGlobal('EventSource', class { addEventListener() {} close() {} }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.assign(window, { chrome: undefined });
});

describe('the Sound row of the Clips section', () => {
  it('says it needs the app in a browser', async () => {
    const { view } = await load(false);
    render(view());
    expect(screen.getByText('Sound in clips needs the Uncbox app.')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('turns sound on and off, and picks a mic from what the app lists, or no mic', async () => {
    const { view, mutate, state } = await load(true);
    const { rerender } = render(view());
    // Asked for the mics because sound is on.
    expect(sent).toContainEqual({ type: 'audiodevices' });
    hear({ type: 'audiodevices', mics: [{ id: 'a', name: 'Desk mic', isDefault: true }, { id: 'b', name: 'Headset', isDefault: false }] });

    const mic = screen.getByLabelText('Mic') as HTMLSelectElement;
    expect([...mic.options].map((o) => o.textContent)).toEqual(['Windows’ default mic (Desk mic)', 'Desk mic', 'Headset', 'No mic']);
    expect(mic.value).toBe('default');

    fireEvent.change(mic, { target: { value: 'b' } });
    expect(state().mic).toBe('b');
    rerender(view());
    fireEvent.change(screen.getByLabelText('Mic'), { target: { value: '' } });
    expect(state().mic).toBeNull();
    rerender(view());
    expect((screen.getByLabelText('Mic') as HTMLSelectElement).value).toBe('');

    fireEvent.click(screen.getByRole('checkbox', { name: /Record sound/ }));
    expect(state().sound).toBe(false);
    expect(mutate).toHaveBeenCalledTimes(3);
    rerender(view());
    expect(screen.queryByLabelText('Mic')).toBeNull();
  });

  it('says what is being recorded, and that it waits for the game when nothing is captured', async () => {
    const { view } = await load(true);
    const { rerender } = render(view(false));
    expect(screen.getByText('Sound starts when your game is showing.')).toBeTruthy();

    // The sound is started by replay.ts; here the app's answer arrives directly.
    const audio = await import('../clips/audio');
    act(() => audio.startClipSound('window:1:0', 'default'));
    hear({ type: 'clipaudio', state: 'on', game: 'app', gameName: 'World of Warcraft', discord: true, mic: true });
    rerender(view(true));
    expect(screen.getByText('Game: World of Warcraft · Discord: on · Mic: on')).toBeTruthy();

    hear({ type: 'clipaudio', state: 'on', game: 'desktop', gameName: '', discord: false, mic: false });
    expect(screen.getByText(/Game: all desktop sound \(couldn’t find the game’s app\) · Discord: not running/)).toBeTruthy();

    hear({ type: 'clipaudio', state: 'error', error: 'Couldn’t record the game’s sound.' });
    expect(screen.getByText('Couldn’t record the game’s sound.')).toBeTruthy();
  });

  it('keeps the game’s window title and the mic’s name off the screen on air', async () => {
    const { view } = await load(true);
    const { rerender } = render(view(true, true));
    hear({ type: 'audiodevices', mics: [{ id: 'a', name: 'SENTINEL_MIC', isDefault: true }] });
    const audio = await import('../clips/audio');
    act(() => audio.startClipSound('window:1:0', 'default'));
    hear({ type: 'clipaudio', state: 'on', game: 'app', gameName: 'SENTINEL_TITLE - Mozilla Firefox', discord: true, mic: true });
    rerender(view(true, true));
    expect(document.body.textContent).not.toContain('SENTINEL');
    expect(screen.getByText('Game: the game · Discord: on · Mic: on')).toBeTruthy();
  });

  it('draws a meter for the game, Discord and the mic from the levels', async () => {
    const { view } = await load(true);
    const { container } = render(view());
    const audio = await import('../clips/audio');
    act(() => audio.startClipSound('window:1:0', 'default'));
    hear({ type: 'clipaudio', state: 'on', game: 'app', gameName: 'Game', discord: true, mic: true });
    hear({ type: 'cliplevels', game: 0.25, discord: 0, mic: 1 });
    const rows = [...container.querySelectorAll<HTMLElement>('.clips__level')];
    expect(rows.map((r) => r.textContent)).toEqual(['Game', 'Discord', 'Mic']);
    expect(rows.map((r) => r.style.getPropertyValue('--v'))).toEqual(['50%', '0%', '100%']);
  });

  it('has no accessibility problems', async () => {
    const { view } = await load(true);
    const { container } = render(view());
    hear({ type: 'audiodevices', mics: [{ id: 'a', name: 'Desk mic', isDefault: true }] });
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
