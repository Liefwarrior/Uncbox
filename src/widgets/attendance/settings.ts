import { ATTENDANCE_SORTS, type AttendanceSort } from './matrix';

export type AttendanceSettings = {
  /** How many of the latest raids to compare. */
  raids: number;
  sort: AttendanceSort;
  /** A rank's index, or -1 for every rank. */
  rank: number;
  /** Leave out people who aren't in the guild. */
  guildOnly: boolean;
  /** Show names on stream. Off, viewers see Member 1, Member 2… */
  showNamesOnStream: boolean;
};

export const RAID_COUNTS = [5, 10, 15, 20] as const;

export const defaultAttendanceSettings = (): AttendanceSettings => ({ raids: 10, sort: 'pct', rank: -1, guildOnly: true, showNamesOnStream: false });

export function cleanAttendanceSettings(s: AttendanceSettings): AttendanceSettings {
  const raids = Math.round(Number(s.raids));
  return {
    ...s,
    raids: raids >= 1 && raids <= 30 ? raids : 10,
    sort: ATTENDANCE_SORTS.includes(s.sort) ? s.sort : 'pct',
    rank: Number.isInteger(s.rank) && s.rank >= 0 && s.rank < 20 ? s.rank : -1,
  };
}
