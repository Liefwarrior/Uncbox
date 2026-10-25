import { useCallback, useEffect, useRef, useState } from 'react';
import { listen, onConnection } from '../events';
import { defaultState, hydrate } from './hydrate';
import type { AppState, PresetData } from './model';
import { activePreset } from './presets';

const clientId = Math.random().toString(36).slice(2);
const SAVE_DELAY_MS = 250;

export type SyncStatus = 'loading' | 'synced' | 'saving' | 'offline';
export type Mutate = (recipe: (draft: AppState) => void) => void;
/** Mutates the active preset's data. */
export type MutatePreset = (recipe: (draft: PresetData) => void) => void;

/**
 * Loads state from the local server, saves changes back (debounced), and applies
 * changes made in other windows as they arrive over /api/events.
 */
export function useAppState() {
  const [state, setState] = useState<AppState>(defaultState);
  const [status, setStatus] = useState<SyncStatus>('loading');
  const loaded = useRef(false);
  const fromRemote = useRef(false);
  const pending = useRef<AppState | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/state')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
      .then((saved) => {
        if (cancelled) return;
        loaded.current = true;
        fromRemote.current = true;
        setState(hydrate(saved));
        setStatus('synced');
      })
      .catch(() => {
        if (cancelled) return;
        loaded.current = true;
        setStatus('offline');
      });

    const stopListening = listen('message', (data) => {
      const msg = JSON.parse(data) as { clientId: string; state: unknown };
      if (msg.clientId === clientId) return;
      fromRemote.current = true;
      setState(hydrate(msg.state));
    });
    const stopWatching = onConnection(
      () => setStatus((s) => (s === 'offline' ? 'synced' : s)),
      () => setStatus('offline'),
    );
    return () => {
      cancelled = true;
      stopListening();
      stopWatching();
    };
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    if (fromRemote.current) {
      fromRemote.current = false;
      return;
    }
    pending.current = state;
    setStatus('saving');
    const t = setTimeout(() => {
      pending.current = null;
      fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Client-Id': clientId },
        body: JSON.stringify(state),
      })
        .then((r) => setStatus(r.ok ? 'synced' : 'offline'))
        .catch(() => setStatus('offline'));
    }, SAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [state]);

  // Flush an unsaved edit if the tab closes inside the debounce window.
  useEffect(() => {
    const flush = () => {
      if (!pending.current) return;
      const blob = new Blob([JSON.stringify(pending.current)], { type: 'application/json' });
      navigator.sendBeacon(`/api/state?client=${clientId}`, blob);
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  const mutate: Mutate = useCallback((recipe) => {
    setState((prev) => {
      const next = structuredClone(prev);
      recipe(next);
      return next;
    });
  }, []);

  const mutatePreset: MutatePreset = useCallback(
    (recipe) => mutate((s) => recipe(activePreset(s).data)),
    [mutate],
  );

  return { state, mutate, mutatePreset, status };
}
