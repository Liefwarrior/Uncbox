import { describe, expect, it } from 'vitest';
import { PRESETS } from '../presets';
import { defaultState, hydrate } from './hydrate';

/** Default slots and milestones get random ids, so compare everything else. */
const withoutIds = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'id' ? undefined : x)));

describe('hydrate', () => {
  it('starts fresh from nothing', () => {
    expect(withoutIds(hydrate(null))).toEqual(withoutIds(defaultState()));
    expect(withoutIds(hydrate('garbage'))).toEqual(withoutIds(defaultState()));
  });

  it('keeps everything a real version 2 save holds', () => {
    const saved = defaultState();
    saved.preset = 'smite2';
    saved.twitch = { channel: 'liefwarrior', hideBots: false };
    saved.camera = { enabled: true, deviceId: 'cam-1', mirrored: false };
    saved.discord.pinned = [{ id: '123456789012345678', name: 'Locker Room Heaven', guildId: '1', guildName: 'Bumta Buds' }];
    const smite = saved.presets.smite2;
    smite.match = { god: 'Thor', role: 'Jungle', mode: 'Ranked', k: 4, d: 1, a: 7 };
    smite.record = {
      wins: 3,
      losses: 1,
      history: [{ id: 'a', god: 'Thor', role: 'Jungle', k: 4, d: 1, a: 7, win: true, at: 1 }],
    };
    smite.windows = [{ id: 'win-abc', title: 'Spotify', fit: 'cover', crop: { top: 5, right: 0, bottom: 0, left: 0 } }];
    smite.layout = [...smite.layout, { i: 'win-abc', x: 0, y: 20, w: 5, h: 4 }];
    smite.run.timer = { startedAt: 1700000000000, elapsedMs: 5000 };
    smite.game.deviceId = 'capture-1';

    const round = hydrate(JSON.parse(JSON.stringify(saved)));
    expect(round).toEqual(saved);
  });

  it('fills in fields that older saves do not have', () => {
    const saved = JSON.parse(JSON.stringify(defaultState()));
    delete saved.discord;
    delete saved.presets.wow.character;
    const state = hydrate(saved);
    expect(state.discord.pinned).toEqual([]);
    expect(state.presets.wow.character.maxLevel).toBe(60);
  });

  it('drops layout entries for panels that no longer exist and clamps the rest', () => {
    const saved = JSON.parse(JSON.stringify(defaultState()));
    saved.presets.pokemon.layout = [
      { i: 'game', x: 30, y: -2, w: 1, h: 1 },
      { i: 'gone', x: 0, y: 0, w: 4, h: 4 },
      { i: 'win-missing', x: 0, y: 0, w: 4, h: 4 },
      { i: 'game', x: 0, y: 0, w: 4, h: 4 },
    ];
    const layout = hydrate(saved).presets.pokemon.layout;
    expect(layout).toEqual([{ i: 'game', x: 18, y: 0, w: 6, h: 6 }]);
  });

  it('rejects values of the wrong type', () => {
    const saved = JSON.parse(JSON.stringify(defaultState()));
    saved.presets.smite2.match.role = 'Tank';
    saved.presets.smite2.match.k = 'lots';
    saved.discord.pinned = [{ id: 'not-a-number', name: 'x' }];
    const state = hydrate(saved);
    expect(state.presets.smite2.match.role).toBe('');
    expect(state.presets.smite2.match.k).toBe(0);
    expect(state.discord.pinned).toEqual([]);
  });

  it('keeps a chosen background and drops one that no longer exists', () => {
    const saved = JSON.parse(JSON.stringify(defaultState()));
    saved.presets.smite2.background = 'stars';
    saved.presets.wow.background = 'lava-lamp';
    const state = hydrate(saved);
    expect(state.presets.smite2.background).toBe('stars');
    expect(state.presets.wow.background).toBe('plain');
  });

  it('adds presets that a save from before them does not have', () => {
    const saved = JSON.parse(JSON.stringify(defaultState()));
    delete saved.presets.terminal;
    const state = hydrate(saved);
    expect(state.presets.terminal.background).toBe('plain');
    expect(state.presets.terminal.layout.length).toBeGreaterThan(0);
  });

  it('moves a version 1 (PokéStream) save into the Pokémon preset', () => {
    const v1 = {
      game: { source: 'window', fit: 'cover', pixelated: true },
      party: [{ id: 'p1', name: 'Pikachu', detail: 'Lv 12', image: '', down: true }],
      counters: [{ id: 'c1', label: 'Deaths', value: 3 }],
      notes: [{ id: 'n1', text: 'No items', done: true }],
      milestones: { label: 'Gyms', done: [true, true, false] },
      run: { title: 'Emerald', subtitle: 'Nuzlocke', timer: { startedAt: null, elapsedMs: 60000 } },
      layout: { panels: { party: false, notes: true } },
      camera: { enabled: true, deviceId: 'cam', mirrored: false },
    };
    const state = hydrate(v1);
    const p = state.presets.pokemon;
    expect(state.version).toBe(2);
    expect(p.slots[0]).toMatchObject({ name: 'Pikachu', detail: 'Lv 12', down: true });
    expect(p.counters).toEqual([{ id: 'c1', label: 'Deaths', value: 3 }]);
    expect(p.notes[0]).toMatchObject({ text: 'No items', done: true });
    expect(p.milestones.label).toBe('Gyms');
    expect(p.milestones.items.map((m) => m.done)).toEqual([true, true, false]);
    expect(p.run.title).toBe('Emerald');
    expect(p.run.timer.elapsedMs).toBe(60000);
    expect(p.game.source).toBe('window');
    // The party panel was hidden in version 1, so it stays hidden.
    expect(p.layout.some((item) => item.i === 'slots')).toBe(false);
    expect(p.layout.length).toBe(PRESETS.pokemon.layout.length - 1);
    expect(state.camera).toEqual({ enabled: true, deviceId: 'cam', mirrored: false });
  });

  it('keeps the Play here game and the clip key, and drops bad ones', () => {
    const good = hydrate({
      version: 2,
      clips: { enabled: false, key: 'F9' },
      presets: { wow: { game: { source: 'native', nativeGame: { process: 'WowClassic', title: 'World of Warcraft' } } } },
    });
    expect(good.clips).toEqual({ enabled: false, key: 'F9' });
    expect(good.presets.wow.game.nativeGame).toEqual({ process: 'WowClassic', title: 'World of Warcraft' });
    const bad = hydrate({
      version: 2,
      clips: { key: 'KeyW' },
      presets: { wow: { game: { nativeGame: { title: 'no process' } } }, smite2: { game: { nativeGame: 'x' } } },
    });
    expect(bad.clips).toEqual({ enabled: true, key: 'Equal' });
    expect(bad.presets.wow.game.nativeGame).toBeNull();
    expect(bad.presets.smite2.game.nativeGame).toBeNull();
  });
});
