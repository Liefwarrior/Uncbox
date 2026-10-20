import { describe, expect, it } from 'vitest';
import { addKill, agoText, nextKda, noKda, SAME_KILL_MS } from './store';

describe('kill banners', () => {
  it('records a kill once while its banner stays up', () => {
    let kills = addKill([], { killer: 'Liefwarrior', victim: 'Kali' }, 1000, '7:39');
    kills = addKill(kills, { killer: 'Liefwarrior', victim: 'Kali' }, 3000, '7:41');
    kills = addKill(kills, { killer: 'liefwarrior', victim: 'KALI' }, 6000, '7:44');
    expect(kills).toHaveLength(1);
    expect(kills[0]).toMatchObject({ at: 1000, lastSeen: 6000, clock: '7:39' });
  });

  it('records the same pair again once the banner has been gone a while', () => {
    let kills = addKill([], { killer: 'A', victim: 'B' }, 0, '1:00');
    kills = addKill(kills, { killer: 'A', victim: 'B' }, SAME_KILL_MS + 1, '2:00');
    expect(kills.map((k) => k.clock)).toEqual(['1:00', '2:00']);
  });

  it('keeps different kills apart and only the latest few dozen', () => {
    let kills = addKill([], { killer: 'A', victim: 'B' }, 0, '');
    kills = addKill(kills, { killer: 'A', victim: 'C' }, 1, '');
    expect(kills).toHaveLength(2);
    for (let i = 0; i < 40; i++) kills = addKill(kills, { killer: 'X', victim: `V${i}` }, 100000 + i, '');
    expect(kills.length).toBeLessThanOrEqual(20);
    expect(kills[kills.length - 1].victim).toBe('V39');
  });
});

describe('K/D/A from the HUD', () => {
  const read = (k: number, d: number, a: number) => ({ k, d, a });

  it('needs the same reading twice in a row', () => {
    let t = nextKda(noKda, read(1, 0, 0));
    expect(t.accepted).toBeNull();
    t = nextKda(t, read(1, 0, 0));
    expect(t.accepted).toEqual(read(1, 0, 0));
  });

  it('forgets a reading that is not repeated, or that could not be parsed', () => {
    let t = nextKda(noKda, read(5, 5, 5));
    t = nextKda(t, read(1, 0, 0));
    t = nextKda(t, null);
    t = nextKda(t, read(1, 0, 0));
    expect(t.accepted).toBeNull();
  });

  it('never goes down', () => {
    let t = nextKda(nextKda(noKda, read(3, 1, 2)), read(3, 1, 2));
    t = nextKda(nextKda(t, read(2, 1, 2)), read(2, 1, 2));
    expect(t.accepted).toEqual(read(3, 1, 2));
    t = nextKda(nextKda(t, read(4, 1, 2)), read(4, 1, 2));
    expect(t.accepted).toEqual(read(4, 1, 2));
  });
});

describe('time ago', () => {
  it('counts minutes and seconds', () => {
    expect(agoText(42_000)).toBe('0:42');
    expect(agoText(125_000)).toBe('2:05');
    expect(agoText(-5)).toBe('0:00');
  });
});
