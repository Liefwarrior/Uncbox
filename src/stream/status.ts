import { useSyncExternalStore } from 'react';
import { listen, onConnection } from '../events';

// Streaming from Uncbox, as the server (server/stream.mjs) reports it: one copy of its last
// status, shared by the sidebar, the privacy signal, the command palette and the controller. The
// stream key never comes here; the status only says whether one is set and its last four characters.

export type StreamState = 'off' | 'starting' | 'live' | 'stopping' | 'dropped' | 'error';

export interface StreamStats {
  fps: number;
  kbps: number;
  dropped: number;
  frames: number;
  speed: number;
}

export interface StreamTools {
  ffmpeg: boolean;
  version: string;
  /** null until the check has run (or when there is no FFmpeg to ask). */
  nvenc: boolean | null;
  ddagrab: boolean | null;
}

export interface StreamStatus {
  state: StreamState;
  /** A test stream goes to Twitch but isn't shown to anyone. */
  test: boolean;
  startedAt: number | null;
  stats: StreamStats | null;
  error: string;
  key: { set: boolean; hint: string; source: 'pasted' | 'twitch' | null };
  tools: StreamTools;
}

export const IDLE: StreamStatus = {
  state: 'off',
  test: false,
  startedAt: null,
  stats: null,
  error: '',
  key: { set: false, hint: '', source: null },
  tools: { ffmpeg: false, version: '', nvenc: null, ddagrab: null },
};

const STATES: readonly string[] = ['off', 'starting', 'live', 'stopping', 'dropped', 'error'];

/** What the server sent, if it is a status; anything else (an error body) is ignored. */
export function readStatus(raw: unknown): StreamStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<StreamStatus>;
  if (typeof s.state !== 'string' || !STATES.includes(s.state)) return null;
  return {
    state: s.state as StreamState,
    test: Boolean(s.test),
    startedAt: typeof s.startedAt === 'number' ? s.startedAt : null,
    stats: s.stats && typeof s.stats === 'object' ? s.stats : null,
    error: typeof s.error === 'string' ? s.error : '',
    key: { ...IDLE.key, ...(s.key ?? {}) },
    tools: { ...IDLE.tools, ...(s.tools ?? {}) },
  };
}

/** Whether the stream is going out, or about to be, or trying to come back. These keep personal info off the screen. */
export const isStreaming = (s: Pick<StreamStatus, 'state'> | null): boolean => Boolean(s && (s.state === 'starting' || s.state === 'live' || s.state === 'dropped'));

// ---- the shared copy ----

let current: StreamStatus = IDLE;
const subscribers = new Set<() => void>();
let stopListening: (() => void) | null = null;

function set(next: StreamStatus) {
  current = next;
  subscribers.forEach((l) => l());
}

function load() {
  try {
    fetch('/api/stream')
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        const status = readStatus(body);
        if (status) set(status);
      })
      .catch(() => {});
  } catch {
    // No network layer (a test): the status stays as it is.
  }
}

function subscribe(listener: () => void) {
  subscribers.add(listener);
  if (subscribers.size === 1) {
    load();
    // Again whenever the event stream reconnects: a push may have been missed meanwhile.
    const stopConnection = onConnection(load);
    const stop = listen('stream', (data) => {
      try {
        const status = readStatus(JSON.parse(data));
        if (status) set(status);
      } catch {
        // A garbled push: the next one replaces it.
      }
    });
    stopListening = () => {
      stop();
      stopConnection();
    };
  }
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) {
      stopListening?.();
      stopListening = null;
    }
  };
}

const quiet = () => () => {};

/** The latest stream status. Needs no polling: the server pushes every change. `on` false listens to nothing (for tests). */
export function useStream(on = true): StreamStatus {
  return useSyncExternalStore(on ? subscribe : quiet, () => current, () => IDLE);
}

// Whether the server has answered a check of FFmpeg and NVENC yet: before that, "not installed"
// would only be a guess.
let toolsChecked = false;

export function markToolsChecked() {
  if (toolsChecked) return;
  toolsChecked = true;
  subscribers.forEach((l) => l());
}

/** True once the server has said what this PC can stream with. */
export function useToolsChecked(): boolean {
  return useSyncExternalStore(subscribe, () => toolsChecked, () => false);
}

/** Replaces the shared status. For the sidebar after a request it made, and for tests. */
export function setStreamStatus(status: StreamStatus) {
  set(status);
}

/** Starts again from "off". For tests. */
export function resetStreamStatusForTests() {
  current = IDLE;
  toolsChecked = false;
}

/** Re-reads the status now (after a request that may have changed it). */
export function refreshStream() {
  load();
}
