import { useSyncExternalStore } from 'react';

// One pending "Undo" at a time, shown as a toast after something is removed. Removing things is
// then a single click with a way back, instead of an "Are you sure?" on every delete.

export interface Undoable {
  message: string;
  /** None for a plain notice, which has nothing to take back. */
  undo?: () => void;
  /** Stays up when the active preset changes (a deleted preset, an import) instead of being dismissed. */
  keepOnSwitch?: boolean;
}

const UNDO_MS = 6000;
let current: (Undoable & { key: number }) | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function offerUndo(message: string, undo: () => void, keepOnSwitch = false) {
  show({ message, undo, keepOnSwitch });
}

/** A short message in the same spot, for things that happened (an import, an error) rather than things to undo. */
export function showNotice(message: string) {
  show({ message, keepOnSwitch: true });
}

function show(item: Undoable) {
  clearTimeout(timer);
  current = { ...item, key: Date.now() };
  timer = setTimeout(dismissUndo, UNDO_MS);
  notify();
}

/** An undo restores into the active preset, so it must not outlive a switch to another one. */
export function dismissUndoOnSwitch() {
  if (!current?.keepOnSwitch) dismissUndo();
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
