import { useEffect, useSyncExternalStore } from 'react';
import { send, shell, useShellMessages, type ShellMessage, type StealthScene } from '../native';

// Stealth mode, the page's side (the app's side is native/UncboxShell/ShellForm.cs and StealthForm.cs).
//
// It is how OBS is used: the game full screen in front, played as it is, and a small window to run
// the stream from. The dashboard keeps running behind the game at its own size, and the stream shows
// it with the game drawn over its panel (made by Uncbox's own streaming engine from two window
// captures, see engine/src/scene.rs), so viewers see Uncbox while you see your game.
//
// Two pages take part. The dashboard (the usual page) is what viewers see, keeps the stream going
// (its controller, its sound, its replay buffer) and passes the scene the app describes on to the
// server. The manager (?view=manager, in the manager window) is what you see: a live preview, the Go
// live controls and the sidebar, with every change reaching the dashboard through the shared state,
// and going live or saving a clip handed to the dashboard through the app.

/** Whether this page is the manager's (the stealth mode window), not the dashboard. */
export function isManagerView(search = typeof window !== 'undefined' ? window.location?.search ?? '' : ''): boolean {
  return new URLSearchParams(search).get('view') === 'manager';
}

/** Only the Uncbox app has stealth mode: a browser can't put the game in front of itself. */
export const stealthAvailable = (): boolean => Boolean(shell);

let on = false;
let scene: StealthScene | null = null;
const listeners = new Set<() => void>();

/** What the app says about stealth mode, kept for every part of the page that asks. */
export function takeStealthMessage(msg: ShellMessage | null | undefined) {
  if (msg?.type === 'stealth') {
    if (msg.on === on) return;
    on = msg.on;
  } else if (msg?.type === 'scene') {
    scene = msg.scene ?? null;
  } else return;
  listeners.forEach((l) => l());
}

/**
 * Mounted once per page, in the app (see StreamRunner): hears what the app says about stealth mode,
 * and asks it once whether it is on, since this page may have just been reloaded. Draws nothing.
 */
export function StealthListener() {
  useShellMessages(takeStealthMessage);
  useEffect(() => {
    if (shell) send({ type: 'stealth' });
  }, []);
  return null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Whether stealth mode is on. */
export function useStealth(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => on,
    () => false,
  );
}

/** What the stream shows in stealth mode, as the app last said; null outside it. */
export function useStealthScene(): StealthScene | null {
  return useSyncExternalStore(
    subscribe,
    () => scene,
    () => null,
  );
}

/** The scene right now, for a stream that is starting. */
export const currentScene = (): StealthScene | null => (on ? scene : null);

/** Into stealth mode (the game full screen, the manager open) or back to the dashboard. */
export function setStealth(want: boolean) {
  send({ type: 'stealth', on: want });
}

/** Hands something to the other page, through the app (see the "relay" messages in ShellForm.cs). */
export function relay(message: { type: 'streamcommand'; action: 'start' | 'test' | 'end' | 'state' } | { type: 'clipsave' } | { type: 'streamstate'; state: unknown }) {
  send({ type: 'relay', message });
}
