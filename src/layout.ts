import { sizeOf } from './panels/catalog';
import { type BoardId, GRID_COLS, GRID_ROWS, type GridItem, type Widget } from './state/model';

function overlaps(a: { x: number; y: number; w: number; h: number }, b: GridItem) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Top-left-most free spot for a w × h panel, trying smaller sizes before giving up. */
export function placePanel(layout: GridItem[], id: BoardId, widgets: Widget[] = []): GridItem {
  const { w, h, minW, minH } = sizeOf(id, widgets);
  for (const [tw, th] of [
    [w, h],
    [Math.max(minW, Math.ceil(w / 2)), h],
    [w, Math.max(minH, Math.ceil(h / 2))],
    [minW, minH],
  ]) {
    for (let y = 0; y + th <= GRID_ROWS; y++) {
      for (let x = 0; x + tw <= GRID_COLS; x++) {
        const spot = { x, y, w: tw, h: th };
        if (!layout.some((item) => overlaps(spot, item))) return { i: id, ...spot };
      }
    }
  }
  // Board is full: drop it underneath and let the user make room.
  const bottom = layout.reduce((m, item) => Math.max(m, item.y + item.h), 0);
  return { i: id, x: 0, y: bottom, w, h };
}
