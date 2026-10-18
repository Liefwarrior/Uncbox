import { useSyncExternalStore } from 'react';

// One pending "Undo" at a time, shown as a toast after something is removed. Removing things is
// then a single click with a way back, instead of an "Are you sure?" on every delete.

export interface Undoable {
  message: string;
  undo: () => void;
}

const UNDO_MS = 6000;
let current: (Undoable & { key: number }) | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function offerUndo(message: string, undo: () => void) {
  clearTimeout(timer);
  current = { message, undo, key: Date.now() };
  timer = setTimeout(dismissUndo, UNDO_MS);
  notify();
}

export function dismissUndo() {
  clearTimeout(timer);
  current = null;
  notify();
}

export function useUndo() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
