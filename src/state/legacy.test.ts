import { describe, expect, it } from 'vitest';
import cozyNow from '../../gallery/presets/cozy-desk.uncbox?raw';
import nuzlockeNow from '../../gallery/presets/nuzlocke-run.uncbox?raw';
import rankedNow from '../../gallery/presets/ranked-grind.uncbox?raw';
import steamNow from '../../gallery/presets/steam-couch.uncbox?raw';
import { fromPresetFile, parsePresetText, PRESET_FILE_VERSION, toPresetFile } from '../presetfile';
import { newWidget } from '../widgets/registry';
import cozyV1 from './fixtures/gallery-v1/cozy-desk.uncbox?raw';
import nuzlockeV1 from './fixtures/gallery-v1/nuzlocke-run.uncbox?raw';
import rankedV1 from './fixtures/gallery-v1/ranked-grind.uncbox?raw';
import steamV1 from './fixtures/gallery-v1/steam-couch.uncbox?raw';
import { defaultState, hydrate, hydratePreset } from './hydrate';

// Saves and preset files from before each widget kept its own settings (and before app windows
// were widgets) still load, and load as what writing them again would give.

const FILES = [
  ['cozy-desk', cozyV1, cozyNow],
  ['nuzlocke-run', nuzlockeV1, nuzlockeNow],
  ['ranked-grind', rankedV1, rankedNow],
  ['steam-couch', steamV1, steamNow],
] as const;

describe('preset files made by the first version', () => {
  for (const [name, old, current] of FILES) {
    it(`${name}: version 1 loads, and is the same preset as the version 2 file made from it`, () => {
      expect(JSON.parse(old).version).toBe(1);
      expect(JSON.parse(current).version).toBe(PRESET_FILE_VERSION);
      const was = parsePresetText(old);
      const now = parsePresetText(current);
      expect(was.ok && now.ok).toBe(true);
      if (!was.ok || !now.ok) return;
      expect(was.name).toBe(now.name);
      expect(was.base).toBe(now.base);
      expect(was.data).toEqual(now.data);
    });

    it(`${name}: saving the old file again writes the current one`, () => {
      const was = parsePresetText(old);
      if (!was.ok) throw new Error(was.error);
      const written = toPresetFile(was.name, was.base, was.data, new Date(JSON.parse(old).exportedAt));
      expect(written).toEqual(JSON.parse(current));
    });
  }

  it('the current files keep only each widget’s own settings', () => {
    const clock = JSON.parse(cozyNow).data.widgets.find((w: { kind: string }) => w.kind === 'clock');
    expect(Object.keys(clock.settings).sort()).toEqual(['hour12', 'seconds', 'timeZone']);
    expect(clock.type).toBeUndefined();
  });
});

