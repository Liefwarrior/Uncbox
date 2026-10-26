import { describe, expect, it } from 'vitest';
import { PRESETS } from '../presets';
import { newWidget } from '../widgets/registry';
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
    // An app window takes the Discord panel's place.
    smite.widgets = [newWidget('window', { id: 'wdg-abc', title: 'Spotify', settings: { fit: 'cover', crop: { top: 5, right: 0, bottom: 0, left: 0 } } })];
    smite.layout = smite.layout.map((item) => (item.i === 'discord' ? { i: 'wdg-abc', x: 13, y: 17, w: 4, h: 7 } : item));
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
    expect(good.clips).toEqual({ enabled: false, key: 'F9', driveAuto: false, driveShare: false, sound: true, mic: 'default' });
    expect(good.presets.wow.game.nativeGame).toEqual({ process: 'WowClassic', title: 'World of Warcraft' });
    const bad = hydrate({
      version: 2,
      clips: { key: 'KeyW' },
      presets: { wow: { game: { nativeGame: { title: 'no process' } } }, smite2: { game: { nativeGame: 'x' } } },
    });
    expect(bad.clips).toEqual({ enabled: true, key: 'Equal', driveAuto: false, driveShare: false, sound: true, mic: 'default' });
    expect(hydrate({ version: 2, clips: { driveAuto: true, driveShare: 'yes' } }).clips).toMatchObject({ driveAuto: true, driveShare: false });
    expect(bad.presets.wow.game.nativeGame).toBeNull();
    expect(bad.presets.smite2.game.nativeGame).toBeNull();
  });

  it('keeps the clip sound settings, "no mic" included, for a state saved before they existed too', () => {
    expect(hydrate({ version: 2, clips: { sound: false, mic: 'device-1' } }).clips).toMatchObject({ sound: false, mic: 'device-1' });
    expect(hydrate({ version: 2, clips: { mic: null } }).clips.mic).toBeNull();
    expect(hydrate({ version: 2, clips: { mic: '' } }).clips.mic).toBe('default');
    expect(hydrate({ version: 2, clips: { mic: 5, sound: 'yes' } }).clips).toMatchObject({ sound: true, mic: 'default' });
    expect(hydrate({ version: 2, clips: { key: 'F9' } }).clips).toMatchObject({ sound: true, mic: 'default' });
  });

  describe('presets of your own', () => {
    const mine = (over: Record<string, unknown> = {}) => ({ id: 'custom-a', name: 'Mine', base: 'wow', data: {}, ...over });

    it('keeps them, with the base and name, and leaves old saves alone', () => {
      const saved = defaultState();
      saved.custom = [{ id: 'custom-a', name: 'Raid night', base: 'wow', data: structuredClone(saved.presets.wow) }];
      saved.custom[0].data.run.title = 'Kronos';
      saved.preset = 'custom-a';
      expect(hydrate(JSON.parse(JSON.stringify(saved)))).toEqual(saved);

      const old = JSON.parse(JSON.stringify(defaultState()));
      delete old.custom;
      expect(hydrate(old).custom).toEqual([]);
    });

    it('cleans their data against the base', () => {
      const state = hydrate({
        version: 2,
        preset: 'custom-a',
        custom: [mine({ base: 'smite2', data: { match: { role: 'Tank', k: 'lots' }, background: 'lava-lamp' } })],
      });
      const p = state.custom[0].data;
      expect(p.match.role).toBe('');
      expect(p.match.k).toBe(0);
      expect(p.background).toBe('plain');
      expect(p.layout.length).toBe(PRESETS.smite2.layout.length);
    });

    it('drops bad entries and repeated ids, and tidies names', () => {
      const state = hydrate({
        version: 2,
        custom: [
          mine(),
          mine({ name: 'Same id' }),
          mine({ id: 'builtin-looking' }),
          mine({ id: 7 }),
          mine({ id: 'custom-b', base: 'nope' }),
          'junk',
          mine({ id: 'custom-c', name: '   ', base: 'steam' }),
          mine({ id: 'custom-d', name: 'x'.repeat(200) }),
        ],
      });
      expect(state.custom.map((c) => c.id)).toEqual(['custom-a', 'custom-c', 'custom-d']);
      expect(state.custom[1].name).toBe(PRESETS.steam.name);
      expect(state.custom[2].name).toHaveLength(60);
    });

    it('keeps at most 50', () => {
      const custom = Array.from({ length: 80 }, (_, i) => mine({ id: `custom-${i}` }));
      expect(hydrate({ version: 2, custom }).custom).toHaveLength(50);
    });

    it('shows a built-in preset when the one that was showing is gone', () => {
      expect(hydrate({ version: 2, preset: 'custom-gone', custom: [] }).preset).toBe('pokemon');
      expect(hydrate({ version: 2, preset: 'custom-a', custom: [mine({ base: 'nope' })] }).preset).toBe('pokemon');
      expect(hydrate({ version: 2, preset: 'custom-a', custom: [mine()] }).preset).toBe('custom-a');
      expect(hydrate({ version: 2, preset: 'wow', custom: [mine()] }).preset).toBe('wow');
    });
  });
});

