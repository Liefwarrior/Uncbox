import { describe, expect, it } from 'vitest';
import { GRID_COLS, GRID_ROWS, isWidgetId, PRESET_IDS } from '../state/model';
import { boardDef, MULTI_KINDS, newWidget, panelTitle, settingsFor, SINGLE_KINDS, sizeOf, widgetDef, widgetForSharing, WIDGETS, widgetTitle } from './registry';
import { CATEGORIES, isSingle } from './types';
import { PRESETS } from '../presets';

describe('the widget library', () => {
  it('has a unique, plain kind for everything', () => {
    const kinds = WIDGETS.map((def) => def.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const kind of kinds) expect(kind, kind).toMatch(/^[a-z][a-z0-9]*$/);
    // 'wdg-…' ids are widgets; a kind can never look like one.
    for (const kind of kinds) expect(isWidgetId(kind)).toBe(false);
    expect([...SINGLE_KINDS, ...MULTI_KINDS].sort()).toEqual([...kinds].sort());
  });

  it('keeps the layout ids panels have always had', () => {
    expect([...SINGLE_KINDS].sort()).toEqual(
      ['game', 'camera', 'chat', 'slots', 'run', 'progress', 'notes', 'match', 'record', 'character', 'discord', 'quests', 'steam', 'hud', 'teams', 'scoreboard', 'damage'].sort(),
    );
  });

  it('describes everything in plain words, in a category the library has', () => {
    for (const def of WIDGETS) {
      expect(def.name.trim(), `${def.kind} name`).not.toBe('');
      expect(def.hint.trim(), `${def.kind} hint`).not.toBe('');
      expect(def.hint, `${def.kind} hint is one line`).not.toMatch(/\n/);
      expect(CATEGORIES, def.kind).toContain(def.category);
      for (const p of def.presets ?? []) expect(PRESET_IDS, `${def.kind} recommends ${p}`).toContain(p);
    }
  });

  it('uses every category it lists', () => {
    for (const name of CATEGORIES) expect(WIDGETS.some((def) => def.category === name), name).toBe(true);
  });

  it('gives everything a size that fits the board, from its smallest up', () => {
    for (const def of WIDGETS) {
      expect(def.minW, def.kind).toBeGreaterThanOrEqual(1);
      expect(def.minH, def.kind).toBeGreaterThanOrEqual(1);
      expect(def.w, def.kind).toBeGreaterThanOrEqual(def.minW);
      expect(def.h, def.kind).toBeGreaterThanOrEqual(def.minH);
      expect(def.w, def.kind).toBeLessThanOrEqual(GRID_COLS);
      expect(def.h, def.kind).toBeLessThanOrEqual(GRID_ROWS);
    }
  });

  it('draws every single panel with `panel`, and every other widget with exactly one of `body` and `panel`', () => {
    for (const def of WIDGETS) {
      if (isSingle(def)) expect(def.panel, def.kind).toBeTypeOf('function');
      else expect([def.body, def.panel].filter(Boolean), def.kind).toHaveLength(1);
    }
  });

  it('gives every widget kind its own defaults, fresh each time, that survive being cleaned and saved', () => {
    for (const kind of MULTI_KINDS) {
      const def = widgetDef(kind)!;
      if (isSingle(def)) continue;
      const a = def.defaults();
      const b = def.defaults();
      expect(a, kind).toEqual(b);
      expect(a, kind).not.toBe(b);
      expect(settingsFor(def, a), kind).toEqual(a);
      expect(settingsFor(def, JSON.parse(JSON.stringify(a))), kind).toEqual(a);
      // Rubbish in, defaults out: cleaning never throws and keeps nothing that is not the kind's.
      const junk = settingsFor(def, { nonsense: 1, text: 5, lat: 'far', url: ['x'], crop: 7, launcherTiles: 'no' });
      expect(Object.keys(junk).sort(), kind).toEqual(Object.keys(a).sort());
      expect(settingsFor(def, junk), kind).toEqual(junk);
    }
  });

  it('a widget form of a kind only offers what it can use', () => {
    for (const def of WIDGETS) {
      if (isSingle(def)) continue;
      // `empty` and `menu` are about the shell around a body.
      if (def.empty) expect(def.empty(def.defaults()), def.kind).toBeTypeOf('boolean');
      if (def.menu) expect(def.menu({ open: false, toggle: () => {} }).length, def.kind).toBeGreaterThan(0);
    }
  });
});

describe('finding things on the board', () => {
  it('a single panel is found by its kind, a widget by its id', () => {
    const clock = newWidget('clock');
    expect(boardDef('game', [])?.kind).toBe('game');
    expect(boardDef(clock.id, [clock])?.kind).toBe('clock');
  });

  it('does not find a widget kind as a panel, a panel kind as a widget, or what does not exist', () => {
    const clock = newWidget('clock');
    expect(boardDef('clock', [clock])).toBeUndefined();
    expect(boardDef(clock.id, [])).toBeUndefined();
    expect(boardDef('wdg-nope', [clock])).toBeUndefined();
    expect(boardDef('hologram', [])).toBeUndefined();
    expect(widgetDef('hologram')).toBeUndefined();
    expect(boardDef('constructor', [])).toBeUndefined();
    expect(boardDef('__proto__', [])).toBeUndefined();
  });

  it('knows how big things are, and gives something unknown a small size so a board can still hold it', () => {
    expect(sizeOf('game')).toMatchObject({ w: 17, h: 17, minW: 6, minH: 6 });
    expect(sizeOf('hologram')).toMatchObject({ minW: 2, minH: 2 });
    const win = newWidget('window');
    expect(sizeOf(win.id, [win])).toMatchObject({ w: 7, h: 8 });
  });

  it('titles single panels the way the preset words them, and widgets by their own title or kind', () => {
    expect(panelTitle(PRESETS.smite2, 'slots')).toBe('Build');
    expect(panelTitle(PRESETS.pokemon, 'slots')).toBe('Party');
    const w = newWidget('weather');
    expect(widgetTitle(w)).toBe('Weather');
    expect(widgetTitle({ ...w, title: 'Home' })).toBe('Home');
  });
});

describe('making widgets', () => {
  it('gives each a new id and the kind’s defaults', () => {
    const a = newWidget('countdown');
    const b = newWidget('countdown');
    expect(a.id).not.toBe(b.id);
    expect(isWidgetId(a.id)).toBe(true);
    expect(a).toMatchObject({ kind: 'countdown', title: '', settings: { target: 0, text: '' } });
    expect(a.settings).not.toBe(b.settings);
  });

  it('lays the settings you give over the defaults', () => {
    expect(newWidget('focus', { settings: { focusWork: 50 } }).settings).toMatchObject({ focusWork: 50, focusShort: 5 });
    expect(newWidget('text', { id: 'wdg-mine', title: 'Rules' })).toMatchObject({ id: 'wdg-mine', title: 'Rules' });
  });

  it('will not make a panel there can only be one of, or a kind that does not exist', () => {
    expect(() => newWidget('game')).toThrow();
    expect(() => newWidget('hologram')).toThrow();
  });

  it('takes what is personal out of a widget going into a shared preset, by kind', () => {
    const weather = newWidget('weather', { settings: { place: 'Home', lat: 1, lon: 2, celsius: true } });
    expect(widgetForSharing(weather).settings).toEqual({ place: '', lat: 0, lon: 0, celsius: true });
    const text = newWidget('text', { settings: { text: 'hi' } });
    expect(widgetForSharing(text)).toBe(text);
    expect(weather.settings.place).toBe('Home');
  });
});
