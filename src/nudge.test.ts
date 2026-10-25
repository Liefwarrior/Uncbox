import { describe, expect, it } from 'vitest';
import { fitResize } from './layout';
import { nudgeRect } from './nudge';
import { type GridItem } from './state/model';

const at = { x: 4, y: 4, w: 6, h: 5 };

describe('nudgeRect', () => {
  it('moves one cell with the arrows', () => {
    expect(nudgeRect(at, 'ArrowRight', false)).toEqual({ x: 5, y: 4, w: 6, h: 5 });
    expect(nudgeRect(at, 'ArrowUp', false)).toEqual({ x: 4, y: 3, w: 6, h: 5 });
  });

  it('resizes one cell with Shift and the arrows', () => {
    expect(nudgeRect(at, 'ArrowRight', true)).toEqual({ x: 4, y: 4, w: 7, h: 5 });
    expect(nudgeRect(at, 'ArrowUp', true)).toEqual({ x: 4, y: 4, w: 6, h: 4 });
  });

  it('ignores other keys', () => {
    expect(nudgeRect(at, 'Enter', false)).toBeNull();
  });

  it('stays on the board through the normal fitting', () => {
    const layout: GridItem[] = [{ i: 'chat', x: 0, y: 0, w: 6, h: 6 }];
    const moved = fitResize(layout, 'chat', nudgeRect(layout[0], 'ArrowLeft', false)!, []);
    expect(moved[0].x).toBe(0);
  });
});
