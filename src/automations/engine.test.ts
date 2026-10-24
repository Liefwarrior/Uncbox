import { describe, expect, it, vi } from 'vitest';
import { defaultState } from '../state/hydrate';
import type { Automation, AutomationThen, AutomationWhen } from '../state/model';
import { activePreset } from '../state/presets';
import { type FocusSettings, isRunning, stateOf } from '../widgets/focus/focus';
import { newWidget } from '../widgets/registry';
import {
  admit,
  CAUSE_MS,
  COOLDOWN_MS,
  firedRules,
  focusSignal,
  gameSignals,
  MAX_CHAIN,
  newGuard,
  recordRun,
  type Runner,
  runRule,
  type Signals,
  startFocusRound,
  timeDue,
} from './engine';

const rule = (when: AutomationWhen, then: AutomationThen[] = [{ kind: 'note', text: 'hi' }], over: Partial<Automation> = {}): Automation => ({
  id: `r-${when.kind}`,
  enabled: true,
  name: '',
  when,
  then,
  lastFired: 0,
  ...over,
});

const signals = (over: Partial<Signals> = {}): Signals => ({ now: 1_000_000, games: {}, steam: null, obs: null, focus: null, ...over });
const fires = (r: Automation, prev: Partial<Signals> | null, next: Partial<Signals>) =>
  firedRules([r], prev ? signals(prev) : null, signals(next)).length === 1;

describe('edge triggering', () => {
  it('fires a game starting once, on the change, for a preset game', () => {
    const r = rule({ kind: 'gameStarts', game: 'smite2' });
    expect(fires(r, { games: { smite2: false } }, { games: { smite2: true } })).toBe(true);
    // Still running: no.
    expect(fires(r, { games: { smite2: true } }, { games: { smite2: true } })).toBe(false);
    // Stopping isn't starting.
    expect(fires(r, { games: { smite2: true } }, { games: { smite2: false } })).toBe(false);
    // Another game.
    expect(fires(r, { games: { wow: false } }, { games: { wow: true } })).toBe(false);
  });

  it('fires a game stopping on the way down only', () => {
    const r = rule({ kind: 'gameStops', game: 'smite2' });
    expect(fires(r, { games: { smite2: true } }, { games: { smite2: false } })).toBe(true);
    expect(fires(r, { games: { smite2: false } }, { games: { smite2: false } })).toBe(false);
    expect(fires(r, { games: { smite2: false } }, { games: { smite2: true } })).toBe(false);
  });

  it('follows any Steam game', () => {
    const starts = rule({ kind: 'gameStarts', game: 'any' });
    const stops = rule({ kind: 'gameStops', game: 'any' });
    expect(fires(starts, { steam: false }, { steam: true })).toBe(true);
    expect(fires(stops, { steam: true }, { steam: false })).toBe(true);
    expect(fires(starts, { steam: true }, { steam: true })).toBe(false);
  });

  it('does not treat the first look, or a signal that was unknown, as a change', () => {
    const r = rule({ kind: 'gameStarts', game: 'smite2' });
    // Uncbox opens with the game already running.
    expect(fires(r, null, { games: { smite2: true } })).toBe(false);
    // The program check had not answered yet.
    expect(fires(r, { games: {} }, { games: { smite2: true } })).toBe(false);
    const live = rule({ kind: 'streamStarts' });
    expect(fires(live, { obs: null }, { obs: { streaming: true, recording: false } })).toBe(false);
    expect(fires(live, { obs: { streaming: false, recording: false } }, { obs: null })).toBe(false);
  });

  it('fires OBS streaming and recording on their changes', () => {
    const off = { streaming: false, recording: false };
    const live = { streaming: true, recording: false };
    const rec = { streaming: false, recording: true };
    expect(fires(rule({ kind: 'streamStarts' }), { obs: off }, { obs: live })).toBe(true);
    expect(fires(rule({ kind: 'streamStarts' }), { obs: live }, { obs: live })).toBe(false);
    expect(fires(rule({ kind: 'streamStops' }), { obs: live }, { obs: off })).toBe(true);
    expect(fires(rule({ kind: 'streamStops' }), { obs: off }, { obs: live })).toBe(false);
    expect(fires(rule({ kind: 'recordStarts' }), { obs: off }, { obs: rec })).toBe(true);
    expect(fires(rule({ kind: 'recordStarts' }), { obs: rec }, { obs: rec })).toBe(false);
    expect(fires(rule({ kind: 'recordStarts' }), { obs: off }, { obs: live })).toBe(false);
  });

  it('fires a focus round or a break starting, but not a paused round resuming', () => {
    const round = rule({ kind: 'focusStarts' });
    const brk = rule({ kind: 'breakStarts' });
    expect(fires(round, { focus: 'idle' }, { focus: 'work' })).toBe(true);
    expect(fires(round, { focus: 'break' }, { focus: 'work' })).toBe(true);
    expect(fires(round, { focus: 'work' }, { focus: 'work' })).toBe(false);
    expect(fires(round, { focus: 'paused' }, { focus: 'work' })).toBe(false);
    expect(fires(brk, { focus: 'work' }, { focus: 'break' })).toBe(true);
    expect(fires(brk, { focus: 'break' }, { focus: 'break' })).toBe(false);
    expect(fires(brk, { focus: 'idle' }, { focus: 'work' })).toBe(false);
    expect(fires(round, null, { focus: 'work' })).toBe(false);
    expect(fires(round, { focus: null }, { focus: 'work' })).toBe(false);
  });

  it('leaves out rules that are switched off', () => {
    const r = rule({ kind: 'streamStarts' }, undefined, { enabled: false });
    expect(fires(r, { obs: { streaming: false, recording: false } }, { obs: { streaming: true, recording: false } })).toBe(false);
  });
});

