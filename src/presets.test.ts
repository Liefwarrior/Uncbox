import { describe, expect, it } from 'vitest';
import { PRESETS } from './presets';
import { defaultPresetData, defaultState, hydrate, hydratePreset, resetLayout } from './state/hydrate';
import { GRID_COLS, GRID_ROWS, isWidgetId, PRESET_IDS } from './state/model';
import { boardDef, newWidget, sizeOf, widgetDef, WIDGETS } from './widgets/registry';
import { isSingle } from './widgets/types';

describe('every built-in preset', () => {
  for (const id of PRESET_IDS) {
    it(`${PRESETS[id].name}: panels are on the board, big enough, apart, and each has something to draw`, () => {
      const { layout, widgets } = defaultPresetData(id);
      const cells = new Set<string>();
      for (const item of layout) {
        const { minW, minH } = sizeOf(item.i, widgets);
        expect(boardDef(item.i, widgets), `${item.i} is a kind in the library`).toBeDefined();
        expect(item.x).toBeGreaterThanOrEqual(0);
        expect(item.y).toBeGreaterThanOrEqual(0);
        expect(item.x + item.w).toBeLessThanOrEqual(GRID_COLS);
        expect(item.y + item.h).toBeLessThanOrEqual(GRID_ROWS);
        expect(item.w, `${item.i} width`).toBeGreaterThanOrEqual(minW);
        expect(item.h, `${item.i} height`).toBeGreaterThanOrEqual(minH);
        for (let x = item.x; x < item.x + item.w; x++) {
          for (let y = item.y; y < item.y + item.h; y++) {
            expect(cells.has(`${x},${y}`), `${item.i} overlaps another panel`).toBe(false);
            cells.add(`${x},${y}`);
          }
        }
        if (isWidgetId(item.i)) expect(widgets.some((w) => w.id === item.i), `${item.i} has no widget`).toBe(true);
      }
      expect(new Set(layout.map((item) => item.i)).size).toBe(layout.length);
      // Every widget the preset brings is on its board.
      for (const w of widgets) expect(layout.some((item) => item.i === w.id)).toBe(true);
    });

    it(`${PRESETS[id].name}: its widgets and renamed panels are all in the library`, () => {
      const def = PRESETS[id];
      for (const seed of def.widgets ?? []) {
        const kind = widgetDef(seed.kind);
        expect(kind, `${seed.id} is a ${seed.kind}`).toBeDefined();
        expect(kind && isSingle(kind), `${seed.kind} can be added more than once`).toBe(false);
      }
      for (const kind of Object.keys(def.titles)) {
        const found = widgetDef(kind);
        expect(found && isSingle(found), `${kind} is a single panel`).toBe(true);
      }
    });

    it(`${PRESETS[id].name}: starts from a hydrated copy of itself, unchanged`, () => {
      const fresh = defaultPresetData(id);
      expect(hydratePreset(id, JSON.parse(JSON.stringify(fresh)))).toEqual(fresh);
    });
  }

  it('every widget in the library names real presets', () => {
    for (const def of WIDGETS) for (const p of def.presets ?? []) expect(PRESET_IDS, `${def.kind} recommends ${p}`).toContain(p);
  });

  it('every preset has the panels it was built around recommended, and some widgets besides', () => {
    for (const id of PRESET_IDS) {
      const recommended = WIDGETS.filter((def) => def.presets?.includes(id));
      for (const item of PRESETS[id].layout.filter((i) => !isWidgetId(i.i))) {
        expect(recommended.some((def) => def.kind === item.i), `${id} recommends its own ${item.i} panel`).toBe(true);
      }
      expect(recommended.filter((def) => !isSingle(def)).length, `${id} recommends some widgets`).toBeGreaterThan(0);
    }
  });

  it('the game presets recommend Ping & FPS and OBS, Steam also Now playing and the Video downloader, and Desk a calendar and Gmail', () => {
    const wants = (preset: (typeof PRESET_IDS)[number], kind: string) => widgetDef(kind)?.presets?.includes(preset);
    expect(wants('smite2', 'network') && wants('smite2', 'obs')).toBe(true);
    expect(wants('steam', 'media') && wants('steam', 'downloads')).toBe(true);
    expect(wants('desk', 'calendar') && wants('desk', 'gmail')).toBe(true);
  });
});

