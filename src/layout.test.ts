import { describe, expect, it } from 'vitest';
import { placePanel } from './layout';
import { PANEL_INFO } from './panels/catalog';
import { GRID_COLS, type GridItem } from './state/model';

const overlaps = (a: GridItem, b: GridItem) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('placePanel', () => {
  it('uses the full default size on an empty board', () => {
    const { w, h } = PANEL_INFO.notes;
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
    expect(placed.w).toBe(PANEL_INFO.notes.minW);
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
    expect(layout[2].h).toBeGreaterThanOrEqual(PANEL_INFO.chat.minH);
    expect(placed.y).toBe(7 + layout[2].h);
    expect(placed.y + placed.h).toBe(24);
    for (const item of layout) expect(overlaps(placed, item)).toBe(false);
  });

  it('drops the panel below a full board', () => {
    const layout: GridItem[] = [{ i: 'game', x: 0, y: 0, w: GRID_COLS, h: 24 }];
    expect(placePanel(layout, 'chat')).toMatchObject({ x: 0, y: 24 });
  });
});
