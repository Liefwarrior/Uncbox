import { useEffect, useSyncExternalStore } from 'react';
import { listen, onConnection } from '../events';
import type { ClipSettings, Crop } from '../state/model';
import type { FromWorker, ToWorker } from './replay.worker';

// Page side of instant replay. The game panel hands its capture to replay.worker.ts, which keeps
// the last minute encoded; the clip key (watched by server/hotkey.mjs, so it works while the game
// has focus) arrives as a "clip" event on /api/events and saves it. Everything the sidebar and
// toast show lives in one small store here.

export const CLIP_SECONDS = 60;

export interface ClipFile {
  name: string;
  size: number;
  at: number;
  /** A video the Video downloader saved ("Downloads/<title>.mp4"), not a clip. */
  download?: boolean;
}

/** What to call a clip in the player and lists: a download by its title, a clip by its file name. */
export const clipLabel = (name: string) => name.replace(/^Downloads\//, '').replace(/\.mp4$/, '');

/** Made with Make vertical (a download called "... vertical" is not). */
export const isVerticalClip = (name: string) => /^Uncbox .* vertical(?: \d+)?\.mp4$/.test(name);

/** The server's clip key watcher: 'unsupported' means only presses inside this window count. */
export type HotkeyStatus = 'on' | 'starting' | 'off' | 'unsupported';

export interface ClipsSnapshot {
  /** The game is being captured and kept. */
  recording: boolean;
  /** How much is kept so far, up to a minute. */
  seconds: number;
  error: string;
  saving: boolean;
  /** The last clip saved from this window, for the toast. */
  saved: { name: string; at: number } | null;
  saveError: string;
  hotkey: HotkeyStatus;
  dir: string;
  clips: ClipFile[];
  /** The clip open in the player, if any. */
  playing: string | null;
  /** The player opens straight into Make vertical. */
  playingEdit: boolean;
}

let snap: ClipsSnapshot = {
  recording: false,
  seconds: 0,
  error: '',
  saving: false,
  saved: null,
  saveError: '',
  hotkey: 'starting',
  dir: '',
  clips: [],
  playing: null,
  playingEdit: false,
};
const listeners = new Set<() => void>();
function set(patch: Partial<ClipsSnapshot>) {
  snap = { ...snap, ...patch };
  listeners.forEach((l) => l());
}

let worker: Worker | null = null;
let nextId = 1;
/** The game panel's latest crop, read when the worker starts. */
let cropRef: Crop = { top: 0, right: 0, bottom: 0, left: 0 };
const waiting = new Map<number, (msg: FromWorker) => void>();

function load() {
  fetch('/api/clips')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
    .then((s: Pick<ClipsSnapshot, 'dir' | 'hotkey' | 'clips'>) => set({ dir: s.dir, hotkey: s.hotkey, clips: s.clips }))
    .catch(() => {});
}

let connected = false;
function connect() {
  if (connected) return;
  connected = true;
  onConnection(load);
  load();
  // Every window hears the key; the server lets only the first to ask save, so two windows
  // capturing the game don't make two clips.
  listen('clip', (data) => {
    if (!worker) return;
    const { press } = JSON.parse(data) as { press: string };
    fetch('/api/clips/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ press }) })
      .then((r) => r.json())
      .then((r: { ok: boolean }) => r.ok && void saveClip())
      .catch(() => {});
  });
  listen('clips', (data) => set(JSON.parse(data)));
}

function supported(): boolean {
  return typeof MediaStreamTrackProcessor === 'function' && typeof VideoEncoder === 'function';
}

/** Keeps the last minute of the stream, cropped like the game panel, while enabled. */
export function useReplayBuffer(stream: MediaStream | null, crop: Crop, enabled: boolean) {
  useEffect(connect, []);
  const track = stream?.getVideoTracks()[0] ?? null;

  useEffect(() => {
    if (!enabled || !track) return;
    if (!supported()) {
      set({ error: 'Clips need Chrome or Edge.' });
      return;
    }
    // A clone, so stopping it here never stops the game panel's own video.
    const own = track.clone();
    const frames = new MediaStreamTrackProcessor({ track: own }).readable;
    const w = new Worker(new URL('./replay.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<FromWorker>) => {
      const msg = e.data;
      if (msg.type === 'status') set({ seconds: Math.min(CLIP_SECONDS, msg.seconds), error: msg.error });
      else waiting.get(msg.id)?.(msg);
    };
    w.postMessage({ type: 'start', frames, crop: cropRef } satisfies ToWorker, [frames]);
    worker = w;
    set({ recording: true, seconds: 0, error: '' });
    return () => {
      w.terminate();
      own.stop();
      if (worker === w) worker = null;
      set({ recording: false, seconds: 0 });
      // A save in progress went with the worker.
      for (const [id, done] of waiting) done({ type: 'failed', id, error: 'The game capture stopped.' });
    };
  }, [enabled, track]);

  const key = `${crop.top},${crop.right},${crop.bottom},${crop.left}`;
  cropRef = crop;
  useEffect(() => {
    worker?.postMessage({ type: 'crop', crop: cropRef } satisfies ToWorker);
  }, [key]);
}

/** Saves the last minute as a clip. Does nothing while a save is already running. */
export async function saveClip() {
  if (snap.saving) return;
  if (!worker) {
    set({ saveError: 'Show your game as a Window or Capture card to clip it.', saved: null });
    return;
  }
  const id = nextId++;
  set({ saving: true, saveError: '' });
  const result = await new Promise<FromWorker>((resolve) => {
    waiting.set(id, resolve);
    worker!.postMessage({ type: 'save', id } satisfies ToWorker);
  });
  waiting.delete(id);
  if (result.type === 'saved') set({ saving: false, saved: { name: result.name, at: Date.now() } });
  else if (result.type === 'failed') set({ saving: false, saveError: result.error, saved: null });
}

/** Opens a clip in the player (null closes it). `edit` opens it with Make vertical already showing. */
export function watchClip(name: string | null, edit = false) {
  set({ playing: name, playingEdit: edit });
}

export function clipUrl(name: string) {
  return `/api/clips/file/${encodeURIComponent(name)}`;
}

export function revealClip(name?: string) {
  void fetch('/api/clips/reveal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function useClips(): ClipsSnapshot {
  useEffect(connect, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snap,
  );
}

/**
 * The clip key inside this window. The server's watcher covers it when it runs (and would see
 * the same press), so this only steps in where that can't run.
 */
export function useClipKeyInPage(settings: ClipSettings) {
  const { hotkey } = useClips();
  const active = settings.enabled && hotkey !== 'on' && hotkey !== 'starting';
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== settings.key || e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      void saveClip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, settings.key]);
}
