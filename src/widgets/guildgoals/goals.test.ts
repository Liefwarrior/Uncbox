import { describe, expect, it } from 'vitest';
import { RAIDS } from '../../wowMocks';
import type { RaidSummary } from '../shared/wowGuild';
import { KNOWN_RAIDS, progression, sameBoss } from './goals';

const mc = (p: Progression) => p.raids.find((r) => r.zone === 'Molten Core')!;
type Progression = ReturnType<typeof progression>;

describe('sameBoss', () => {
  it('matches however the game spells the name', () => {
    expect(sameBoss('Ragnaros', 'Ragnaros')).toBe(true);
    expect(sameBoss('Majordomo Executus', 'majordomo executus')).toBe(true);
    expect(sameBoss('Kaz’rogal', 'Kaz\'rogal')).toBe(true);
    expect(sameBoss('Majordomo', 'Majordomo Executus')).toBe(true);
    expect(sameBoss('Garr', 'Baron Geddon')).toBe(false);
    expect(sameBoss('', 'Ragnaros')).toBe(false);
  });
});

describe('progression', () => {
  const p = progression(RAIDS, { hideUntouched: false });

  it('ticks off the bosses killed in a raid whose bosses are known, with when', () => {
    const molten = mc(p);
    expect(molten).toMatchObject({ killed: 3, total: 10, known: true });
    expect(molten.bosses.filter((b) => b.killedAt !== null).map((b) => b.name)).toEqual(['Lucifron', 'Magmadar', 'Gehennas']);
  });

  it('uses the first time a boss was killed', () => {
    const lucifron = mc(p).bosses.find((b) => b.name === 'Lucifron')!;
    expect(lucifron.killedAt).toBe(Math.min(...RAIDS.map((r) => r.bosses.find((b) => b.name === 'Lucifron')!.endedAt!)));
  });

  it('lists every known raid, even untouched, unless asked to hide them', () => {
    expect(p.raids.map((r) => r.zone)).toEqual(KNOWN_RAIDS.map((r) => r.zone));
    expect(progression(RAIDS, { hideUntouched: true }).raids.map((r) => r.zone)).toEqual(['Molten Core']);
  });

  it('adds up the bosses down and the bosses there are', () => {
    expect(p.killed).toBe(3);
    expect(p.total).toBe(KNOWN_RAIDS.reduce((n, r) => n + r.bosses.length, 0));
  });

  it('lists the kills in a raid it does not know the bosses of, without a total', () => {
    const odd: RaidSummary = { ...RAIDS[0], id: 5, zone: 'Barrow Deeps', bosses: [{ ...RAIDS[0].bosses[0], name: 'The Warden' }] };
    const out = progression([odd], { hideUntouched: true });
    expect(out.raids).toEqual([{ zone: 'Barrow Deeps', bosses: [{ name: 'The Warden', killedAt: odd.bosses[0].endedAt }], killed: 1, total: 1, known: false }]);
    expect(out.total).toBe(0);
  });

  it('does not count a wipe', () => {
    const wipe: RaidSummary = { ...RAIDS[0], bosses: [{ ...RAIDS[0].bosses[0], success: false }] };
    expect(progression([wipe], { hideUntouched: true }).killed).toBe(0);
  });

  it('knows Onyxia’s Lair whatever the apostrophe', () => {
    const ony: RaidSummary = { ...RAIDS[0], zone: "Onyxia's Lair", bosses: [{ ...RAIDS[0].bosses[0], name: 'Onyxia' }] };
    expect(progression([ony], { hideUntouched: true }).raids[0]).toMatchObject({ zone: 'Onyxia’s Lair', killed: 1, total: 1 });
  });
});
