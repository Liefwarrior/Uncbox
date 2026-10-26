import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultState } from '../state/hydrate';
import type { StreamSettings } from '../state/model';
import type { StartBody } from './api';
import { createStreamController, NO_SOUND_NOTE, READY_TIMEOUT_MS, SOUND_OFF_GRACE_MS, type StreamController } from './controller';
import { retryDelayMs, STEADY_MS, triesAfterDrop } from './retry';
import { IDLE, type StreamStatus } from './status';

const PIPE = '\\\\.\\pipe\\uncbox-stream-audio-1a2b3c4d';

describe('the retry timing', () => {
  it('waits 2, 4, 8, 16 and 30 seconds, then gives up', () => {
    expect([0, 1, 2, 3, 4].map(retryDelayMs)).toEqual([2000, 4000, 8000, 16_000, 30_000]);
    expect(retryDelayMs(5)).toBeNull();
    expect(retryDelayMs(99)).toBeNull();
  });

  it('starts the count over only after a stream that stayed up', () => {
    expect(triesAfterDrop(3, STEADY_MS - 1)).toBe(3);
    expect(triesAfterDrop(3, STEADY_MS)).toBe(0);
    expect(triesAfterDrop(0, 0)).toBe(0);
  });
});

/** The controller with its outside world played by the test: the app's messages, the server, a clock. */
function setup({ shell = true, settings = {} as Partial<StreamSettings> } = {}) {
  const sent: { type: string; [key: string]: unknown }[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const startCalls: StartBody[] = [];
  let startProblem = '';
  let clock = 1_000_000;
  const stop = vi.fn(async () => '');
  const config = { ...defaultState().stream, with: 'uncbox' as const, ...settings };
  const c: StreamController = createStreamController({
    hasShell: shell,
    send: (m) => sent.push(m),
    api: {
      start: async (body) => {
        startCalls.push(body);
        return startProblem;
      },
      stop,
    },
    settings: () => config,
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) (t as { live: boolean }).live = false;
    },
    now: () => clock,
  });
  const flush = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  const status = (over: Partial<StreamStatus>): StreamStatus => ({ ...IDLE, ...over });
  const timer = (ms: number) => timers.find((t) => t.live && t.ms === ms);
  const audio = () => sent.filter((m) => m.type === 'streamaudio');
  /** Goes live the way a person would: the app opens the pipe when asked, and the server starts. */
  async function goLive(test = false) {
    const started = c.start(test);
    await flush();
    if (shell) c.onShell({ type: 'streamaudio', state: 'ready', pipe: PIPE, rate: 48000, channels: 2, format: 'f32le' });
    await started;
    c.onStatus(status({ state: 'live', startedAt: clock, test }));
  }
  return {
    c,
    sent,
    timers,
    startCalls,
    stop,
    flush,
    status,
    timer,
    audio,
    goLive,
    failStarts: (why: string) => (startProblem = why),
    tick: (ms: number) => (clock += ms),
  };
}

