import { useEffect, useRef, useState } from 'react';
import { listen } from '../../events';
import { addonLine, SEEN_WITHIN_MS, useWowSeenAt, useWowStatus, type WowStatus } from '../../wow';

// What the WoW guild widgets share: the shapes the guild link answers with (server/wowdb.mjs),
// a hook that keeps one answer fresh, the "set it up" notices, and the little pure helpers for
// names, times and links. Times are milliseconds since 1970 everywhere.

// ---- what the server answers ----

export interface GuildMember {
  name: string;
  rankIndex: number;
  rank: string;
  level: number;
  class: string;
  zone: string;
  note: string;
  /** Only when asked for (?officer=1). */
  officerNote?: string;
  online: boolean;
  status: '' | 'afk' | 'dnd';
  lastSeen: number;
  firstSeen: number;
}

export interface GuildAnswer {
  available: boolean;
  guild: { name: string; motd: string; info: string; ranks: string[]; updatedAt: number };
  members: GuildMember[];
  counts: { total: number; online: number };
}

export type GuildEventType = 'on' | 'off' | 'join' | 'leave' | 'kick' | 'promote' | 'demote' | 'level';

export interface GuildEvent {
  id: number;
  at: number;
  type: GuildEventType;
  name: string;
  /** The new rank (promote, demote) or level. */
  a: string;
  /** Who did it (kick, promote, demote). */
  b: string;
}

export interface RaidBoss {
  id: number;
  name: string;
  difficulty: number;
  size: number;
  startedAt: number;
  endedAt: number | null;
  success: boolean | null;
}

export interface RaidSummary {
  id: number;
  zone: string;
  instanceId: number | null;
  size: number | null;
  startedAt: number;
  endedAt: number | null;
  lootMethod: string;
  masterLooter: string;
  bosses: RaidBoss[];
  kills: number;
  snapshots: number;
  /** Everyone who was in at least one snapshot; `pct` is how many of the raid's snapshots they were in. */
  attendees: { name: string; pct: number }[];
  lootCount: number;
}

export interface LootEntry {
  id: number;
  at: number;
  raidId: number | null;
  who: string;
  itemId: number;
  name: string;
  quality: number;
  count: number;
  boss: string;
}

export interface ReadyCheck {
  at: number;
  initiator: string;
  ready: string[];
  notReady: string[];
  afk: string[];
  done: boolean;
}

export interface RaidMember {
  name: string;
  class: string;
  level: number;
  subgroup: number;
  rank: 'leader' | 'assist' | 'member';
  /** The main tank / main assist assignment. */
  role: 'tank' | 'assist' | '';
  online: boolean;
  dead: boolean;
  zone: string;
  masterLooter: boolean;
}

export interface RaidAnswer {
  inRaid: boolean;
  size: number;
  members: RaidMember[];
  counts: { online: number; dead: number; byClass: Record<string, number> };
  raid: RaidSummary | null;
  lastReadyCheck: ReadyCheck | null;
  updatedAt: number;
}

export interface AttendanceMember {
  name: string;
  class: string;
  rankIndex: number | null;
  inGuild: boolean;
  attended: number;
  raids: number;
  pct: number;
  bossesAttended: number;
  bosses: number;
  lastRaidAt: number;
}

export interface AttendanceAnswer {
  raids: number;
  since: number;
  members: AttendanceMember[];
}

export interface MemberDetail {
  member: GuildMember;
  rankHistory: { at: number; kind: string; fromIndex: number | null; toIndex: number | null; rank: string; by: string }[];
  sessions: { name: string; start: number; end: number | null }[];
  loot: LootEntry[];
  attendance: AttendanceMember | null;
}

// ---- keeping an answer fresh ----

/** What the server's `wowguild` event says changed. */
export type WowTopic = 'guild' | 'events' | 'raid' | 'raids' | 'loot' | 'readychecks';

/** How often a showing widget asks again as well as when told, in case an event was missed. */
export const POLL_MS = 60_000;

/**
 * The JSON at `url`, asked for again when the server says one of `topics` changed, when the page
 * comes back to the front, and gently every minute while it is showing. Null until it arrives
 * (and for no url). An answer that fails keeps the last good one; `error` says why when there is none.
 */
