import { describe, expect, it } from 'vitest';
import { PRESETS } from './presets';
import { forSharing, fromPresetFile, parsePresetText, presetFileName, toPresetFile } from './presetfile';
import { defaultPresetData } from './state/hydrate';
import type { PresetData } from './state/model';
import { defaultWidgetSettings } from './widgets/catalog';

/** A WoW preset that has been played: everything personal or progress-like filled in. */
function played(): PresetData {
  const d = defaultPresetData('wow');
  d.game = { ...d.game, source: 'native', deviceId: 'cam-1', nativeGame: { process: 'WowClassic', title: 'World of Warcraft' }, fit: 'cover', pixelated: true, chroma: '#112233' };
  d.game.crop.top = 7;
  d.run.title = 'Road to 60';
  d.run.timer = { startedAt: 1700000000000, elapsedMs: 123456 };
  d.slots[0] = { id: 's1', name: 'Thrall', detail: 'Level 20 Shaman', image: 'data:image/png;base64,AAAA', down: true };
  d.slots[1] = { id: 's2', name: 'Jaina', detail: '', image: 'https://tracker.example/pixel.png', down: false };
  d.counters = [{ id: 'c1', label: 'Deaths', value: 9 }];
  d.milestones.items[0].done = true;
  d.notes = [{ id: 'n1', text: 'Train spells', done: true }];
  d.match = { god: 'Thor', role: 'Jungle', mode: 'Ranked', k: 4, d: 1, a: 7 };
  d.record = { wins: 3, losses: 1, history: [{ id: 'h', god: 'Thor', role: 'Jungle', k: 1, d: 1, a: 1, win: true, at: 5 }] };
  d.character = { name: 'Lief', race: 'Orc', cls: 'Shaman', level: 33, maxLevel: 60, xp: 50, zone: 'Barrens', realm: 'Kronos', guild: 'Bumta Buds', gold: '12g', hardcore: true };
  d.quests = [{ title: 'Wanted', level: 5, state: 'open', objectives: [{ text: 'x 1/2', done: false }] }];
  d.wowLinkAt = 1700000000000;
  d.hud = [{ id: 'h1', label: 'Emeralds', x: 1, y: 2, w: 10, h: 5, numeric: true, value: '1234', at: 99 }];
  d.triggers = [{ id: 't1', label: 'You died', x: 25, y: 38, w: 50, h: 24, phrase: 'YOU DIED', regex: false, action: { kind: 'counter', counterId: 'c1' }, enabled: true, cooldownSec: 8, at: 1700000000000 }];
  d.background = 'stars';
  d.windows = [{ id: 'win-a', title: 'Spotify', fit: 'cover', crop: { top: 1, right: 2, bottom: 3, left: 4 } }];
  d.layout.push({ i: 'win-a', x: 0, y: 20, w: 5, h: 4 });
  const settings = defaultWidgetSettings();
  d.widgets = [
    { id: 'wdg-n', type: 'notifications', title: '', settings: { ...settings, apps: 'Discord' } },
    { id: 'wdg-w', type: 'weather', title: 'Home', settings: { ...settings, place: 'Springfield', lat: 1, lon: 2 } },
  ];
  return d;
}

describe('toPresetFile', () => {
  it('has a clear header', () => {
    const f = toPresetFile('My WoW', 'wow', played(), new Date('2026-01-02T03:04:05Z'));
    expect(f).toMatchObject({ uncbox: 'preset', version: 1, name: 'My WoW', base: 'wow', exportedAt: '2026-01-02T03:04:05.000Z' });
  });

  it('takes out what is personal or only true on this PC', () => {
    const d = forSharing(played(), 'wow');
    expect(d.game.deviceId).toBeNull();
    expect(d.game.nativeGame).toBeNull();
    expect(d.game.source).toBe('none');
    expect(d.run.timer).toEqual({ startedAt: null, elapsedMs: 0 });
    expect(d.match).toEqual(defaultPresetData('wow').match);
    expect(d.record).toEqual({ wins: 0, losses: 0, history: [] });
    expect(d.character).toMatchObject({ name: '', realm: '', guild: '', gold: '0g', level: 1, xp: 0, zone: 'Elwynn Forest' });
    expect(d.quests).toEqual([]);
    expect(d.wowLinkAt).toBe(0);
    expect(d.hud).toEqual([{ id: 'h1', label: 'Emeralds', x: 1, y: 2, w: 10, h: 5, numeric: true, value: '', at: 0 }]);
    expect(d.triggers).toEqual([{ ...played().triggers[0], at: 0 }]);
    expect(d.widgets[1].settings).toMatchObject({ place: '', lat: 0, lon: 0 });
    expect(d.slots[0].down).toBe(false);
    expect(d.slots[1].image).toBe('');
    expect(JSON.stringify(d)).not.toMatch(/Kronos|Bumta|Lief|cam-1|WowClassic|tracker\.example|Springfield/);
  });

  it('keeps the look and the setup', () => {
    const before = played();
    const d = forSharing(before, 'wow');
    expect(d.layout).toEqual(before.layout);
    expect(d.background).toBe('stars');
    expect(d.run.title).toBe('Road to 60');
    expect(d.slots[0]).toMatchObject({ name: 'Thrall', detail: 'Level 20 Shaman', image: 'data:image/png;base64,AAAA' });
    expect(d.counters).toEqual([{ id: 'c1', label: 'Deaths', value: 0 }]);
    expect(d.milestones.items.every((m) => !m.done)).toBe(true);
    expect(d.milestones.label).toBe(before.milestones.label);
    expect(d.notes).toEqual([{ id: 'n1', text: 'Train spells', done: false }]);
    expect(d.character).toMatchObject({ race: 'Orc', cls: 'Shaman', hardcore: true, maxLevel: 60 });
    expect(d.windows).toEqual(before.windows);
    expect(d.widgets[0].settings.apps).toBe('Discord');
    expect(d.widgets[1].title).toBe('Home');
    expect(d.game).toMatchObject({ fit: 'cover', pixelated: true, chroma: '#112233', crop: { top: 7, right: 0, bottom: 0, left: 0 } });
  });

  it('keeps a chroma source, and does not change what it was given', () => {
    const d = played();
    d.game.source = 'chroma';
    const snapshot = JSON.stringify(d);
    expect(forSharing(d, 'wow').game.source).toBe('chroma');
    expect(JSON.stringify(d)).toBe(snapshot);
  });
});

