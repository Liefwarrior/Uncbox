import { useEffect, useState } from 'react';
import { listen } from './events';

// Steam, live from the Steam client on this PC (server/steam.mjs): what you're playing and your
// recent games. Shared by the Steam panel and the game panel, which follows a game Steam starts.

export interface SteamGame {
  appid: number;
  name: string;
  lastPlayed: number;
  /** Minutes, as Steam counts them (it updates them when a game closes). */
  playtime: number;
}

export interface SteamSnapshot {
  available: boolean;
  user?: { name: string };
  playing?:
    | (SteamGame & {
        since: number;
        /** Where the game is installed, or ''. */
        dir: string;
        achievements: {
          unlocked: number;
          total: number;
          latest: { name: string; description: string; icon: string; at: number } | null;
        } | null;
      })
    | null;
  recent?: SteamGame[];
}

/** The latest Steam snapshot, or null before it arrives (or while off). */
export function useSteam(on = true) {
  const [snap, setSnap] = useState<SteamSnapshot | null>(null);
  useEffect(() => {
    if (!on) return;
    let alive = true;
    fetch('/api/steam')
      .then((r) => r.json())
      .then((s) => alive && setSnap(s))
      .catch(() => {});
    const stop = listen('steam', (data) => setSnap(JSON.parse(data)));
    return () => {
      alive = false;
      stop();
    };
  }, [on]);
  return on ? snap : null;
}