describe('going live with the app', () => {
  it('opens the sound from the settings, waits for the pipe, then starts the stream with it', async () => {
    const t = setup({ settings: { desktop: true, mic: 'mic-1', desktopVolume: 0.8, micVolume: 1.5, screen: 1, fps: 30, height: 720, kbps: 4500 } });
    const started = t.c.start(false);
    await t.flush();
    expect(t.audio()).toEqual([{ type: 'streamaudio', on: true, desktop: true, mic: 'mic-1', desktopVolume: 0.8, micVolume: 1.5 }]);
    // Nothing starts until the pipe is ready.
    expect(t.startCalls).toEqual([]);
    expect(t.c.getState().phase).toBe('preparing');
    t.c.onShell({ type: 'streamaudio', state: 'ready', pipe: PIPE, rate: 48000, channels: 2, format: 'f32le' });
    await started;
    expect(t.startCalls).toEqual([{ audioPipe: PIPE, test: false, settings: { screen: 1, fps: 30, height: 720, kbps: 4500 } }]);
    expect(t.c.getState()).toMatchObject({ phase: 'running', error: '', note: '' });
  });

  it('starts a test stream as a test', async () => {
    const t = setup();
    await t.goLive(true);
    expect(t.startCalls[0].test).toBe(true);
    expect(t.c.getState().test).toBe(true);
  });

  it('does not start without the pipe, and says so, when the app is too slow', async () => {
    const t = setup();
    const started = t.c.start(false);
    await t.flush();
    t.timer(READY_TIMEOUT_MS)!.fn();
    await started;
    expect(t.startCalls).toEqual([]);
    expect(t.c.getState()).toMatchObject({ phase: 'idle' });
    expect(t.c.getState().error).toMatch(/sound ready in time/);
    expect(t.audio().at(-1)).toEqual({ type: 'streamaudio', on: false });
  });

  it('says what went wrong when the app cannot get the sound', async () => {
    const t = setup();
    const started = t.c.start(false);
    await t.flush();
    t.c.onShell({ type: 'streamaudio', state: 'error', error: 'That mic isn’t connected.' });
    await started;
    expect(t.c.getState()).toMatchObject({ phase: 'idle', error: 'That mic isn’t connected.' });
    expect(t.startCalls).toEqual([]);
  });

  it('closes the pipe again when the server will not start', async () => {
    const t = setup();
    t.failStarts('Add your Twitch stream key first.');
    const started = t.c.start(false);
    await t.flush();
    t.c.onShell({ type: 'streamaudio', state: 'ready', pipe: PIPE, rate: 48000, channels: 2, format: 'f32le' });
    await started;
    expect(t.c.getState()).toMatchObject({ phase: 'idle', error: 'Add your Twitch stream key first.' });
    expect(t.audio().at(-1)).toEqual({ type: 'streamaudio', on: false });
  });

  it('ignores an "off" for the old pipe while the new one opens', async () => {
    const t = setup();
    const started = t.c.start(false);
    await t.flush();
    t.c.onShell({ type: 'streamaudio', state: 'off' });
    t.c.onShell({ type: 'streamaudio', state: 'ready', pipe: PIPE, rate: 48000, channels: 2, format: 'f32le' });
    await started;
    expect(t.c.getState().phase).toBe('running');
  });

  it('does not start twice', async () => {
    const t = setup();
    await t.goLive();
    await t.c.start(false);
    expect(t.startCalls).toHaveLength(1);
  });
});

describe('going live in a browser', () => {
  it('starts with no pipe, never talks to the app, and says there is no sound', async () => {
    const t = setup({ shell: false });
    await t.goLive();
    expect(t.startCalls[0].audioPipe).toBeUndefined();
    expect(t.sent).toEqual([]);
    expect(t.c.getState()).toMatchObject({ phase: 'running', note: NO_SOUND_NOTE });
    expect(NO_SOUND_NOTE).toBe('No sound: open Uncbox with the app to stream your sound.');
  });
});

describe('ending', () => {
  it('stops the stream, then closes the sound', async () => {
    const t = setup();
    await t.goLive();
    const order: string[] = [];
    t.stop.mockImplementation(async () => {
      order.push(`stop (sound off yet: ${t.audio().at(-1)?.on === false})`);
      return '';
    });
    await t.c.end();
    expect(order).toEqual(['stop (sound off yet: false)']);
    expect(t.audio().at(-1)).toEqual({ type: 'streamaudio', on: false });
    expect(t.c.getState()).toMatchObject({ phase: 'idle', error: '' });
  });

  it('can end while still opening the sound, and the stream never starts', async () => {
    const t = setup();
    const started = t.c.start(false);
    await t.flush();
    const ended = t.c.end();
    await Promise.all([started, ended]);
    expect(t.startCalls).toEqual([]);
    expect(t.c.getState().phase).toBe('idle');
  });

  it('stops a stream that was started while it was ending', async () => {
    const t = setup({ shell: false });
    let release: (v: string) => void = () => {};
    const slow = new Promise<string>((resolve) => (release = resolve));
    const c = createStreamController({
      hasShell: false,
      send: () => {},
      api: { start: () => slow, stop: t.stop },
      settings: () => defaultState().stream,
      setTimer: () => 0,
      clearTimer: () => {},
    });
    const started = c.start(false);
    await t.flush();
    const ended = c.end();
    release('');
    await Promise.all([started, ended]);
    // Once for the end itself and once for the stream that came up behind it.
    expect(t.stop).toHaveBeenCalledTimes(2);
    expect(c.getState().phase).toBe('idle');
  });
});

