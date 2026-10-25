import { fold, type LootEntry, type RaidSummary } from '../shared/wowGuild';
import { csvDateTime, toCsv } from '../shared/csv';
import { qualityName } from '../shared/quality';

// The Raid loot widget's logic: filtering the history, who has had the fewest drops lately (for
// fair loot), and the CSV.

export interface LootFilter {
  /** Part of a player's name; '' for everyone. */
  member: string;
  /** A raid's id, or 0 for every raid. */
  raid: number;
  /** Items of this quality and better. */
  minQuality: number;
  /** Only the last this many days; 0 for all of it. */
  days: number;
}

export const noLootFilter = (): LootFilter => ({ member: '', raid: 0, minQuality: 0, days: 0 });

export const DAY_CHOICES = [
  { days: 0, label: 'All time' },
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
] as const;

/** The loot that passes every filter, newest first. */
export function filterLoot(loot: readonly LootEntry[], f: LootFilter, now: number): LootEntry[] {
  const who = fold(f.member.trim());
  const since = f.days > 0 ? now - f.days * 86_400_000 : 0;
  return loot
    .filter((l) => (!who || fold(l.who).includes(who)) && (!f.raid || l.raidId === f.raid) && l.quality >= f.minQuality && l.at >= since)
    .sort((a, b) => b.at - a.at || b.id - a.id);
}

export interface FairRow {
  name: string;
  /** Items they were given in the window (a stack counts for what it holds). */
  drops: number;
  /** Raids in the window they were at. */
  raids: number;
  lastAt: number;
}

/**
 * Who has had how many drops lately, fewest first: the people who should be looked at first when
 * something drops. Everyone who was at a raid in the window is listed, even with nothing. Among
 * equal counts, the one who was at more raids comes first. Only items of `minQuality` and better count.
 */
export function fairness(
  loot: readonly LootEntry[],
  raids: readonly RaidSummary[],
  opts: { minQuality: number; days: number; now: number },
): FairRow[] {
  const since = opts.days > 0 ? opts.now - opts.days * 86_400_000 : 0;
  const rows = new Map<string, FairRow>();
  const row = (name: string) => {
    let r = rows.get(name);
    if (!r) rows.set(name, (r = { name, drops: 0, raids: 0, lastAt: 0 }));
    return r;
  };
  for (const raid of raids) {
    if (raid.startedAt < since) continue;
    for (const a of raid.attendees) if (a.pct >= 50) row(a.name).raids++;
  }
  for (const l of loot) {
    if (l.at < since || l.quality < opts.minQuality) continue;
    const r = row(l.who);
    r.drops += Math.max(1, l.count);
    r.lastAt = Math.max(r.lastAt, l.at);
  }
  return [...rows.values()].sort((a, b) => a.drops - b.drops || b.raids - a.raids || a.lastAt - b.lastAt || a.name.localeCompare(b.name));
}

/** The CSV for a loot council: one row per drop. `raidsById` gives the zone for a raid's id. */
export function lootCsv(loot: readonly LootEntry[], raids: readonly RaidSummary[]): string {
  const zone = new Map(raids.map((r) => [r.id, r.zone]));
  const head = ['Date', 'Raid', 'Boss', 'Player', 'Item', 'Item ID', 'Quality', 'Count'];
  const body = loot.map((l) => [csvDateTime(l.at), (l.raidId && zone.get(l.raidId)) || '', l.boss, l.who, l.name, l.itemId, qualityName(l.quality), l.count]);
  return toCsv([head, ...body]);
}

/** Totals per player over the loot given: [name, drops], most first. */
export function perMember(loot: readonly LootEntry[]): { name: string; drops: number }[] {
  const n = new Map<string, number>();
  for (const l of loot) n.set(l.who, (n.get(l.who) ?? 0) + Math.max(1, l.count));
  return [...n.entries()].map(([name, drops]) => ({ name, drops })).sort((a, b) => b.drops - a.drops || a.name.localeCompare(b.name));
}
