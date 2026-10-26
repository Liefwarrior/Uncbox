import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Crop } from './state/model';

// The page's side of the native shell (native/UncboxShell). Inside it the page can put a game's
// real window in the game panel ("Play here") instead of a capture of it. See ShellForm.cs for
// the messages. In a browser none of this exists and the game panel works as before.

/** A shared buffer the app handed over (WebView2's sharedbufferreceived event). */
interface SharedBufferEvent {
  additionalData?: unknown;
  getBuffer(): ArrayBuffer;
}

interface WebViewBridge {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
  addEventListener(type: 'sharedbufferreceived', listener: (e: SharedBufferEvent) => void): void;
  removeEventListener(type: 'sharedbufferreceived', listener: (e: SharedBufferEvent) => void): void;
  /** Gives a shared buffer back to the app once it has been copied. */
  releaseBuffer(buffer: ArrayBuffer): void;
}

declare global {
  interface Window {
    chrome?: { webview?: WebViewBridge };
  }
}

/** The shell's message channel, or null in a browser. */
export const shell: WebViewBridge | null = (typeof window !== 'undefined' && window.chrome?.webview) || null;

export interface HostWindow {
  id: string;
  title: string;
  process: string;
}

export type ShellMessage =
  | { type: 'windows'; windows: HostWindow[] }
  /** followed: the app took it by itself (a game Steam started), so it isn't the saved window. */
  | { type: 'attached'; id: string; title: string; process: string; followed?: boolean }
  | { type: 'detached' }
  /** The game won't be resized, so it's shown as a live picture; launchOption makes it resizable. */
  | { type: 'picture'; on: boolean; launchOption: string }
  /** A web widget's page moved on (see useWebView). */
  | ({ type: 'webstate' } & WebState)
  /** Whether Uncbox starts with Windows (sent when asked and after every change). */
  | { type: 'autostartstate'; enabled: boolean }
  /** The microphones, when asked (`audiodevices`). */
  | { type: 'audiodevices'; mics: AudioDevice[] }
  /**
   * The sound kept for clips (see src/clips/audio.ts): what is being recorded, or that it stopped.
   * `game` is 'app' for the captured game's own sound, or 'desktop' (all sound except Discord) when
   * its window couldn't be found. An answer to `clipaudioget` also has type 'clipaudio', with an id.
   */
  | { type: 'clipaudio'; state: 'on'; game: 'app' | 'desktop'; gameName: string; discord: boolean; mic: boolean; micError?: string }
  | { type: 'clipaudio'; state: 'off' }
  | { type: 'clipaudio'; state: 'error'; error: string }
  /** Peak level 0..1 of each clip sound source, about five times a second while it is on. */
  | { type: 'cliplevels'; game: number; discord: number; mic: number };

export interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

/** A clip's stretch of sound: 48 kHz stereo, 16-bit, interleaved, `frames` long on each of the three tracks. */
export interface ClipPcm {
  frames: number;
  rate: number;
  game: Int16Array;
  discord: Int16Array;
  mic: Int16Array;
}

export function send(message: { type: string; [key: string]: unknown }) {
  shell?.postMessage(message);
}

export function useShellMessages(onMessage: (msg: ShellMessage) => void) {
  const latest = useRef(onMessage);
  useEffect(() => {
    latest.current = onMessage;
  });
  useEffect(() => {
    if (!shell) return;
    const listener = (e: { data: unknown }) => latest.current(e.data as ShellMessage);
    shell.addEventListener('message', listener);
    return () => shell.removeEventListener('message', listener);
  }, []);
}

/** An element's box in device pixels (the shell works in those; the page measures in CSS pixels). */
export function deviceBox(el: Element, dpr = window.devicePixelRatio) {
  const r = el.getBoundingClientRect();
  return { x: r.left * dpr, y: r.top * dpr, w: r.width * dpr, h: r.height * dpr };
}

/**
 * Tells the shell where the game should go: el's box in device pixels, kept up to date while
 * panels move and resize. The game window is made bigger than the box by the crop (percent per
 * edge) and stripPx (the WoW addon's strip, in game pixels), and those parts sit under the
 * dashboard, out of sight. A null element takes the game back out.
 */
