import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeSound } from './audio';
import type { SoundStatus } from './audio';

const on = (over: Partial<SoundStatus> = {}): SoundStatus => ({
  state: 'on',
  game: 'app',
  gameName: 'World of Warcraft',
  discord: true,
  mic: true,
  micError: '',
  error: '',
  ...over,
});

describe('describeSound', () => {
  it('names the game, Discord and the mic', () => {
    expect(describeSound(on(), true)).toBe('Game: World of Warcraft · Discord: on · Mic: on');
  });

  it('says when the game’s app wasn’t found, and what is recorded instead', () => {
    expect(describeSound(on({ game: 'desktop', gameName: '' }), true)).toBe(
      'Game: all desktop sound except Discord (couldn’t find the game’s app) · Discord: on · Mic: on',
    );
    expect(describeSound(on({ game: 'desktop', gameName: '', discord: false }), true)).toContain('Game: all desktop sound (couldn’t');
  });

  it('says when Discord isn’t running and when there is no mic or it doesn’t work', () => {
    expect(describeSound(on({ discord: false }), true)).toContain('Discord: not running');
    expect(describeSound(on({ mic: false }), false)).toContain('Mic: off');
    expect(describeSound(on({ mic: false }), true)).toContain('Mic: not connected');
    expect(describeSound(on({ mic: false, micError: 'That mic isn’t connected.' }), true)).toContain('Mic: That mic isn’t connected.');
  });
});

// The store that follows the app's messages, against a fake window.chrome.webview.
describe('the sound state', () => {
  type Listener = (e: { data: unknown }) => void;
  let sent: { type: string; [key: string]: unknown }[];
  let listeners: Set<Listener>;
  const hear = (data: unknown) => listeners.forEach((l) => l({ data }));

  async function load() {
    vi.resetModules();
    sent = [];
    listeners = new Set();
    const webview = {
      postMessage: (m: never) => void sent.push(m),
      addEventListener: (_: string, l: Listener) => void listeners.add(l),
      removeEventListener: (_: string, l: Listener) => void listeners.delete(l),
    };
    vi.stubGlobal('window', { chrome: { webview } });
    return import('./audio');
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts with the game’s label and the mic, and shows what the app found', async () => {
    const audio = await load();
    audio.startClipSound('window:123:0', 'default');
    expect(sent).toEqual([{ type: 'clipaudio', on: true, title: 'window:123:0', mic: 'default' }]);
    expect(audio.soundPlan()).toEqual({ ask: true });
    hear({ type: 'clipaudio', state: 'on', game: 'app', gameName: 'Notepad', discord: false, mic: true });
    hear({ type: 'cliplevels', game: 0.5, discord: 0, mic: 0.25 });
    // The store is read through hooks; the plan and the sent messages are what saving relies on.
    expect(audio.soundPlan()).toEqual({ ask: true });
  });

  it('stops after a beat, so a changed mic restarts instead of flickering off', async () => {
    const audio = await load();
    audio.startClipSound('window:1:0', 'default');
    audio.stopClipSound();
    audio.startClipSound('window:1:0', null);
    vi.advanceTimersByTime(10);
    expect(sent.map((m) => m.on)).toEqual([true, true]);
    expect(sent[1].mic).toBeNull();

    audio.stopClipSound();
    vi.advanceTimersByTime(10);
    expect(sent[2]).toEqual({ type: 'clipaudio', on: false });
    expect(audio.soundPlan()).toEqual({ ask: false, reason: '' });
  });

  it('saves video only, and says why, after the app reported an error', async () => {
    const audio = await load();
    audio.startClipSound('window:1:0', 'default');
    hear({ type: 'clipaudio', state: 'error', error: 'Couldn’t record the game’s sound.' });
    expect(audio.soundPlan()).toEqual({ ask: false, reason: 'Couldn’t record the game’s sound.' });
    // Starting again clears it.
    audio.startClipSound('window:1:0', 'default');
    expect(audio.soundPlan()).toEqual({ ask: true });
  });

  it('does nothing without the app', async () => {
    vi.resetModules();
    vi.stubGlobal('window', {});
    const audio = await import('./audio');
    audio.startClipSound('x', null);
    audio.stopClipSound();
    expect(audio.soundPlan()).toEqual({ ask: false, reason: '' });
  });
});
