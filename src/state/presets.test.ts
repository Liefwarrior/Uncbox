import { describe, expect, it } from 'vitest';
import { PRESETS } from '../presets';
import { defaultState } from './hydrate';
import { type AppState, MAX_CUSTOM } from './model';
import {
  activePreset,
  addCustom,
  canAddCustom,
  cleanName,
  copyOfActive,
  newCustomId,
  removeCustom,
  renameCustom,
  restoreCustom,
  takenNames,
  uniqueName,
} from './presets';

function withCustom(): AppState {
  const s = defaultState();
  addCustom(s, newCustomId(), 'My raid night', 'wow', structuredClone(s.presets.wow));
  return s;
}

describe('activePreset', () => {
  it('is the built-in preset when one is showing', () => {
    const s = defaultState();
    s.preset = 'smite2';
    const a = activePreset(s);
    expect(a).toMatchObject({ id: 'smite2', base: 'smite2' });
    expect(a.def).toBe(PRESETS.smite2);
    expect(a.data).toBe(s.presets.smite2);
  });

  it('resolves a custom copy to its base for the game, with its own name and data', () => {
    const s = withCustom();
    const a = activePreset(s);
    expect(a.id).toBe(s.preset);
    expect(a.base).toBe('wow');
    expect(a.def.id).toBe('wow');
    expect(a.def.name).toBe('My raid night');
    expect(a.def.slots).toBe(PRESETS.wow.slots);
    expect(a.def.titles).toBe(PRESETS.wow.titles);
    expect(a.data).toBe(s.custom[0].data);
    expect(a.data).not.toBe(s.presets.wow);
  });

  it('resolves a custom SMITE 2 copy to SMITE', () => {
    const s = defaultState();
    addCustom(s, newCustomId(), 'Ranked', 'smite2', s.presets.smite2);
    expect(activePreset(s)).toMatchObject({ base: 'smite2' });
    expect(activePreset(s).def.featured).toBe(PRESETS.smite2.featured);
  });

  it('falls back to a built-in preset if the custom one is missing', () => {
    const s = defaultState();
    s.preset = 'custom-gone';
    expect(activePreset(s)).toMatchObject({ id: 'pokemon', base: 'pokemon' });
  });
});

describe('names', () => {
  it('trims, flattens and shortens', () => {
    expect(cleanName('  a \n b  ')).toBe('a b');
    expect(cleanName('x'.repeat(100))).toHaveLength(60);
    expect(cleanName(7, 'fallback')).toBe('fallback');
    expect(cleanName('   ', 'fallback')).toBe('fallback');
  });

  it('adds a number when a name is taken, in any case', () => {
    expect(uniqueName('Fresh', ['Other'])).toBe('Fresh');
    expect(uniqueName('Fresh', ['fresh'])).toBe('Fresh 2');
    expect(uniqueName('Fresh', ['Fresh', 'Fresh 2'])).toBe('Fresh 3');
    expect(uniqueName('Fresh 2', ['Fresh 2'])).toBe('Fresh 3');
    expect(uniqueName('x'.repeat(60), ['x'.repeat(60)])).toHaveLength(60);
  });

  it('counts built-in names as taken', () => {
    expect(takenNames({ custom: [] })).toContain('WoW Forever');
    const s = defaultState();
    addCustom(s, newCustomId(), PRESETS.wow.name, 'wow', s.presets.wow);
    expect(s.custom[0].name).toBe('WoW Forever 2');
  });
});

describe('custom preset changes', () => {
  it('adds, shows, renames and removes', () => {
    const s = withCustom();
    const { id } = s.custom[0];
    expect(s.preset).toBe(id);
    renameCustom(s, id, '  Better name ');
    expect(s.custom[0].name).toBe('Better name');
    renameCustom(s, id, '   ');
    expect(s.custom[0].name).toBe('Better name');
    renameCustom(s, id, 'Pokémon');
    expect(s.custom[0].name).toBe('Pokémon 2');
    removeCustom(s, id);
    expect(s.custom).toEqual([]);
    expect(s.preset).toBe('wow');
  });

  it('puts a deleted preset back where it was', () => {
    const s = withCustom();
    addCustom(s, newCustomId(), 'Second', 'terminal', s.presets.terminal);
    const first = s.custom[0];
    removeCustom(s, first.id);
    restoreCustom(s, first, 0, true);
    expect(s.custom.map((c) => c.name)).toEqual(['My raid night', 'Second']);
    expect(s.preset).toBe(first.id);
    restoreCustom(s, first, 0, false);
    expect(s.custom).toHaveLength(2);
  });

  it('stops at the limit', () => {
    const s = defaultState();
    for (let i = 0; i < MAX_CUSTOM + 5; i++) addCustom(s, newCustomId(), `P${i}`, 'terminal', s.presets.terminal);
    expect(s.custom).toHaveLength(MAX_CUSTOM);
    expect(canAddCustom(s)).toBe(false);
  });

  it('copies the active preset whole, pausing a running timer', () => {
    const s = defaultState();
    s.presets.pokemon.run.timer = { startedAt: Date.now() - 5000, elapsedMs: 1000 };
    s.presets.pokemon.counters[0].value = 4;
    const copy = copyOfActive(s);
    expect(copy.base).toBe('pokemon');
    expect(copy.data.counters[0].value).toBe(4);
    expect(copy.data.run.timer.startedAt).toBeNull();
    expect(copy.data.run.timer.elapsedMs).toBeGreaterThanOrEqual(6000);
    expect(s.presets.pokemon.run.timer.startedAt).not.toBeNull();
  });
});
