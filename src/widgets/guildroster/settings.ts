import { CLASS_NAMES } from '../shared/classColor';
import { ROSTER_SORTS, type RosterSort } from './roster';

export type RosterSettings = {
  /** Show officer notes (while editing; never on stream). */
  showOfficerNotes: boolean;
  /** Show public notes on stream too. */
  showNotesOnStream: boolean;
  /** Only the online count and class dots, however big the panel. */
  compact: boolean;
  sort: RosterSort;
  onlineOnly: boolean;
  /** A rank's index, or -1 for any. */
  rank: number;
  /** A class name, or '' for any. */
  cls: string;
  /** 0 for no limit. */
  minLevel: number;
  maxLevel: number;
};

export const defaultRosterSettings = (): RosterSettings => ({
  showOfficerNotes: false,
  showNotesOnStream: false,
  compact: false,
  sort: 'online',
  onlineOnly: false,
  rank: -1,
  cls: '',
  minLevel: 0,
  maxLevel: 0,
});

const level = (n: number) => (Number.isFinite(n) ? Math.min(80, Math.max(0, Math.round(n))) : 0);

export function cleanRosterSettings(s: RosterSettings): RosterSettings {
  return {
    ...s,
    sort: ROSTER_SORTS.includes(s.sort) ? s.sort : 'online',
    rank: Number.isInteger(s.rank) && s.rank >= 0 && s.rank < 20 ? s.rank : -1,
    cls: CLASS_NAMES.includes(s.cls) ? s.cls : '',
    minLevel: level(s.minLevel),
    maxLevel: level(s.maxLevel),
  };
}
