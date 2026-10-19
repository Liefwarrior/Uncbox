import { useEffect, useRef, useState } from 'react';

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
  | { type: 'attached'; id: string; title: string }
  | { type: 'detached' };

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
 * panels move and resize. A null element takes the game back out.
 */
export function useHole(el: HTMLElement | null) {
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
        send({ type: 'rect', ...rect });
      }
      frame = requestAnimationFrame(report);
    };
    // Every frame, so the game follows a panel being dragged; only changes are sent.
    report();
    return () => {
      cancelAnimationFrame(frame);
      send({ type: 'rect' });
    };
  }, [el]);
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
