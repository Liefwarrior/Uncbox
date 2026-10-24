import { classKey, classLabel } from '../shared/classColor';
import type { RaidMember, ReadyCheck } from '../shared/wowGuild';
import { ago } from '../shared/wowGuild';

// The Raid composition's logic: roles, class counts, which buffs the raid has, and who is in
// trouble. The game says who the main tank is, not who heals, so healing is a guess from the
// class that you can correct for each person.

export type Role = 'tank' | 'healer' | 'dps';
export const ROLES: Role[] = ['tank', 'healer', 'dps'];
export const ROLE_LABELS: Record<Role, string> = { tank: 'Tank', healer: 'Healer', dps: 'Damage' };
export const ROLE_SHORT: Record<Role, string> = { tank: 'T', healer: 'H', dps: 'D' };

/** The classes that can heal in Classic. */
export const HEALER_CLASSES = ['Priest', 'Paladin', 'Druid', 'Shaman'];

export interface RoleChoice {
  name: string;
  role: Role;
}

/** A guess at someone's role: the main tank assignment, else healer for a class that can heal, else damage. */
export function estimateRole(m: Pick<RaidMember, 'class' | 'role'>): Role {
  if (m.role === 'tank') return 'tank';
  return HEALER_CLASSES.includes(classKey(m.class)) ? 'healer' : 'dps';
}

/** A person's role: the one chosen for them, else the guess. */
export function roleOf(m: Pick<RaidMember, 'name' | 'class' | 'role'>, chosen: readonly RoleChoice[]): { role: Role; guessed: boolean } {
  const pick = chosen.find((c) => c.name === m.name);
  return pick ? { role: pick.role, guessed: false } : { role: estimateRole(m), guessed: true };
}

/** The role after clicking: Tank, Healer, Damage, then back to the guess. */
export function nextChoice(current: Role | null): Role | null {
  if (current === null) return 'tank';
  const i = ROLES.indexOf(current);
  return i + 1 < ROLES.length ? ROLES[i + 1] : null;
}

/** The chosen roles with this person's changed (null takes the choice away). */
export function withChoice(chosen: readonly RoleChoice[], name: string, role: Role | null): RoleChoice[] {
  const rest = chosen.filter((c) => c.name !== name);
  return role ? [...rest, { name, role }] : rest;
}

export interface RoleCounts {
  tank: number;
  healer: number;
  dps: number;
  /** How many of the healers are only a guess from their class. */
  guessed: number;
}

export function roleCounts(members: readonly RaidMember[], chosen: readonly RoleChoice[]): RoleCounts {
  const counts: RoleCounts = { tank: 0, healer: 0, dps: 0, guessed: 0 };
  for (const m of members) {
    const { role, guessed } = roleOf(m, chosen);
    counts[role]++;
    if (guessed && role === 'healer') counts.guessed++;
  }
  return counts;
}

/** The classes in the raid with how many, most first. */
export function classTally(members: readonly RaidMember[]): { cls: string; n: number }[] {
  const n = new Map<string, number>();
  for (const m of members) {
    const key = classKey(m.class) || 'Unknown';
    n.set(key, (n.get(key) ?? 0) + 1);
  }
  return [...n.entries()].map(([cls, count]) => ({ cls, n: count })).sort((a, b) => b.n - a.n || a.cls.localeCompare(b.cls));
}

/** What each class brings the raid that no one else can. */
export const RAID_BUFFS: { cls: string; label: string }[] = [
  { cls: 'Priest', label: 'Fortitude and Spirit' },
  { cls: 'Mage', label: 'Arcane Intellect' },
  { cls: 'Druid', label: 'Mark of the Wild' },
  { cls: 'Paladin', label: 'Blessings' },
  { cls: 'Shaman', label: 'Totems' },
  { cls: 'Warlock', label: 'Curses' },
  { cls: 'Warrior', label: 'Battle Shout' },
];

export interface BuffLine {
  cls: string;
  label: string;
  /** How many of that class are in the raid. */
  n: number;
}

/** Which of those buffs the raid has, and which it does without ("No Shaman"). Counts people who are online. */
export function buffCoverage(members: readonly RaidMember[]): { have: BuffLine[]; missing: BuffLine[] } {
  const have: BuffLine[] = [];
  const missing: BuffLine[] = [];
  for (const b of RAID_BUFFS) {
    const n = members.filter((m) => classKey(m.class) === b.cls && m.online).length;
    (n > 0 ? have : missing).push({ ...b, n });
  }
  return { have, missing };
}

/** The raid's 8 groups of 5, each with whoever is in it. Groups past the last one with anyone are left off. */
export function bySubgroup(members: readonly RaidMember[]): { group: number; members: RaidMember[] }[] {
  const groups = Array.from({ length: 8 }, (_, i) => ({ group: i + 1, members: [] as RaidMember[] }));
  for (const m of members) {
    const g = groups[Math.min(8, Math.max(1, m.subgroup)) - 1];
    g.members.push(m);
  }
  let last = 0;
  groups.forEach((g, i) => g.members.length && (last = i + 1));
  return groups.slice(0, Math.max(1, last));
}

/** Who is offline and who is dead. */
export function trouble(members: readonly RaidMember[]): { offline: string[]; dead: string[] } {
  return {
    offline: members.filter((m) => !m.online).map((m) => m.name),
    dead: members.filter((m) => m.dead && m.online).map((m) => m.name),
  };
}

/** The ready check in words: when, how many said ready, and who didn't. */
export function readySummary(check: ReadyCheck, now: number): { when: string; ready: number; notReady: string[]; away: string[] } {
  return { when: ago(check.at, now), ready: check.ready.length, notReady: check.notReady, away: check.afk };
}

/** "Priest, Paladin and Druid" for a short list of class names. */
export function listClasses(list: readonly string[]): string {
  const names = list.map((c) => classLabel(c) || c);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');
}
