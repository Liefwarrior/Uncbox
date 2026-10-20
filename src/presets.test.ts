import { describe, expect, it } from 'vitest';
import { sizeOf } from './panels/catalog';
import { PRESETS } from './presets';
import { defaultPresetData, defaultState, hydrate, hydratePreset, resetLayout } from './state/hydrate';
import { GRID_COLS, GRID_ROWS, isWidgetId, PRESET_IDS, type WidgetType } from './state/model';
import { newWidget } from './widgets/catalog';

describe('every built-in preset', () => {
  for (const id of PRESET_IDS) {
    it(`${PRESETS[id].name}: panels are on the board, big enough, apart, and each has something to draw`, () => {
      const { layout, widgets } = defaultPresetData(id);
      const cells = new Set<string>();
      for (const item of layout) {
        const { minW, minH } = sizeOf(item.i, widgets);
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
  }
});

describe('the Desk preset', () => {
  const widgetTypes: WidgetType[] = ['web', 'drive', 'focus', 'launcher', 'media', 'notifications', 'clock', 'weather'];

  it('fills the whole board with no gaps', () => {
    const area = PRESETS.desk.layout.reduce((sum, item) => sum + item.w * item.h, 0);
    expect(area).toBe(GRID_COLS * GRID_ROWS);
  });

  it('has no game panel, and a big Web widget as the hero', () => {
    const { layout, widgets } = defaultPresetData('desk');
    expect(layout.some((item) => item.i === 'game')).toBe(false);
    const web = widgets.find((w) => w.type === 'web');
    const hero = layout.find((item) => item.i === web?.id);
    const biggest = Math.max(...layout.map((item) => item.w * item.h));
    expect(hero && hero.w * hero.h).toBe(biggest);
  });

  it('brings the productivity widgets and a Notes panel', () => {
    const { layout, widgets } = defaultPresetData('desk');
    expect(widgets.map((w) => w.type).sort()).toEqual([...widgetTypes].sort());
    expect(layout.some((item) => item.i === 'notes')).toBe(true);
  });

  it('opens the Web widget on a site that allows framing, not Google', () => {
    const web = defaultPresetData('desk').widgets.find((w) => w.type === 'web');
    expect(web?.settings.homeUrl).toMatch(/^https:\/\/en\.wikipedia\.org\//);
  });

  it('comes back from a saved state with its widgets and layout intact', () => {
    const state = defaultState();
    const back = hydrate(JSON.parse(JSON.stringify(state)));
    expect(back.presets.desk.widgets).toEqual(state.presets.desk.widgets);
    expect(back.presets.desk.layout).toEqual(state.presets.desk.layout);
    expect(back.presets.desk.widgets.map((w) => w.type).sort()).toEqual([...widgetTypes].sort());
  });

  it('is filled in for a save made before it existed', () => {
    const saved = JSON.parse(JSON.stringify(defaultState()));
    delete saved.presets.desk;
    const desk = hydrate(saved).presets.desk;
    expect(desk.widgets).toHaveLength(widgetTypes.length);
    expect(desk.layout).toEqual(PRESETS.desk.layout);
  });

  it('gives each widget its settings back after hydrating a hand-trimmed save', () => {
    const desk = hydratePreset('desk', { widgets: [{ id: 'wdg-deskclock', type: 'clock', settings: {} }] });
    expect(desk.widgets).toHaveLength(1);
    expect(desk.widgets[0].settings.focusWork).toBe(25);
  });

  it('Reset layout restores the layout and the preset’s widgets, and drops added ones', () => {
    const d = defaultPresetData('desk');
    const added = newWidget('text');
    d.widgets = d.widgets.filter((w) => w.type !== 'weather');
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
});
