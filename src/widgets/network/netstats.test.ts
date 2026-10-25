import { describe, expect, it } from 'vitest';
import { fpsTone, pingTone, sparkline } from './netstats';

describe('pingTone', () => {
  it('is green under 60, amber under 120, red above', () => {
    expect(pingTone(0)).toBe('good');
    expect(pingTone(59.9)).toBe('good');
    expect(pingTone(60)).toBe('warn');
    expect(pingTone(119)).toBe('warn');
    expect(pingTone(120)).toBe('bad');
    expect(pingTone(null)).toBe('bad');
  });
});

describe('fpsTone', () => {
  it('is red under 30, amber under 60', () => {
    expect(fpsTone(144)).toBe('good');
    expect(fpsTone(45)).toBe('warn');
    expect(fpsTone(12)).toBe('bad');
  });
});

describe('sparkline', () => {
  it('has nothing to draw without readings', () => {
    expect(sparkline([])).toEqual({ path: '', gaps: [] });
  });

  it('puts the newest reading at the right edge and the highest at the top', () => {
    expect(sparkline([10, 40]).path).toBe('M118 23L120 2');
  });

  it('leaves a gap where a reading is missing', () => {
    const { path, gaps } = sparkline([10, null, 30]);
    expect(path.match(/M/g)).toHaveLength(2);
    expect(gaps).toHaveLength(1);
  });

  it('keeps a calm line low instead of stretching it to the top', () => {
    expect(sparkline([1, 1], { floorMax: 20 }).path).toBe('M118 28.6L120 28.6');
  });
});
