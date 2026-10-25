// Types for messages.mjs.

export const KIND_GUILD: 4;
export const KIND_GUILD_EVENTS: 5;
export const KIND_RAID: 6;
export const KIND_RAID_EVENTS: 7;

export interface GuildMember {
  name: string;
  rankIndex: number;
  level: number;
  /** The class token: WARRIOR, DRUID… */
  class: string;
  zone: string;
  online: boolean;
  /** 0 none, 1 AFK, 2 DND. */
  status: number;
  /** Hours since they were last online, or null when online (or unknown). */
  hoursOffline: number | null;
}

export interface GroupMember {
  name: string;
  class: string;
  level: number;
  subgroup: number;
  /** 0 member, 1 assistant, 2 leader. */
  rank: number;
  /** "T" main tank, "A" main assist, or "". */
  role: string;
  online: boolean;
  dead: boolean;
  zone: string;
  masterLooter: boolean;
}

export type RosterMessage<M> =
  | { type: 'info'; name: string; motd: string; ranks: string[] }
  | { type: 'full'; sync: number; index: number; count: number; members: M[]; removed: string[] }
  | { type: 'delta'; sync: number; members: M[]; removed: string[] };

export function parseRosterMessage(kind: 4, text: string): RosterMessage<GuildMember> | null;
export function parseRosterMessage(kind: 6, text: string): RosterMessage<GroupMember> | null;
export function parseRosterMessage(kind: number, text: string): RosterMessage<GuildMember | GroupMember> | null;

export class RosterTracker<M extends { name: string } = GuildMember> {
  sync: number;
  members: Map<string, M>;
  apply(msg: RosterMessage<M> | null): { full: boolean; members: M[]; removed: string[] } | null;
}

export interface GuildEvent {
  type: string;
  /** Seconds since 1970 by the game's clock. */
  t: number;
  name: string;
  a: string;
  b: string;
}
export function parseGuildEvents(text: string): GuildEvent[];

export type RaidEvent =
  | { tag: 'raid'; id: number; zone: string; instanceId: number; endT: number | null; size: number; lootMethod: string; masterLooter: string }
  | { tag: 'attendance'; t: number; raid: number; kind: string; boss: string; names: string[] }
  | { tag: 'encounter'; t: number; raid: number; id: number; name: string; difficulty: number; size: number; success: boolean | null; endT: number | null }
  | { tag: 'loot'; t: number; raid: number; who: string; itemId: number; name: string; quality: number; count: number; boss: string }
  | { tag: 'readycheck'; t: number; initiator: string }
  | { tag: 'readycheck_done'; t: number; initiator: string; ready: string[]; notReady: string[]; afk: string[] };
export function parseRaidEvents(text: string): RaidEvent[];