describe('the sound failing while live', () => {
  it('ends the stream and shows the error when the app reports one', async () => {
    const t = setup();
    await t.goLive();
    t.c.onShell({ type: 'streamaudio', state: 'error', error: 'The default speakers went away.' });
    await t.flush();
    expect(t.stop).toHaveBeenCalled();
    expect(t.c.getState()).toMatchObject({ phase: 'idle', error: 'The default speakers went away.' });
  });

  it('ends the stream when only the sound stopped', async () => {
    const t = setup();
    await t.goLive();
    t.c.onShell({ type: 'streamaudio', state: 'off' });
    t.timer(SOUND_OFF_GRACE_MS)!.fn();
    await t.flush();
    expect(t.stop).toHaveBeenCalled();
    expect(t.c.getState().error).toMatch(/sound stopped/);
  });

  it('leaves it to the retry when FFmpeg dropped as well (the pipe closing is why the sound stopped)', async () => {
    const t = setup();
    await t.goLive();
    t.c.onShell({ type: 'streamaudio', state: 'off' });
    t.c.onStatus(t.status({ state: 'dropped', error: 'Connection reset by peer', startedAt: 1 }));
    t.timer(SOUND_OFF_GRACE_MS)?.fn();
    await t.flush();
    expect(t.stop).not.toHaveBeenCalled();
    expect(t.c.getState().retryIn).toBe(2);
  });

  it('ignores the app’s messages when nothing is streaming', () => {
    const t = setup();
    t.c.onShell({ type: 'streamaudio', state: 'error', error: 'x' });
    t.c.onShell({ type: 'streamaudio', state: 'off' });
    expect(t.stop).not.toHaveBeenCalled();
    expect(t.c.getState().phase).toBe('idle');
  });
});

