// A pretend guild link for the tests: what /api/wow/guild, /raid, /raids, /attendance, /loot and the
// rest answer for a small guild in the middle of a raid night, and what they answer before anything
// has been collected. Used by src/smokeMocks.ts, and by the guild widgets' own tests.

import type { AttendanceAnswer, GuildAnswer, GuildEvent, GuildMember, LootEntry, MemberDetail, RaidAnswer, RaidSummary } from './widgets/shared/wowGuild';

export const WOW_NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const member = (name: string, cls: string, rankIndex: number, rank: string, level: number, over: Partial<GuildMember> = {}): GuildMember => ({
  name,
  rankIndex,
  rank,
  level,
  class: cls,
  zone: 'Molten Core',
  note: '',
  online: true,
  status: '',
  lastSeen: WOW_NOW,
  firstSeen: WOW_NOW - 90 * DAY,
  ...over,
});

export const RANKS = ['Guild Master', 'Officer', 'Raider', 'Initiate'];

export const MEMBERS: GuildMember[] = [
  member('Lief', 'DRUID', 0, 'Guild Master', 60, { note: 'Raid leader', officerNote: 'Owes 200g to the bank' }),
  member('Zoë', 'PRIEST', 1, 'Officer', 60, { status: 'afk', zone: 'Orgrimmar', note: 'Healing lead' }),
  member('Bumta', 'WARRIOR', 2, 'Raider', 59, { online: false, lastSeen: WOW_NOW - 3 * HOUR, zone: 'Orgrimmar' }),
  member('Kaz', 'SHAMAN', 2, 'Raider', 60, { zone: 'Molten Core' }),
  member('Rook', 'ROGUE', 2, 'Raider', 58, { online: false, lastSeen: WOW_NOW - 2 * DAY }),
  member('Mira', 'MAGE', 3, 'Initiate', 41, { zone: 'Tanaris', status: 'dnd' }),
  member('Torv', 'HUNTER', 3, 'Initiate', 33, { online: false, lastSeen: WOW_NOW - 9 * DAY }),
  member('Sela', 'PALADIN', 2, 'Raider', 60, { zone: 'Molten Core' }),
  member('Vex', 'WARLOCK', 2, 'Raider', 60, { zone: 'Molten Core' }),
];

const stripOfficer = (m: GuildMember): GuildMember => {
  const { officerNote: _officerNote, ...rest } = m;
  void _officerNote;
  return rest;
};

export const guildAnswer = (officer = false): GuildAnswer => ({
  available: true,
  guild: { name: 'Night’s Watch', motd: 'Raid Tuesday', info: '', ranks: RANKS, updatedAt: WOW_NOW },
  members: officer ? MEMBERS : MEMBERS.map(stripOfficer),
  counts: { total: MEMBERS.length, online: MEMBERS.filter((m) => m.online).length },
});

export const EMPTY_GUILD: GuildAnswer = {
  available: false,
  guild: { name: '', motd: '', info: '', ranks: [], updatedAt: 0 },
  members: [],
  counts: { total: 0, online: 0 },
};

export const EVENTS: GuildEvent[] = [
  { id: 6, at: WOW_NOW - 2 * MIN, type: 'level', name: 'Mira', a: '42', b: '' },
  { id: 5, at: WOW_NOW - 9 * MIN, type: 'promote', name: 'Sela', a: 'Raider', b: 'Lief' },
  { id: 4, at: WOW_NOW - 20 * MIN, type: 'join', name: 'Vex', a: '', b: '' },
  { id: 3, at: WOW_NOW - 50 * MIN, type: 'leave', name: 'Grim', a: '', b: '' },
  { id: 2, at: WOW_NOW - 55 * MIN, type: 'on', name: 'Kaz', a: '', b: '' },
  { id: 1, at: WOW_NOW - 1 * HOUR, type: 'demote', name: 'Torv', a: 'Initiate', b: 'Lief' },
];

