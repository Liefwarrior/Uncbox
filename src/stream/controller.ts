import type { StreamSettings } from '../state/model';
import type { ShellMessage } from '../native';
import type { StartBody } from './api';
import { retryDelayMs, triesAfterDrop } from './retry';
import type { StreamStatus } from './status';

// Going live, testing and ending, from the page. The server only runs FFmpeg; the page is the
// one that knows about the Uncbox app's sound pipe (see the audio messages in src/native.ts), so
// it does the steps in order, ends the stream when the sound goes, and starts it again when it
// drops. Everything it needs from outside is handed in, so the tests can play both sides.

/** How long the app has to open the sound pipe before going live is given up on. */
export const READY_TIMEOUT_MS = 10_000;
/** After the app says its sound stopped, how long to see whether FFmpeg dropped too (which the retry handles) before ending. */
export const SOUND_OFF_GRACE_MS = 1_500;

export const NO_SOUND_NOTE = 'No sound: open Uncbox with the app to stream your sound.';

export type Phase =
  /** Nothing of ours is running (the server may still show a stream started before this page loaded; see onStatus). */
  | 'idle'
  /** Opening the sound and starting FFmpeg. */
  | 'preparing'
  /** The stream is going, or the server will say it dropped. */
  | 'running'
  /** Stopping it. */
  | 'ending';

export interface ControllerState {
  phase: Phase;
  test: boolean;
  /** Why the last attempt ended, in plain words; '' when there is nothing to say. */
  error: string;
  /** Something worth saying about a stream that is going ("No sound: …"). */
  note: string;
  /** Tries made in a row to get a dropped stream back; 0 when it has not dropped. */
  retries: number;
  /** Seconds until the next try, while waiting for one. */
  retryIn: number | null;
}

const START: ControllerState = { phase: 'idle', test: false, error: '', note: '', retries: 0, retryIn: null };

export interface ControllerDeps {
  /** Whether the Uncbox app is hosting the page, and so can make the sound pipe. */
  hasShell: boolean;
  send: (message: { type: string; [key: string]: unknown }) => void;
  api: { start: (body: StartBody) => Promise<string>; stop: () => Promise<unknown> };
  settings: () => StreamSettings;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  now?: () => number;
}

type Shell = Extract<ShellMessage, { type: 'streamaudio' }>;

export type StreamController = ReturnType<typeof createStreamController>;

