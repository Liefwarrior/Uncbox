import { describe, expect, it } from 'vitest';
import { LOOT, RAIDS, WOW_NOW } from '../../wowMocks';
import type { LootEntry } from '../shared/wowGuild';
import { fairness, filterLoot, lootCsv, noLootFilter, perMember } from './loot';
import { cleanLootSettings, defaultLootSettings } from './settings';

const DAY = 86_400_000;
const drop = (id: number, who: string, over: Partial<LootEntry> = {}): LootEntry => ({ id, at: WOW_NOW - id * 1000, raidId: 202, who, itemId: id, name: `Item ${id}`, quality: 4, count: 1, boss: 'Ragnaros', ...over });

describe('filterLoot', () => {
  it('lists everything newest first with no filter', () => {
    expect(filterLoot(LOOT, noLootFilter(), WOW_NOW).map((l) => l.id)).toEqual([2, 3, 1].sort((a, b) => LOOT.find((l) => l.id === b)!.at - LOOT.find((l) => l.id === a)!.at));
  });

  it('filters by member, ignoring case and accents, matching part of a name', () => {
    expect(filterLoot(LOOT, { ...noLootFilter(), member: 'zoe' }, WOW_NOW).map((l) => l.who)).toEqual(['Zoë']);
    expect(filterLoot(LOOT, { ...noLootFilter(), member: 'BUM' }, WOW_NOW).map((l) => l.who)).toEqual(['Bumta']);
  });

  it('filters by raid, by quality and by how many days back', () => {
    expect(filterLoot(LOOT, { ...noLootFilter(), raid: 201 }, WOW_NOW).map((l) => l.who)).toEqual(['Bumta']);
    expect(filterLoot(LOOT, { ...noLootFilter(), minQuality: 4 }, WOW_NOW)).toHaveLength(2);
    expect(filterLoot(LOOT, { ...noLootFilter(), days: 7 }, WOW_NOW).map((l) => l.who).sort()).toEqual(['Kaz', 'Zoë']);
  });
});

describe('fairness', () => {
  const opts = { minQuality: 3, days: 30, now: WOW_NOW };

  it('lists everyone who raided, with the fewest drops first, even those with none', () => {
    const rows = fairness(LOOT, RAIDS, opts);
    expect(rows.map((r) => [r.name, r.drops])).toEqual([
      ['Lief', 0],
      ['Rook', 0],
      ['Sela', 0],
      ['Zoë', 1],
      ['Kaz', 1],
      ['Bumta', 1],
    ]);
  });

  it('puts the one who raided more first among equal counts', () => {
    const rows = fairness(LOOT, RAIDS, opts);
    expect(rows[0].name).toBe('Lief');
    expect(rows[0].raids).toBe(2);
    expect(rows[1].raids).toBe(1);
  });

  it('counts a stack for what it holds, and only items of the quality asked for', () => {
    const rows = fairness([drop(1, 'Kaz', { count: 3 }), drop(2, 'Kaz', { quality: 2 }), drop(3, 'Zoë')], RAIDS, { ...opts, minQuality: 3 });
    expect(rows.find((r) => r.name === 'Kaz')!.drops).toBe(3);
    expect(rows.find((r) => r.name === 'Zoë')!.drops).toBe(1);
  });

  it('only looks at the days asked for, and at all time with 0', () => {
    const old = drop(1, 'Kaz', { at: WOW_NOW - 60 * DAY });
    expect(fairness([old], RAIDS, { ...opts, days: 30 }).find((r) => r.name === 'Kaz')!.drops).toBe(0);
    expect(fairness([old], RAIDS, { ...opts, days: 0 }).find((r) => r.name === 'Kaz')!.drops).toBe(1);
  });

  it('lists someone who got loot at a raid not in the list', () => {
    expect(fairness([drop(1, 'Pickup')], [], opts)).toEqual([{ name: 'Pickup', drops: 1, raids: 0, lastAt: WOW_NOW - 1000 }]);
  });
});

describe('perMember', () => {
  it('totals the drops per player, most first', () => {
    expect(perMember([drop(1, 'Kaz'), drop(2, 'Kaz'), drop(3, 'Zoë', { count: 2 }), drop(4, 'Bumta')])).toEqual([
      { name: 'Kaz', drops: 2 },
      { name: 'Zoë', drops: 2 },
      { name: 'Bumta', drops: 1 },
    ]);
  });
});

describe('lootCsv', () => {
  const lines = (text: string) => text.trimEnd().split('\r\n');

  it('has a header and a row per drop with the raid’s zone', () => {
    const out = lines(lootCsv(LOOT, RAIDS));
    expect(out[0]).toBe('Date,Raid,Boss,Player,Item,Item ID,Quality,Count');
    expect(out).toHaveLength(4);
    expect(out[1]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2},Molten Core,Magmadar,Kaz,Arcanist Bindings,16799,Epic,1$/);
  });

  it('quotes item names with commas and keeps accents', () => {
    const out = lines(lootCsv([drop(1, 'Zoë', { name: 'Thunderfury, Blessed Blade', boss: '' })], RAIDS));
    expect(out[1]).toContain('Zoë,"Thunderfury, Blessed Blade",');
  });

  it('leaves the raid empty for loot from no known raid', () => {
    expect(lines(lootCsv([drop(1, 'Kaz', { raidId: null })], RAIDS))[1].split(',')[1]).toBe('');
  });
});

describe('settings', () => {
  it('start on the drops, green and better, the last 30 days, names hidden on stream', () => {
    expect(defaultLootSettings()).toMatchObject({ view: 'history', minQuality: 2, days: 30, showNamesOnStream: false });
  });

  it('are put right when they come from a hand-edited file', () => {
    expect(cleanLootSettings({ ...defaultLootSettings(), view: 'x' as never, minQuality: 12, days: 5 })).toMatchObject({ view: 'history', minQuality: 2, days: 30 });
  });
});
