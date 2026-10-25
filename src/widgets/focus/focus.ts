
// The focus timer's maths, kept apart from the screen. It never counts ticks: a running timer is
// just the moment it ends (`endsAt`), so a reload, a sleeping tab or a PC that was asleep all
// land on the right answer, because "now" is the only thing that changes.

import type { Widget } from '../../state/model';

export type FocusPhase = 'work' | 'short' | 'long';

/** What the widget saves (these live in the widget's settings). */
export interface FocusState {
  phase: FocusPhase;
  /** Which work round of the cycle this is, from 1. */
  round: number;
  /** When the running phase ends (ms since 1970), or 0 while paused or not started. */
  endsAt: number;
  /** While paused: how long was left (ms). 0 means the phase hasn't started, so it has its full length. */
  left: number;
}

export interface FocusConfig {
  work: number;
  short: number;
  long: number;
  /** Work rounds before a long break. */
  rounds: number;
  /** Start the next phase by itself when one ends. */
  auto: boolean;
}

export const PHASE_NAMES: Record<FocusPhase, string> = { work: 'Focus', short: 'Short break', long: 'Long break' };

export const startState = (): FocusState => ({ phase: 'work', round: 1, endsAt: 0, left: 0 });

const MINUTE = 60_000;
const whole = (v: number, min: number, max: number, fallback: number) =>
  Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;

/** The settings as safe numbers: minutes of at least 1, and at least 1 round. */
export function cleanConfig(c: FocusConfig): FocusConfig {
  return {
    work: whole(c.work, 1, 600, 25),
    short: whole(c.short, 1, 600, 5),
    long: whole(c.long, 1, 600, 15),
    rounds: whole(c.rounds, 1, 12, 4),
    auto: !!c.auto,
  };
}

export const phaseMs = (phase: FocusPhase, c: FocusConfig) => cleanConfig(c)[phase === 'work' ? 'work' : phase] * MINUTE;

/** Work, then a short break; after the last round of the cycle, a long break, and round 1 again. */
export function nextPhase(phase: FocusPhase, round: number, c: FocusConfig): { phase: FocusPhase; round: number } {
  const rounds = cleanConfig(c).rounds;
  if (phase === 'work') return { phase: round >= rounds ? 'long' : 'short', round };
  return { phase: 'work', round: phase === 'long' ? 1 : round + 1 };
}

/** Time left in the current phase, in ms. */
export function remaining(s: FocusState, now: number, c: FocusConfig): number {
  if (s.endsAt) return Math.max(0, s.endsAt - now);
  return s.left || phaseMs(s.phase, c);
}

export const isRunning = (s: FocusState) => s.endsAt > 0;

export function start(s: FocusState, now: number, c: FocusConfig): FocusState {
  if (isRunning(s)) return s;
  return { ...s, endsAt: now + (s.left || phaseMs(s.phase, c)), left: 0 };
}

export function pause(s: FocusState, now: number): FocusState {
  if (!isRunning(s)) return s;
  return { ...s, endsAt: 0, left: Math.max(1, s.endsAt - now) };
}

/** Jumps to the next phase. A running timer keeps running; a paused one waits at the start of it. */
export function skip(s: FocusState, now: number, c: FocusConfig): FocusState {
  const next = nextPhase(s.phase, s.round, c);
  return { ...next, endsAt: isRunning(s) ? now + phaseMs(next.phase, c) : 0, left: 0 };
}

export const reset = startState;

export interface Settled {
  state: FocusState;
  /** The phases that ended since the last look, oldest first. */
  ended: FocusPhase[];
  /** When the last of them ended (ms since 1970), or 0 if none did. */
  endedAt: number;
}

/**
 * Brings a saved state up to `now`: every phase whose end has passed is finished. With auto-start
 * the next one begins at the moment the last ended (not "now"), so nothing drifts, and a long
 * sleep catches up through several phases. Without it the timer stops at the start of the next.
 */
export function settle(s: FocusState, now: number, c: FocusConfig): Settled {
  const ended: FocusPhase[] = [];
  let state = s;
  let endedAt = 0;
  while (state.endsAt > 0 && now >= state.endsAt && ended.length < 1000) {
    ended.push(state.phase);
    endedAt = state.endsAt;
    const next = nextPhase(state.phase, state.round, c);
    state = { ...next, endsAt: cleanConfig(c).auto ? endedAt + phaseMs(next.phase, c) : 0, left: 0 };
  }
  return { state, ended, endedAt };
}

/** Round dots: how many of the cycle's rounds are done, and which one is under way (-1 in a break). */
export function roundDots(s: FocusState, c: FocusConfig): { done: number; current: number; total: number } {
  const total = cleanConfig(c).rounds;
  const round = Math.min(s.round, total);
  return s.phase === 'work' ? { done: round - 1, current: round - 1, total } : { done: round, current: -1, total };
}

// ---- the timer as a widget's settings ----

/** What a Focus timer widget saves: its setup, and where the timer is (so a reload carries on). */
export type FocusSettings = {
  /** Minutes of work, short break and long break; work rounds before a long break. */
  focusWork: number;
  focusShort: number;
  focusLong: number;
  focusRounds: number;
  /** Start the next phase by itself, and chime when one ends. */
  focusAuto: boolean;
  focusSound: boolean;
  focusPhase: 'work' | 'short' | 'long';
  focusRound: number;
  focusEndsAt: number;
  focusLeft: number;
};

export const defaultFocusSettings = (): FocusSettings => ({
  focusWork: 25,
  focusShort: 5,
  focusLong: 15,
  focusRounds: 4,
  focusAuto: false,
  focusSound: true,
  focusPhase: 'work',
  focusRound: 1,
  focusEndsAt: 0,
  focusLeft: 0,
});

export function cleanFocusSettings(s: FocusSettings): FocusSettings {
  if (!['work', 'short', 'long'].includes(s.focusPhase)) s.focusPhase = 'work';
  s.focusRound = Math.max(1, s.focusRound);
  return s;
}

/** A Focus timer widget; its settings are typed. */
export const isFocusWidget = (w: Widget): w is Widget<FocusSettings> => w.kind === 'focus';

export const configOf = (s: FocusSettings): FocusConfig => ({
  work: s.focusWork,
  short: s.focusShort,
  long: s.focusLong,
  rounds: s.focusRounds,
  auto: s.focusAuto,
});

export const stateOf = (s: FocusSettings): FocusState => ({ phase: s.focusPhase, round: s.focusRound, endsAt: s.focusEndsAt, left: s.focusLeft });

export const patchOf = (f: FocusState): Partial<FocusSettings> => ({ focusPhase: f.phase, focusRound: f.round, focusEndsAt: f.endsAt, focusLeft: f.left });

/** Start (or resume) a stopped timer, pause a running one; the settings to save. */
export function toggleFocus(s: FocusSettings, now: number): Partial<FocusSettings> {
  const cfg = configOf(s);
  const state = settle(stateOf(s), now, cfg).state;
  return patchOf(isRunning(state) ? pause(state, now) : start(state, now, cfg));
}
