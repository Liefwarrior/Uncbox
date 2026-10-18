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

  it('drops the panel below a full board', () => {
    const layout: GridItem[] = [{ i: 'game', x: 0, y: 0, w: GRID_COLS, h: 24 }];
    expect(placePanel(layout, 'chat')).toMatchObject({ x: 0, y: 24 });
  });
});
