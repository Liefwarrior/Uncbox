import { describe, expect, it } from 'vitest';
import bands from './fixtures/kda.bands.json';
import { brightText, findKdaDigits, kdaPicture, type Picture } from './pixels';
import { KDA_PITCH } from './screen';

// The bands are the K/D/A strip's neighbourhood cut from two real screenshots (grey levels only):
// "hud" has 0 / 0 / 0, "hud2" has 2 / 0 / 1, and the second has bright orange sky beside the strip.
const band = (k: 'hud' | 'hud2'): Picture & { pitch: number } => {
  const b = (bands as Record<string, { w: number; h: number; gameH: number; gray: string }>)[k];
  const gray = Uint8Array.from(atob(b.gray), (c) => c.charCodeAt(0));
  const data = new Uint8ClampedArray(b.w * b.h * 4);
  gray.forEach((v, i) => data.set([v, v, v, 255], i * 4));
  return { data, w: b.w, h: b.h, pitch: KDA_PITCH * b.gameH };
};

describe('K/D/A strip', () => {
  it('finds the three numbers, not the icons between them', () => {
    const a = band('hud');
    expect(findKdaDigits(a, a.pitch)!.spans).toEqual([
      { x0: 52, x1: 57 },
      { x0: 81, x1: 86 },
      { x0: 109, x1: 115 },
    ]);
    const b = band('hud2');
    expect(findKdaDigits(b, b.pitch)!.spans).toEqual([
      { x0: 60, x1: 66 },
      { x0: 89, x1: 95 },
      { x0: 119, x1: 124 },
    ]);
  });

  it('lays them side by side on white for the OCR', () => {
    const b = band('hud2');
    const pic = kdaPicture(b, b.pitch)!;
    expect(pic.w).toBeGreaterThan(300);
    // Black ink exists, and the corners are white.
    const px = (x: number, y: number) => pic.data[(y * pic.w + x) * 4];
    expect(px(0, 0)).toBe(255);
    expect(Array.from({ length: pic.w }, (_, x) => px(x, Math.floor(pic.h / 2))).some((v) => v < 100)).toBe(true);
  });

  it('gives nothing when there is no strip', () => {
    const blank: Picture = { data: new Uint8ClampedArray(150 * 26 * 4).fill(20), w: 150, h: 26 };
    expect(findKdaDigits(blank, 30)).toBeNull();
    expect(kdaPicture(blank, 30)).toBeNull();
  });
});

describe('bright text', () => {
  it('keeps only the brightest pixels, black on white', () => {
    const data = new Uint8ClampedArray([255, 255, 255, 255, 200, 40, 40, 255, 100, 100, 100, 255]);
    const out = brightText({ data, w: 3, h: 1 }, 170);
    expect(Array.from(out.data)).toEqual([0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
  });
});
