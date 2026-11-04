import { describe, expect, it } from 'vitest';
import { BLOCK, fromBlocks, locate, paginate, readBlocks, toBlocks } from './codec';
import { inside, isPacked, rgbaFrom } from './region';

// The strip worker's pixels: a copy of a few rows of a captured frame, as the codec reads them.

/** A BGRX picture (what Windows window captures are) with the addon's strip drawn at (sx, sy), rows `stride` bytes apart. */
function bgrxWithStrip(height: number, stride: number, sx: number, sy: number, blocks: number[]) {
  const bytes = new Uint8Array(stride * height).fill(40);
  blocks.forEach((v, i) => {
    const col = i % 256;
    const row = Math.floor(i / 256);
    for (let dy = 0; dy < BLOCK; dy++) {
      for (let dx = 0; dx < BLOCK; dx++) {
        const at = (sy + row * BLOCK + dy) * stride + (sx + col * BLOCK + dx) * 4;
        bytes[at] = v & 1 ? 255 : 0; // blue
        bytes[at + 1] = v & 2 ? 255 : 0; // green
        bytes[at + 2] = v & 4 ? 255 : 0; // red
        bytes[at + 3] = 0;
      }
    }
  });
  return bytes;
}

describe('the strip’s pixels', () => {
  it('reads the packed formats window captures arrive in, and no others', () => {
    for (const f of ['RGBA', 'RGBX', 'BGRA', 'BGRX']) expect(isPacked(f), f).toBe(true);
    for (const f of ['NV12', 'I420', 'I420A', '', null, undefined]) expect(isPacked(f), String(f)).toBe(false);
    expect(rgbaFrom('NV12', new Uint8Array(64), 16, 4, 4)).toBeNull();
  });

  it('puts red first and makes every pixel opaque, row by row whatever the stride', () => {
    // Two pixels a row, rows 12 bytes apart (4 bytes of padding).
    const bgrx = new Uint8Array([1, 2, 3, 0, 4, 5, 6, 0, 9, 9, 9, 9, 7, 8, 9, 0, 10, 11, 12, 0]);
    expect(Array.from(rgbaFrom('BGRX', bgrx, 12, 2, 2)!.data)).toEqual([3, 2, 1, 255, 6, 5, 4, 255, 9, 8, 7, 255, 12, 11, 10, 255]);
    expect(Array.from(rgbaFrom('RGBA', bgrx, 12, 2, 2)!.data)).toEqual([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]);
  });

  it('refuses a copy too short for its size', () => {
    expect(rgbaFrom('BGRX', new Uint8Array(15), 8, 2, 2)).toBeNull();
    expect(rgbaFrom('BGRX', new Uint8Array(16), 4, 2, 2)).toBeNull();
    expect(rgbaFrom('BGRX', new Uint8Array(16), 8, 0, 2)).toBeNull();
  });

  it('decodes a page of the strip from just its rows of a full-size capture', () => {
    const [page] = paginate(1, 7, new TextEncoder().encode('Thrall|Orc|Shaman|60'));
    const blocks = toBlocks(page);
    const width = 2560;
    const stride = width * 4 + 64;
    const frame = bgrxWithStrip(40, stride, 3, 11, blocks);
    // What copyTo with a rectangle hands over: the strip's rows only, from x 0.
    const rows = 2 * BLOCK + 3;
    const top = 10;
    const copy = frame.subarray(top * stride, (top + rows) * stride);
    const img = rgbaFrom('BGRX', copy, stride, 256 * BLOCK + 8, rows)!;
    const spot = locate(img);
    expect(spot).not.toBeNull();
    const read = fromBlocks(readBlocks(img, spot!));
    expect(read).toMatchObject({ kind: 1, seq: 7, index: 0, count: 1 });
    expect(new TextDecoder().decode(read!.payload)).toBe('Thrall|Orc|Shaman|60');
  });

  it('keeps a region inside the picture, in whole pixels', () => {
    expect(inside(-1.5, -1, 10, 6, 100, 100)).toEqual({ x: 0, y: 0, width: 8, height: 5 });
    expect(inside(95, 98, 10, 10, 100, 100)).toEqual({ x: 95, y: 98, width: 5, height: 2 });
    expect(inside(100, 0, 10, 10, 100, 100)).toBeNull();
    expect(inside(0, 0, 0, 10, 100, 100)).toBeNull();
  });
});
