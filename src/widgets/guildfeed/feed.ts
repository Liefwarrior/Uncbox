import { clockTime, type GuildEvent, type LootEntry, type RaidSummary } from '../shared/wowGuild';

// The Guild news feed's logic: turn what the server keeps (guild events, boss kills, loot) into
// plain-words lines, newest first, and choose which of them to show.

export const FEED_KINDS = ['join', 'leave', 'rank', 'level', 'online', 'boss', 'loot'] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

export const KIND_LABELS: Record<FeedKind, string> = {
  join: 'Joins',
  leave: 'Leaves',
  rank: 'Promotions',
  level: 'Level-ups',
  online: 'Online / offline',
  boss: 'Boss kills',
  loot: 'Loot',
};

/** What is on when a feed is added: everything except coming and going, which is too noisy. */
export const DEFAULT_KINDS: FeedKind[] = ['join', 'leave', 'rank', 'level', 'boss', 'loot'];

export interface FeedItem {
  /** Stable for the same news, so a refetch doesn't make old lines look new. */
  id: string;
  at: number;
  kind: FeedKind;
  /** The line, in plain words. */
  text: string;
  /** The part of the line that is a person's name, for the class color. */
  name?: string;
  /** The item's quality, for a loot line. */
  quality?: number;
  /** Someone going away or being brought down a rank: left out on stream unless asked for. */
  departure: boolean;
}

/** A guild event as a line. */
export function eventLine(e: GuildEvent): Pick<FeedItem, 'kind' | 'text' | 'departure'> {
  switch (e.type) {
    case 'join':
      return { kind: 'join', text: `${e.name} joined the guild`, departure: false };
    case 'leave':
      return { kind: 'leave', text: `${e.name} left the guild`, departure: true };
    case 'kick':
      return { kind: 'leave', text: `${e.name} was removed from the guild${e.b ? ` by ${e.b}` : ''}`, departure: true };
    case 'promote':
      return { kind: 'rank', text: `${e.name} was promoted to ${e.a || 'a higher rank'}${e.b ? ` by ${e.b}` : ''}`, departure: false };
    case 'demote':
      return { kind: 'rank', text: `${e.name} was demoted to ${e.a || 'a lower rank'}${e.b ? ` by ${e.b}` : ''}`, departure: true };
    case 'level':
      return { kind: 'level', text: `${e.name} reached level ${e.a}`, departure: false };
    case 'on':
      return { kind: 'online', text: `${e.name} came online`, departure: false };
    case 'off':
      return { kind: 'online', text: `${e.name} went offline`, departure: false };
  }
}

export interface FeedInput {
  events: readonly GuildEvent[];
  raids: readonly RaidSummary[];
  loot: readonly LootEntry[];
}

export interface FeedOptions {
  kinds: readonly FeedKind[];
  /** Loot of this quality and better is news (4 is epic). */
  lootMinQuality: number;
  /** Drop the lines that are about someone going (for stream). */
  hideDepartures: boolean;
  max: number;
}

/** Every line there is news for, newest first, then the ones the options leave in. */
export function buildFeed(input: FeedInput, opts: FeedOptions): FeedItem[] {
  const items: FeedItem[] = [];
  for (const e of input.events) {
    const line = eventLine(e);
    items.push({ id: `e${e.id}`, at: e.at, name: e.name, ...line });
  }
  for (const raid of input.raids) {
    for (const boss of raid.bosses) {
      if (boss.success !== true) continue;
      const at = boss.endedAt ?? boss.startedAt;
      items.push({ id: `b${raid.id}-${boss.id}-${boss.startedAt}`, at, kind: 'boss', text: `${boss.name} was defeated${raid.zone ? ` in ${raid.zone}` : ''}`, departure: false });
    }
  }
  for (const l of input.loot) {
    if (l.quality < opts.lootMinQuality) continue;
    items.push({
      id: `l${l.id}`,
      at: l.at,
      kind: 'loot',
      name: l.who,
      quality: l.quality,
      text: `${l.who} got ${l.name || `item ${l.itemId}`}${l.count > 1 ? ` ×${l.count}` : ''}${l.boss ? ` from ${l.boss}` : ''}`,
      departure: false,
    });
  }
  return items
    .filter((i) => opts.kinds.includes(i.kind) && !(opts.hideDepartures && i.departure))
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
    .slice(0, opts.max);
}

/** The time on a line: "7:42 PM", with the day first when it wasn't today. */
export const lineTime = (item: FeedItem, now: number): string => clockTime(item.at, now);

/** Which lines are new since the last time we looked: none the first time, so nothing fades in on load. */
export function newIds(previous: ReadonlySet<string> | null, items: readonly FeedItem[]): Set<string> {
  if (!previous) return new Set();
  return new Set(items.filter((i) => !previous.has(i.id)).map((i) => i.id));
}
