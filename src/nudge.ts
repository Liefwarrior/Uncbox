import type { Rect } from './layout';

const STEP: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * What an arrow key does to a panel on the board: the arrows move it one cell, Shift plus the
 * arrows make it one cell wider or taller (or narrower or shorter). Null for any other key. The
 * result goes through the same fitting as a mouse resize, which keeps it on the board.
 */
export function nudgeRect(item: Rect, key: string, resize: boolean): Rect | null {
  const step = STEP[key];
  if (!step) return null;
  const [dx, dy] = step;
  return resize ? { x: item.x, y: item.y, w: item.w + dx, h: item.h + dy } : { x: item.x + dx, y: item.y + dy, w: item.w, h: item.h };
}
