import { describe, expect, it } from 'vitest';
import { addWidgetTo, fitResize, fitToBoard, placePanel, type Rect, removeFromBoard, restoreToBoard, setPanelShown } from './layout';
import { defaultPresetData } from './state/hydrate';
import { newWidget, sizeOf } from './widgets/registry';
import { PRESETS } from './presets';
import { type BoardId, GRID_COLS, GRID_ROWS, type GridItem } from './state/model';

const overlaps = (a: GridItem, b: GridItem) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const at = (i: BoardId, x: number, y: number, w: number, h: number): GridItem => ({ i, x, y, w, h });
const find = (layout: GridItem[], id: BoardId) => {
  const item = layout.find((it) => it.i === id);
  if (!item) throw new Error(`no ${id} in layout`);
  return item;
};
const rectOf = ({ x, y, w, h }: GridItem) => ({ x, y, w, h });

/** The rules every result must follow: the same panels in the same order, on the board, at least minimum size, apart. */
function expectValid(layout: GridItem[], before: GridItem[]) {
  expect(layout.map((it) => it.i)).toEqual(before.map((it) => it.i));
  for (const [n, a] of layout.entries()) {
    const { minW, minH } = sizeOf(a.i);
    expect(a.x).toBeGreaterThanOrEqual(0);
    expect(a.y).toBeGreaterThanOrEqual(0);
    expect(a.x + a.w).toBeLessThanOrEqual(GRID_COLS);
    expect(a.y + a.h).toBeLessThanOrEqual(GRID_ROWS);
    expect(a.w).toBeGreaterThanOrEqual(minW);
    expect(a.h).toBeGreaterThanOrEqual(minH);
    for (const b of layout.slice(n + 1)) expect(overlaps(a, b), `${a.i} overlaps ${b.i}`).toBe(false);
  }
}

// A full-height row of panels, left to right.
const row = (...cells: [BoardId, number][]) => {
  let x = 0;
  return cells.map(([id, w]) => at(id, (x += w) - w, 0, w, GRID_ROWS));
};

describe('placePanel', () => {
  it('uses the full default size on an empty board', () => {
    const { w, h } = sizeOf('notes');
    expect(placePanel([], 'notes')).toEqual({ i: 'notes', x: 0, y: 0, w, h });
  });

  it('finds the top-left-most gap without overlapping anything', () => {
    const layout: GridItem[] = [{ i: 'game', x: 0, y: 0, w: 17, h: 24 }];
    const placed = placePanel(layout, 'camera');
    expect(placed).toMatchObject({ x: 17, y: 0 });
    expect(overlaps(placed, layout[0])).toBe(false);
  });

  it('shrinks toward the minimum size to fit a small gap', () => {
    const layout: GridItem[] = [{ i: 'game', x: 0, y: 0, w: GRID_COLS - 4, h: 24 }];
    const placed = placePanel(layout, 'notes');
    expect(placed.x).toBe(GRID_COLS - 4);
    expect(placed.w).toBe(sizeOf('notes').minW);
    expect(overlaps(placed, layout[0])).toBe(false);
  });

  it('takes room from the biggest panel on a full board, never the game', () => {
    const layout: GridItem[] = [
      { i: 'game', x: 0, y: 0, w: 17, h: 24 },
      { i: 'camera', x: 17, y: 0, w: 7, h: 7 },
      { i: 'chat', x: 17, y: 7, w: 7, h: 17 },
    ];
    const placed = placePanel(layout, 'steam');
    expect(placed).toMatchObject({ x: 17, w: 7 });
    expect(layout[0]).toEqual({ i: 'game', x: 0, y: 0, w: 17, h: 24 });
    expect(layout[2].h).toBeGreaterThanOrEqual(sizeOf('chat').minH);
    expect(placed.y).toBe(7 + layout[2].h);
    expect(placed.y + placed.h).toBe(24);
    for (const item of layout) expect(overlaps(placed, item)).toBe(false);
  });

  it('drops the panel below a full board', () => {
    const layout: GridItem[] = [{ i: 'game', x: 0, y: 0, w: GRID_COLS, h: 24 }];
    expect(placePanel(layout, 'chat')).toMatchObject({ x: 0, y: 24 });
  });
});

