import { describe, expect, it } from 'vitest';
import { bitrateText, dropLevel, droppedPercent } from './obs';

describe('obs display helpers', () => {
  it('turns dropped frames into a percentage', () => {
    expect(droppedPercent({ dropped: 3, total: 300 })).toBe(1);
    expect(droppedPercent({ dropped: 0, total: 0 })).toBe(0);
  });

  it('goes amber over 1 % and red over 5 %', () => {
    expect([0, 1, 1.01, 5, 5.01, 40].map(dropLevel)).toEqual(['ok', 'ok', 'warn', 'warn', 'bad', 'bad']);
  });

  it('writes the bitrate the way streamers say it', () => {
    expect(bitrateText(6000)).toBe('6.0 Mbps');
    expect(bitrateText(4520)).toBe('4.5 Mbps');
    expect(bitrateText(800)).toBe('800 kbps');
  });
});