describe('fromPresetFile', () => {
  it('round-trips a preset through JSON text', () => {
    const fresh = defaultPresetData('pokemon');
    fresh.run.title = 'Emerald';
    fresh.background = 'stars';
    fresh.counters[0].label = 'Wipes';
    const text = JSON.stringify(toPresetFile('Mine', 'pokemon', fresh));
    const back = parsePresetText(text);
    expect(back).toMatchObject({ ok: true, name: 'Mine', base: 'pokemon' });
    expect(back.ok && back.data).toEqual(forSharing(fresh, 'pokemon'));
  });

  it('round-trips a played preset to the same stripped file', () => {
    const file = toPresetFile('Shared', 'wow', played(), new Date(0));
    const back = fromPresetFile(JSON.parse(JSON.stringify(file)));
    expect(back).toMatchObject({ ok: true, name: 'Shared', base: 'wow' });
    expect(back.ok && toPresetFile('Shared', 'wow', back.data, new Date(0))).toEqual(file);
  });

  it('refuses files that are not presets', () => {
    const bad = [null, 'hello', 42, [], {}, { uncbox: 'state', version: 1, data: {} }, { uncbox: 'preset', version: 1 }, { uncbox: 'preset', version: 1, data: 'x' }];
    for (const json of bad) {
      const r = fromPresetFile(json);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(10);
    }
    expect(parsePresetText('not json {').ok).toBe(false);
    expect(parsePresetText('x'.repeat(5 * 1024 * 1024 + 1)).ok).toBe(false);
  });

  it('refuses a version it does not know, with a plain message', () => {
    const r = fromPresetFile({ uncbox: 'preset', version: 2, name: 'x', base: 'wow', data: {} });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/newer Uncbox/);
    expect(fromPresetFile({ uncbox: 'preset', version: 0, data: {} }).ok).toBe(false);
    expect(fromPresetFile({ uncbox: 'preset', version: '1', data: {} }).ok).toBe(false);
  });

  it('falls back to a plain base when the base is unknown', () => {
    const r = fromPresetFile({ uncbox: 'preset', version: 1, name: 'From the future', base: 'diablo9', data: {} });
    expect(r).toMatchObject({ ok: true, base: 'terminal', name: 'From the future' });
  });

  it('cleans a hostile or hand-edited file like saved state', () => {
    const r = fromPresetFile(
      JSON.parse(`{
        "uncbox": "preset", "version": 1, "base": "steam",
        "name": "  Evil\\n\\n   name ${'!'.repeat(500)}",
        "data": {
          "game": { "source": "native", "deviceId": "my-camera", "nativeGame": { "process": "calc", "title": "Calculator" }, "fit": "sideways" },
          "run": { "timer": { "startedAt": 5, "elapsedMs": "lots" } },
          "layout": [
            { "i": "game", "x": 999, "y": -5, "w": 1, "h": 1 },
            { "i": "__proto__", "x": 0, "y": 0, "w": 4, "h": 4 },
            { "i": "win-ghost", "x": 0, "y": 0, "w": 4, "h": 4 }
          ],
          "background": "lava-lamp",
          "slots": [{ "id": "a", "name": 5, "detail": "ok", "image": "javascript:alert(1)", "down": "yes" }, "junk"],
          "wowLinkAt": 99,
          "quests": [{ "title": "q", "level": 1, "state": "open", "objectives": [] }],
          "record": { "wins": 50 },
          "__proto__": { "polluted": true },
          "extra": "ignored"
        }
      }`),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name.length).toBeLessThanOrEqual(60);
    expect(r.name).not.toMatch(/\n/);
    expect(r.data.game).toMatchObject({ source: 'none', deviceId: null, nativeGame: null, fit: 'contain' });
    expect(r.data.run.timer).toEqual({ startedAt: null, elapsedMs: 0 });
    expect(r.data.layout).toEqual([{ i: 'game', x: 18, y: 0, w: 6, h: 6 }]);
    expect(r.data.background).toBe('network');
    expect(r.data.slots[0]).toMatchObject({ name: '', detail: 'ok', image: '', down: false });
    expect(r.data.wowLinkAt).toBe(0);
    expect(r.data.quests).toEqual([]);
    expect(r.data.record.wins).toBe(0);
    expect(Object.keys(r.data).sort()).toEqual(Object.keys(defaultPresetData('steam')).sort());
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('uses the base name when the file gives none', () => {
    const r = fromPresetFile({ uncbox: 'preset', version: 1, name: '   ', base: 'wow', data: {} });
    expect(r).toMatchObject({ ok: true, name: PRESETS.wow.name });
  });
});

describe('presetFileName', () => {
  it('is the name plus .uncbox, safe for Windows', () => {
    expect(presetFileName('My WoW')).toBe('My WoW.uncbox');
    expect(presetFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij.uncbox');
    expect(presetFileName('  ... ')).toBe('Uncbox preset.uncbox');
  });
});