const raid = (id: number, daysAgo: number, present: Record<string, number>, kills: string[]): RaidSummary => ({
  id,
  zone: 'Molten Core',
  instanceId: 409,
  size: 40,
  startedAt: WOW_NOW - daysAgo * DAY,
  endedAt: WOW_NOW - daysAgo * DAY + 3 * HOUR,
  lootMethod: 'master',
  masterLooter: 'Lief',
  bosses: kills.map((name, i) => ({ id: 1000 + i, name, difficulty: 0, size: 40, startedAt: WOW_NOW - daysAgo * DAY + i * 600_000, endedAt: WOW_NOW - daysAgo * DAY + i * 600_000 + 300_000, success: true })),
  kills: kills.length,
  snapshots: 4,
  attendees: Object.entries(present).map(([name, pct]) => ({ name, pct })),
  lootCount: 2,
});

export const RAIDS: RaidSummary[] = [
  raid(202, 1, { Lief: 100, Zoë: 100, Kaz: 100, Sela: 75, Bumta: 25 }, ['Lucifron', 'Magmadar', 'Gehennas']),
  raid(201, 8, { Lief: 100, Zoë: 90, Bumta: 100, Kaz: 50, Rook: 100 }, ['Lucifron', 'Magmadar']),
];

export const LOOT: LootEntry[] = [
  { id: 3, at: WOW_NOW - 1 * DAY + 5 * MIN, raidId: 202, who: 'Kaz', itemId: 16799, name: 'Arcanist Bindings', quality: 4, count: 1, boss: 'Magmadar' },
  { id: 2, at: WOW_NOW - 1 * DAY + 2 * MIN, raidId: 202, who: 'Zoë', itemId: 17063, name: 'Band of Accuria', quality: 3, count: 1, boss: 'Lucifron' },
  { id: 1, at: WOW_NOW - 8 * DAY, raidId: 201, who: 'Bumta', itemId: 16795, name: 'Arcanist Crown', quality: 4, count: 1, boss: 'Lucifron' },
];

export const ATTENDANCE: AttendanceAnswer = {
  raids: 2,
  since: WOW_NOW - 8 * DAY,
  members: [
    { name: 'Lief', class: 'DRUID', rankIndex: 0, inGuild: true, attended: 2, raids: 2, pct: 100, bossesAttended: 5, bosses: 5, lastRaidAt: WOW_NOW - DAY },
    { name: 'Zoë', class: 'PRIEST', rankIndex: 1, inGuild: true, attended: 2, raids: 2, pct: 100, bossesAttended: 5, bosses: 5, lastRaidAt: WOW_NOW - DAY },
    { name: 'Kaz', class: 'SHAMAN', rankIndex: 2, inGuild: true, attended: 2, raids: 2, pct: 100, bossesAttended: 4, bosses: 5, lastRaidAt: WOW_NOW - DAY },
    { name: 'Bumta', class: 'WARRIOR', rankIndex: 2, inGuild: true, attended: 1, raids: 2, pct: 50, bossesAttended: 2, bosses: 5, lastRaidAt: WOW_NOW - 8 * DAY },
    { name: 'Rook', class: 'ROGUE', rankIndex: 2, inGuild: true, attended: 1, raids: 2, pct: 50, bossesAttended: 2, bosses: 5, lastRaidAt: WOW_NOW - 8 * DAY },
    { name: 'Sela', class: 'PALADIN', rankIndex: 2, inGuild: true, attended: 1, raids: 2, pct: 50, bossesAttended: 3, bosses: 5, lastRaidAt: WOW_NOW - DAY },
    { name: 'Mira', class: 'MAGE', rankIndex: 3, inGuild: true, attended: 0, raids: 2, pct: 0, bossesAttended: 0, bosses: 5, lastRaidAt: 0 },
  ],
};

