import { describe, expect, it } from 'vitest';
import { PRESET_IDS } from '../state/model';
import { librarySections, matchesQuery, recommendedWidgets } from './library';
import { widgetDef, WIDGETS } from './registry';
import { CATEGORIES } from './types';

const kinds = (defs: readonly { kind: string }[]) => defs.map((d) => d.kind);
const opts = { query: '', category: null, preset: 'smite2' as const, presetName: 'SMITE 2' };

describe('searching the library', () => {
  it('matches words that start a word of the name, hint, category or keywords', () => {
    const clock = widgetDef('clock')!;
    expect(matchesQuery(clock, 'clo')).toBe(true);
    expect(matchesQuery(clock, 'CLOCK')).toBe(true);
    expect(matchesQuery(clock, 'time timezone')).toBe(true);
    expect(matchesQuery(clock, 'media')).toBe(true); // its category
    expect(matchesQuery(clock, 'lock')).toBe(false); // not the start of a word
    expect(matchesQuery(clock, 'weather')).toBe(false);
  });

  it('matches everything for nothing typed, and finds by what a widget is for', () => {
    expect(WIDGETS.every((def) => matchesQuery(def, '  '))).toBe(true);
    expect(kinds(librarySections({ ...opts, query: 'pomodoro' }).flatMap((s) => s.defs))).toEqual(['focus']);
    expect(kinds(librarySections({ ...opts, query: 'ping' }).flatMap((s) => s.defs))).toContain('network');
  });

  it('says nothing found as no sections', () => {
    expect(librarySections({ ...opts, query: 'zzzz' })).toEqual([]);
  });

  it('searches within a chosen category', () => {
    const all = kinds(librarySections({ ...opts, query: 'a' }).flatMap((s) => s.defs));
    const some = librarySections({ ...opts, query: 'a', category: 'Streaming' }).flatMap((s) => s.defs);
    expect(some.every((d) => d.category === 'Streaming')).toBe(true);
    expect(some.length).toBeLessThan(all.length);
  });
});

describe('the library’s groups', () => {
  it('lists what the preset recommends first, then every other widget by category, none twice', () => {
    const sections = librarySections(opts);
    expect(sections[0].title).toBe('Recommended for SMITE 2');
    expect(kinds(sections[0].defs)).toEqual(kinds(recommendedWidgets('smite2')));
    const listed = kinds(sections.flatMap((s) => s.defs));
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.sort()).toEqual(kinds(WIDGETS).sort());
    expect(sections.slice(1).map((s) => s.title)).toEqual(CATEGORIES.filter((c) => sections.some((s) => s.title === c)));
  });

  it('shows a whole category, recommended or not, when a chip is picked', () => {
    const [only] = librarySections({ ...opts, category: 'SMITE 2' });
    expect(only.title).toBe('SMITE 2');
    expect(kinds(only.defs)).toEqual(['match', 'record', 'teams', 'scoreboard', 'damage']);
  });

  it('has recommendations for every preset', () => {
    for (const id of PRESET_IDS) expect(recommendedWidgets(id).length, id).toBeGreaterThan(0);
  });
});
