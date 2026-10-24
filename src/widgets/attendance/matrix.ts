import { classLabel } from '../shared/classColor';
import { csvDate, toCsv } from '../shared/csv';
import type { AttendanceMember, RaidSummary } from '../shared/wowGuild';

// The Raid attendance table's logic: who was at which raid, the percentage, and the CSV for a loot
// council. Someone was at a raid if they were in at least half its snapshots (what the server uses
// too); a raid with no snapshots can't say who was there and is left out.

/** How much of a raid someone must have been in to count as there. */
export const PRESENT_PCT = 50;

export const ATTENDANCE_SORTS = ['pct', 'name', 'rank'] as const;
export type AttendanceSort = (typeof ATTENDANCE_SORTS)[number];
export const SORT_LABELS: Record<AttendanceSort, string> = { pct: 'Attendance %', name: 'Name', rank: 'Rank' };

export interface MatrixRaid {
  id: number;
  zone: string;
  startedAt: number;
  size: number | null;
  bosses: string[];
  /** How many of the people in the table were there. */
  there: number;
}

export interface MatrixRow {
  name: string;
  cls: string;
  /** The rank's index, or null for someone who isn't in the guild (a pickup). */
  rankIndex: number | null;
  inGuild: boolean;
  /** Per raid, in the same order as the columns. */
  present: boolean[];
  attended: number;
  pct: number;
}

export interface Matrix {
  raids: MatrixRaid[];
  rows: MatrixRow[];
}

/**
 * The last `last` raids (oldest on the left) against everyone who has a place in the guild or was
 * at one of them. `members` is the attendance answer, which has the class and rank of each.
 */
export function buildMatrix(raids: readonly RaidSummary[], members: readonly AttendanceMember[], last: number): Matrix {
  const counted = raids
    .filter((r) => r.snapshots > 0)
    .sort((a, b) => b.id - a.id)
    .slice(0, Math.max(1, last))
    .reverse();
  const info = new Map(members.map((m) => [m.name, m]));
  const names = new Set<string>(members.filter((m) => m.inGuild).map((m) => m.name));
  for (const r of counted) for (const a of r.attendees) if (a.pct >= PRESENT_PCT) names.add(a.name);

  const there = counted.map((r) => new Set(r.attendees.filter((a) => a.pct >= PRESENT_PCT).map((a) => a.name)));
  const rows = [...names].map((name): MatrixRow => {
    const present = there.map((set) => set.has(name));
    const attended = present.filter(Boolean).length;
    const m = info.get(name);
    return {
      name,
      cls: m?.class ?? '',
      rankIndex: m?.rankIndex ?? null,
      inGuild: m?.inGuild ?? false,
      present,
      attended,
      pct: counted.length ? Math.round((attended / counted.length) * 100) : 0,
    };
  });
  return {
    raids: counted.map((r, i) => ({
      id: r.id,
      zone: r.zone,
      startedAt: r.startedAt,
      size: r.size,
      bosses: r.bosses.filter((b) => b.success).map((b) => b.name),
      there: rows.filter((row) => row.present[i]).length,
    })),
    rows,
  };
}

export interface RowFilter {
  /** A rank's index, or -1 for every rank. */
  rank: number;
  /** Leave out people who aren't in the guild. */
  guildOnly: boolean;
}

/** The rows that pass the filter, in the order asked for (a new list). */
export function shapeRows(rows: readonly MatrixRow[], f: RowFilter, sort: AttendanceSort): MatrixRow[] {
  const kept = rows.filter((r) => (!f.guildOnly || r.inGuild) && (f.rank < 0 || r.rankIndex === f.rank));
  const rank = (r: MatrixRow) => r.rankIndex ?? 99;
  const compare: Record<AttendanceSort, (a: MatrixRow, b: MatrixRow) => number> = {
    pct: (a, b) => b.pct - a.pct || b.attended - a.attended,
    name: (a, b) => a.name.localeCompare(b.name),
    rank: (a, b) => rank(a) - rank(b),
  };
  return kept.sort((a, b) => compare[sort](a, b) || b.pct - a.pct || a.name.localeCompare(b.name));
}

/** The average attendance of the rows, in whole percent (0 for none). */
export function averagePct(rows: readonly MatrixRow[]): number {
  return rows.length ? Math.round(rows.reduce((sum, r) => sum + r.pct, 0) / rows.length) : 0;
}

/** One raid in words, for the detail under the table. */
export function raidDetail(raid: MatrixRaid, rows: readonly MatrixRow[], index: number) {
  return {
    zone: raid.zone || 'Raid',
    startedAt: raid.startedAt,
    size: raid.size,
    bosses: raid.bosses,
    there: rows.filter((r) => r.present[index]).map((r) => r.name),
    missed: rows.filter((r) => r.inGuild && !r.present[index]).map((r) => r.name),
  };
}

/** The CSV for a loot council: a row per person, a Yes or No per raid. Rank names come from the guild's rank list. */
export function attendanceCsv(matrix: Matrix, rows: readonly MatrixRow[], ranks: readonly string[]): string {
  const head = ['Name', 'Class', 'Rank', 'Attendance %', 'Raids attended', 'Raids counted', ...matrix.raids.map((r) => `${csvDate(r.startedAt)} ${r.zone}`.trim())];
  const body = rows.map((r) => [
    r.name,
    classLabel(r.cls),
    r.rankIndex === null ? '' : (ranks[r.rankIndex] ?? `Rank ${r.rankIndex + 1}`),
    r.pct,
    r.attended,
    matrix.raids.length,
    ...r.present.map((p) => (p ? 'Yes' : 'No')),
  ]);
  return toCsv([head, ...body]);
}