describe('fitResize: growing', () => {
  it('cuts back the neighbour in the way', () => {
    const start = row(['game', 12], ['chat', 12]);
    const next = fitResize(start, 'game', { x: 0, y: 0, w: 16, h: 24 });
    expect(rectOf(find(next, 'game'))).toEqual({ x: 0, y: 0, w: 16, h: 24 });
    expect(rectOf(find(next, 'chat'))).toEqual({ x: 16, y: 0, w: 8, h: 24 });
    expectValid(next, start);
  });

  it('pushes a neighbour already at its minimum, and the cascade carries on', () => {
    const start = row(['game', 8], ['chat', 4], ['run', 4], ['notes', 8]);
    const next = fitResize(start, 'game', { x: 0, y: 0, w: 10, h: 24 });
    expect(find(next, 'game').w).toBe(10);
    expect(rectOf(find(next, 'chat'))).toMatchObject({ x: 10, w: 4 });
    expect(rectOf(find(next, 'run'))).toMatchObject({ x: 14, w: 4 });
    expect(rectOf(find(next, 'notes'))).toMatchObject({ x: 18, w: 6 });
    expectValid(next, start);
  });

  it('caps the growth where nothing can give any more', () => {
    // Only the last panel has a spare column (4 wide, 3 is its minimum), so the game gets one.
    const start = row(['game', 8], ['chat', 4], ['run', 4], ['progress', 4], ['discord', 4]);
    const next = fitResize(start, 'game', { x: 0, y: 0, w: 14, h: 24 });
    expect(find(next, 'game').w).toBe(9);
    expect(find(next, 'discord')).toMatchObject({ x: 21, w: 3 });
    expectValid(next, start);
  });

  it('returns the layout unchanged when there is no room at all', () => {
    const start = row(['game', 8], ['chat', 4], ['run', 4], ['progress', 4], ['notes', 4]);
    expect(fitResize(start, 'game', { x: 0, y: 0, w: 12, h: 24 })).toEqual(start);
  });

  it('grows from the nw corner, moving x and y', () => {
    const start = [at('chat', 0, 0, 10, 24), at('camera', 10, 0, 14, 10), at('game', 10, 10, 14, 14)];
    const next = fitResize(start, 'game', { x: 6, y: 6, w: 18, h: 18 });
    expect(rectOf(find(next, 'game'))).toEqual({ x: 6, y: 6, w: 18, h: 18 });
    expect(rectOf(find(next, 'chat'))).toEqual({ x: 0, y: 0, w: 6, h: 24 });
    expect(rectOf(find(next, 'camera'))).toEqual({ x: 10, y: 0, w: 14, h: 6 });
    expectValid(next, start);
  });

  it('cuts a diagonal neighbour along the axis with the smaller overlap', () => {
    // Growing se into the corner panel reaches 2 columns but 5 rows into it.
    const start = [at('game', 0, 0, 10, 10), at('quests', 12, 15, 12, 9)];
    const next = fitResize(start, 'game', { x: 0, y: 0, w: 14, h: 20 });
    expect(rectOf(find(next, 'game'))).toEqual({ x: 0, y: 0, w: 14, h: 20 });
    expect(rectOf(find(next, 'quests'))).toEqual({ x: 14, y: 15, w: 10, h: 9 });
    expectValid(next, start);
  });

  it('clamps to the board and to the minimum size', () => {
    const start = row(['game', 12], ['chat', 12]);
    const wide = fitResize(start, 'chat', { x: 12, y: 0, w: 40, h: 40 });
    expect(rectOf(find(wide, 'chat'))).toEqual({ x: 12, y: 0, w: 12, h: 24 });
    const tiny = fitResize(start, 'chat', { x: 12, y: 0, w: 1, h: 1 });
    expect(find(tiny, 'chat')).toMatchObject({ w: sizeOf('chat').minW, h: sizeOf('chat').minH });
    expectValid(tiny, start);
  });
});

describe('fitResize: shrinking', () => {
  it('lets a tucked neighbour follow the edge, and leaves the others', () => {
    const start = PRESETS.pokemon.layout;
    const next = fitResize(start, 'game', { x: 0, y: 0, w: 12, h: 17 });
    // The camera sat flush against the game's right edge, inside its rows.
    expect(rectOf(find(next, 'camera'))).toEqual({ x: 12, y: 0, w: 12, h: 7 });
    // These stick out past the game's rows, so they stay and leave a gap.
    expect(find(next, 'slots')).toEqual(find(start, 'slots'));
    expect(find(next, 'chat')).toEqual(find(start, 'chat'));
    expectValid(next, start);
  });

  it('lets the row underneath follow a bottom edge pulled up', () => {
    const start = PRESETS.pokemon.layout;
    const next = fitResize(start, 'game', { x: 0, y: 0, w: 17, h: 12 });
    for (const id of ['run', 'progress', 'notes', 'discord'] as const) {
      expect(find(next, id)).toMatchObject({ y: 12, h: 12 });
    }
    expectValid(next, start);
  });

  it('leaves a neighbour that is not flush with the edge where it was', () => {
    const start = [at('game', 0, 0, 10, 24), at('chat', 12, 0, 12, 24)];
    const next = fitResize(start, 'game', { x: 0, y: 0, w: 6, h: 24 });
    expect(find(next, 'chat')).toEqual(find(start, 'chat'));
  });
});