describe('time rules', () => {
  // 2026-10-20 is a Tuesday.
  const at = (h: number, m: number, s = 0, day = 20) => new Date(2026, 9, day, h, m, s).getTime();
  const nine = rule({ kind: 'time', at: '09:30', days: [] });

  it('is due during its minute, and not before or after', () => {
    expect(timeDue(nine, at(9, 29, 59))).toBe(false);
    expect(timeDue(nine, at(9, 30, 0))).toBe(true);
    expect(timeDue(nine, at(9, 30, 59))).toBe(true);
    expect(timeDue(nine, at(9, 31, 0))).toBe(false);
  });

  it('respects the days (0 is Sunday)', () => {
    const weekdays = rule({ kind: 'time', at: '09:30', days: [1, 2, 3, 4, 5] });
    const weekend = rule({ kind: 'time', at: '09:30', days: [0, 6] });
    expect(timeDue(weekdays, at(9, 30))).toBe(true); // Tuesday
    expect(timeDue(weekend, at(9, 30))).toBe(false);
    expect(timeDue(weekend, at(9, 30, 0, 24))).toBe(true); // Saturday
    expect(timeDue(weekdays, at(9, 30, 0, 24))).toBe(false);
  });

  it('fires once in the minute: the saved last-fired stops a second run, even after a reload', () => {
    const ran = { ...nine, lastFired: at(9, 30, 2) };
    expect(timeDue(ran, at(9, 30, 40))).toBe(false);
    // Tomorrow's minute is a new one.
    expect(timeDue(ran, at(9, 30, 0, 21))).toBe(true);
    // It fires from firedRules without needing a previous look.
    expect(firedRules([nine], null, signals({ now: at(9, 30, 5) }))).toEqual([nine]);
    expect(firedRules([ran], null, signals({ now: at(9, 30, 5) }))).toEqual([]);
  });
});

