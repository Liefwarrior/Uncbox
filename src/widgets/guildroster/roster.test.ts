import { describe, expect, it } from 'vitest';
import { MEMBERS, WOW_NOW } from '../../wowMocks';
import { cleanRosterSettings, defaultRosterSettings } from './settings';
import { countText, filterRoster, headerText, isFiltering, noFilter, notesShown, onlineDots, presenceText, rankChangeText, rankOptions, sessionLength, sortRoster } from './roster';

const names = (list: { name: string }[]) => list.map((m) => m.name);

describe('filterRoster', () => {
  it('lists everyone with no filter', () => {
    expect(filterRoster(MEMBERS, noFilter())).toHaveLength(MEMBERS.length);
    expect(isFiltering(noFilter())).toBe(false);
  });

  it('keeps only who is online', () => {
    const online = filterRoster(MEMBERS, { ...noFilter(), onlineOnly: true });
    expect(names(online)).toEqual(['Lief', 'Zoë', 'Kaz', 'Mira', 'Sela', 'Vex']);
  });

  it('filters by rank, by class and by a range of levels', () => {
    expect(names(filterRoster(MEMBERS, { ...noFilter(), rank: 3 }))).toEqual(['Mira', 'Torv']);
    expect(names(filterRoster(MEMBERS, { ...noFilter(), cls: 'Rogue' }))).toEqual(['Rook']);
    expect(names(filterRoster(MEMBERS, { ...noFilter(), minLevel: 40, maxLevel: 58 }))).toEqual(['Rook', 'Mira']);
    expect(names(filterRoster(MEMBERS, { ...noFilter(), minLevel: 60 }))).toEqual(['Lief', 'Zoë', 'Kaz', 'Sela', 'Vex']);
    expect(names(filterRoster(MEMBERS, { ...noFilter(), maxLevel: 33 }))).toEqual(['Torv']);
  });

  it('searches name, class, rank and zone, ignoring case and accents, every word having to match', () => {
    expect(names(filterRoster(MEMBERS, { ...noFilter(), search: 'zoe' }))).toEqual(['Zoë']);
    expect(names(filterRoster(MEMBERS, { ...noFilter(), search: 'ZOË' }))).toEqual(['Zoë']);
    expect(names(filterRoster(MEMBERS, { ...noFilter(), search: 'tanaris' }))).toEqual(['Mira']);
    expect(names(filterRoster(MEMBERS, { ...noFilter(), search: 'priest' }))).toEqual(['Zoë']);
    expect(names(filterRoster(MEMBERS, { ...noFilter(), search: 'raider molten' }))).toEqual(['Kaz', 'Rook', 'Sela', 'Vex']);
    expect(filterRoster(MEMBERS, { ...noFilter(), search: 'nobody here' })).toEqual([]);
  });

  it('combines filters', () => {
    expect(names(filterRoster(MEMBERS, { ...noFilter(), onlineOnly: true, rank: 2, search: 'molten' }))).toEqual(['Kaz', 'Sela', 'Vex']);
    expect(isFiltering({ ...noFilter(), search: ' x ' })).toBe(true);
  });
});

describe('sortRoster', () => {
  it('puts who is online first, then by rank', () => {
    expect(names(sortRoster(MEMBERS, 'online'))).toEqual(['Lief', 'Zoë', 'Kaz', 'Sela', 'Vex', 'Mira', 'Bumta', 'Rook', 'Torv']);
  });

  it('sorts by name, level (highest first), rank, class and zone', () => {
    expect(names(sortRoster(MEMBERS, 'name'))).toEqual(['Bumta', 'Kaz', 'Lief', 'Mira', 'Rook', 'Sela', 'Torv', 'Vex', 'Zoë']);
    expect(sortRoster(MEMBERS, 'level').map((m) => m.level)).toEqual([60, 60, 60, 60, 60, 59, 58, 41, 33]);
    expect(names(sortRoster(MEMBERS, 'rank')).slice(0, 2)).toEqual(['Lief', 'Zoë']);
    expect(names(sortRoster(MEMBERS, 'class'))[0]).toBe('Lief');
    expect(names(sortRoster(MEMBERS, 'class')).at(-1)).toBe('Bumta');
    expect(sortRoster(MEMBERS, 'zone')[0].zone).toBe('Molten Core');
  });

  it('sorts by when they were last seen, online first', () => {
    expect(names(sortRoster(MEMBERS, 'seen')).slice(-3)).toEqual(['Bumta', 'Rook', 'Torv']);
  });

  it('does not change the list it is given', () => {
    const before = names(MEMBERS);
    sortRoster(MEMBERS, 'name');
    expect(names(MEMBERS)).toEqual(before);
  });
});

