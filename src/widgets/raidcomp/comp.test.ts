import { describe, expect, it } from 'vitest';
import { RAID_GROUP, WOW_NOW } from '../../wowMocks';
import type { RaidMember } from '../shared/wowGuild';
import { buffCoverage, bySubgroup, classTally, estimateRole, listClasses, nextChoice, readySummary, roleCounts, roleOf, trouble, withChoice } from './comp';
import { cleanCompSettings, compForSharing, defaultCompSettings } from './settings';

const m = (name: string, cls: string, over: Partial<RaidMember> = {}): RaidMember => ({ name, class: cls, level: 60, subgroup: 1, rank: 'member', role: '', online: true, dead: false, zone: '', masterLooter: false, ...over });
const members = RAID_GROUP.members;

describe('roles', () => {
  it('takes the main tank assignment as a tank, a healing class as a healer, anyone else as damage', () => {
    expect(estimateRole(m('a', 'WARRIOR', { role: 'tank' }))).toBe('tank');
    for (const c of ['PRIEST', 'Paladin', 'druid', 'SHAMAN']) expect(estimateRole(m('a', c)), c).toBe('healer');
    for (const c of ['WARRIOR', 'MAGE', 'ROGUE', 'HUNTER', 'WARLOCK', '']) expect(estimateRole(m('a', c)), c).toBe('dps');
    // A main tank who is a Druid is a tank, not a healer.
    expect(estimateRole(m('a', 'DRUID', { role: 'tank' }))).toBe('tank');
  });

  it('prefers the role chosen by hand, and says which are guesses', () => {
    const chosen = [{ name: 'Kaz', role: 'dps' as const }];
    expect(roleOf(m('Kaz', 'SHAMAN'), chosen)).toEqual({ role: 'dps', guessed: false });
    expect(roleOf(m('Zoë', 'PRIEST'), chosen)).toEqual({ role: 'healer', guessed: true });
  });

  it('counts tanks, healers and damage, and how many healers are only a guess', () => {
    expect(roleCounts(members, [])).toEqual({ tank: 1, healer: 4, dps: 4, guessed: 4 });
    // Kaz is a damage-dealing Shaman, Rook is picked as a healer.
    expect(roleCounts(members, [{ name: 'Kaz', role: 'dps' }, { name: 'Rook', role: 'healer' }])).toEqual({ tank: 1, healer: 4, dps: 4, guessed: 3 });
  });

  it('cycles Tank, Healer, Damage, then back to the guess', () => {
    expect(nextChoice(null)).toBe('tank');
    expect(nextChoice('tank')).toBe('healer');
    expect(nextChoice('healer')).toBe('dps');
    expect(nextChoice('dps')).toBeNull();
  });

  it('changes one person’s choice without touching the others', () => {
    const a = withChoice([], 'Kaz', 'dps');
    const b = withChoice(a, 'Zoë', 'tank');
    expect(b).toEqual([{ name: 'Kaz', role: 'dps' }, { name: 'Zoë', role: 'tank' }]);
    expect(withChoice(b, 'Kaz', null)).toEqual([{ name: 'Zoë', role: 'tank' }]);
    expect(withChoice(b, 'Kaz', 'healer')).toContainEqual({ name: 'Kaz', role: 'healer' });
  });
});

describe('the class tally', () => {
  it('counts each class, most first', () => {
    const tally = classTally([m('a', 'PRIEST'), m('b', 'priest'), m('c', 'MAGE'), m('d', 'NOPE')]);
    expect(tally).toEqual([{ cls: 'Priest', n: 2 }, { cls: 'Mage', n: 1 }, { cls: 'Unknown', n: 1 }]);
  });
});

describe('buff coverage', () => {
  it('says which classes’ buffs the raid has and which it is missing (an offline player does not count)', () => {
    const { have, missing } = buffCoverage(members);
    expect(have.map((b) => b.cls)).toEqual(['Priest', 'Mage', 'Druid', 'Shaman', 'Warlock', 'Warrior']);
    // Sela, the only Paladin, is offline.
    expect(missing.map((b) => b.cls)).toEqual(['Paladin']);
  });

  it('is all missing for an empty raid, and none for a full one', () => {
    expect(buffCoverage([]).missing).toHaveLength(7);
    const all = ['PRIEST', 'MAGE', 'DRUID', 'PALADIN', 'SHAMAN', 'WARLOCK', 'WARRIOR'].map((c, i) => m(`p${i}`, c));
    expect(buffCoverage(all).missing).toEqual([]);
  });
});

describe('subgroups', () => {
  it('lays the raid out in groups of five, leaving off empty groups at the end', () => {
    const groups = bySubgroup(members);
    expect(groups.map((g) => [g.group, g.members.length])).toEqual([[1, 3], [2, 3], [3, 3]]);
    expect(bySubgroup([])).toHaveLength(1);
    expect(bySubgroup([m('a', 'MAGE', { subgroup: 8 })])).toHaveLength(8);
  });

  it('puts a nonsense group number in the nearest real one', () => {
    expect(bySubgroup([m('a', 'MAGE', { subgroup: 0 }), m('b', 'MAGE', { subgroup: 12 })]).flatMap((g) => g.members.map((x) => [x.name, g.group]))).toEqual([['a', 1], ['b', 8]]);
  });
});

describe('who is in trouble', () => {
  it('lists who is offline and who is dead (not counting the offline as dead)', () => {
    expect(trouble(members)).toEqual({ offline: ['Sela'], dead: ['Zoë'] });
    expect(trouble([m('a', 'MAGE', { online: false, dead: true })])).toEqual({ offline: ['a'], dead: [] });
  });
});

describe('the ready check', () => {
  it('says how many were ready and who was not', () => {
    const s = readySummary(RAID_GROUP.lastReadyCheck!, WOW_NOW);
    expect(s).toEqual({ when: '4 min ago', ready: 6, notReady: ['Mira'], away: ['Zoë'] });
  });
});

describe('listClasses', () => {
  it('reads as a sentence', () => {
    expect(listClasses(['PRIEST', 'PALADIN', 'DRUID'])).toBe('Priest, Paladin and Druid');
    expect(listClasses(['SHAMAN'])).toBe('Shaman');
    expect(listClasses([])).toBe('');
  });
});

describe('settings', () => {
  it('keep only sensible hand-picked roles', () => {
    const messy = { roles: [{ name: 'Kaz', role: 'dps' }, { name: 'Kaz', role: 'tank' }, { name: '', role: 'dps' }, { name: 'Bob', role: 'wizard' }, null, { name: 'x'.repeat(60), role: 'dps' }] } as never;
    expect(cleanCompSettings(messy).roles).toEqual([{ name: 'Kaz', role: 'dps' }]);
    expect(cleanCompSettings({ roles: 'nope' } as never).roles).toEqual([]);
  });

  it('keep the roles by name out of a shared preset', () => {
    expect(compForSharing({ roles: [{ name: 'Kaz', role: 'dps' }] })).toEqual(defaultCompSettings());
  });
});