export function useHole(el: HTMLElement | null, crop: Crop, stripPx: number) {
  const cropKey = `${crop.top},${crop.right},${crop.bottom},${crop.left},${stripPx}`;
  useEffect(() => {
    if (!shell) return;
    if (!el) {
      send({ type: 'rect' });
      return;
    }
    let last = '';
    let frame = 0;
    const report = () => {
      const rect = deviceBox(el);
      const key = JSON.stringify(rect);
      if (key !== last) {
        last = key;
        send({ type: 'rect', ...rect, crop, stripPx });
      }
      frame = requestAnimationFrame(report);
    };
    // Every frame, so the game follows a panel being dragged; only changes are sent.
    report();
    return () => {
      cancelAnimationFrame(frame);
      send({ type: 'rect' });
    };
    // crop is read through cropKey, so a new but equal object doesn't resend.
  }, [el, cropKey]);
}

/** Whether Uncbox starts with Windows (null until the app answers), and a way to change it. */
export function useAutostart(): [boolean | null, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useShellMessages((msg) => {
    if (msg.type === 'autostartstate') setEnabled(msg.enabled);
  });
  useEffect(() => send({ type: 'autostart' }), []);
  return [enabled, (on) => send({ type: 'autostart', enabled: on })];
}

/** The microphones to pick from (asked for when `open` turns true); null until the app answers. */
export function useAudioDevices(open: boolean): AudioDevice[] | null {
  const [mics, setMics] = useState<AudioDevice[] | null>(null);
  useShellMessages((msg) => {
    if (msg.type === 'audiodevices') setMics(msg.mics);
  });
  useEffect(() => {
    if (open) send({ type: 'audiodevices' });
  }, [open]);
  return mics;
}

let clipAudioId = 1;
const CLIP_AUDIO_WAIT_MS = 15_000;

/**
 * Asks the app for the sound of a clip: the stretch that started `fromMs` ago and ended `toMs` ago
 * (both from now, fromMs > toMs >= 0). It comes back as a WebView2 shared buffer (60 s of three
 * tracks is about 35 MB, too much for a message), which is copied and given back right away.
 * Rejects with plain words when the app can't (not running the sound, or no app at all).
 */
export function requestClipAudio(fromMs: number, toMs: number): Promise<ClipPcm> {
  return new Promise((resolve, reject) => {
    if (!shell) return reject(new Error('Sound in clips needs the Uncbox app.'));
    const bridge = shell;
    const id = clipAudioId++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer);
      bridge.removeEventListener('sharedbufferreceived', onBuffer);
      bridge.removeEventListener('message', onMessage);
    };
    const onBuffer = (e: SharedBufferEvent) => {
      const info = e.additionalData as { type?: string; id?: number; frames?: number; rate?: number } | undefined;
      if (info?.type !== 'clipaudio' || info.id !== id) return;
      const buffer = e.getBuffer();
      try {
        resolve(copyClipPcm(buffer, info.frames ?? 0, info.rate ?? 48000));
      } catch (err) {
        reject(err);
      } finally {
        bridge.releaseBuffer(buffer);
        done();
      }
    };
    const onMessage = (e: { data: unknown }) => {
      const msg = e.data as { type?: string; id?: number; error?: string } | undefined;
      if (msg?.type !== 'clipaudio' || msg.id !== id || typeof msg.error !== 'string') return;
      done();
      reject(new Error(msg.error));
    };
    bridge.addEventListener('sharedbufferreceived', onBuffer);
    bridge.addEventListener('message', onMessage);
    timer = setTimeout(() => {
      done();
      reject(new Error('The app didn’t send the sound.'));
    }, CLIP_AUDIO_WAIT_MS);
    bridge.postMessage({ type: 'clipaudioget', id, fromMs, toMs });
  });
}

/** The shared buffer's layout: the game, then Discord, then the mic, each `frames` x 2 samples. */
export function copyClipPcm(buffer: ArrayBuffer, frames: number, rate: number): ClipPcm {
  const samples = frames * 2;
  if (!Number.isInteger(frames) || frames <= 0 || buffer.byteLength < samples * 3 * 2) throw new Error('The sound for that clip was cut short.');
  const all = new Int16Array(buffer, 0, samples * 3);
  // slice() copies, so the shared memory can go back to the app.
  return { frames, rate, game: all.slice(0, samples), discord: all.slice(samples, samples * 2), mic: all.slice(samples * 2, samples * 3) };
}

/** The window list, asked for when the picker opens. */
export function useHostWindows(open: boolean) {
  const [windows, setWindows] = useState<HostWindow[]>([]);
  useShellMessages((msg) => {
    if (msg.type === 'windows') setWindows(msg.windows);
  });
  useEffect(() => {
    if (open) send({ type: 'windows' });
  }, [open]);
  return windows;
}

