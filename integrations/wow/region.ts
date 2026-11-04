import type { Rgba } from './codec';

// Turning the few rows of a captured video frame that hold the addon's strip into the RGBA the
// codec reads (see strip.worker.ts). Window captures arrive as packed 8-bit RGB (BGRX on Windows),
// which is copied straight out of the frame; any other format (a YUV one) returns null and is drawn
// through a canvas instead, as before.

/** The packed formats read here, and whether red comes first. */
const PACKED: Record<string, boolean> = { RGBA: true, RGBX: true, BGRA: false, BGRX: false };

export const isPacked = (format: string | null | undefined): boolean => Boolean(format && format in PACKED);

/**
 * RGBA (alpha 255) from `bytes`, a copy of `width` x `height` pixels in `format` whose rows are
 * `stride` bytes apart. Null for a format that isn't packed RGB, or a copy too short for its size.
 */
export function rgbaFrom(format: string | null | undefined, bytes: Uint8Array, stride: number, width: number, height: number): Rgba | null {
  if (!format || !(format in PACKED) || width <= 0 || height <= 0 || stride < width * 4) return null;
  if (bytes.length < stride * (height - 1) + width * 4) return null;
  const redFirst = PACKED[format];
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    let from = y * stride;
    let to = y * width * 4;
    for (let x = 0; x < width; x++, from += 4, to += 4) {
      data[to] = bytes[from + (redFirst ? 0 : 2)];
      data[to + 1] = bytes[from + 1];
      data[to + 2] = bytes[from + (redFirst ? 2 : 0)];
      data[to + 3] = 255;
    }
  }
  return { data, width, height };
}

/** A part of a picture that is `vw` x `vh`, held inside it (whole pixels, at least 1 x 1), or null when none of it is inside. */
export function inside(x: number, y: number, w: number, h: number, vw: number, vh: number): { x: number; y: number; width: number; height: number } | null {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(vw, Math.floor(x + w));
  const y1 = Math.min(vh, Math.floor(y + h));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}