describe('hydrate: focus and launcher widgets', () => {
  const load = (settings: unknown, kind = 'focus') => {
    const state = defaultState();
    state.presets.pokemon.widgets = [{ id: 'wdg-1', kind, title: '', settings }] as never;
    state.presets.pokemon.layout.push({ i: 'wdg-1', x: 0, y: 30, w: 6, h: 6 });
    return hydrate(JSON.parse(JSON.stringify(state))).presets.pokemon.widgets[0];
  };

  it('accepts both new types and fills in missing settings', () => {
    const focus = load({ focusWork: 50 });
    expect(focus.kind).toBe('focus');
    expect(focus.settings).toMatchObject({ focusWork: 50, focusShort: 5, focusLong: 15, focusRounds: 4, focusSound: true, focusPhase: 'work', focusRound: 1, focusEndsAt: 0 });
    const launcher = load({ launcherTiles: ['tile-0123456789ab', 7] }, 'launcher');
    expect(launcher.kind).toBe('launcher');
    expect(launcher.settings.launcherTiles).toEqual(['tile-0123456789ab']);
    expect(load({}, 'launcher').settings.launcherTiles).toEqual([]);
  });

  it('keeps a running timer so a reload carries on', () => {
    const s = load({ focusPhase: 'short', focusRound: 3, focusEndsAt: 1700000000000, focusLeft: 0 }).settings;
    expect(s).toMatchObject({ focusPhase: 'short', focusRound: 3, focusEndsAt: 1700000000000 });
  });

  it('repairs a phase that is not one', () => {
    expect(load({ focusPhase: 'nap', focusRound: -2 }).settings).toMatchObject({ focusPhase: 'work', focusRound: 1 });
  });
});

describe('hydrate: Google Drive widget', () => {
  const withDrive = (settings: unknown) => {
    const saved = JSON.parse(JSON.stringify(defaultState()));
    saved.presets.wow.widgets = [{ id: 'wdg-drive1', kind: 'drive', title: '', settings }];
    saved.presets.wow.layout.push({ i: 'wdg-drive1', x: 0, y: 30, w: 6, h: 6 });
    return hydrate(saved).presets.wow.widgets[0];
  };

  it('keeps the chosen view', () => {
    expect(withDrive({ driveView: 'starred' }).settings.driveView).toBe('starred');
  });

  it('falls back to Recent for a missing or unknown view', () => {
    expect(withDrive({}).settings.driveView).toBe('recent');
    expect(withDrive({ driveView: 'trash' }).settings.driveView).toBe('recent');
    expect(withDrive({ driveView: 7 }).settings.driveView).toBe('recent');
  });
});

