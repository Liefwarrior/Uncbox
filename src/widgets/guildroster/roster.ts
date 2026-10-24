import { classKey } from '../shared/classColor';
import { ago, fold, type GuildMember } from '../shared/wowGuild';

// The Guild roster's logic: which members to list, in which order, and the words around them.

export const ROSTER_SORTS = ['online', 'name', 'level', 'rank', 'class', 'zone', 'seen'] as const;
export type RosterSort = (typeof ROSTER_SORTS)[number];

export const SORT_LABELS: Record<RosterSort, string> = {
  online: 'Online first',
  name: 'Name',
  level: 'Level',
  rank: 'Rank',
  class: 'Class',
  zone: 'Zone',
  seen: 'Last seen',
};

export interface RosterFilter {
  /** Typed in the search box: matches a name, class, rank or zone. */
  search: string;
  onlineOnly: boolean;
  /** A rank's index, or -1 for any. */
  rank: number;
  /** A class name ("Druid"), or '' for any. */
  cls: string;
  /** 0 for no limit. */
  minLevel: number;
  maxLevel: number;
}

export const noFilter = (): RosterFilter => ({ search: '', onlineOnly: false, rank: -1, cls: '', minLevel: 0, maxLevel: 0 });

/** Whether any filter is narrowing the list. */
export const isFiltering = (f: RosterFilter): boolean => Boolean(f.search.trim()) || f.onlineOnly || f.rank >= 0 || Boolean(f.cls) || f.minLevel > 0 || f.maxLevel > 0;

/** The members that pass every filter. The search words must each be found in the name, class, rank or zone. */
export function filterRoster(members: readonly GuildMember[], f: RosterFilter): GuildMember[] {
  const words = fold(f.search).split(/\s+/).filter(Boolean);
  return members.filter((m) => {
    if (f.onlineOnly && !m.online) return false;
    if (f.rank >= 0 && m.rankIndex !== f.rank) return false;
    if (f.cls && classKey(m.class) !== classKey(f.cls)) return false;
    if (f.minLevel > 0 && m.level < f.minLevel) return false;
    if (f.maxLevel > 0 && m.level > f.maxLevel) return false;
    if (words.length) {
      const hay = fold(`${m.name} ${classKey(m.class)} ${m.rank} ${m.zone}`);
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

const byName = (a: GuildMember, b: GuildMember) => a.name.localeCompare(b.name);

/** The members in the order asked for (a new list; ties fall back to rank, then name). */
export function sortRoster(members: readonly GuildMember[], sort: RosterSort): GuildMember[] {
  const compare: Record<RosterSort, (a: GuildMember, b: GuildMember) => number> = {
    online: (a, b) => Number(b.online) - Number(a.online) || a.rankIndex - b.rankIndex,
    name: byName,
    level: (a, b) => b.level - a.level,
    rank: (a, b) => a.rankIndex - b.rankIndex,
    class: (a, b) => classKey(a.class).localeCompare(classKey(b.class)),
    zone: (a, b) => (a.zone || '~').localeCompare(b.zone || '~'),
    seen: (a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen,
  };
  return [...members].sort((a, b) => compare[sort](a, b) || a.rankIndex - b.rankIndex || byName(a, b));
}

/** "23 online of 57". */
export const countText = (online: number, total: number): string => `${online} online of ${total}`;

/** "23 online of 57", or with a filter on, "5 shown · 23 online of 57". */
export function headerText(all: readonly GuildMember[], shown: readonly GuildMember[]): string {
  const online = all.filter((m) => m.online).length;
  const base = countText(online, all.length);
  return shown.length === all.length ? base : `${shown.length} shown · ${base}`;
}

/** What to say about when a member was around: "Online", "Away", "Busy", or when they were last seen. */
export function presenceText(m: GuildMember, now: number): string {
  if (m.online) return m.status === 'afk' ? 'Away' : m.status === 'dnd' ? 'Busy' : 'Online';
  return `Seen ${ago(m.lastSeen, now)}`;
}

/** The online members' classes, in a stable order, for the dots of the compact view. */
export function onlineDots(members: readonly GuildMember[], max = 80): string[] {
  return sortRoster(
    members.filter((m) => m.online),
    'class',
  )
    .slice(0, max)
    .map((m) => m.class);
}

/**
 * Which notes may be on screen. Officer notes only while editing and only when the setting is on,
 * never on stream; public notes on stream only when "Show notes on stream" is on.
 */
export function notesShown(o: { editing: boolean; showOfficerNotes: boolean; showNotesOnStream: boolean }): { publicNote: boolean; officerNote: boolean } {
  return { publicNote: o.editing || o.showNotesOnStream, officerNote: o.editing && o.showOfficerNotes };
}

/** "Promoted to Officer", "Demoted to Initiate". */
export function rankChangeText(h: { kind: string; rank: string }): string {
  const rank = h.rank || 'a new rank';
  return h.kind === 'promote' ? `Promoted to ${rank}` : h.kind === 'demote' ? `Demoted to ${rank}` : `Rank ${rank}`;
}

/** A play session as a line: when it started and how long it lasted ("now" while it goes on). */
export function sessionLength(s: { start: number; end: number | null }, now: number): number {
  return Math.max(0, (s.end ?? now) - s.start);
}

/** The ranks of a guild for a filter: those with members, in order. */
export function rankOptions(ranks: readonly string[], members: readonly GuildMember[]): { index: number; name: string }[] {
  const used = new Set(members.map((m) => m.rankIndex));
  return [...used]
    .sort((a, b) => a - b)
    .map((index) => ({ index, name: ranks[index] || members.find((m) => m.rankIndex === index)?.rank || `Rank ${index + 1}` }));
}