export const RAID_GROUP: RaidAnswer = {
  inRaid: true,
  size: 9,
  members: [
    { name: 'Bumta', class: 'WARRIOR', level: 60, subgroup: 1, rank: 'member', role: 'tank', online: true, dead: false, zone: 'Molten Core', masterLooter: false },
    { name: 'Lief', class: 'DRUID', level: 60, subgroup: 1, rank: 'leader', role: '', online: true, dead: false, zone: 'Molten Core', masterLooter: true },
    { name: 'Zoë', class: 'PRIEST', level: 60, subgroup: 1, rank: 'assist', role: '', online: true, dead: true, zone: 'Molten Core', masterLooter: false },
    { name: 'Kaz', class: 'SHAMAN', level: 60, subgroup: 2, rank: 'member', role: '', online: true, dead: false, zone: 'Molten Core', masterLooter: false },
    { name: 'Sela', class: 'PALADIN', level: 60, subgroup: 2, rank: 'member', role: '', online: false, dead: false, zone: 'Orgrimmar', masterLooter: false },
    { name: 'Vex', class: 'WARLOCK', level: 60, subgroup: 2, rank: 'member', role: '', online: true, dead: false, zone: 'Molten Core', masterLooter: false },
    { name: 'Rook', class: 'ROGUE', level: 58, subgroup: 3, rank: 'member', role: '', online: true, dead: false, zone: 'Molten Core', masterLooter: false },
    { name: 'Torv', class: 'HUNTER', level: 33, subgroup: 3, rank: 'member', role: '', online: true, dead: false, zone: 'Molten Core', masterLooter: false },
    { name: 'Mira', class: 'MAGE', level: 41, subgroup: 3, rank: 'member', role: '', online: true, dead: false, zone: 'Molten Core', masterLooter: false },
  ],
  counts: { online: 8, dead: 1, byClass: { WARRIOR: 1, DRUID: 1, PRIEST: 1, SHAMAN: 1, PALADIN: 1, WARLOCK: 1, ROGUE: 1, HUNTER: 1, MAGE: 1 } },
  raid: RAIDS[0],
  lastReadyCheck: { at: WOW_NOW - 4 * MIN, initiator: 'Lief', ready: ['Lief', 'Kaz', 'Vex', 'Rook', 'Torv', 'Bumta'], notReady: ['Mira'], afk: ['Zoë'], done: true },
  updatedAt: WOW_NOW,
};

export const NO_RAID: RaidAnswer = {
  inRaid: false,
  size: 0,
  members: [],
  counts: { online: 0, dead: 0, byClass: {} },
  raid: null,
  lastReadyCheck: null,
  updatedAt: 0,
};

export const MEMBER_DETAIL = (name: string, officer = false): MemberDetail | null => {
  const m = MEMBERS.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!m) return null;
  return {
    member: officer ? m : stripOfficer(m),
    rankHistory: [{ at: WOW_NOW - 20 * DAY, kind: 'promote', fromIndex: 3, toIndex: 2, rank: 'Raider', by: 'Lief' }],
    sessions: [
      { name: m.name, start: WOW_NOW - 3 * HOUR, end: null },
      { name: m.name, start: WOW_NOW - DAY - 4 * HOUR, end: WOW_NOW - DAY - HOUR },
    ],
    loot: LOOT.filter((l) => l.who === m.name),
    attendance: ATTENDANCE.members.find((a) => a.name === m.name) ?? null,
  };
};

type Reply = { status?: number; body: unknown };

/**
 * The guild link's answer to a GET of /api/wow/…, or null for a path that isn't one of the guild routes.
 * `data` is whether the guild has anything collected yet.
 */
export function wowGuildRoute(data: boolean, url: URL): Reply | null {
  const p = url.pathname;
  const officer = url.searchParams.get('officer') === '1';
  switch (p) {
    case '/api/wow/guild':
      return { body: data ? guildAnswer(officer) : EMPTY_GUILD };
    case '/api/wow/guild/events':
      return { body: { events: data ? EVENTS : [] } };
    case '/api/wow/guild/sessions':
      return { body: { sessions: [] } };
    case '/api/wow/guild/member': {
      const found = data ? MEMBER_DETAIL(url.searchParams.get('name') ?? '', officer) : null;
      return found ? { body: found } : { status: 404, body: { error: 'No such member' } };
    }
    case '/api/wow/raid':
      return { body: data ? RAID_GROUP : NO_RAID };
    case '/api/wow/raids':
      return { body: { raids: data ? RAIDS : [] } };
    case '/api/wow/attendance':
      return { body: data ? ATTENDANCE : { raids: 0, since: 0, members: [] } };
    case '/api/wow/loot':
      return { body: { loot: data ? LOOT : [] } };
    case '/api/wow/readychecks':
      return { body: { readyChecks: [] } };
    default:
      return null;
  }
}