describe('fitResize: every preset', () => {
  const sides = ['e', 'w', 's', 'n', 'se', 'sw', 'ne', 'nw'];
  const moved = (r: Rect, side: string, n: number): Rect => ({
    x: side.includes('w') ? r.x - n : r.x,
    y: side.includes('n') ? r.y - n : r.y,
    w: r.w + (side.includes('e') || side.includes('w') ? n : 0),
    h: r.h + (side.includes('s') || side.includes('n') ? n : 0),
  });

  for (const preset of Object.values(PRESETS)) {
    it(`${preset.name} stays valid for any resize of any panel`, () => {
      const start = preset.layout;
      for (const item of start) {
        for (const side of sides) {
          for (const n of [-6, -2, -1, 1, 2, 5, 9, 24]) {
            const want = moved(item, side, n);
            const next = fitResize(start, item.i, want);
            expectValid(next, start);
            // Growth never overshoots what was asked for.
            const got = find(next, item.i);
            expect(got.w).toBeLessThanOrEqual(Math.max(want.w, item.w));
            expect(got.h).toBeLessThanOrEqual(Math.max(want.h, item.h));
          }
        }
      }
    });

    it(`${preset.name} is unchanged by a resize to its own size`, () => {
      for (const item of preset.layout) expect(fitResize(preset.layout, item.i, rectOf(item))).toEqual(preset.layout);
    });
  }

  it('keeps the requested top edge when growing upward is possible', () => {
    const start = PRESETS.terminal.layout;
    const camera = find(start, 'camera');
    const next = fitResize(start, 'run', { x: 0, y: 12, w: 4, h: 12 });
    expect(find(next, 'run')).toMatchObject({ y: 12, h: 12 });
    expect(camera).toEqual(find(next, 'camera'));
    expectValid(next, start);
  });
});

describe('fitToBoard', () => {
  it('leaves the preset layouts alone', () => {
    for (const preset of Object.values(PRESETS)) expect(fitToBoard(preset.layout)).toEqual(preset.layout);
  });

  it('shrinks panels pushed past the last row', () => {
    // What vertical compaction does when the game is made taller.
    const start = PRESETS.pokemon.layout.map((it) => (it.i === 'game' ? { ...it, h: 20 } : it.y === 17 ? { ...it, y: 20 } : it));
    const next = fitToBoard(start);
    expect(next).not.toBeNull();
    if (!next) return;
    expect(find(next, 'game').h).toBe(20);
    expect(find(next, 'run')).toMatchObject({ y: 20, h: 4 });
    expectValid(next, start);
  });

  it('shrinks panels pushed past the last column', () => {
    const start = [at('game', 0, 0, 12, 24), at('chat', 20, 0, 7, 24)];
    const next = fitToBoard(start);
    expect(next && find(next, 'chat')).toMatchObject({ x: 20, w: 4 });
  });

  it('moves a panel up, cutting what is above, when its minimum height needs the room', () => {
    const start = [at('game', 0, 0, GRID_COLS, 21), at('run', 0, 21, GRID_COLS, 7)];
    const next = fitToBoard(start);
    expect(next && rectOf(find(next, 'run'))).toEqual({ x: 0, y: 20, w: GRID_COLS, h: 4 });
    expect(next && find(next, 'game').h).toBe(20);
    expectValid(next ?? [], start);
  });

  it('will not cut the panel it was told to keep', () => {
    const start = [at('game', 0, 0, GRID_COLS, 21), at('run', 0, 21, GRID_COLS, 7)];
    expect(fitToBoard(start, 'game')).toBeNull();
  });

  it('gives up when the minimum sizes cannot all fit', () => {
    const ids = ['game', 'match', 'character', 'record', 'run'] as const; // 6 + 6 + 6 + 5 + 4 rows, minimum
    let y = 0;
    const start = ids.map((id) => at(id, 0, (y += sizeOf(id).minH) - sizeOf(id).minH, GRID_COLS, sizeOf(id).minH));
    expect(fitToBoard(start)).toBeNull();
  });
});

describe('showing, adding and removing', () => {
  it('shows a hidden single panel once, and hides a shown one', () => {
    const d = defaultPresetData('smite2');
    setPanelShown(d, 'damage', true);
    setPanelShown(d, 'damage', true);
    expect(d.layout.filter((i) => i.i === 'damage')).toHaveLength(1);
    setPanelShown(d, 'damage', false);
    expect(d.layout.some((i) => i.i === 'damage')).toBe(false);
  });

  it('adds a widget with its panel, and takes both off again, and back', () => {
    const d = defaultPresetData('smite2');
    const w = newWidget('clock');
    addWidgetTo(d, w);
    expect(d.widgets).toContain(w);
    expect(d.layout.some((i) => i.i === w.id)).toBe(true);

    const removed = removeFromBoard(d, w.id);
    expect(d.widgets).not.toContain(w);
    expect(d.layout.some((i) => i.i === w.id)).toBe(false);
    restoreToBoard(d, w.id, removed);
    restoreToBoard(d, w.id, removed);
    expect(d.widgets.filter((x) => x.id === w.id)).toHaveLength(1);
    expect(d.layout.filter((i) => i.i === w.id)).toHaveLength(1);
  });

  it('removing a single panel leaves its data in the preset', () => {
    const d = defaultPresetData('smite2');
    d.notes = [{ id: 'n', text: 'keep me', done: false }];
    d.layout.push(placePanel(d.layout, 'notes'));
    const removed = removeFromBoard(d, 'notes');
    expect(removed.widget).toBeUndefined();
    expect(d.layout.some((i) => i.i === 'notes')).toBe(false);
    expect(d.notes).toHaveLength(1);
    restoreToBoard(d, 'notes', removed);
    expect(d.layout.some((i) => i.i === 'notes')).toBe(true);
  });
});

