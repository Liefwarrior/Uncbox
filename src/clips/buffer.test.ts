import { describe, expect, it } from 'vitest';
import { type Kept, goesBack, keepFrom } from './buffer';

/** One packet every 1/60 s from `from` to `to` seconds, with a keyframe every second. */
function run(from: number, to: number): Kept[] {
  const out: Kept[] = [];
  for (let i = 0; from + i / 60 <= to; i++) out.push({ timestamp: from + i / 60, type: i % 60 === 0 ? 'key' : 'delta' });
  return out;
}

describe('keepFrom', () => {
  it('keeps everything while there is less than the clip length', () => {
    expect(keepFrom(run(0, 30), 60)).toBe(0);
  });

  it('starts on the newest keyframe at least the clip length old', () => {
    const packets = run(0, 90.5);
    const kept = packets.slice(keepFrom(packets, 60));
    expect(kept[0].type).toBe('key');
    expect(kept[0].timestamp).toBeCloseTo(30);
  });

  it('drops what came before a long pause in the capture', () => {
    // A minimized game for 12 hours, then 10 seconds of play.
    const packets = [...run(0, 50), ...run(43_200, 43_210)];
    const kept = packets.slice(keepFrom(packets, 60));
    expect(kept[0].timestamp).toBe(43_200);
    expect(kept[0].type).toBe('key');
  });

  it('keeps a short pause, which a clip shows as a held frame', () => {
    const packets = [...run(0, 40), ...run(45, 70)];
    expect(packets.slice(keepFrom(packets, 60))[0].timestamp).toBeCloseTo(10);
  });

  it('handles an empty buffer', () => {
    expect(keepFrom([], 60)).toBe(0);
  });
});

describe('goesBack', () => {
  it('is true only when time goes backwards', () => {
    expect(goesBack(10, 9)).toBe(true);
    expect(goesBack(10, 10)).toBe(false);
    expect(goesBack(10, 10.016)).toBe(false);
  });
});