export function useWowData<T>(url: string | null, topics: readonly WowTopic[], pollMs = POLL_MS): { data: T | null; error: string } {
  const [got, setGot] = useState<{ url: string; data: T } | null>(null);
  const [problem, setProblem] = useState<{ url: string; error: string } | null>(null);
  const key = topics.join(',');
  useEffect(() => {
    if (!url) return;
    let alive = true;
    let latest = 0;
    const load = () => {
      const mine = ++latest;
      fetch(url)
        .then(async (r) => {
          if (r.ok) return r.json();
          throw new Error((await r.json().catch(() => null))?.error ?? 'WoW isn’t answering');
        })
        .then((data) => {
          if (!alive || mine !== latest) return;
          setGot({ url, data });
          setProblem(null);
        })
        .catch((err) => {
          if (alive && mine === latest) setProblem({ url, error: err instanceof Error ? err.message : 'WoW isn’t answering' });
        });
    };
    load();
    const stop = listen('wowguild', (raw) => {
      let what: unknown;
      try {
        what = JSON.parse(raw).what;
      } catch {
        what = null;
      }
      if (!Array.isArray(what) || what.some((w) => key.split(',').includes(String(w)))) load();
    });
    const visible = () => document.visibilityState === 'visible';
    const timer = setInterval(() => visible() && load(), pollMs);
    const onShow = () => visible() && load();
    document.addEventListener('visibilitychange', onShow);
    return () => {
      alive = false;
      stop();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [url, key, pollMs]);
  return {
    data: url && got?.url === url ? got.data : null,
    error: url && problem?.url === url && !(got?.url === url) ? problem.error : '',
  };
}

// ---- when there is nothing to show yet ----

export interface SetupNotice {
  id: 'server' | 'addon' | 'seen' | 'guild';
  title: string;
  hint: string;
}

/**
 * Why a guild widget has nothing to show, in plain words, or null when it isn't a setup matter.
 * `error` is a failed request. `inGuild` is whether the roster has anyone (only asked for by
 * widgets about the guild).
 */
export function setupNotice(o: {
  status: WowStatus | null;
  seenAt: number;
  now: number;
  error: string;
  /** Only the guild widgets: false when the roster is empty. */
  inGuild?: boolean;
}): SetupNotice | null {
  if (o.error) return { id: 'server', title: 'Can’t reach the WoW link', hint: o.error };
  if (o.status && !addonLine(o.status).done && !o.status.installs.some((i) => i.version !== null)) {
    return o.status.installs.length
      ? { id: 'addon', title: 'The Uncbox addon isn’t installed', hint: 'Open the WoW preset’s Get set up list to install it, then type /reload in WoW.' }
      : { id: 'addon', title: 'WoW wasn’t found on this PC', hint: 'Install WoW Forever, and Uncbox sets its addon up by itself.' };
  }
  if (!o.seenAt) return { id: 'seen', title: 'Not seen in the game yet', hint: 'Log in to WoW and type /reload.' };
  if (o.now - o.seenAt > SEEN_WITHIN_MS && o.inGuild === false) return { id: 'seen', title: 'Not seen in the game lately', hint: 'Log in to WoW and type /reload.' };
  if (o.inGuild === false) return { id: 'guild', title: 'Not in a guild', hint: 'Join a guild in WoW and your members show up here.' };
  return null;
}

/**
 * The setup notice for a widget with nothing to show; null while there is something to show
 * (`hasData`), so the status isn't asked for at all then.
 */
export function useSetupNotice(hasData: boolean, error: string, inGuild?: boolean): SetupNotice | null {
  const status = useWowStatus(!hasData);
  const seenAt = useWowSeenAt();
  if (hasData) return null;
  return setupNotice({ status, seenAt, now: Date.now(), error, inGuild });
}

// ---- names ----

/** A name for comparing: no case, no accents ("Zoë" is "zoe"). */
export const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The same person under two spellings of their name. */
export const sameName = (a: string, b: string): boolean => fold(a) === fold(b);

/**
 * What to call each name on stream when names are hidden: "Member 1", "Member 2"… in the order the
 * names are first given (so the same person is the same number all through one widget).
 */
export function hiddenNames(names: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of names) if (!out.has(name)) out.set(name, `Member ${out.size + 1}`);
  return out;
}

/** The label for a name: itself, or its "Member N" when names are hidden. */
export function nameLabel(name: string, hidden: Map<string, string> | null): string {
  return hidden ? (hidden.get(name) ?? 'Member') : name;
}

// ---- times ----

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "2 days ago", then the date. */
export function ago(at: number, now: number): string {
  if (!at) return 'never';
  const d = Math.max(0, now - at);
  if (d < MINUTE) return 'just now';
  if (d < HOUR) return `${Math.floor(d / MINUTE)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  if (d < 30 * DAY) {
    const days = Math.floor(d / DAY);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }
  return shortDate(at);
}

/** "8 Oct" in this PC's language. */
export const shortDate = (at: number): string => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** "Tue 8 Oct" in this PC's language. */
export const longDate = (at: number): string => new Date(at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

/** "7:42 PM", with the day before it when it wasn't today. */
export function clockTime(at: number, now: number): string {
  const time = new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return sameDay ? time : `${new Date(at).toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

/** "3 h 8 min" for a length of time. */
export function lasted(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  return minutes % 60 ? `${h} h ${minutes % 60} min` : `${h} h`;
}

// ---- links and asking from outside ----

/** The Wowhead page of an item (Classic's). */
export const wowheadUrl = (itemId: number): string => `https://www.wowhead.com/classic/item=${Math.round(itemId)}`;

/** Opens an item's Wowhead page in the browser, through the server (it only opens that page). */
export function openItem(itemId: number) {
  void fetch('/api/wow/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: Math.round(itemId) }),
  }).catch(() => {});
}

type MemberListener = (name: string) => void;
const memberListeners = new Map<string, MemberListener>();
const memberWaiting = new Map<string, string>();

/**
 * Asks the Guild roster with this id to show a member, from outside it (the command palette).
 * A roster that isn't on screen yet is asked as soon as it is.
 */
export function requestMember(widgetId: string, name: string) {
  const listener = memberListeners.get(widgetId);
  if (listener) listener(name);
  else memberWaiting.set(widgetId, name);
}

/** Lets the Guild roster with this id be asked to show a member. */
export function useMemberRequests(widgetId: string, show: (name: string) => void) {
  const latest = useRef(show);
  latest.current = show;
  useEffect(() => {
    memberListeners.set(widgetId, (name) => latest.current(name));
    const waiting = memberWaiting.get(widgetId);
    if (waiting) {
      memberWaiting.delete(widgetId);
      latest.current(waiting);
    }
    return () => void memberListeners.delete(widgetId);
  }, [widgetId]);
}