describe('a save from before each widget kept its own settings', () => {
  /** A widget the way it was saved: `type`, and one struct of everyone's settings. */
  const legacy = (id: string, type: string, settings: Record<string, unknown> = {}, title = '') => ({
    id,
    type,
    title,
    settings: {
      timeZone: 'Europe/London',
      hour12: false,
      seconds: true,
      place: 'Austin, Texas',
      lat: 30.27,
      lon: -97.74,
      celsius: true,
      apps: 'Discord',
      showBody: true,
      target: 1700000000000,
      text: 'Raid night',
      pingTarget: '1.1.1.1',
      showRouter: false,
      focusWork: 50,
      focusShort: 10,
      focusLong: 20,
      focusRounds: 3,
      focusAuto: true,
      focusSound: false,
      focusPhase: 'short',
      focusRound: 2,
      focusEndsAt: 0,
      focusLeft: 4000,
      launcherTiles: ['tile-0123456789ab'],
      url: 'https://example.com/page',
      homeUrl: 'https://example.com/',
      searchEngine: 'bing',
      hideToolbar: true,
      zoom: 125,
      driveView: 'starred',
      calendarDays: 7,
      calendarHideAllDay: true,
      gmailOnlyUnread: true,
      gmailLabel: 'Label_9',
      showOnStream: true,
      ...settings,
    },
  });

  const load = (widgets: unknown[], windows: unknown[] = [], extraLayout: unknown[] = []) => {
    const saved = JSON.parse(JSON.stringify(defaultState()));
    const board = saved.presets.terminal;
    board.widgets = widgets;
    board.windows = windows;
    board.layout = [...(widgets as { id: string }[]).map((w, n) => ({ i: w.id, x: (n % 4) * 6, y: Math.floor(n / 4) * 6, w: 6, h: 6 })), ...extraLayout];
    return hydrate(saved).presets.terminal;
  };

  it('gives every widget its kind and only its own settings', () => {
    const d = load([
      legacy('wdg-clock', 'clock'),
      legacy('wdg-weather', 'weather'),
      legacy('wdg-focus', 'focus'),
      legacy('wdg-web', 'web'),
      legacy('wdg-cal', 'calendar'),
      legacy('wdg-mail', 'gmail'),
      legacy('wdg-net', 'network'),
      legacy('wdg-drive', 'drive'),
    ]);
    const by = (id: string) => d.widgets.find((w) => w.id === id)!;
    expect(d.widgets.map((w) => w.kind)).toEqual(['clock', 'weather', 'focus', 'web', 'calendar', 'gmail', 'network', 'drive']);
    expect(by('wdg-clock').settings).toEqual({ timeZone: 'Europe/London', hour12: false, seconds: true });
    expect(by('wdg-weather').settings).toEqual({ place: 'Austin, Texas', lat: 30.27, lon: -97.74, celsius: true });
    expect(by('wdg-focus').settings).toEqual({
      focusWork: 50,
      focusShort: 10,
      focusLong: 20,
      focusRounds: 3,
      focusAuto: true,
      focusSound: false,
      focusPhase: 'short',
      focusRound: 2,
      focusEndsAt: 0,
      focusLeft: 4000,
    });
    expect(by('wdg-web').settings).toEqual({ url: 'https://example.com/page', homeUrl: 'https://example.com/', searchEngine: 'bing', hideToolbar: true, zoom: 125 });
    // Calendar and Gmail each keep their own copy of the shared "show on stream".
    expect(by('wdg-cal').settings).toEqual({ calendarDays: 7, calendarHideAllDay: true, hour12: false, showOnStream: true });
    expect(by('wdg-mail').settings).toEqual({ gmailOnlyUnread: true, gmailLabel: 'Label_9', showOnStream: true });
    expect(by('wdg-net').settings).toEqual({ pingTarget: '1.1.1.1', showRouter: false });
    expect(by('wdg-drive').settings).toEqual({ driveView: 'starred' });
    for (const w of d.widgets) expect(w).not.toHaveProperty('type');
  });

  it('still cleans a kind’s settings (a web page that is not one, a day count that is not allowed)', () => {
    const d = load([legacy('wdg-web', 'web', { url: 'javascript:alert(1)', zoom: 9000 }), legacy('wdg-cal', 'calendar', { calendarDays: 5 })]);
    expect(d.widgets[0].settings).toMatchObject({ url: '', zoom: 200 });
    expect(d.widgets[1].settings).toMatchObject({ calendarDays: 3 });
  });

  it('turns app windows into widgets of the kind "window", keeping their place, name and picture settings', () => {
    const d = load(
      [legacy('wdg-clock', 'clock')],
      [
        { id: 'win-spotify', title: 'Spotify', fit: 'cover', crop: { top: 1, right: 2, bottom: 3, left: 4 } },
        { id: 'win-plain', title: 'App window', fit: 'contain', crop: { top: 0, right: 0, bottom: 0, left: 0 } },
        { id: 'win-odd', title: 5, fit: 'sideways' },
      ],
      [
        { i: 'win-spotify', x: 0, y: 12, w: 6, h: 6 },
        { i: 'win-plain', x: 6, y: 12, w: 6, h: 6 },
        { i: 'win-odd', x: 12, y: 12, w: 6, h: 6 },
        { i: 'win-missing', x: 18, y: 12, w: 6, h: 6 },
      ],
    );
    const windows = d.widgets.filter((w) => w.kind === 'window');
    expect(windows.map((w) => w.id)).toEqual(['wdg-spotify', 'wdg-plain', 'wdg-odd']);
    expect(windows[0]).toMatchObject({ title: 'Spotify', settings: { fit: 'cover', crop: { top: 1, right: 2, bottom: 3, left: 4 } } });
    // An untitled window is called what the library calls it.
    expect(windows[1].title).toBe('');
    expect(windows[2]).toMatchObject({ title: '', settings: { fit: 'contain' } });
    expect(d.layout.map((item) => item.i)).toEqual(['wdg-clock', 'wdg-spotify', 'wdg-plain', 'wdg-odd']);
    expect(d).not.toHaveProperty('windows');
  });

  it('does not let a window take the id of a widget', () => {
    const d = load([legacy('wdg-same', 'clock')], [{ id: 'win-same', title: 'X', fit: 'contain', crop: {} }], [{ i: 'win-same', x: 6, y: 12, w: 6, h: 6 }]);
    const ids = d.widgets.map((w) => w.id);
    expect(new Set(ids).size).toBe(2);
    expect(d.layout.map((item) => item.i).sort()).toEqual([...ids].sort());
  });

  it('reads a widget saved under "kind" the same way', () => {
    const fresh = newWidget('clock', { id: 'wdg-new', settings: { seconds: true } });
    const d = load([fresh]);
    expect(d.widgets).toEqual([fresh]);
  });

  it('reads an imported version 1 file the same way', () => {
    const file = {
      uncbox: 'preset',
      version: 1,
      name: 'Old',
      base: 'terminal',
      data: {
        widgets: [legacy('wdg-w', 'weather', {}, 'Home')],
        windows: [{ id: 'win-a', title: 'Chat', fit: 'cover', crop: { top: 0, right: 0, bottom: 0, left: 0 } }],
        layout: [
          { i: 'wdg-w', x: 0, y: 0, w: 6, h: 6 },
          { i: 'win-a', x: 6, y: 0, w: 6, h: 6 },
        ],
      },
    };
    const r = fromPresetFile(file);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Sharing takes the weather place out.
    expect(r.data.widgets.map((w) => [w.id, w.kind, w.title])).toEqual([
      ['wdg-w', 'weather', 'Home'],
      ['wdg-a', 'window', 'Chat'],
    ]);
    expect(r.data.widgets[0].settings).toEqual({ place: '', lat: 0, lon: 0, celsius: true });
  });

  it('a hand-edited preset can not carry a kind this version lacks into the board', () => {
    const d = hydratePreset('terminal', { widgets: [{ id: 'wdg-x', kind: 'rm-rf', settings: {} }], layout: [{ i: 'wdg-x', x: 0, y: 0, w: 6, h: 6 }] });
    expect(d.widgets).toEqual([]);
    expect(d.layout.some((item) => item.i === 'wdg-x')).toBe(false);
  });
});
