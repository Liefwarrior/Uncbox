import { describe, expect, it } from 'vitest';
import { toPresetFile } from '../presetfile';
import { defaultState, hydrate } from '../state/hydrate';
import { type Automation, MAX_AUTOMATION_STEPS, MAX_AUTOMATIONS } from '../state/model';
import { daysText, GAME_PRESETS, hydrateAutomations, needsOf, SUGGESTIONS, thenText, timeText, whenText } from './rules';

const valid = (over: Record<string, unknown> = {}) => ({
  id: 'a',
  enabled: true,
  name: 'Mine',
  when: { kind: 'gameStarts', game: 'smite2' },
  then: [{ kind: 'preset', preset: 'smite2' }],
  lastFired: 123,
  ...over,
});

describe('sentences', () => {
  it('reads each kind of rule in plain words', () => {
    expect(whenText({ kind: 'gameStarts', game: 'smite2' })).toBe('SMITE 2 starts');
    expect(whenText({ kind: 'gameStops', game: 'any' })).toBe('a Steam game stops');
    expect(whenText({ kind: 'streamStarts' })).toBe('OBS starts streaming');
    expect(whenText({ kind: 'time', at: '21:30', days: [1, 2, 3, 4, 5] })).toBe('it’s 9:30 PM on weekdays');
    expect(whenText({ kind: 'breakStarts' })).toBe('a break starts');
    const custom = [{ id: 'custom-a', name: 'My SMITE', base: 'smite2', data: defaultState().presets.smite2 }] as ReturnType<typeof defaultState>['custom'];
    expect(thenText({ kind: 'preset', preset: 'smite2' }, [])).toBe('switch to the SMITE 2 preset');
    expect(thenText({ kind: 'preset', preset: 'custom-a' }, custom)).toBe('switch to the My SMITE preset');
    expect(thenText({ kind: 'stream', on: false }, [])).toBe('turn stream mode off');
    expect(thenText({ kind: 'note', text: 'GL' }, [])).toBe('show “GL”');
  });

  it('formats times and days', () => {
    expect(timeText('00:05')).toBe('12:05 AM');
    expect(timeText('12:00')).toBe('12:00 PM');
    expect(timeText('18:45')).toBe('6:45 PM');
    expect(daysText([])).toBe('every day');
    expect(daysText([0, 1, 2, 3, 4, 5, 6])).toBe('every day');
    expect(daysText([6, 0])).toBe('on weekends');
    expect(daysText([5, 1])).toBe('on Mon, Fri');
  });
});

describe('what the rules need', () => {
  const r = (when: Automation['when'], enabled = true): Automation => ({ id: 'x', enabled, name: '', when, then: [{ kind: 'focus' }], lastFired: 0 });

  it('watches nothing with no rules, or only rules that are off', () => {
    const none = { obs: false, steam: false, exes: [], time: false, focus: false, games: [] };
    expect(needsOf([])).toEqual(none);
    expect(needsOf([r({ kind: 'streamStarts' }, false), r({ kind: 'time', at: '10:00', days: [] }, false)])).toEqual(none);
  });

  it('asks only for what a rule uses', () => {
    expect(needsOf([r({ kind: 'recordStarts' })])).toMatchObject({ obs: true, steam: false, time: false });
    expect(needsOf([r({ kind: 'time', at: '10:00', days: [] })])).toMatchObject({ time: true, obs: false });
    expect(needsOf([r({ kind: 'breakStarts' })])).toMatchObject({ focus: true });
    expect(needsOf([r({ kind: 'gameStarts', game: 'any' })])).toMatchObject({ steam: true, exes: [], games: [] });
    expect(needsOf([r({ kind: 'gameStarts', game: 'mcd2' }), r({ kind: 'gameStops', game: 'mcd2' })])).toMatchObject({
      steam: true,
      exes: ['dungeons.exe'],
      games: ['mcd2'],
    });
  });
});