describe('hydrate: Calendar and Gmail widgets', () => {
  const load = (kind: string, settings: unknown) => {
    const saved = JSON.parse(JSON.stringify(defaultState()));
    saved.presets.wow.widgets = [{ id: 'wdg-g1', kind, title: '', settings }];
    saved.presets.wow.layout.push({ i: 'wdg-g1', x: 0, y: 30, w: 6, h: 6 });
    return hydrate(saved).presets.wow.widgets[0];
  };

  it('accepts both types and fills in missing settings, keeping stream details off', () => {
    for (const kind of ['calendar', 'gmail']) {
      const w = load(kind, {});
      expect(w.kind).toBe(kind);
      expect(w.settings).toMatchObject({ showOnStream: false });
    }
    expect(load('calendar', {}).settings).toMatchObject({ calendarDays: 3, calendarHideAllDay: false });
    expect(load('gmail', {}).settings).toMatchObject({ gmailOnlyUnread: false, gmailLabel: 'INBOX' });
  });

  it('keeps what was chosen', () => {
    const s = load('calendar', { calendarDays: 7, calendarHideAllDay: true, showOnStream: true }).settings;
    expect(s).toMatchObject({ calendarDays: 7, calendarHideAllDay: true, showOnStream: true });
    expect(load('gmail', { gmailLabel: 'Label_12', gmailOnlyUnread: true }).settings).toMatchObject({ gmailLabel: 'Label_12', gmailOnlyUnread: true });
  });

  it('repairs a number of days or a label that is not one', () => {
    expect(load('calendar', { calendarDays: 5 }).settings.calendarDays).toBe(3);
    expect(load('calendar', { calendarDays: 'many' }).settings.calendarDays).toBe(3);
    expect(load('gmail', { gmailLabel: '../threads' }).settings.gmailLabel).toBe('INBOX');
    expect(load('gmail', { gmailLabel: '' }).settings.gmailLabel).toBe('INBOX');
  });
});

describe('hydrate: screen triggers', () => {
  const trigger = {
    id: 't1',
    label: 'You died',
    x: 25,
    y: 38,
    w: 50,
    h: 24,
    phrase: 'YOU DIED',
    regex: false,
    action: { kind: 'counter', counterId: 'c1' },
    enabled: true,
    cooldownSec: 8,
    at: 123,
  };
  const load = (triggers: unknown) => {
    const saved = JSON.parse(JSON.stringify(defaultState()));
    saved.presets.pokemon.triggers = triggers;
    return hydrate(saved).presets.pokemon.triggers;
  };

  it('starts with none, and older saves without the field get none', () => {
    const saved = JSON.parse(JSON.stringify(defaultState()));
    delete saved.presets.pokemon.triggers;
    expect(hydrate(saved).presets.pokemon.triggers).toEqual([]);
  });

  it('keeps a saved trigger as it was', () => {
    expect(load([trigger])).toEqual([trigger]);
    const nuzlocke = { ...trigger, phrase: '{name} fainted!', action: { kind: 'slotDown' } };
    expect(load([nuzlocke])).toEqual([nuzlocke]);
  });

  it('fills in missing fields and drops junk', () => {
    const [t] = load([{ phrase: 'WASTED' }, 'nope', 5]);
    expect(t).toMatchObject({ phrase: 'WASTED', regex: false, enabled: true, cooldownSec: 5, at: 0, action: { kind: 'counter', counterId: '' } });
    expect(load([{ phrase: 'x' }, 7, null])).toHaveLength(1);
    expect(load('not a list')).toEqual([]);
  });

  it('repairs a box off the picture, a strange action, a silly cooldown and a long phrase', () => {
    const [t] = load([{ ...trigger, x: -5, y: 90, w: 500, h: 50, action: { kind: 'format-disk' }, cooldownSec: 99999, phrase: 'x'.repeat(500) }]);
    expect(t).toMatchObject({ x: 0, y: 90, w: 100, h: 10, cooldownSec: 600, action: { kind: 'counter', counterId: '' } });
    expect(t.phrase).toHaveLength(120);
    expect(load([{ ...trigger, cooldownSec: 0 }])[0].cooldownSec).toBe(5);
    expect(load([{ ...trigger, cooldownSec: -3 }])[0].cooldownSec).toBe(1);
  });

  it('keeps at most 12', () => {
    expect(load(Array.from({ length: 30 }, (_, i) => ({ ...trigger, id: `t${i}` })))).toHaveLength(12);
  });
});
