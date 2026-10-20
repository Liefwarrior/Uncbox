import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Crop } from './state/model';

// The page's side of the native shell (native/UncboxShell). Inside it the page can put a game's
// real window in the game panel ("Play here") instead of a capture of it. See ShellForm.cs for
// the messages. In a browser none of this exists and the game panel works as before.

interface WebViewBridge {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
}

declare global {
  interface Window {
    chrome?: { webview?: WebViewBridge };
  }
}

/** The shell's message channel, or null in a browser. */
export const shell: WebViewBridge | null = window.chrome?.webview ?? null;

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
  | { type: 'picture'; on: boolean; launchOption: string };

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
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio;
      const rect = { x: r.left * dpr, y: r.top * dpr, w: r.width * dpr, h: r.height * dpr };
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

/** Hides the game behind the dashboard while on (an overlay of Uncbox's own, like the clip player). */
export function useCover(on: boolean) {
  useEffect(() => {
    if (!on || !shell) return;
    covers++;
    coverListeners.forEach((l) => l());
    return () => {
      covers--;
      coverListeners.forEach((l) => l());
    };
  }, [on]);
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
