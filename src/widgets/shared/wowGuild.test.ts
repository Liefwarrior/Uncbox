import { describe, expect, it } from 'vitest';
import type { WowStatus } from '../../wow';
import { ago, clockTime, fold, hiddenNames, lasted, nameLabel, sameName, setupNotice, wowheadUrl } from './wowGuild';

const installed = (version: string | null): WowStatus => ({
  bundled: '1.0.0',
  addons: { Uncbox: '1.0.0' },
  preferred: 'C:\\WoW',
  installs: [{ flavor: '_classic_era_', label: 'Classic Era', path: 'C:\\WoW', exes: [], version, addons: {} }],
  autoInstall: true,
  flavor: '',
  settings: { strip: { enabled: true, corner: 'TOPLEFT' }, modules: { character: true, quests: true, party: true, guild: true, raid: true, loot: true }, lootMinQuality: 2 },
});

const NOW = 1_000_000_000_000;

describe('names', () => {
  it('compares without case or accents', () => {
    expect(fold('Zoë')).toBe('zoe');
    expect(sameName('ZOË', 'zoe')).toBe(true);
    expect(sameName('Zoe', 'Zoa')).toBe(false);
  });

  it('numbers hidden names in the order they first come, the same person the same number', () => {
    const hidden = hiddenNames(['Lief', 'Zoë', 'Lief', 'Kaz']);
    expect([...hidden.entries()]).toEqual([['Lief', 'Member 1'], ['Zoë', 'Member 2'], ['Kaz', 'Member 3']]);
    expect(nameLabel('Zoë', hidden)).toBe('Member 2');
    expect(nameLabel('Zoë', null)).toBe('Zoë');
    expect(nameLabel('Nobody', hidden)).toBe('Member');
  });
});

describe('times', () => {
  it('says how long ago in plain words', () => {
    expect(ago(NOW - 20_000, NOW)).toBe('just now');
    expect(ago(NOW - 5 * 60_000, NOW)).toBe('5 min ago');
    expect(ago(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago');
    expect(ago(NOW - 86_400_000, NOW)).toBe('1 day ago');
    expect(ago(NOW - 5 * 86_400_000, NOW)).toBe('5 days ago');
    expect(ago(0, NOW)).toBe('never');
    expect(ago(NOW - 90 * 86_400_000, NOW)).not.toMatch(/ago/);
  });

  it('says how long something lasted', () => {
    expect(lasted(40 * 60_000)).toBe('40 min');
    expect(lasted(3 * 3_600_000)).toBe('3 h');
    expect(lasted(3 * 3_600_000 + 8 * 60_000)).toBe('3 h 8 min');
  });

  it('puts the day before a time that is not today’s', () => {
    const now = new Date(2026, 9, 24, 20, 0).getTime();
    const today = clockTime(new Date(2026, 9, 24, 19, 5).getTime(), now);
    const earlier = clockTime(new Date(2026, 9, 21, 19, 5).getTime(), now);
    expect(earlier.length).toBeGreaterThan(today.length);
    expect(earlier.endsWith(today)).toBe(true);
  });
});

describe('Wowhead', () => {
  it('links the Classic page of an item', () => {
    expect(wowheadUrl(19019)).toBe('https://www.wowhead.com/classic/item=19019');
  });
});

describe('setupNotice', () => {
  const base = { status: installed('1.0.0'), seenAt: NOW - 60_000, now: NOW, error: '' };

  it('says when the link itself can’t be reached', () => {
    expect(setupNotice({ ...base, error: 'Run this on the PC WoW is on.' })).toMatchObject({ id: 'server', hint: 'Run this on the PC WoW is on.' });
  });

  it('says when WoW or the addon is not there', () => {
    expect(setupNotice({ ...base, status: { ...installed(null), installs: [] } })).toMatchObject({ id: 'addon', title: 'WoW wasn’t found on this PC' });
    expect(setupNotice({ ...base, status: installed(null) })).toMatchObject({ id: 'addon', title: 'The Uncbox addon isn’t installed' });
  });

  it('says to log in and /reload when it has not been seen in the game', () => {
    expect(setupNotice({ ...base, seenAt: 0 })).toMatchObject({ id: 'seen', hint: 'Log in to WoW and type /reload.' });
  });

  it('says there is no guild only when the roster is empty, and it was seen lately', () => {
    expect(setupNotice({ ...base, inGuild: false })).toMatchObject({ id: 'guild', title: 'Not in a guild' });
    expect(setupNotice({ ...base, inGuild: false, seenAt: NOW - 3_600_000 })).toMatchObject({ id: 'seen' });
    expect(setupNotice({ ...base })).toBeNull();
  });

  it('is quiet until the status is known', () => {
    expect(setupNotice({ ...base, status: null })).toBeNull();
  });
});
