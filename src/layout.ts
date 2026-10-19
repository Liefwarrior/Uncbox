import { sizeOf } from './panels/catalog';
import { type BoardId, GRID_COLS, GRID_ROWS, type GridItem, type Widget } from './state/model';

function overlaps(a: { x: number; y: number; w: number; h: number }, b: GridItem) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Where a new w × h panel goes: the top-left-most free spot, trying smaller sizes before giving
 * up. Presets fill the whole board, so usually there is none; then the biggest panel that can
 * spare the room gives up its bottom (or right) part. The board is the window, and anything
 * below its last row would be out of sight. Changes the donor panel in layout, so pass the
 * layout being edited.
 */
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

  // The game panel is never cut into; everything else, biggest first.
  const donors = layout.filter((item) => item.i !== 'game').sort((a, b) => b.w * b.h - a.w * a.h);
  for (const d of donors) {
    const min = sizeOf(d.i, widgets);
    // Its bottom part, as wide as it is…
    const spareH = d.h - min.minH;
    if (spareH >= minH && d.w >= minW) {
      const take = Math.min(h, spareH);
      d.h -= take;
      return { i: id, x: d.x, y: d.y + d.h, w: d.w, h: take };
    }
    // …or its right part, as tall as it is.
    const spareW = d.w - min.minW;
    if (spareW >= minW && d.h >= minH) {
      const take = Math.min(w, spareW);
      d.w -= take;
      return { i: id, x: d.x + d.w, y: d.y, w: take, h: d.h };
    }
  }

  // Nothing can spare the room: put it underneath and let the user make space.
  const bottom = layout.reduce((m, item) => Math.max(m, item.y + item.h), 0);
  return { i: id, x: 0, y: bottom, w, h };
}