describe('a dropped stream', () => {
  const drop = (t: ReturnType<typeof setup>, over: Partial<StreamStatus> = {}) => t.c.onStatus(t.status({ state: 'dropped', error: 'Connection reset by peer', startedAt: null, ...over }));

  /** The wait runs out, the app opens a new pipe, and the server starts again. */
  async function retry(t: ReturnType<typeof setup>, ms: number, ok = true) {
    t.timer(ms)!.fn();
    await t.flush();
    if (t.sent.at(-1)?.on === true) t.c.onShell({ type: 'streamaudio', state: 'ready', pipe: PIPE, rate: 48000, channels: 2, format: 'f32le' });
    await t.flush();
    if (ok) t.c.onStatus(t.status({ state: 'starting' }));
  }

  it('starts again after two seconds with a new pipe and a new start', async () => {
    const t = setup();
    await t.goLive();
    drop(t);
    expect(t.c.getState()).toMatchObject({ phase: 'running', retries: 1, retryIn: 2 });
    expect(t.timer(2000)).toBeTruthy();
    const starts = t.startCalls.length;
    await retry(t, 2000);
    expect(t.startCalls).toHaveLength(starts + 1);
    expect(t.audio().filter((m) => m.on === true)).toHaveLength(2);
    expect(t.c.getState()).toMatchObject({ phase: 'running', retryIn: null, retries: 1 });
  });

  it('keeps the test flag when it starts again', async () => {
    const t = setup();
    await t.goLive(true);
    drop(t);
    await retry(t, 2000);
    expect(t.startCalls.at(-1)!.test).toBe(true);
  });

  it('waits longer each time and gives up after five tries in a row', async () => {
    const t = setup();
    await t.goLive();
    for (const [i, ms] of [2000, 4000, 8000, 16_000, 30_000].entries()) {
      drop(t);
      expect(t.c.getState()).toMatchObject({ retryIn: ms / 1000, retries: i + 1 });
      await retry(t, ms);
    }
    drop(t);
    await t.flush();
    expect(t.c.getState().phase).toBe('idle');
    expect(t.c.getState().error).toMatch(/couldn’t get it back after 5 tries/);
    expect(t.c.getState().error).toContain('Connection reset by peer');
    expect(t.stop).toHaveBeenCalled();
    expect(t.audio().at(-1)).toEqual({ type: 'streamaudio', on: false });
  });

  it('counts a try that could not even start, and goes on to the next', async () => {
    const t = setup();
    await t.goLive();
    drop(t);
    t.failStarts('Couldn’t reach Uncbox.');
    await retry(t, 2000, false);
    expect(t.c.getState()).toMatchObject({ phase: 'running', retries: 2, retryIn: 4 });
    expect(t.timer(4000)).toBeTruthy();
  });

  it('starts the count over after a stream that stayed up', async () => {
    const t = setup();
    await t.goLive();
    drop(t);
    await retry(t, 2000);
    t.c.onStatus(t.status({ state: 'live', startedAt: 5_000_000 }));
    t.tick(5_000_000 - 1_000_000 + STEADY_MS + 1);
    drop(t, { startedAt: 5_000_000 });
    expect(t.c.getState()).toMatchObject({ retries: 1, retryIn: 2 });
  });

  it('does not count the same drop twice', async () => {
    const t = setup();
    await t.goLive();
    drop(t);
    drop(t);
    expect(t.c.getState().retries).toBe(1);
  });

  it('is ended for good by End stream, even while waiting for a try', async () => {
    const t = setup();
    await t.goLive();
    drop(t);
    const waiting = t.timer(2000)!;
    await t.c.end();
    expect(waiting.live).toBe(false);
    expect(t.c.getState()).toMatchObject({ phase: 'idle', retryIn: null });
    const starts = t.startCalls.length;
    waiting.fn();
    await t.flush();
    expect(t.startCalls).toHaveLength(starts);
  });
});

describe('what the server says', () => {
  it('shows an error the server gives', async () => {
    const t = setup();
    await t.goLive();
    t.c.onStatus(t.status({ state: 'error', error: 'Couldn’t start FFmpeg.' }));
    await t.flush();
    expect(t.c.getState()).toMatchObject({ phase: 'idle', error: 'Couldn’t start FFmpeg.' });
  });

  it('goes quiet when the stream was ended somewhere else', async () => {
    const t = setup();
    await t.goLive();
    t.c.onStatus(t.status({ state: 'off' }));
    expect(t.c.getState().phase).toBe('idle');
    expect(t.audio().at(-1)).toEqual({ type: 'streamaudio', on: false });
  });

  it('takes over a stream that was started before the page loaded, so End stream works', () => {
    const t = setup();
    t.c.onStatus(t.status({ state: 'live', test: true, startedAt: 1 }));
    expect(t.c.getState()).toMatchObject({ phase: 'running', test: true });
  });

  it('does not take over one that is stopping or has dropped', () => {
    const t = setup();
    t.c.onStatus(t.status({ state: 'stopping' }));
    t.c.onStatus(t.status({ state: 'dropped' }));
    expect(t.c.getState().phase).toBe('idle');
  });

  it('tells the page of every change', async () => {
    const t = setup({ shell: false });
    const seen = vi.fn();
    t.c.subscribe(seen);
    await t.goLive();
    expect(seen).toHaveBeenCalled();
  });
});

beforeEach(() => vi.clearAllMocks());
