import { type BoardId, GRID_COLS, GRID_ROWS, type GridItem, isWidgetId, type PresetData, type Widget } from './state/model';
import { sizeOf } from './widgets/registry';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Shows or hides a single panel (a kind there is only one of: 'game', 'chat'…) of a preset being edited. */
export function setPanelShown(d: PresetData, kind: BoardId, on: boolean) {
  const shown = d.layout.some((item) => item.i === kind);
  if (on && !shown) d.layout.push(placePanel(d.layout, kind, d.widgets));
  else if (!on) d.layout = d.layout.filter((item) => item.i !== kind);
}

/** Adds a widget to a preset being edited, placed on the board. */
export function addWidgetTo(d: PresetData, widget: Widget) {
  d.widgets.push(widget);
  d.layout.push(placePanel(d.layout, widget.id, d.widgets));
}

/** What taking something off the board leaves behind, to put it back with restoreToBoard. */
export interface Removed {
  item?: GridItem;
  /** A widget is deleted with its panel; a single panel's data stays in the preset. */
  widget?: Widget;
}

/** Takes a panel or widget off the board of a preset being edited. */
export function removeFromBoard(d: PresetData, id: BoardId): Removed {
  const removed: Removed = { item: d.layout.find((it) => it.i === id) };
  d.layout = d.layout.filter((it) => it.i !== id);
  if (isWidgetId(id)) {
    removed.widget = d.widgets.find((w) => w.id === id);
    d.widgets = d.widgets.filter((w) => w.id !== id);
  }
  return removed;
}

