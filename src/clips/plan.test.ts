import { describe, expect, it } from 'vitest';
import {
  DISCORD_MAX_BYTES,
  clampTrim,
  discordBitrate,
  discordSize,
  frameShare,
  isSoft,
  lastSeconds,
  verticalCrop,
} from './plan';

describe('verticalCrop', () => {
  it('cuts 608 x 1080 out of a 1080p clip, centred by default', () => {
    expect(verticalCrop(1920, 1080, 0.5)).toEqual({ left: 656, top: 0, width: 608, height: 1080 });
  });

  it('slides from the left edge to the right edge', () => {
    expect(verticalCrop(1920, 1080, 0).left).toBe(0);
    expect(verticalCrop(1920, 1080, 1)).toEqual({ left: 1312, top: 0, width: 608, height: 1080 });
    expect(verticalCrop(1920, 1080, 1).left + 608).toBe(1920);
  });

  it('stays inside the frame and on even pixels whatever it is given', () => {
    for (const p of [-3, 0.123, 0.5, 0.777, 1, 42, NaN]) {
      const c = verticalCrop(1920, 1080, p);
      expect(c.left).toBeGreaterThanOrEqual(0);
      expect(c.left + c.width).toBeLessThanOrEqual(1920);
      expect(c.left % 2).toBe(0);
    }
  });

  it('copes with a clip that is not wide enough for a 9:16 slice', () => {
    expect(verticalCrop(500, 1080, 0.5)).toEqual({ left: 0, top: 0, width: 500, height: 1080 });
  });

  it('reports how much of the frame the slice covers', () => {
    expect(frameShare(1920, 1080)).toBeCloseTo(608 / 1920);
  });
});

describe('discordBitrate', () => {
  const size = (seconds: number) => (discordBitrate(seconds) * seconds) / 8;

  it('keeps clips of ordinary lengths under the limit with room to spare', () => {
    for (const s of [5, 15, 30, 45, 60, 90]) expect(size(s)).toBeLessThan(9_500_000);
  });

  it('gives shorter clips more bits, up to a ceiling', () => {
    expect(discordBitrate(15)).toBeGreaterThan(discordBitrate(60));
    expect(discordBitrate(1)).toBe(8_000_000);
    expect(discordBitrate(0)).toBe(8_000_000);
  });

  it('never asks for less than a floor, however long the clip', () => {
    expect(discordBitrate(10_000)).toBe(250_000);
  });

  it('calls a full minute soft and half of it fine', () => {
    expect(isSoft(discordBitrate(60))).toBe(true);
    expect(isSoft(discordBitrate(30))).toBe(false);
  });

  it('aims below what Discord allows', () => {
    expect(size(60)).toBeLessThan(DISCORD_MAX_BYTES);
  });
});

describe('discordSize', () => {
  it('shrinks landscape and vertical clips to 720p-class, keeping their shape', () => {
    expect(discordSize(1920, 1080)).toEqual({ width: 1280, height: 720 });
    expect(discordSize(1080, 1920)).toEqual({ width: 720, height: 1280 });
    expect(discordSize(608, 1080)).toEqual({ width: 608, height: 1080 });
  });

  it('never makes a small clip bigger', () => {
    expect(discordSize(640, 360)).toEqual({ width: 640, height: 360 });
  });
});

describe('trims', () => {
  it('takes the whole clip or the end of it', () => {
    expect(lastSeconds(60, null)).toEqual({ start: 0, end: 60 });
    expect(lastSeconds(60, 30)).toEqual({ start: 30, end: 60 });
    expect(lastSeconds(60, 15)).toEqual({ start: 45, end: 60 });
    expect(lastSeconds(12, 30)).toEqual({ start: 0, end: 12 });
  });

  it('keeps the start before the end, and both inside the clip', () => {
    expect(clampTrim({ start: 59.9, end: 60 }, 60, 'start')).toEqual({ start: 59.5, end: 60 });
    expect(clampTrim({ start: 20, end: 10 }, 60, 'start')).toEqual({ start: 20, end: 20.5 });
    expect(clampTrim({ start: 20, end: 10 }, 60, 'end')).toEqual({ start: 9.5, end: 10 });
    expect(clampTrim({ start: -5, end: 80 }, 60, 'end')).toEqual({ start: 0, end: 60 });
  });
});