export function createStreamController({ hasShell, send, api, settings, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t as number), now = Date.now }: ControllerDeps) {
  let state: ControllerState = START;
  const listeners = new Set<() => void>();
  /** Bumped by every end, so work that was in flight when it happened knows to stand down. */
  let epoch = 0;
  let status: StreamStatus | null = null;
  let ready: { resolve: (r: { pipe: string } | { error: string }) => void; timer: unknown } | null = null;
  let retryTimer: unknown = null;
  let soundTimer: unknown = null;
  let tries = 0;

  const set = (patch: Partial<ControllerState>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };

  const audioOff = () => {
    if (hasShell) send({ type: 'streamaudio', on: false });
  };

  function cancelTimers() {
    clearTimer(retryTimer);
    clearTimer(soundTimer);
    retryTimer = soundTimer = null;
    if (ready) {
      clearTimer(ready.timer);
      ready.resolve({ error: '' });
      ready = null;
    }
  }

  /** The sound pipe: asks the app for one and waits for it to be ready. */
  function openSound(s: StreamSettings): Promise<{ pipe: string } | { error: string }> {
    return new Promise((resolve) => {
      send({ type: 'streamaudio', on: true, desktop: s.desktop, mic: s.mic, desktopVolume: s.desktopVolume, micVolume: s.micVolume });
      const timer = setTimer(() => {
        ready = null;
        resolve({ error: 'The Uncbox app didn’t get your sound ready in time. Try again.' });
      }, READY_TIMEOUT_MS);
      ready = { resolve, timer };
    });
  }

  /** One attempt: sound first (with the app), then FFmpeg. Resolves to '' or why it didn't work. */
  async function begin(test: boolean, mine: number): Promise<string> {
    const s = settings();
    let audioPipe: string | undefined;
    if (hasShell) {
      const opened = await openSound(s);
      if (mine !== epoch) return '';
      if ('error' in opened) {
        audioOff();
        return opened.error;
      }
      audioPipe = opened.pipe;
    }
    const problem = await api.start({ audioPipe, test, settings: { screen: s.screen, fps: s.fps, height: s.height, kbps: s.kbps } });
    if (mine !== epoch) {
      // Ended while it started: don't leave it going.
      if (!problem) void api.stop();
      return '';
    }
    if (problem) audioOff();
    return problem;
  }

  async function start(test: boolean) {
    if (state.phase !== 'idle') return;
    tries = 0;
    const mine = epoch;
    set({ phase: 'preparing', test, error: '', note: '', retries: 0, retryIn: null });
    const problem = await begin(test, mine);
    if (mine !== epoch) return;
    if (problem) return set({ phase: 'idle', error: problem });
    set({ phase: 'running', note: hasShell ? '' : NO_SOUND_NOTE });
  }

  /** Stops everything: the stream, the sound, the timers. `why` is what to tell the person, if anything. */
  async function finish(why: string) {
    epoch++;
    cancelTimers();
    set({ phase: 'ending', retryIn: null });
    await api.stop().catch(() => {});
    audioOff();
    tries = 0;
    set({ ...START, error: why });
  }

  /** Ends the stream, whatever its state. */
  const end = () => finish('');

  /** The stream can't go on (the app's sound failed, FFmpeg couldn't run): stop it and say why. */
  const fail = (why: string) => finish(why);

  function scheduleRetry(lastError: string) {
    const delay = retryDelayMs(tries);
    if (delay === null) {
      void fail(`The stream dropped and Uncbox couldn’t get it back after ${tries} tries.${lastError ? ` ${lastError}` : ''}`);
      return;
    }
    tries++;
    const mine = epoch;
    set({ phase: 'running', retries: tries, retryIn: Math.round(delay / 1000), error: '' });
    retryTimer = setTimer(async () => {
      retryTimer = null;
      if (mine !== epoch) return;
      set({ phase: 'preparing', retryIn: null });
      const problem = await begin(state.test, mine);
      if (mine !== epoch) return;
      if (problem) return scheduleRetry(problem);
      set({ phase: 'running', note: hasShell ? '' : NO_SOUND_NOTE });
    }, delay);
  }

  /** What the server says about the stream. */
  function onStatus(next: StreamStatus) {
    const before = status;
    status = next;
    if (state.phase === 'idle') {
      // The page was opened (or reloaded) while a stream was going: it is ours to end.
      if (next.state === 'starting' || next.state === 'live') set({ phase: 'running', test: next.test, error: '', note: '' });
      return;
    }
    if (state.phase !== 'running' || state.retryIn !== null) return;
    if (next.state === 'dropped' && before?.state !== 'dropped') {
      tries = triesAfterDrop(tries, before?.startedAt ? now() - before.startedAt : next.startedAt ? now() - next.startedAt : 0);
      scheduleRetry(next.error);
    } else if (next.state === 'error') {
      void fail(next.error || 'Couldn’t start the stream.');
    } else if (next.state === 'off') {
      // Stopped from somewhere else (another window), or it never got going.
      cancelTimers();
      audioOff();
      set({ ...START });
    }
  }

  /** What the app says about the sound. */
  function onShell(msg: ShellMessage) {
    if (msg.type !== 'streamaudio') return;
    const m = msg as Shell;
    if (m.state === 'ready') {
      if (!ready) return;
      clearTimer(ready.timer);
      const { resolve } = ready;
      ready = null;
      resolve({ pipe: m.pipe });
    } else if (m.state === 'error') {
      if (ready) {
        clearTimer(ready.timer);
        const { resolve } = ready;
        ready = null;
        resolve({ error: m.error || 'The Uncbox app couldn’t get your sound.' });
      } else if (state.phase === 'running' && state.retryIn === null) {
        void fail(m.error || 'The Uncbox app couldn’t get your sound.');
      }
    } else if (m.state === 'off') {
      // While opening a new pipe an "off" is the old one closing. While live it means the app lost the
      // sound: either FFmpeg dropped (the server says so and the retry handles it), or only the sound
      // stopped, which ends the stream, since going on without it would be silent.
      if (ready || state.phase !== 'running' || state.retryIn !== null) return;
      clearTimer(soundTimer);
      const mine = epoch;
      soundTimer = setTimer(() => {
        soundTimer = null;
        if (mine !== epoch || state.phase !== 'running' || state.retryIn !== null) return;
        if (status && (status.state === 'live' || status.state === 'starting')) void fail('The sound stopped, so Uncbox ended the stream.');
      }, SOUND_OFF_GRACE_MS);
    }
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    start,
    end,
    onStatus,
    onShell,
  };
}