describe('the words', () => {
  it('counts online of the total', () => {
    expect(countText(23, 57)).toBe('23 online of 57');
    expect(headerText(MEMBERS, MEMBERS)).toBe('6 online of 9');
    expect(headerText(MEMBERS, MEMBERS.slice(0, 2))).toBe('2 shown · 6 online of 9');
  });

  it('says who is here, away, busy, or when they were last seen', () => {
    expect(presenceText(MEMBERS[0], WOW_NOW)).toBe('Online');
    expect(presenceText(MEMBERS[1], WOW_NOW)).toBe('Away');
    expect(presenceText(MEMBERS[5], WOW_NOW)).toBe('Busy');
    expect(presenceText(MEMBERS[2], WOW_NOW)).toBe('Seen 3 h ago');
  });

  it('describes rank changes and session lengths', () => {
    expect(rankChangeText({ kind: 'promote', rank: 'Officer' })).toBe('Promoted to Officer');
    expect(rankChangeText({ kind: 'demote', rank: 'Initiate' })).toBe('Demoted to Initiate');
    expect(sessionLength({ start: 1000, end: 4000 }, 9000)).toBe(3000);
    expect(sessionLength({ start: 1000, end: null }, 9000)).toBe(8000);
  });

  it('gives a dot per online member for the compact view, capped', () => {
    expect(onlineDots(MEMBERS)).toHaveLength(6);
    expect(onlineDots(MEMBERS, 2)).toHaveLength(2);
  });

  it('lists the ranks that have members, with names', () => {
    expect(rankOptions(['Guild Master', 'Officer', 'Raider', 'Initiate'], MEMBERS)).toEqual([
      { index: 0, name: 'Guild Master' },
      { index: 1, name: 'Officer' },
      { index: 2, name: 'Raider' },
      { index: 3, name: 'Initiate' },
    ]);
    expect(rankOptions([], MEMBERS)[1].name).toBe('Officer');
  });
});

describe('which notes may be shown', () => {
  const on = { showOfficerNotes: true, showNotesOnStream: true };
  it('shows public notes while editing, and on stream only when asked', () => {
    expect(notesShown({ isPrivate: false, showOfficerNotes: false, showNotesOnStream: false }).publicNote).toBe(true);
    expect(notesShown({ isPrivate: true, showOfficerNotes: false, showNotesOnStream: false }).publicNote).toBe(false);
    expect(notesShown({ isPrivate: true, showOfficerNotes: false, showNotesOnStream: true }).publicNote).toBe(true);
  });

  it('shows officer notes only while editing with the setting on, never on stream', () => {
    expect(notesShown({ isPrivate: false, showOfficerNotes: false, showNotesOnStream: true }).officerNote).toBe(false);
    expect(notesShown({ isPrivate: false, ...on }).officerNote).toBe(true);
    expect(notesShown({ isPrivate: true, ...on }).officerNote).toBe(false);
  });
});

describe('settings', () => {
  it('start with officer notes and stream notes off', () => {
    expect(defaultRosterSettings()).toMatchObject({ showOfficerNotes: false, showNotesOnStream: false });
  });

  it('are put right when they come from a hand-edited file', () => {
    const bad = { ...defaultRosterSettings(), sort: 'sideways' as never, rank: 99, cls: 'Gnome', minLevel: -4, maxLevel: 900 };
    expect(cleanRosterSettings(bad)).toMatchObject({ sort: 'online', rank: -1, cls: '', minLevel: 0, maxLevel: 80 });
    expect(cleanRosterSettings(defaultRosterSettings())).toEqual(defaultRosterSettings());
  });
});