describe('suggestions', () => {
  it('makes a rule per game that can be told, and a stream mode rule', () => {
    const [games, live] = SUGGESTIONS;
    const made = games.make();
    expect(made.map((m) => m.when)).toEqual(GAME_PRESETS.map((game) => ({ kind: 'gameStarts', game })));
    expect(made.map((m) => m.then)).toEqual(GAME_PRESETS.map((preset) => [{ kind: 'preset', preset }]));
    expect(GAME_PRESETS).toContain('smite2');
    expect(new Set(made.map((m) => m.id)).size).toBe(made.length);
    expect(live.make()).toMatchObject([{ when: { kind: 'streamStarts' }, then: [{ kind: 'stream', on: true }], enabled: true }]);
    expect(hydrateAutomations(made)).toEqual(made);
  });
});

describe('hydration', () => {
  it('starts with none, and keeps good ones as saved', () => {
    expect(defaultState().automations).toEqual([]);
    expect(hydrate({ version: 2 }).automations).toEqual([]);
    const saved = [
      valid(),
      valid({
        id: 'b',
        when: { kind: 'time', at: '07:05', days: [1, 3] },
        then: [
          { kind: 'stream', on: true },
          { kind: 'note', text: 'Morning' },
        ],
      }),
    ];
    expect(hydrate({ version: 2, automations: JSON.parse(JSON.stringify(saved)) }).automations).toEqual(saved);
  });

  it('drops rules it cannot understand and fixes what it can', () => {
    const out = hydrateAutomations([
      'nonsense',
      valid({ id: 'no-when', when: { kind: 'nope' } }),
      valid({ id: 'bad-game', when: { kind: 'gameStarts', game: 'zelda' } }),
      valid({ id: 'bad-time', when: { kind: 'time', at: '25:99', days: [] } }),
      valid({ id: 'no-steps', then: [] }),
      valid({
        id: 'bad-steps',
        then: [
          { kind: 'preset', preset: 'zelda' },
          { kind: 'note', text: '   ' },
          { kind: 'scene', scene: '' },
        ],
      }),
      valid({
        id: 'fixed',
        enabled: 'maybe',
        name: 5,
        lastFired: 'yesterday',
        when: { kind: 'time', at: '09:00', days: [3, 3, 9, 'x', 1, 0, 2, 4, 5, 6] },
        then: [{ kind: 'bogus' }, { kind: 'scene', scene: 'Game' }],
      }),
    ]);
    expect(out).toEqual([
      { id: 'fixed', enabled: true, name: '', when: { kind: 'time', at: '09:00', days: [] }, then: [{ kind: 'scene', scene: 'Game' }], lastFired: 0 },
    ]);
  });

  it('gives duplicate and missing ids their own', () => {
    const out = hydrateAutomations([valid({ id: 'same' }), valid({ id: 'same' }), valid({ id: undefined })]);
    expect(new Set(out.map((r) => r.id)).size).toBe(3);
  });

  it('keeps custom preset ids, and caps the sizes', () => {
    const out = hydrateAutomations([valid({ then: [{ kind: 'preset', preset: 'custom-abc' }] })]);
    expect(out[0].then).toEqual([{ kind: 'preset', preset: 'custom-abc' }]);
    expect(hydrateAutomations([valid({ then: [{ kind: 'preset', preset: 'custom-' }] })])).toEqual([]);
    const many = Array.from({ length: MAX_AUTOMATIONS + 5 }, (_, i) => valid({ id: `r${i}` }));
    expect(hydrateAutomations(many)).toHaveLength(MAX_AUTOMATIONS);
    const long = hydrateAutomations([valid({ then: Array.from({ length: 20 }, () => ({ kind: 'focus' })) })]);
    expect(long[0].then).toHaveLength(MAX_AUTOMATION_STEPS);
    expect(hydrateAutomations([valid({ then: [{ kind: 'note', text: 'x'.repeat(500) }] })])[0].then[0]).toMatchObject({ text: 'x'.repeat(140) });
  });

  it('is app-wide: not part of a preset or its export', () => {
    const state = defaultState();
    state.automations = hydrateAutomations([valid()]);
    expect(JSON.stringify(toPresetFile('Test', 'smite2', state.presets.smite2))).not.toContain('Mine');
    expect(Object.keys(state.presets.smite2)).not.toContain('automations');
    expect(Object.keys(hydrate(JSON.parse(JSON.stringify(state))).presets.smite2)).not.toContain('automations');
  });
});