describe('cooldown and loop protection', () => {
  const a = rule({ kind: 'streamStarts' }, [{ kind: 'stream', on: true }], { id: 'a' });

  it('lets a rule fire only once per cooldown', () => {
    const guard = newGuard();
    const chain = admit(guard, a, 1000)!;
    expect(chain).toEqual(['a']);
    recordRun(guard, a, 1000, chain);
    expect(admit(guard, a, 1000 + COOLDOWN_MS - 1)).toBeNull();
    expect(admit(guard, a, 1000 + COOLDOWN_MS)).toEqual(['a']);
  });

  it('keeps a rule from being set off by something it made happen itself', () => {
    const guard = newGuard();
    const loop = rule({ kind: 'recordStarts' }, [{ kind: 'record', on: true }], { id: 'loop' });
    recordRun(guard, loop, 0, admit(guard, loop, 0)!);
    // It started recording, which is its own trigger: blocked, whatever the cooldown says.
    expect(admit(guard, loop, CAUSE_MS - 1)).toBeNull();
    // Once the cause has been forgotten and the cooldown is over, a real new event goes through.
    expect(admit(guard, loop, Math.max(COOLDOWN_MS, CAUSE_MS) + 1)).toEqual(['loop']);
  });

  it('stops two rules that set each other off', () => {
    const guard = newGuard();
    // A: a focus round starts -> start recording.  B: recording starts -> start a focus round.
    const a1 = rule({ kind: 'focusStarts' }, [{ kind: 'record', on: true }], { id: 'a1' });
    const b1 = rule({ kind: 'recordStarts' }, [{ kind: 'focus' }], { id: 'b1' });
    const first = admit(guard, a1, 0)!;
    recordRun(guard, a1, 0, first);
    const second = admit(guard, b1, 100)!; // a real chain: allowed
    expect(second).toEqual(['a1', 'b1']);
    recordRun(guard, b1, 100, second);
    // B's focus round is what A waits for; A is already in the chain, so it can't come round again.
    expect(admit(guard, a1, 200)).toBeNull();
  });

  it('lets a chain run, but only so far', () => {
    const guard = newGuard();
    // Each one's step makes the next one's trigger happen: recording, a focus round, recording...
    const kinds: AutomationWhen[] = [{ kind: 'recordStarts' }, { kind: 'focusStarts' }, { kind: 'recordStarts' }, { kind: 'focusStarts' }, { kind: 'recordStarts' }];
    const thens: AutomationThen[] = [{ kind: 'focus' }, { kind: 'record', on: true }, { kind: 'focus' }, { kind: 'record', on: true }, { kind: 'focus' }];
    const rules = kinds.map((k, i) => rule(k, [thens[i]], { id: `c${i}` }));
    let admitted = 0;
    for (const r of rules) {
      const chain = admit(guard, r, admitted * 10);
      if (!chain) break;
      recordRun(guard, r, admitted * 10, chain);
      admitted++;
    }
    expect(admitted).toBe(MAX_CHAIN);
  });

  it('forgets a cause after a few seconds, so a real later event is not blocked', () => {
    const guard = newGuard();
    const maker = rule({ kind: 'streamStarts' }, [{ kind: 'record', on: true }], { id: 'maker' });
    const waiter = rule({ kind: 'recordStarts' }, [{ kind: 'stream', on: true }], { id: 'waiter' });
    recordRun(guard, maker, 0, admit(guard, maker, 0)!);
    expect(admit(guard, waiter, 1)).toEqual(['maker', 'waiter']);
    expect(admit(guard, waiter, CAUSE_MS + 1)).toEqual(['waiter']);
  });
});

describe('running the steps', () => {
  const runner = (log: string[], over: Partial<Runner> = {}): Runner => ({
    preset: (p) => (log.push(`preset ${p}`), { message: `switched to ${p}`, undo: () => void log.push(`undo preset ${p}`) }),
    stream: (on) => (log.push(`stream ${on}`), { message: `stream ${on}`, undo: () => void log.push(`undo stream ${on}`) }),
    scene: async (s) => {
      await Promise.resolve();
      log.push(`scene ${s}`);
      return { message: `scene ${s}` };
    },
    record: (on) => (log.push(`record ${on}`), { message: `record ${on}` }),
    focus: () => (log.push('focus'), { message: 'focus' }),
    note: (t) => (log.push(`note ${t}`), { message: t }),
    ...over,
  });

  it('does the steps in order, waiting for each one', async () => {
    const log: string[] = [];
    const r = rule({ kind: 'streamStarts' }, [
      { kind: 'preset', preset: 'smite2' },
      { kind: 'scene', scene: 'Game' },
      { kind: 'stream', on: true },
      { kind: 'record', on: true },
      { kind: 'focus' },
      { kind: 'note', text: 'Good luck' },
    ]);
    const result = await runRule(r, runner(log));
    expect(log).toEqual(['preset smite2', 'scene Game', 'stream true', 'record true', 'focus', 'note Good luck']);
    expect(result.message).toBe('switched to smite2, scene Game, stream true, record true, focus, Good luck');
  });

  it('undoes what can be undone, last first', async () => {
    const log: string[] = [];
    const r = rule({ kind: 'streamStarts' }, [
      { kind: 'preset', preset: 'wow' },
      { kind: 'note', text: 'x' },
      { kind: 'stream', on: true },
    ]);
    const result = await runRule(r, runner(log));
    log.length = 0;
    result.undo!();
    expect(log).toEqual(['undo stream true', 'undo preset wow']);
  });

  it('has no undo when nothing can be taken back', async () => {
    const result = await runRule(rule({ kind: 'streamStarts' }, [{ kind: 'note', text: 'hello' }]), runner([]));
    expect(result.message).toBe('hello');
    expect(result.undo).toBeUndefined();
  });

  it('carries on after a step fails', async () => {
    const log: string[] = [];
    const boom = vi.fn(() => {
      throw new Error('no');
    });
    const r = rule({ kind: 'streamStarts' }, [
      { kind: 'scene', scene: 'A' },
      { kind: 'note', text: 'after' },
    ]);
    const result = await runRule(r, runner(log, { scene: boom }));
    expect(boom).toHaveBeenCalled();
    expect(log).toEqual(['note after']);
    expect(result.message).toBe('something went wrong, after');
  });
});

