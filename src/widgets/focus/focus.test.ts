import { describe, expect, it } from 'vitest';
import { type FocusConfig, type FocusState, nextPhase, pause, phaseMs, remaining, roundDots, settle, skip, start, startState } from './focus';

const MIN = 60_000;
const cfg: FocusConfig = { work: 25, short: 5, long: 15, rounds: 4, auto: false };
const T0 = 1_700_000_000_000;

describe('nextPhase', () => {
  it('goes work, short break, work, with the round counting up', () => {
    expect(nextPhase('work', 1, cfg)).toEqual({ phase: 'short', round: 1 });
    expect(nextPhase('short', 1, cfg)).toEqual({ phase: 'work', round: 2 });
  });

  it('takes the long break after the last round, then starts the cycle over', () => {
    expect(nextPhase('work', 3, cfg)).toEqual({ phase: 'short', round: 3 });
    expect(nextPhase('work', 4, cfg)).toEqual({ phase: 'long', round: 4 });
    expect(nextPhase('long', 4, cfg)).toEqual({ phase: 'work', round: 1 });
  });

  it('follows the rounds setting', () => {
    expect(nextPhase('work', 2, { ...cfg, rounds: 2 }).phase).toBe('long');
    expect(nextPhase('work', 1, { ...cfg, rounds: 1 }).phase).toBe('long');
  });

  it('cycles correctly over a whole day of phases', () => {
    let s = { phase: 'work' as const, round: 1 } as { phase: FocusState['phase']; round: number };
    const seen: string[] = [];
    for (let i = 0; i < 16; i++) {
      seen.push(s.phase);
      s = nextPhase(s.phase, s.round, cfg);
    }
    expect(seen.join(' ')).toBe('work short work short work short work long work short work short work short work long');
  });
});

describe('durations and cleaning', () => {
  it('uses the minutes for each phase', () => {
    expect(phaseMs('work', cfg)).toBe(25 * MIN);
    expect(phaseMs('short', cfg)).toBe(5 * MIN);
    expect(phaseMs('long', cfg)).toBe(15 * MIN);
  });

  it('never lets a bad setting give a zero or broken length', () => {
    expect(phaseMs('work', { ...cfg, work: 0 })).toBe(MIN);
    expect(phaseMs('work', { ...cfg, work: NaN })).toBe(25 * MIN);
    expect(nextPhase('work', 1, { ...cfg, rounds: 0 }).phase).toBe('long');
  });
});

describe('start, pause and resume', () => {
  it('starts with the full length', () => {
    const s = start(startState(), T0, cfg);
    expect(s.endsAt).toBe(T0 + 25 * MIN);
    expect(remaining(s, T0 + 10 * MIN, cfg)).toBe(15 * MIN);
  });

  it('pauses with the time left, and resumes from it', () => {
    const running = start(startState(), T0, cfg);
    const paused = pause(running, T0 + 10 * MIN);
    expect(paused).toMatchObject({ endsAt: 0, left: 15 * MIN });
    // Time passing while paused changes nothing.
    expect(remaining(paused, T0 + 3 * 60 * MIN, cfg)).toBe(15 * MIN);
    const resumed = start(paused, T0 + 20 * MIN, cfg);
    expect(resumed.endsAt).toBe(T0 + 35 * MIN);
    expect(resumed.left).toBe(0);
  });

  it('start and pause are no-ops when already in that state', () => {
    const running = start(startState(), T0, cfg);
    expect(start(running, T0 + MIN, cfg)).toBe(running);
    const idle = startState();
    expect(pause(idle, T0)).toBe(idle);
  });

  it('shows the full length before it starts', () => {
    expect(remaining(startState(), T0, cfg)).toBe(25 * MIN);
  });
});

describe('resuming from a saved end time', () => {
  const saved: FocusState = { phase: 'work', round: 2, endsAt: T0 + 7 * MIN, left: 0 };

  it('carries on where it was after a reload', () => {
    const { state, ended } = settle(saved, T0 + 2 * MIN, cfg);
    expect(ended).toEqual([]);
    expect(state).toEqual(saved);
    expect(remaining(state, T0 + 2 * MIN, cfg)).toBe(5 * MIN);
  });

  it('finishes a phase that ended while the page was away, and stops at the next one', () => {
    const { state, ended, endedAt } = settle(saved, T0 + 20 * MIN, cfg);
    expect(ended).toEqual(['work']);
    expect(endedAt).toBe(saved.endsAt);
    expect(state).toEqual({ phase: 'short', round: 2, endsAt: 0, left: 0 });
  });

  it('ends exactly on the dot', () => {
    expect(settle(saved, saved.endsAt, cfg).ended).toEqual(['work']);
    expect(settle(saved, saved.endsAt - 1, cfg).ended).toEqual([]);
  });

  it('with auto-start, begins the next phase at the moment the last one ended', () => {
    const auto = { ...cfg, auto: true };
    const { state, ended } = settle(saved, saved.endsAt + 2 * MIN, auto);
    expect(ended).toEqual(['work']);
    expect(state).toEqual({ phase: 'short', round: 2, endsAt: saved.endsAt + 5 * MIN, left: 0 });
    expect(remaining(state, saved.endsAt + 2 * MIN, auto)).toBe(3 * MIN);
  });

  it('with auto-start, catches up through several phases after a long sleep', () => {
    const auto = { ...cfg, auto: true };
    // Round 2 work ends, then 5 short, 25 work (round 3), 5 short, 25 work (round 4) = 60 min later, so it's in the long break.
    const { state, ended } = settle(saved, saved.endsAt + 61 * MIN, auto);
    expect(ended).toEqual(['work', 'short', 'work', 'short', 'work']);
    expect(state).toEqual({ phase: 'long', round: 4, endsAt: saved.endsAt + 60 * MIN + 15 * MIN, left: 0 });
  });

  it('leaves a paused timer alone however much time passes', () => {
    const paused: FocusState = { phase: 'short', round: 1, endsAt: 0, left: 3 * MIN };
    expect(settle(paused, T0 + 10_000 * MIN, cfg)).toEqual({ state: paused, ended: [], endedAt: 0 });
  });
});

describe('skip', () => {
  it('moves to the next phase and waits when paused', () => {
    expect(skip({ phase: 'work', round: 1, endsAt: 0, left: 4 * MIN }, T0, cfg)).toEqual({ phase: 'short', round: 1, endsAt: 0, left: 0 });
  });

  it('keeps running when it was running', () => {
    const s = skip(start(startState(), T0, cfg), T0 + MIN, cfg);
    expect(s).toEqual({ phase: 'short', round: 1, endsAt: T0 + MIN + 5 * MIN, left: 0 });
  });
});

describe('roundDots', () => {
  it('marks finished rounds and the one under way', () => {
    expect(roundDots({ phase: 'work', round: 1, endsAt: 0, left: 0 }, cfg)).toEqual({ done: 0, current: 0, total: 4 });
    expect(roundDots({ phase: 'work', round: 3, endsAt: 0, left: 0 }, cfg)).toEqual({ done: 2, current: 2, total: 4 });
  });

  it('counts the round as done during its break', () => {
    expect(roundDots({ phase: 'short', round: 2, endsAt: 0, left: 0 }, cfg)).toEqual({ done: 2, current: -1, total: 4 });
    expect(roundDots({ phase: 'long', round: 4, endsAt: 0, left: 0 }, cfg)).toEqual({ done: 4, current: -1, total: 4 });
  });
});