/** Puts back what removeFromBoard took, where it was (unless something has taken the place or it is already back). */
export function restoreToBoard(d: PresetData, id: BoardId, removed: Removed) {
  if (removed.widget && !d.widgets.some((w) => w.id === id)) d.widgets.push(removed.widget);
  if (removed.item && !d.layout.some((it) => it.i === id)) d.layout.push(removed.item);
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

// ---------- keeping everything on the board ----------
//
// The board is the window, with nothing to scroll to, so a panel pushed past the last row or column
// is lost. Resizing and dragging go through the functions below, which shrink or shove the other
// panels instead, and refuse a change that cannot fit.

type Side = 'n' | 's' | 'e' | 'w';

const edgesOf = (r: Rect) => ({ left: r.x, right: r.x + r.w, top: r.y, bottom: r.y + r.h });

/** Every panel is inside the board, at least its minimum size, and clear of the others. */
export function isValid(items: GridItem[], widgets: Widget[]) {
  return items.every((a, n) => {
    const { minW, minH } = sizeOf(a.i, widgets);
    const inside = a.x >= 0 && a.y >= 0 && a.x + a.w <= GRID_COLS && a.y + a.h <= GRID_ROWS;
    return inside && a.w >= minW && a.h >= minH && items.every((b, m) => m <= n || !overlaps(a, b));
  });
}

/** The sides of `now` that have moved outward from `prev`: the ones that can run into a neighbour. */
function grownSides(prev: Rect, now: Rect): Side[] {
  const was = edgesOf(prev);
  const is = edgesOf(now);
  const sides: Side[] = [];
  if (is.right > was.right) sides.push('e');
  if (is.left < was.left) sides.push('w');
  if (is.bottom > was.bottom) sides.push('s');
  if (is.top < was.top) sides.push('n');
  return sides;
}

/**
 * Cuts `q` back from the side facing `p`. Its far edge stays put unless it would go under its
 * minimum size, in which case it keeps the minimum and slides on, which is how a push cascades.
 */
function cutBack(q: GridItem, p: Rect, side: Side, widgets: Widget[]) {
  const { minW, minH } = sizeOf(q.i, widgets);
  const at = edgesOf(p);
  const far = edgesOf(q);
  if (side === 'e') {
    q.x = at.right;
    q.w = Math.max(far.right, at.right + minW) - q.x;
  } else if (side === 'w') {
    q.x = Math.min(far.left, at.left - minW);
    q.w = at.left - q.x;
  } else if (side === 's') {
    q.y = at.bottom;
    q.h = Math.max(far.bottom, at.bottom + minH) - q.y;
  } else {
    q.y = Math.min(far.top, at.top - minH);
    q.h = at.top - q.y;
  }
}

/**
 * Settles the overlaps a change leaves behind, editing `items` in place. `moved` holds each panel
 * that changed and where it was. Every panel it now overlaps is cut back from the side facing it,
 * along the axis the edge travelled (the smaller overlap for a diagonal), and a panel that had to
 * slide is treated as a mover in turn. Panels in `frozen` are never cut. False if a panel has
 * nowhere to go.
 */
function settle(items: GridItem[], moved: { id: BoardId; prev: Rect }[], frozen: BoardId[], widgets: Widget[]) {
  for (let steps = 0; moved.length; steps++) {
    const mover = moved.shift();
    if (!mover || steps > 500) return false;
    const p = items.find((it) => it.i === mover.id);
    if (!p) continue;
    const sides = grownSides(mover.prev, p);
    const was = edgesOf(mover.prev);
    const now = edgesOf(p);
    for (const q of items) {
      if (q === p || !overlaps(p, q)) continue;
      const before = { x: q.x, y: q.y, w: q.w, h: q.h };
      const e = edgesOf(q);
      // How far each grown edge reaches into q, counting only the edges q lay beyond.
      const reach: [Side, number][] = [];
      if (sides.includes('e') && e.left >= was.right) reach.push(['e', now.right - e.left]);
      if (sides.includes('w') && e.right <= was.left) reach.push(['w', e.right - now.left]);
      if (sides.includes('s') && e.top >= was.bottom) reach.push(['s', now.bottom - e.top]);
      if (sides.includes('n') && e.bottom <= was.top) reach.push(['n', e.bottom - now.top]);
      const best = reach.reduce<[Side, number] | undefined>((m, r) => (!m || r[1] < m[1] ? r : m), undefined);
      if (!best || frozen.includes(q.i)) return false;
      cutBack(q, p, best[0], widgets);
      const after = edgesOf(q);
      if (after.left < 0 || after.top < 0 || after.right > GRID_COLS || after.bottom > GRID_ROWS) return false;
      moved.push({ id: q.i, prev: before });
    }
  }
  return true;
}

/** Lets the neighbours that were flush against an edge that moved in follow it, so no hole opens. */
function followEdges(items: GridItem[], r: GridItem, was: Rect) {
  const old = edgesOf(was);
  const now = edgesOf(r);
  const tucked = (lo: number, hi: number, from: number, to: number) => lo >= from && hi <= to;
  const follow = (q: GridItem, to: Rect) => {
    // A neighbour that would run into something else stays where it is: a gap is fine.
    if (!items.some((o) => o !== q && overlaps(to, o))) Object.assign(q, to);
  };
  for (const q of items) {
    if (q === r) continue;
    const e = edgesOf(q);
    const alongY = tucked(e.top, e.bottom, old.top, old.bottom);
    const alongX = tucked(e.left, e.right, old.left, old.right);
    if (now.right < old.right && e.left === old.right && alongY) {
      follow(q, { x: now.right, y: q.y, w: e.right - now.right, h: q.h });
    } else if (now.left > old.left && e.right === old.left && alongY) {
      follow(q, { x: q.x, y: q.y, w: now.left - q.x, h: q.h });
    } else if (now.bottom < old.bottom && e.top === old.bottom && alongX) {
      follow(q, { x: q.x, y: now.bottom, w: q.w, h: e.bottom - now.bottom });
    } else if (now.top > old.top && e.bottom === old.top && alongX) {
      follow(q, { x: q.x, y: q.y, w: q.w, h: now.top - q.y });
    }
  }
}

/** One axis of a wanted rect, kept on the board and at least `min` long, holding the edge that stayed put. */
function clampSpan(pos: number, len: number, min: number, total: number, from: number, fromLen: number) {
  let lo = Math.max(0, pos);
  let hi = Math.min(total, pos + len);
  if (hi - lo < min) {
    if (pos !== from && pos + len === from + fromLen) lo = hi - min;
    else hi = lo + min;
  }
  if (lo < 0) [lo, hi] = [0, min];
  if (hi > total) [lo, hi] = [total - min, total];
  return [lo, hi - lo];
}

/** Resizes `id` to exactly `want`, making room around it; null when the board cannot hold the result. */
export function tryResize<T extends GridItem>(start: T[], id: BoardId, want: Rect, widgets: Widget[] = []): T[] | null {
  const items = start.map((it) => ({ ...it }));
  const r = items.find((it) => it.i === id);
  if (!r) return null;
  const was = { x: r.x, y: r.y, w: r.w, h: r.h };
  Object.assign(r, want);
  if (!settle(items, [{ id, prev: was }], [id], widgets)) return null;
  followEdges(items, r, was);
  return isValid(items, widgets) ? items : null;
}

/**
 * The layout after resizing panel `id` to the rect `want`; `start` is the layout from before the
 * resize began. Growing cuts the panels in the way back from the side facing it, or pushes them
 * along at their minimum size, and the growth is capped where the board runs out of room.
 * Shrinking lets neighbours tucked against the edge follow it. Falls back to `start` if nothing
 * valid is found.
 */
export function fitResize<T extends GridItem>(start: T[], id: BoardId, want: Rect, widgets: Widget[] = []): T[] {
  const from = start.find((it) => it.i === id);
  if (!from) return start;
  const { minW, minH } = sizeOf(id, widgets);
  const [x, w] = clampSpan(want.x, want.w, minW, GRID_COLS, from.x, from.w);
  const [y, h] = clampSpan(want.y, want.h, minH, GRID_ROWS, from.y, from.h);
  // Step the rect back toward where it started, a cell at a time on each axis, until it fits.
  const toward = (v: number, goal: number, n: number) => v + Math.max(-n, Math.min(n, goal - v));
  const spanX = Math.max(Math.abs(x - from.x), Math.abs(x + w - from.x - from.w));
  const spanY = Math.max(Math.abs(y - from.y), Math.abs(y + h - from.y - from.h));
  for (let n = 0; n <= spanX + spanY; n++) {
    for (let a = Math.max(0, n - spanY); a <= Math.min(spanX, n); a++) {
      const b = n - a;
      const left = toward(x, from.x, a);
      const top = toward(y, from.y, b);
      const rect = {
        x: left,
        y: top,
        w: toward(x + w, from.x + from.w, a) - left,
        h: toward(y + h, from.y + from.h, b) - top,
      };
      const fitted = tryResize(start, id, rect, widgets);
      if (fitted) return fitted;
    }
  }
  return start;
}

/** Slides every panel up as far as it will go, the way a vertical compactor does. */
function compactUp<T extends GridItem>(layout: T[]): T[] {
  const items = layout.map((it) => ({ ...it }));
  const placed: T[] = [];
  for (const it of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    while (it.y > 0 && !placed.some((p) => overlaps({ ...it, y: it.y - 1 }, p))) it.y--;
    for (let hit = placed.find((p) => overlaps(it, p)); hit; hit = placed.find((p) => overlaps(it, p))) {
      it.y = hit.y + hit.h;
    }
    placed.push(it);
  }
  return items;
}

/**
 * Compacts the layout upward, then shrinks any panel that sticks out past the last row or column
 * (from its bottom or right, down to its minimum size, then up or left), cutting back whatever it
 * runs into. `keep` is a panel that must not change size, such as the one being dragged. Null if
 * the panels cannot all fit. Also repairs saved layouts that are already off the board.
 */
export function fitToBoard<T extends GridItem>(layout: T[], keep?: BoardId, widgets: Widget[] = []): T[] | null {
  const items = compactUp(layout);
  for (const it of items) {
    if (it.x + it.w <= GRID_COLS && it.y + it.h <= GRID_ROWS) continue;
    const { minW, minH } = sizeOf(it.i, widgets);
    const was = { x: it.x, y: it.y, w: it.w, h: it.h };
    if (it.x + it.w > GRID_COLS) {
      it.w = Math.min(it.w, Math.max(minW, GRID_COLS - it.x));
      it.x = Math.min(it.x, GRID_COLS - it.w);
    }
    if (it.y + it.h > GRID_ROWS) {
      it.h = Math.min(it.h, Math.max(minH, GRID_ROWS - it.y));
      it.y = Math.min(it.y, GRID_ROWS - it.h);
    }
    if (!settle(items, [{ id: it.i, prev: was }], keep ? [it.i, keep] : [it.i], widgets)) return null;
  }
  return isValid(items, widgets) ? items : null;
}
