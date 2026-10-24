import { describe, expect, it } from 'vitest';
import { count, sparkPoints, uptime } from './twitch';

describe('uptime', () => {
  it('counts minutes and seconds under an hour', () => {
    expect(uptime(0, 125_000)).toBe('2:05');
    expect(uptime(1000, 1000)).toBe('0:00');
  });

  it('adds hours after the first', () => {
    expect(uptime(0, 3_725_000)).toBe('1:02:05');
    expect(uptime(0, 36_000_000)).toBe('10:00:00');
  });

  it('never goes negative when the clocks differ a little', () => {
    expect(uptime(5000, 1000)).toBe('0:00');
  });
});

describe('sparkPoints', () => {
  it('draws nothing until there are two readings', () => {
    expect(sparkPoints([], 80, 20)).toBe('');
    expect(sparkPoints([5], 80, 20)).toBe('');
  });

  it('runs left to right, with the highest count at the top', () => {
    const pts = sparkPoints([10, 20, 15], 80, 20).split(' ');
    expect(pts).toEqual(['0.0,18.0', '40.0,2.0', '80.0,10.0']);
  });

  it('keeps a flat line in the middle', () => {
    expect(sparkPoints([7, 7, 7], 60, 20)).toBe('0.0,10.0 30.0,10.0 60.0,10.0');
  });
});

describe('count', () => {
  it('spells out a number and dashes a missing one', () => {
    expect(count(null)).toBe('–');
    expect(count(0)).toBe('0');
    expect(count(1234)).toBe((1234).toLocaleString());
  });
});