/** A default state with the desk preset's own focus timer taken out, so a test adds the only one. */
function stateWithoutTimers() {
  const state = defaultState();
  for (const d of Object.values(state.presets)) d.widgets = d.widgets.filter((w) => w.kind !== 'focus');
  return state;
}

describe('reading the world', () => {
  it('works out each preset game from its program and from Steam', () => {
    // mcd2 has both a program and a Steam name.
    expect(gameSignals(['mcd2'], ['dungeons.exe'], null)).toEqual({ mcd2: true });
    expect(gameSignals(['mcd2'], [], 'Minecraft Dungeons II')).toEqual({ mcd2: true });
    expect(gameSignals(['mcd2'], [], null)).toEqual({ mcd2: false });
    // Not known until both have answered, unless one already says yes.
    expect(gameSignals(['mcd2'], null, null)).toEqual({});
    expect(gameSignals(['mcd2'], [], undefined)).toEqual({});
    expect(gameSignals(['mcd2'], null, 'minecraft dungeons ii')).toEqual({ mcd2: true });
    // SMITE 2 is told by Steam alone.
    expect(gameSignals(['smite2'], null, 'SMITE 2')).toEqual({ smite2: true });
    expect(gameSignals(['smite2'], null, 'Other Game')).toEqual({ smite2: false });
    // A preset with no way to tell is left out.
    expect(gameSignals(['pokemon'], [], null)).toEqual({});
  });

  it('reads the focus timer from any widget on any preset', () => {
    const state = stateWithoutTimers();
    const now = 5_000_000;
    expect(focusSignal(state, now)).toBe('idle');
    const w = newWidget<FocusSettings>('focus');
    state.presets.desk.widgets.push(w);
    expect(focusSignal(state, now)).toBe('idle');
    w.settings.focusEndsAt = now + 60_000;
    expect(focusSignal(state, now)).toBe('work');
    w.settings.focusPhase = 'short';
    expect(focusSignal(state, now)).toBe('break');
    w.settings.focusEndsAt = 0;
    w.settings.focusLeft = 30_000;
    expect(focusSignal(state, now)).toBe('paused');
  });

  it('catches up a timer that ended while nobody looked', () => {
    const state = stateWithoutTimers();
    const w = newWidget<FocusSettings>('focus');
    w.settings.focusAuto = true;
    state.presets.desk.widgets.push(w);
    const now = 10_000_000;
    // A work round that ended 1 minute ago, with auto-start: the short break is now running.
    w.settings.focusEndsAt = now - 60_000;
    expect(focusSignal(state, now)).toBe('break');
  });

  it('starts a focus round on the timer of the preset showing', () => {
    const state = stateWithoutTimers();
    state.preset = 'desk';
    const w = newWidget<FocusSettings>('focus');
    state.presets.desk.widgets.push(w);
    const other = newWidget<FocusSettings>('focus');
    state.presets.wow.widgets.push(other);
    const now = 7_000_000;
    expect(startFocusRound(state, now)).toBe('started');
    expect(isRunning(stateOf(w.settings))).toBe(true);
    expect(w.settings.focusPhase).toBe('work');
    expect(isRunning(stateOf(other.settings))).toBe(false);
    // Already running: left alone.
    expect(startFocusRound(state, now + 1000)).toBe('already');
    expect(w.settings.focusEndsAt).toBe(now + 25 * 60_000);
  });

  it('starts the next round after a break, and says when there is no timer', () => {
    const state = stateWithoutTimers();
    expect(startFocusRound(state, 1)).toBe('none');
    const w = newWidget<FocusSettings>('focus');
    activePreset(state).data.widgets.push(w);
    w.settings.focusPhase = 'short';
    w.settings.focusRound = 1;
    expect(startFocusRound(state, 1000)).toBe('started');
    expect(w.settings.focusPhase).toBe('work');
    expect(w.settings.focusRound).toBe(2);
  });
});
