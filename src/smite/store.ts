import { useSyncExternalStore } from 'react';
import type { CombatLog, HudTop, Kda, KillBanner, Scoreboard, TopCards } from './screen';

// What the screen reader (reader.ts) has seen of the match so far, and when. The Scoreboard and
// Damage panels read it from here; nothing is saved, because a screen is only worth showing while
// the match it came from is still going.

export interface Seen<T> {
  /** When it was last read (Date.now()). */
  at: number;
  value: T;
}

export interface KillEvent {
  /** When the banner first appeared, and the last time it was still up. */
  at: number;
  lastSeen: number;
  /** The match clock then ("7:39"), or '' if the top bar hadn't been read. */
  clock: string;
  killer: string;
  victim: string;
}

export interface ScreenState {
  scoreboard: Seen<Scoreboard> | null;
  combat: Seen<CombatLog> | null;
  cards: Seen<TopCards> | null;
  top: Seen<HudTop> | null;
  gold: Seen<number> | null;
  /** Your K/D/A as accepted from the HUD (see nextKda). */
  kda: Seen<Kda> | null;
  fps: Seen<number> | null;
  /** Oldest first. */
  kills: KillEvent[];
}

const EMPTY: ScreenState = { scoreboard: null, combat: null, cards: null, top: null, gold: null, kda: null, fps: null, kills: [] };

let state = EMPTY;
const listeners = new Set<() => void>();

export function publish(patch: Partial<ScreenState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

/** A new match, or the reader stopping: nothing from before counts any more. */
export function resetScreen() {
  if (state === EMPTY) return;
  state = EMPTY;
  listeners.forEach((l) => l());
}

export function useScreen(): ScreenState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export const currentScreen = () => state;

// --- Kill banners ----------------------------------------------------------------------------

/** A banner stays up for a few seconds, so the same pair seen again within this long is the same kill. */
export const SAME_KILL_MS = 8000;
const MAX_KILLS = 20;

const same = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]/g, '') === b.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Adds a kill unless it is the banner of one already recorded; returns the same list in that case's place. */
export function addKill(kills: KillEvent[], banner: KillBanner, now: number, clock: string): KillEvent[] {
  const i = kills.findLastIndex((k) => same(k.killer, banner.killer) && same(k.victim, banner.victim) && now - k.lastSeen < SAME_KILL_MS);
  if (i >= 0) return kills.map((k, j) => (j === i ? { ...k, lastSeen: now } : k));
  return [...kills, { at: now, lastSeen: now, clock, killer: banner.killer, victim: banner.victim }].slice(-MAX_KILLS);
}

// --- Your K/D/A from the HUD -----------------------------------------------------------------

/**
 * The HUD's K/D/A is tiny and OCR sometimes misreads it, so a reading only counts when it comes
 * twice in a row and none of the three has gone down (they never do in a match).
 */
export interface KdaTracker {
  accepted: Kda | null;
  pending: Kda | null;
}

export const noKda: KdaTracker = { accepted: null, pending: null };

export function nextKda(t: KdaTracker, read: Kda | null): KdaTracker {
  if (!read) return { ...t, pending: null };
  const again = t.pending && t.pending.k === read.k && t.pending.d === read.d && t.pending.a === read.a;
  if (!again) return { ...t, pending: read };
  const a = t.accepted;
  if (a && (read.k < a.k || read.d < a.d || read.a < a.a)) return { ...t, pending: null };
  return { accepted: read, pending: null };
}

// --- Showing it -------------------------------------------------------------------------------

/** "0:42" for how long ago something was read. */
export function agoText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
