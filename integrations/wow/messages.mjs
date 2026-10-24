// Reads the guild and raid messages the addon sends over the strip (kinds 4 to 7). The page passes
// the texts on to the server, which runs them through this; the same file is used by the tests, so
// what the Lua writes and what this reads can't drift apart. See addon/Uncbox/Guild.lua, Raid.lua
// and Sync.lua for what each field is. Fields are split by \x1f, records by \x1e.

export const KIND_GUILD = 4;
export const KIND_GUILD_EVENTS = 5;
export const KIND_RAID = 6;
export const KIND_RAID_EVENTS = 7;

const FIELD = '\x1f';
const RECORD = '\x1e';

const num = (s) => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

const names = (s) => (s ? s.split(',').filter(Boolean) : []);

/** A guild member's record, from a strip message or the same shape from SavedVariables. */
function guildMember(f) {
  return {
    name: f[1] ?? '',
    rankIndex: num(f[2]),
    level: num(f[3]),
    class: f[4] ?? '',
    zone: f[5] ?? '',
    online: f[6] === '1',
    status: num(f[7]),
    hoursOffline: f[8] ? num(f[8]) : null,
  };
}

function groupMember(f) {
  return {
    name: f[1] ?? '',
    class: f[2] ?? '',
    level: num(f[3]),
    subgroup: num(f[4]) || 1,
    rank: num(f[5]),
    role: f[6] ?? '',
    online: f[7] !== '0',
    dead: f[8] === '1',
    zone: f[9] ?? '',
    masterLooter: f[10] === '1',
  };
}

/**
 * A roster message (guild, kind 4, or raid group, kind 6): the start of a full sync ("full", piece
 * `index` of `count`), changes since it ("delta"), or the guild's name, message of the day and rank
 * names ("info"). Returns null for anything else.
 */
export function parseRosterMessage(kind, text) {
  const records = String(text).split(RECORD).map((r) => r.split(FIELD));
  const head = records.shift();
  if (!head) return null;
  const member = kind === KIND_RAID ? groupMember : guildMember;
  if (head[0] === 'I' && kind === KIND_GUILD) return { type: 'info', name: head[1] ?? '', motd: head[2] ?? '', ranks: head.slice(3) };
  if (head[0] !== 'R' && head[0] !== 'D') return null;
  const out = { type: head[0] === 'R' ? 'full' : 'delta', sync: num(head[1]), members: [], removed: [] };
  if (out.type === 'full') Object.assign(out, { index: num(head[2]), count: num(head[3]) });
  for (const f of records) {
    if (f[0] === 'M') out.members.push(member(f));
    else if (f[0] === 'X' && out.type === 'delta') out.removed.push(f[1] ?? '');
  }
  return out;
}

/**
 * Keeps a roster up to date from its messages. A full sync arrives in pieces and replaces the whole
 * roster once the last one is in; a delta applies only to the full sync with its number, and is
 * ignored until one has arrived (the addon sends a full sync every few minutes).
 */
export class RosterTracker {
  constructor() {
    /** @type {number} */
    this.sync = -1;
    /** @type {Map<string, object>} */
    this.members = new Map();
    this.partial = null;
  }

  /**
   * Applies a parsed roster message. Returns { members, removed } (the people added or changed, and
   * the names that went), with `full: true` when the whole roster was replaced; null when nothing changed.
   */
  apply(msg) {
    if (!msg) return null;
    if (msg.type === 'delta') {
      if (msg.sync !== this.sync) return null;
      for (const m of msg.members) this.members.set(m.name, m);
      for (const n of msg.removed) this.members.delete(n);
      return msg.members.length || msg.removed.length ? { full: false, members: msg.members, removed: msg.removed } : null;
    }
    if (msg.type !== 'full') return null;
    if (!this.partial || this.partial.sync !== msg.sync || this.partial.count !== msg.count) {
      this.partial = { sync: msg.sync, count: msg.count, pieces: new Map() };
    }
    this.partial.pieces.set(msg.index, msg.members);
    if (this.partial.pieces.size < msg.count) return null;
    const all = [];
    for (let i = 1; i <= msg.count; i++) all.push(...(this.partial.pieces.get(i) ?? []));
    const next = new Map(all.map((m) => [m.name, m]));
    const removed = [...this.members.keys()].filter((n) => !next.has(n));
    this.members = next;
    this.sync = msg.sync;
    this.partial = null;
    return { full: true, members: all, removed };
  }
}

/** Guild events (kind 5): { type, t, name, a, b }. t is seconds since 1970 by the game's clock. */
export function parseGuildEvents(text) {
  return String(text)
    .split(RECORD)
    .map((r) => r.split(FIELD))
    .filter((f) => f.length >= 3 && f[0])
    .map((f) => ({ type: f[0], t: num(f[1]), name: f[2], a: f[3] ?? '', b: f[4] ?? '' }));
}

/**
 * Raid news (kind 7): a list of { tag, ... }. tag is "raid" (started, ended or changed),
 * "attendance", "encounter", "loot", "readycheck" (started) or "readycheck_done". `raid` is the id
 * of the raid it belongs to: the time that raid started.
 */
export function parseRaidEvents(text) {
  const out = [];
  for (const r of String(text).split(RECORD)) {
    const f = r.split(FIELD);
    switch (f[0]) {
      case 'Z':
        out.push({ tag: 'raid', id: num(f[1]), zone: f[2] ?? '', instanceId: num(f[3]), endT: f[4] ? num(f[4]) : null, size: num(f[5]), lootMethod: f[6] ?? '', masterLooter: f[7] ?? '' });
        break;
      case 'A':
        out.push({ tag: 'attendance', t: num(f[1]), raid: num(f[2]), kind: f[3] ?? '', boss: f[4] ?? '', names: names(f[5]) });
        break;
      case 'E':
        out.push({
          tag: 'encounter',
          t: num(f[1]),
          raid: num(f[2]),
          id: num(f[3]),
          name: f[4] ?? '',
          difficulty: num(f[5]),
          size: num(f[6]),
          success: f[7] ? f[7] === '1' : null,
          endT: f[8] ? num(f[8]) : null,
        });
        break;
      case 'L':
        out.push({ tag: 'loot', t: num(f[1]), raid: num(f[2]), who: f[3] ?? '', itemId: num(f[4]), name: f[5] ?? '', quality: num(f[6]), count: num(f[7]) || 1, boss: f[8] ?? '' });
        break;
      case 'C':
        out.push({ tag: 'readycheck', t: num(f[1]), initiator: f[2] ?? '' });
        break;
      case 'F':
        out.push({ tag: 'readycheck_done', t: num(f[1]), initiator: f[2] ?? '', ready: names(f[3]), notReady: names(f[4]), afk: names(f[5]) });
        break;
      default:
    }
  }
  return out;
}
