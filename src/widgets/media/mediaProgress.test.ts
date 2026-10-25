import { describe, expect, it } from 'vitest';
import { formatClock, interpolatePosition, progressFraction, seekPosition } from './mediaProgress';

describe('interpolatePosition', () => {
  const playing = { position: 30, duration: 200, playing: true };

  it('moves forward with the clock while playing', () => {
    expect(interpolatePosition(playing, 0)).toBe(30);
    expect(interpolatePosition(playing, 2500)).toBe(32.5);
  });

  it('stands still while paused', () => {
    expect(interpolatePosition({ ...playing, playing: false }, 10_000)).toBe(30);
  });

  it('stops at the end of the track', () => {
    expect(interpolatePosition(playing, 999_000)).toBe(200);
  });

  it('keeps going when the length is unknown', () => {
    expect(interpolatePosition({ position: 5, duration: 0, playing: true }, 4000)).toBe(9);
  });

  it('ignores a clock that ran backwards', () => {
    expect(interpolatePosition(playing, -5000)).toBe(30);
  });
});

describe('progress and seeking', () => {
  it('gives the fraction along the bar', () => {
    expect(progressFraction(50, 200)).toBe(0.25);
    expect(progressFraction(300, 200)).toBe(1);
    expect(progressFraction(10, 0)).toBe(0);
  });

  it('turns a click into seconds, kept inside the track', () => {
    expect(seekPosition(0.5, 201)).toBe(100.5);
    expect(seekPosition(-1, 200)).toBe(0);
    expect(seekPosition(2, 200)).toBe(200);
  });

  it('writes clock times', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(75.9)).toBe('1:15');
    expect(formatClock(3725)).toBe('1:02:05');
  });
});