describe('the Desk preset', () => {
  const kinds = ['web', 'drive', 'calendar', 'gmail', 'focus', 'launcher', 'media', 'notifications', 'clock', 'weather'];

  it('fills the whole board with no gaps', () => {
    const area = PRESETS.desk.layout.reduce((sum, item) => sum + item.w * item.h, 0);
    expect(area).toBe(GRID_COLS * GRID_ROWS);
  });

  it('has no game panel, and a big Web widget as the hero', () => {
    const { layout, widgets } = defaultPresetData('desk');
    expect(layout.some((item) => item.i === 'game')).toBe(false);
    const web = widgets.find((w) => w.kind === 'web');
    const hero = layout.find((item) => item.i === web?.id);
    const biggest = Math.max(...layout.map((item) => item.w * item.h));
    expect(hero && hero.w * hero.h).toBe(biggest);
  });

  it('brings the productivity widgets and a Notes panel', () => {
    const { layout, widgets } = defaultPresetData('desk');
    expect(widgets.map((w) => w.kind).sort()).toEqual([...kinds].sort());
    expect(layout.some((item) => item.i === 'notes')).toBe(true);
  });

  it('opens the Web widget on a site that allows framing, not Google', () => {
    const web = defaultPresetData('desk').widgets.find((w) => w.kind === 'web');
    expect(web?.settings.homeUrl).toMatch(/^https:\/\/en\.wikipedia\.org\//);
  });

  it('comes back from a saved state with its widgets and layout intact', () => {
    const state = defaultState();
    const back = hydrate(JSON.parse(JSON.stringify(state)));
    expect(back.presets.desk.widgets).toEqual(state.presets.desk.widgets);
    expect(back.presets.desk.layout).toEqual(state.presets.desk.layout);
    expect(back.presets.desk.widgets.map((w) => w.kind).sort()).toEqual([...kinds].sort());
  });

  it('is filled in for a save made before it existed', () => {
    const saved = JSON.parse(JSON.stringify(defaultState()));
    delete saved.presets.desk;
    const desk = hydrate(saved).presets.desk;
    expect(desk.widgets).toHaveLength(kinds.length);
    expect(desk.layout).toEqual(PRESETS.desk.layout);
  });

  it('gives each widget its settings back, and the rest of the board, after hydrating a hand-trimmed save', () => {
    const desk = hydratePreset('desk', { widgets: [{ id: 'wdg-deskclock', kind: 'clock', settings: {} }] });
    // Its layout was not saved, so the preset's own comes back with the widgets it uses.
    expect(desk.layout).toEqual(PRESETS.desk.layout);
    expect(desk.widgets).toHaveLength(kinds.length);
    const clock = desk.widgets.find((w) => w.id === 'wdg-deskclock')!;
    expect(clock.settings).toMatchObject({ timeZone: '', seconds: false });
    expect(desk.widgets.find((w) => w.kind === 'focus')!.settings.focusWork).toBe(25);
  });
});

describe('Reset layout', () => {
  it('restores the layout and the preset’s widgets, and drops added ones', () => {
    const d = defaultPresetData('desk');
    const added = newWidget('text');
    d.widgets = d.widgets.filter((w) => w.kind !== 'weather');
    d.widgets.push(added);
    d.layout = [{ i: added.id, x: 0, y: 0, w: 5, h: 3 }];
    d.notes = [];
    resetLayout(d, 'desk');
    const fresh = defaultPresetData('desk');
    expect(d.layout).toEqual(fresh.layout);
    expect(d.widgets).toEqual(fresh.widgets);
    expect(d.widgets.some((w) => w.id === added.id)).toBe(false);
    // Only the layout side resets: what you wrote stays.
    expect(d.notes).toEqual([]);
  });

  it('keeps the settings of the preset’s own widgets', () => {
    const d = defaultPresetData('desk');
    const web = d.widgets.find((w) => w.kind === 'web')!;
    web.settings.homeUrl = 'https://example.com/';
    web.title = 'Docs';
    d.layout = d.layout.filter((item) => item.i !== web.id);
    resetLayout(d, 'desk');
    const back = d.widgets.find((w) => w.id === web.id)!;
    expect(back.settings.homeUrl).toBe('https://example.com/');
    expect(back.title).toBe('Docs');
    expect(d.layout.some((item) => item.i === web.id)).toBe(true);
  });

  it('brings a hidden single panel back and loses a Window you added, in every preset', () => {
    for (const id of PRESET_IDS) {
      const d = defaultPresetData(id);
      const fresh = defaultPresetData(id);
      d.layout = [];
      const win = newWidget('window');
      d.widgets = [...d.widgets, win];
      d.layout.push({ i: win.id, x: 0, y: 0, w: 5, h: 5 });
      resetLayout(d, id);
      expect(d.layout, id).toEqual(fresh.layout);
      expect(d.widgets, id).toEqual(fresh.widgets);
    }
  });
});

describe('hydrating a board', () => {
  const widgetIds = (d: { widgets: { id: string }[] }) => d.widgets.map((w) => w.id).sort();

  it('drops a panel or widget of a kind this version does not know, and keeps the rest', () => {
    const fresh = defaultPresetData('steam');
    const saved = JSON.parse(JSON.stringify(fresh));
    saved.layout.push({ i: 'hologram', x: 0, y: 0, w: 4, h: 4 }, { i: 'wdg-future', x: 0, y: 0, w: 4, h: 4 });
    saved.widgets.push({ id: 'wdg-future', kind: 'hologram', title: '', settings: {} });
    const d = hydratePreset('steam', saved);
    expect(d.layout).toEqual(fresh.layout);
    expect(widgetIds(d)).toEqual(widgetIds(fresh));
  });

  it('does not take a widget kind as a panel, or a panel kind as a widget', () => {
    const saved = JSON.parse(JSON.stringify(defaultPresetData('pokemon')));
    // 'clock' is a widget (it needs an id of its own); 'game' is a panel (it has no widgets).
    saved.layout.push({ i: 'clock', x: 0, y: 0, w: 4, h: 4 });
    saved.widgets.push({ id: 'wdg-g', kind: 'game', title: '', settings: {} });
    saved.layout.push({ i: 'wdg-g', x: 0, y: 0, w: 4, h: 4 });
    const d = hydratePreset('pokemon', saved);
    expect(d.layout.some((item) => item.i === 'clock' || item.i === 'wdg-g')).toBe(false);
    expect(d.widgets.some((w) => w.id === 'wdg-g')).toBe(false);
  });

  it('uses the preset’s own board when nothing in a saved one can be drawn', () => {
    const d = hydratePreset('wow', { layout: [{ i: 'hologram', x: 0, y: 0, w: 4, h: 4 }, { i: 'wdg-gone', x: 4, y: 0, w: 4, h: 4 }] });
    expect(d.layout).toEqual(PRESETS.wow.layout);
  });

  it('leaves a board you emptied yourself empty', () => {
    expect(hydratePreset('wow', { layout: [] }).layout).toEqual([]);
  });

  it('squeezes a board that overlaps itself or runs off the bottom back on, or else uses the preset’s own', () => {
    const saved = JSON.parse(JSON.stringify(defaultPresetData('pokemon')));
    saved.layout = [
      { i: 'game', x: 0, y: 0, w: 17, h: 17 },
      { i: 'camera', x: 10, y: 5, w: 7, h: 7 },
      { i: 'chat', x: 17, y: 20, w: 7, h: 12 },
    ];
    const d = hydratePreset('pokemon', saved);
    const cells = new Set<string>();
    for (const item of d.layout) {
      expect(item.y + item.h, `${item.i} on the board`).toBeLessThanOrEqual(GRID_ROWS);
      expect(item.x + item.w).toBeLessThanOrEqual(GRID_COLS);
      for (let x = item.x; x < item.x + item.w; x++)
        for (let y = item.y; y < item.y + item.h; y++) {
          expect(cells.has(`${x},${y}`), `${item.i} overlaps`).toBe(false);
          cells.add(`${x},${y}`);
        }
    }
  });

  it('drops a widget that is not on the board, a repeated id, and a widget saved twice', () => {
    const saved = JSON.parse(JSON.stringify(defaultPresetData('pokemon')));
    saved.widgets = [
      { id: 'wdg-a', kind: 'text', title: 'first', settings: { text: 'one' } },
      { id: 'wdg-a', kind: 'text', title: 'second', settings: { text: 'two' } },
      { id: 'wdg-nowhere', kind: 'clock', title: '', settings: {} },
    ];
    saved.layout = [...saved.layout.slice(0, 3), { i: 'wdg-a', x: 0, y: 17, w: 5, h: 3 }, { i: 'wdg-a', x: 6, y: 17, w: 5, h: 3 }];
    const d = hydratePreset('pokemon', saved);
    expect(d.widgets.map((w) => [w.id, w.title])).toEqual([['wdg-a', 'first']]);
    expect(d.layout.filter((item) => item.i === 'wdg-a')).toHaveLength(1);
  });

  it('puts back the preset’s own widgets that its layout uses and a save has lost', () => {
    const saved = JSON.parse(JSON.stringify(defaultPresetData('steam')));
    saved.widgets = [];
    const d = hydratePreset('steam', saved);
    expect(widgetIds(d)).toEqual(['wdg-steamclock', 'wdg-steamsystem']);
  });
});
