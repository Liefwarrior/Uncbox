import { describe, expect, it } from 'vitest';
import { ArrivalClock, chunks, clipWindow, framesFor, mixTracks, s16ToF32, sliceFrames } from './pcm';

describe('ArrivalClock', () => {
  it('maps capture times to wall times with the least delay seen lately, so jitter drops out', () => {
    const clock = new ArrivalClock();
    expect(clock.ready).toBe(false);
    // Frames at 60 fps, seen 5 to 25 ms after they were taken (wall clock = capture time + 1 000 000 ms).
    for (let i = 0; i < 120; i++) clock.add(i / 60, 1_000_000 + (i / 60) * 1000 + 5 + (i % 5) * 5);
    expect(clock.ready).toBe(true);
    expect(clock.wallMs(1)).toBeCloseTo(1_000_000 + 1000 + 5, 6);
    expect(clock.wallMs(1.5)).toBeCloseTo(1_000_000 + 1500 + 5, 6);
  });

  it('forgets old seconds and starts over after a reset', () => {
    const clock = new ArrivalClock(3);
    clock.add(0.5, 1000 + 500); // offset 1000
    for (let s = 1; s <= 4; s++) clock.add(s + 0.5, 2000 + (s + 0.5) * 1000); // offset 2000
    expect(clock.wallMs(10)).toBeCloseTo(10_000 + 2000, 6);
    clock.reset();
    expect(clock.ready).toBe(false);
    clock.add(0, 7);
    expect(clock.wallMs(2)).toBeCloseTo(2007, 6);
  });
});

describe('clipWindow', () => {
  it('counts back from now', () => {
    expect(clipWindow(940_000, 1_000_000, 1_000_400)).toEqual({ fromMs: 60_400, toMs: 400 });
  });

  it('never asks for the future, and keeps from past to', () => {
    expect(clipWindow(900, 1_100, 1_000)).toEqual({ fromMs: 100, toMs: 0 });
    expect(clipWindow(1_000, 1_000, 1_000)).toEqual({ fromMs: 1, toMs: 0 });
    expect(clipWindow(1_050, 1_100, 1_000)).toEqual({ fromMs: 1, toMs: 0 });
  });
});

describe('sliceFrames', () => {
  const pcm = Int16Array.from([1, 2, 3, 4, 5, 6, 7, 8]); // four stereo frames

  it('takes a run of frames', () => {
    expect([...sliceFrames(pcm, 1, 2)]).toEqual([3, 4, 5, 6]);
  });

  it('fills with silence where the sound is shorter than the video', () => {
    expect([...sliceFrames(pcm, 0, 6)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0]);
    expect([...sliceFrames(new Int16Array(0), 0, 2)]).toEqual([0, 0, 0, 0]);
  });

  it('cuts sound that runs long and gives a copy', () => {
    const cut = sliceFrames(pcm, 0, 2);
    expect([...cut]).toEqual([1, 2, 3, 4]);
    cut[0] = 99;
    expect(pcm[0]).toBe(1);
  });
});

describe('framesFor and chunks', () => {
  it('rounds the video span to whole frames', () => {
    expect(framesFor(60.0166, 48000)).toBe(2_880_797);
    expect(framesFor(1.5, 48000)).toBe(72_000);
    expect(framesFor(-1, 48000)).toBe(0);
  });

  it('cuts a length into runs with a short last one', () => {
    expect(chunks(250, 100)).toEqual([[0, 100], [100, 100], [200, 50]]);
    expect(chunks(0, 100)).toEqual([]);
  });
});

describe('s16ToF32 and mixTracks', () => {
  it('turns 16-bit samples into -1..1', () => {
    const f = s16ToF32(Int16Array.from([0, 16384, -32768, 32767]));
    expect(f[0]).toBe(0);
    expect(f[1]).toBe(0.5);
    expect(f[2]).toBe(-1);
    expect(f[3]).toBeCloseTo(1, 4);
  });

  it('sums the tracks and clamps the result', () => {
    const mix = mixTracks([Float32Array.from([0.25, 0.75, -0.75, 0]), Float32Array.from([0.25, 0.75, -0.75, 0]), Float32Array.from([0.5, 0, 0, 0])]);
    expect([...mix]).toEqual([1, 1, -1, 0]);
  });

  it('is silence for no tracks', () => {
    expect(mixTracks([]).length).toBe(0);
  });
});
