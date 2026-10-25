import { useEffect, useState } from 'react';
import { listen } from './events';
import type { MutatePreset } from './state/useAppState';

// SMITE 2, live from the game's log (server/smite.mjs): the draft, your god and your build.

export interface SmiteSnapshot {
  phase: 'lobby' | 'draft' | 'match';
  mode: string;
  startedAt: number;
  endedAt: number;
  god: string;
  allies: string[];
  enemies: string[];
  build: string[];
  consumables: Record<string, number>;
}

export function useSmite(on = true): SmiteSnapshot | null {
  const [snap, setSnap] = useState<SmiteSnapshot | null>(null);
  useEffect(() => {
    if (!on) return;
    let alive = true;
    fetch('/api/smite')
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => alive && s && setSnap(s))
      .catch(() => {});
    const stop = listen('smite', (data) => setSnap(JSON.parse(data)));
    return () => {
      alive = false;
      stop();
    };
  }, [on]);
  return on ? snap : null;
}

/**
 * Keeps the SMITE 2 preset's Match panel (god, mode) and Build panel in step with the game. Only
 * what the log knows is written, and only when it changes, so anything typed by hand stays until
 * the game says otherwise.
 */
export function useSmiteSync(on: boolean, mutatePreset: MutatePreset) {
  const snap = useSmite(on);
  const key = snap ? JSON.stringify([snap.phase, snap.god, snap.mode, snap.build]) : '';
  useEffect(() => {
    if (!snap || snap.phase === 'lobby' || !(snap.god || snap.build.length)) return;
    mutatePreset((d) => {
      if (snap.god) d.match.god = snap.god;
      if (snap.mode) d.match.mode = snap.mode;
      // The build fills the Build tiles in order; with more items than tiles, the newest win.
      const items = snap.build.slice(-d.slots.length);
      d.slots.forEach((slot, i) => {
        slot.name = items[i] ?? '';
        slot.detail = '';
      });
    });
    // snap is read through key.
  }, [key, mutatePreset]);
  return snap;
}
