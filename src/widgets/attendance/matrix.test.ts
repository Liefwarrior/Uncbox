import { describe, expect, it } from 'vitest';
import { ATTENDANCE, RAIDS, RANKS } from '../../wowMocks';
import { attendanceCsv, averagePct, buildMatrix, raidDetail, shapeRows } from './matrix';
import { cleanAttendanceSettings, defaultAttendanceSettings } from './settings';

const matrix = buildMatrix(RAIDS, ATTENDANCE.members, 10);
const row = (name: string) => matrix.rows.find((r) => r.name === name)!;

describe('buildMatrix', () => {
  it('has a column per raid, the oldest on the left', () => {
    expect(matrix.raids.map((r) => r.id)).toEqual([201, 202]);
    expect(matrix.raids[1].bosses).toEqual(['Lucifron', 'Magmadar', 'Gehennas']);
  });

  it('counts someone as there when they were in half the raid or more', () => {
    expect(row('Kaz').present).toEqual([true, true]);
    expect(row('Sela').present).toEqual([false, true]);
    expect(row('Bumta').present).toEqual([true, false]);
  });

  it('works out each person’s percentage from the raids shown', () => {
    expect([row('Lief').pct, row('Bumta').pct, row('Mira').pct]).toEqual([100, 50, 0]);
    expect(row('Bumta').attended).toBe(1);
  });

  it('only looks at the last N raids', () => {
    const one = buildMatrix(RAIDS, ATTENDANCE.members, 1);
    expect(one.raids.map((r) => r.id)).toEqual([202]);
    expect(one.rows.find((r) => r.name === 'Bumta')!.pct).toBe(0);
    expect(one.rows.find((r) => r.name === 'Kaz')!.pct).toBe(100);
  });

  it('leaves out a raid with no snapshots, since it cannot say who was there', () => {
    const blind = { ...RAIDS[0], id: 999, snapshots: 0 };
    expect(buildMatrix([blind, ...RAIDS], ATTENDANCE.members, 10).raids.map((r) => r.id)).toEqual([201, 202]);
  });

  it('includes people who came but are not in the guild, as pickups', () => {
    const pug = { ...RAIDS[0], attendees: [...RAIDS[0].attendees, { name: 'Wanderer', pct: 90 }] };
    const m = buildMatrix([pug], ATTENDANCE.members, 10);
    expect(m.rows.find((r) => r.name === 'Wanderer')).toMatchObject({ inGuild: false, rankIndex: null, pct: 100 });
  });

  it('counts how many were there at each raid, and gives 0% when there are no raids', () => {
    expect(matrix.raids.map((r) => r.there)).toEqual([5, 4]);
    expect(buildMatrix([], ATTENDANCE.members, 10).rows.every((r) => r.pct === 0)).toBe(true);
  });
});

describe('shapeRows', () => {
  it('sorts by percentage, with more raids first among equals', () => {
    const rows = shapeRows(matrix.rows, { rank: -1, guildOnly: true }, 'pct');
    expect(rows.map((r) => r.pct)).toEqual([100, 100, 100, 50, 50, 50, 0]);
    expect(rows.at(-1)!.name).toBe('Mira');
  });

  it('sorts by name and by rank', () => {
    expect(shapeRows(matrix.rows, { rank: -1, guildOnly: true }, 'name').map((r) => r.name)).toEqual(['Bumta', 'Kaz', 'Lief', 'Mira', 'Rook', 'Sela', 'Zoë']);
    expect(shapeRows(matrix.rows, { rank: -1, guildOnly: true }, 'rank').map((r) => r.rankIndex)).toEqual([0, 1, 2, 2, 2, 2, 3]);
  });

  it('filters by rank, and leaves out pickups when asked', () => {
    expect(shapeRows(matrix.rows, { rank: 2, guildOnly: true }, 'name').map((r) => r.name)).toEqual(['Bumta', 'Kaz', 'Rook', 'Sela']);
    const pug = buildMatrix([{ ...RAIDS[0], attendees: [{ name: 'Wanderer', pct: 100 }] }], ATTENDANCE.members, 10);
    expect(shapeRows(pug.rows, { rank: -1, guildOnly: true }, 'name').some((r) => r.name === 'Wanderer')).toBe(false);
    expect(shapeRows(pug.rows, { rank: -1, guildOnly: false }, 'name').some((r) => r.name === 'Wanderer')).toBe(true);
  });

  it('averages the percentages', () => {
    expect(averagePct(matrix.rows)).toBe(64);
    expect(averagePct([])).toBe(0);
  });
});

describe('raidDetail', () => {
  it('tells the zone, the size, the bosses, who was there and which guild members missed it', () => {
    const d = raidDetail(matrix.raids[1], matrix.rows, 1);
    expect(d).toMatchObject({ zone: 'Molten Core', size: 40, bosses: ['Lucifron', 'Magmadar', 'Gehennas'] });
    expect(d.there.sort()).toEqual(['Kaz', 'Lief', 'Sela', 'Zoë']);
    expect(d.missed.sort()).toEqual(['Bumta', 'Mira', 'Rook']);
  });
});

describe('attendanceCsv', () => {
  const lines = (text: string) => text.trimEnd().split('\r\n');

  it('has a header with a column per raid, and a row per person', () => {
    const rows = shapeRows(matrix.rows, { rank: -1, guildOnly: true }, 'name');
    const out = lines(attendanceCsv(matrix, rows, RANKS));
    expect(out).toHaveLength(8);
    expect(out[0].split(',')).toHaveLength(8);
    expect(out[0]).toMatch(/^Name,Class,Rank,Attendance %,Raids attended,Raids counted,\d{4}-\d{2}-\d{2} Molten Core,\d{4}-\d{2}-\d{2} Molten Core$/);
    expect(out[1]).toBe('Bumta,Warrior,Raider,50,1,2,Yes,No');
  });

  it('keeps names with accents, and quotes what needs it', () => {
    const rows = [{ ...matrix.rows[0], name: 'Zoë, "the Kind"', cls: 'PRIEST' }];
    const out = lines(attendanceCsv(matrix, rows, RANKS));
    expect(out[1].startsWith('"Zoë, ""the Kind""",Priest,')).toBe(true);
    expect(lines(attendanceCsv(matrix, [{ ...matrix.rows[0], name: 'Zoë' }], RANKS))[1].startsWith('Zoë,')).toBe(true);
  });

  it('leaves the rank empty for a pickup', () => {
    const pug = { ...matrix.rows[0], rankIndex: null, inGuild: false };
    expect(lines(attendanceCsv(matrix, [pug], RANKS))[1].split(',')[2]).toBe('');
  });
});

describe('settings', () => {
  it('start at the last 10 raids by percentage, guild members only, names hidden on stream', () => {
    expect(defaultAttendanceSettings()).toMatchObject({ raids: 10, sort: 'pct', guildOnly: true, showNamesOnStream: false });
  });

  it('are put right when they come from a hand-edited file', () => {
    expect(cleanAttendanceSettings({ ...defaultAttendanceSettings(), raids: 500, sort: 'x' as never, rank: -7 })).toMatchObject({ raids: 10, sort: 'pct', rank: -1 });
  });
});
