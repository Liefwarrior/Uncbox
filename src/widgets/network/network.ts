import { useEffect, useState } from 'react';
import { listen } from '../../events';
import type { NetworkSettings } from './settings';

// Ping, jitter and loss, and a game's frame rate, from the Uncbox server (server/netstats.mjs).

export interface PingStats {
  host: string;
  /** Milliseconds for the newest ping, or null when it was lost. */
  last: number | null;
  avg: number | null;
  jitter: number;
  /** Percent of the last 60 pings that were lost. */
  loss: number;
  history: (number | null)[];
}

export interface GameStats {
  name: string;
  fps: number;
  /** The 1% low frame rate over the last 60 seconds. */
  fpsLow: number | null;
  fpsHistory: number[];
  gpuMs: number | null;
  /** The game's own ping, or null when it has no server connection. */
  ping: number | null;
  pingHistory: (number | null)[];
}

interface NetstatsEvent {
  targets: Record<string, PingStats>;
  router: PingStats | null;
  game: GameStats | null;
}

export interface Netstats {
  ping: PingStats | null;
  router: PingStats | null;
  game: GameStats | null;
}

/**
 * Live ping and frame rate. Asking the server every few seconds is what keeps it measuring; it
 * stops by itself soon after the last widget goes away. The numbers arrive as "netstats" events.
 */
export function useNetstats(s: NetworkSettings): { stats: Netstats | null; error: string } {
  const [stats, setStats] = useState<Netstats | null>(null);
  const [error, setError] = useState('');
  const target = s.pingTarget.trim();
  const router = s.showRouter;

  useEffect(() => {
    let alive = true;
    let key = '';
    const apply = (e: NetstatsEvent) => setStats({ ping: e.targets[key] ?? null, router: e.router, game: e.game });
    const ask = async () => {
      try {
        const r = await fetch(`/api/netstats?target=${encodeURIComponent(target)}&router=${router ? 1 : 0}`);
        const d = await r.json();
        if (!alive) return;
        if (!r.ok) return setError(d.error || 'Ping is unavailable.');
        setError('');
        key = d.key;
        apply(d);
      } catch {
        // Server restarting; the next ask tries again.
      }
    };
    void ask();
    const t = setInterval(ask, 5000);
    const stop = listen('netstats', (data) => alive && key && apply(JSON.parse(data)));
    return () => {
      alive = false;
      clearInterval(t);
      stop();
    };
  }, [target, router]);
  return { stats, error };
}