// The app's own dialogs (the window picker) are drawn inside Uncbox, where the game's hole would
// cut through them. While one is up, the game hides behind the dashboard.
let covers = 0;
// Overlays that only the web widgets' views sit above (menus): the game's hole is left alone.
let webCovers = 0;
const coverListeners = new Set<() => void>();

export async function whileCovered<T>(work: () => Promise<T>): Promise<T> {
  if (!shell) return work();
  covers++;
  coverListeners.forEach((l) => l());
  try {
    return await work();
  } finally {
    covers--;
    coverListeners.forEach((l) => l());
  }
}

/**
 * Hides the game and the web widgets' pages behind the dashboard while on (an overlay of Uncbox's
 * own, like the clip player). With webOnly, only the web pages hide (a menu: the game's hole
 * stays, as it always did).
 */
export function useCover(on: boolean, webOnly = false) {
  useEffect(() => {
    if (!on || !shell) return;
    if (webOnly) webCovers++;
    else covers++;
    coverListeners.forEach((l) => l());
    return () => {
      if (webOnly) webCovers--;
      else covers--;
      coverListeners.forEach((l) => l());
    };
  }, [on, webOnly]);
}

export function useCovered(): boolean {
  return useSyncExternalStore(
    (l) => {
      coverListeners.add(l);
      return () => coverListeners.delete(l);
    },
    () => covers > 0,
  );
}

/** Like useCovered, for the web widgets' pages, which menus cover as well. */
export function useWebCovered(): boolean {
  return useSyncExternalStore(
    (l) => {
      coverListeners.add(l);
      return () => coverListeners.delete(l);
    },
    () => covers + webCovers > 0,
  );
}

// ---- web widgets: a real WebView2 per widget, over the panel ----

export type WebAction = 'back' | 'forward' | 'reload';

/** What a web widget's page is doing, as the shell reports it. */
export interface WebState {
  id: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

/**
 * The messages for the shell's web views (see ShellForm.cs / WebViews.cs). Each widget's id names
 * its view. Rects are in device pixels, like the game's.
 */
export const web = {
  /** Makes the view, or takes it to another page. */
  open: (id: string, url: string) => send({ type: 'web', id, url }),
  rect: (id: string, box: { x: number; y: number; w: number; h: number }, visible: boolean) => send({ type: 'webrect', id, ...box, visible }),
  nav: (id: string, action: WebAction) => send({ type: 'webnav', id, action }),
  /** A factor: 1 is 100%. */
  zoom: (id: string, factor: number) => send({ type: 'webzoom', id, factor }),
  close: (id: string) => send({ type: 'webclose', id }),
};

/**
 * Puts a real page over `el` in the app: the shell makes a WebView2 for this widget, shows it
 * where el is (kept up to date while panels move and resize, and hidden while an overlay of
 * Uncbox's own is up) and closes it when the widget goes. `url` is where the user wants it to be;
 * the returned state says where it is. In a browser this does nothing.
 */
export function useWebView(id: string, el: HTMLElement | null, url: string, zoom: number): WebState | null {
  const [state, setState] = useState<WebState | null>(null);
  const covered = useWebCovered();
  // The page the view is on, as last asked for or reported, so a report isn't sent back as a request.
  const known = useRef('');
  useShellMessages((msg) => {
    if (msg.type !== 'webstate' || msg.id !== id) return;
    known.current = msg.url;
    setState(msg);
  });
  useEffect(() => {
    if (!shell || !url || url === known.current) return;
    known.current = url;
    web.open(id, url);
  }, [id, url]);
  useEffect(() => {
    if (shell) web.zoom(id, zoom / 100);
  }, [id, zoom]);
  useEffect(() => {
    if (!shell || !el) return;
    let last = '';
    let frame = 0;
    const report = () => {
      const box = deviceBox(el);
      const visible = !covered && box.w > 0 && box.h > 0;
      const key = JSON.stringify([box, visible]);
      if (key !== last) {
        last = key;
        web.rect(id, box, visible);
      }
      frame = requestAnimationFrame(report);
    };
    report();
    return () => {
      cancelAnimationFrame(frame);
      web.rect(id, { x: 0, y: 0, w: 0, h: 0 }, false);
    };
  }, [id, el, covered]);
  // Declared last, so on the way out the rect is hidden first and the close (which forgets it) after.
  useEffect(() => {
    if (!shell) return;
    return () => {
      known.current = '';
      web.close(id);
    };
  }, [id]);
  return state;
}
