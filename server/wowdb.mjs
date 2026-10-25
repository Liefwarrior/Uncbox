// The WoW guild and raid database (data/wow.db): who is in the guild and what rank, when they were
// online, raids with their bosses, who was there, loot and ready checks. It is fed from two places
// that see the same game: the addon's SavedVariables file (everything, whenever WoW saves it) and
// the live messages the page reads off the strip (a few seconds old, but only the news). Every
// event carries the game's own time, and each table has a unique key on it, so whichever comes
// second finds the row already there and nothing is counted twice.
//
// Times are seconds since 1970 in the database, milliseconds in what the API sends.
//
// This file only knows about a node:sqlite database handed to it; server/wow.mjs opens the file,
// watches SavedVariables and answers the routes.

import { KIND_GUILD, KIND_GUILD_EVENTS, KIND_RAID, KIND_RAID_EVENTS, parseGuildEvents, parseRaidEvents, parseRosterMessage, RosterTracker } from '../integrations/wow/messages.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS members (
  name TEXT PRIMARY KEY, rank_index INTEGER, rank TEXT, level INTEGER, class TEXT, zone TEXT,
  note TEXT, officer_note TEXT, online INTEGER, status INTEGER, last_seen INTEGER, first_seen INTEGER,
  present INTEGER NOT NULL DEFAULT 1, left_at INTEGER
);
CREATE TABLE IF NOT EXISTS rank_history (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT, from_index INTEGER, to_index INTEGER,
  rank TEXT, actor TEXT, UNIQUE (name, at, kind, rank)
);
CREATE TABLE IF NOT EXISTS guild_events (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, a TEXT NOT NULL DEFAULT '', b TEXT NOT NULL DEFAULT '',
  UNIQUE (at, type, name, a, b)
);
CREATE INDEX IF NOT EXISTS guild_events_at ON guild_events (at);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER, UNIQUE (name, start)
);
CREATE TABLE IF NOT EXISTS raids (
  id INTEGER PRIMARY KEY, zone TEXT NOT NULL DEFAULT '', instance_id INTEGER, size INTEGER, started_at INTEGER, ended_at INTEGER,
  loot_method TEXT, master_looter TEXT
);
CREATE TABLE IF NOT EXISTS snapshots (
  raid_id INTEGER NOT NULL, at INTEGER NOT NULL, kind TEXT, boss TEXT, names TEXT NOT NULL, PRIMARY KEY (raid_id, at)
);
CREATE TABLE IF NOT EXISTS encounters (
  raid_id INTEGER NOT NULL, at INTEGER NOT NULL, encounter_id INTEGER NOT NULL, name TEXT, difficulty INTEGER, size INTEGER,
  success INTEGER, ended_at INTEGER, PRIMARY KEY (raid_id, at, encounter_id)
);
CREATE TABLE IF NOT EXISTS loot (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, raid_id INTEGER, who TEXT NOT NULL, item_id INTEGER NOT NULL, name TEXT,
  quality INTEGER, count INTEGER, boss TEXT, UNIQUE (at, who, item_id)
);
CREATE INDEX IF NOT EXISTS loot_who ON loot (who);
CREATE TABLE IF NOT EXISTS ready_checks (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, initiator TEXT NOT NULL, ready TEXT, not_ready TEXT, afk TEXT, done INTEGER NOT NULL DEFAULT 0,
  UNIQUE (at, initiator)
);
CREATE TABLE IF NOT EXISTS raid_group (
  name TEXT PRIMARY KEY, class TEXT, level INTEGER, subgroup INTEGER, rank INTEGER, role TEXT, online INTEGER, dead INTEGER,
  zone TEXT, master_looter INTEGER
);
`;

/** Creates the tables (all of them "if not exists", so an older file is only added to). */
export function initSchema(db) {
  db.exec(SCHEMA);
}

// ---- small helpers ----

/** A value SQLite can store: booleans as 0/1, anything missing as null. */
const sql = (v) => (v === undefined || v === null ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const text = (v) => (v === undefined || v === null ? '' : String(v));
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
/** A Lua list from SavedVariables: an array, or the object a sparse table comes out as. */
const list = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
const ms = (s) => (s ? s * 1000 : 0);
const sameName = (a, b) => text(a).trim().toLowerCase() === text(b).trim().toLowerCase();
const csv = (names) => JSON.stringify(list(names).map(String));
const unCsv = (s) => {
  try {
    return JSON.parse(s ?? '[]');
  } catch {
    return [];
  }
};

/** More than this share of the current members missing from a full roster is taken as a bad roster, not mass departure. */
const MAX_DEPARTURE = 0.5;
/** A rank change seen in the roster is not new if a promotion to that rank was recorded within this many seconds. */
const RANK_MATCH_S = 86400;

/**
 * The store over an open database. `now` (seconds) is what stamps live news and roster reads, so
 * tests can fix it.
 */
export function createStore(db, { now = () => Math.floor(Date.now() / 1000) } = {}) {
  initSchema(db);
  const q = (strings) => db.prepare(strings[0]);
  const guildTracker = new RosterTracker();
  const groupTracker = new RosterTracker();
  /** The guild the live messages are about is not the one we keep. */
  let liveBlocked = false;

  // Statements, made once.
  const st = {
    getMeta: q`SELECT value FROM meta WHERE key = ?`,
    setMeta: q`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    member: q`SELECT * FROM members WHERE name = ?`,
    upsertMember: q`
      INSERT INTO members (name, rank_index, rank, level, class, zone, note, officer_note, online, status, last_seen, first_seen, present, left_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)
      ON CONFLICT(name) DO UPDATE SET rank_index = excluded.rank_index, rank = excluded.rank, level = excluded.level,
        class = CASE WHEN excluded.class = '' THEN class ELSE excluded.class END, zone = excluded.zone,
        note = COALESCE(excluded.note, note), officer_note = COALESCE(excluded.officer_note, officer_note),
        online = excluded.online, status = excluded.status,
        last_seen = MAX(COALESCE(last_seen, 0), COALESCE(excluded.last_seen, 0)),
        first_seen = MIN(COALESCE(first_seen, excluded.first_seen), excluded.first_seen), present = 1, left_at = NULL`,
    markLeft: q`UPDATE members SET present = 0, left_at = ?, online = 0 WHERE name = ? AND present = 1`,
    presentNames: q`SELECT name FROM members WHERE present = 1`,
    addRank: q`INSERT OR IGNORE INTO rank_history (name, at, kind, from_index, to_index, rank, actor) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    rankSeen: q`SELECT 1 FROM rank_history WHERE name = ? AND rank = ? AND at >= ?`,
    addEvent: q`INSERT OR IGNORE INTO guild_events (at, type, name, a, b) VALUES (?, ?, ?, ?, ?)`,
    eventsFor: q`SELECT type, at FROM guild_events WHERE name = ? AND type IN ('on', 'off') ORDER BY at, id`,
    clearSessions: q`DELETE FROM sessions WHERE name = ?`,
    addSession: q`INSERT OR IGNORE INTO sessions (name, start, end) VALUES (?, ?, ?)`,
    setRank: q`UPDATE members SET rank_index = ?, rank = ? WHERE name = ?`,
    setRankName: q`UPDATE members SET rank = ? WHERE name = ?`,
    setLevel: q`UPDATE members SET level = MAX(COALESCE(level, 0), ?) WHERE name = ?`,
    ensureMember: q`INSERT OR IGNORE INTO members (name, rank_index, rank, level, class, zone, online, status, first_seen, last_seen, present) VALUES (?, ?, ?, 0, '', '', 0, 0, ?, ?, 1)`,
    reviveMember: q`UPDATE members SET present = 1, left_at = NULL WHERE name = ?`,
    ensureRaid: q`INSERT OR IGNORE INTO raids (id, zone, started_at) VALUES (?, '', ?)`,
    upsertRaid: q`
      INSERT INTO raids (id, zone, instance_id, size, started_at, ended_at, loot_method, master_looter) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET zone = CASE WHEN excluded.zone = '' THEN zone ELSE excluded.zone END,
        instance_id = COALESCE(excluded.instance_id, instance_id), size = COALESCE(excluded.size, size),
        started_at = COALESCE(started_at, excluded.started_at),
        ended_at = excluded.ended_at,
        loot_method = COALESCE(excluded.loot_method, loot_method), master_looter = COALESCE(excluded.master_looter, master_looter)`,
    upsertRaidKeepEnd: q`
      INSERT INTO raids (id, zone, instance_id, size, started_at, ended_at, loot_method, master_looter) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET zone = CASE WHEN excluded.zone = '' THEN zone ELSE excluded.zone END,
        instance_id = COALESCE(excluded.instance_id, instance_id), size = COALESCE(excluded.size, size),
        started_at = COALESCE(started_at, excluded.started_at),
        ended_at = COALESCE(excluded.ended_at, ended_at),
        loot_method = COALESCE(excluded.loot_method, loot_method), master_looter = COALESCE(excluded.master_looter, master_looter)`,
    addSnapshot: q`INSERT OR IGNORE INTO snapshots (raid_id, at, kind, boss, names) VALUES (?, ?, ?, ?, ?)`,
    upsertEncounter: q`
      INSERT INTO encounters (raid_id, at, encounter_id, name, difficulty, size, success, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(raid_id, at, encounter_id) DO UPDATE SET name = CASE WHEN excluded.name = '' THEN name ELSE excluded.name END,
        success = COALESCE(excluded.success, success), ended_at = COALESCE(excluded.ended_at, ended_at)`,
    addLoot: q`INSERT OR IGNORE INTO loot (at, raid_id, who, item_id, name, quality, count, boss) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    startReady: q`INSERT OR IGNORE INTO ready_checks (at, initiator, ready, not_ready, afk, done) VALUES (?, ?, '[]', '[]', '[]', 0)`,
    finishReady: q`
      INSERT INTO ready_checks (at, initiator, ready, not_ready, afk, done) VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(at, initiator) DO UPDATE SET ready = excluded.ready, not_ready = excluded.not_ready, afk = excluded.afk, done = 1
      WHERE done = 0`,
    clearGroup: q`DELETE FROM raid_group`,
    addGroup: q`INSERT OR REPLACE INTO raid_group (name, class, level, subgroup, rank, role, online, dead, zone, master_looter) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    removeGroup: q`DELETE FROM raid_group WHERE name = ?`,
  };

  const meta = (key) => st.getMeta.get(key)?.value ?? null;
  const setMeta = (key, value) => void st.setMeta.run(key, value === null ? null : String(value));
  const ranks = () => {
    try {
      return JSON.parse(meta('ranks') ?? '[]');
    } catch {
      return [];
    }
  };

  /** Runs fn as one transaction. */
  function tx(fn) {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- the guild ----

  /** The guild's name, message of the day and rank names. { ok: false } when it's another guild's. */
  function applyGuildInfo({ name, motd, info, ranks: names }, at = now()) {
    const have = meta('guild');
    if (name && have && !sameName(name, have)) return { ok: false, changed: false };
    const before = JSON.stringify([have, meta('motd'), meta('info'), meta('ranks')]);
    if (name && !have) setMeta('guild', name);
    if (motd !== undefined) setMeta('motd', motd);
    if (info !== undefined) setMeta('info', info);
    if (names && names.length) setMeta('ranks', JSON.stringify(names));
    const changed = before !== JSON.stringify([meta('guild'), meta('motd'), meta('info'), meta('ranks')]);
    if (changed) setMeta('guild_at', at);
    return { ok: true, changed };
  }

  /** The guild's members as the game listed them. `full` means this is everyone: anyone else has gone. */
  function applyRoster(members, { full = false, at = now() } = {}) {
    let changed = false;
    const names = ranks();
    const seen = new Set();
    for (const m of members) {
      if (!m.name) continue;
      seen.add(m.name);
      const row = st.member.get(m.name);
      const rankIndex = int(m.rankIndex);
      const rank = m.rank || names[rankIndex] || row?.rank || '';
      const lastOnline = m.online ? at : m.lastOnline ? m.lastOnline : m.hoursOffline !== null && m.hoursOffline !== undefined ? at - m.hoursOffline * 3600 : null;
      if (row?.present && row.rank_index !== rankIndex && row.rank_index !== null && !st.rankSeen.get(m.name, rank, at - RANK_MATCH_S)) {
        st.addRank.run(m.name, at, rankIndex < row.rank_index ? 'promote' : 'demote', row.rank_index, rankIndex, rank, null);
      }
      const level = int(m.level);
      if (
        !row ||
        !row.present ||
        row.rank_index !== rankIndex ||
        row.level !== level ||
        row.zone !== text(m.zone) ||
        row.online !== (m.online ? 1 : 0) ||
        row.status !== int(m.status) ||
        (m.note !== undefined && row.note !== m.note) ||
        (m.officerNote !== undefined && row.officer_note !== m.officerNote) ||
        (lastOnline && lastOnline > (row.last_seen ?? 0))
      ) {
        changed = true;
      }
      st.upsertMember.run(
        m.name,
        rankIndex,
        rank,
        level,
        text(m.class),
        text(m.zone),
        m.note === undefined ? null : text(m.note),
        m.officerNote === undefined ? null : text(m.officerNote),
        m.online ? 1 : 0,
        int(m.status),
        lastOnline ? int(lastOnline) : null,
        row?.first_seen ?? int(at),
      );
    }
    if (full && seen.size) {
      const gone = st.presentNames.all().map((r) => r.name).filter((n) => !seen.has(n));
      const present = gone.length + seen.size;
      // A roster missing most of the guild is a roster without offline members, not a mass exodus.
      if (gone.length <= present * MAX_DEPARTURE) {
        for (const n of gone) if (st.markLeft.run(int(at), n).changes) changed = true;
      }
    }
    if (changed) setMeta('guild_at', at);
    return changed;
  }

  /** Rebuilds a member's sessions (online spells) from their online and offline events. */
  function rebuildSessions(name) {
    const spells = [];
    let open = null;
    for (const e of st.eventsFor.all(name)) {
      if (e.type === 'on') {
        if (open === null) open = e.at;
      } else if (open !== null) {
        spells.push([open, e.at]);
        open = null;
      }
    }
    if (open !== null) {
      // Still online by the events, but the roster says they've gone: they went when it last saw them.
      const row = st.member.get(name);
      spells.push([open, row && !row.online && row.last_seen > open ? row.last_seen : null]);
    }
    st.clearSessions.run(name);
    for (const [start, end] of spells) st.addSession.run(name, start, end);
  }

  const rankIndexOf = (rankName) => {
    const i = ranks().findIndex((r) => sameName(r, rankName));
    return i < 0 ? null : i;
  };

  /** One guild event. Returns true if it was new. */
  function applyGuildEvent(e) {
    const at = int(e.t);
    if (!e.type || !e.name || !at) return false;
    const res = st.addEvent.run(at, e.type, e.name, text(e.a), text(e.b));
    if (!res.changes) return false;
    const row = st.member.get(e.name);
    switch (e.type) {
      case 'on':
      case 'off':
        rebuildSessions(e.name);
        break;
      case 'join':
        if (row) st.reviveMember.run(e.name);
        else st.ensureMember.run(e.name, null, '', at, at);
        break;
      case 'leave':
      case 'kick':
        st.markLeft.run(at, e.name);
        rebuildSessions(e.name);
        break;
      case 'promote':
      case 'demote': {
        const to = rankIndexOf(e.a);
        st.addRank.run(e.name, at, e.type, row?.rank_index ?? null, to, text(e.a), e.b ? text(e.b) : null);
        if (row) {
          // Only the newest change decides the rank.
          const newest = db.prepare(`SELECT MAX(at) AS at FROM rank_history WHERE name = ?`).get(e.name)?.at ?? 0;
          if (at >= newest) {
            if (to !== null) st.setRank.run(to, text(e.a), e.name);
            else st.setRankName.run(text(e.a), e.name);
          }
        }
        break;
      }
      case 'level':
        if (row) st.setLevel.run(int(e.a), e.name);
        break;
      default:
    }
    setMeta('guild_at', now());
    return true;
  }

  // ---- raids ----

  function applyRaid(r, { live = false } = {}) {
    if (!r.id) return false;
    const before = db.prepare(`SELECT * FROM raids WHERE id = ?`).get(r.id);
    (live ? st.upsertRaid : st.upsertRaidKeepEnd).run(
      int(r.id),
      text(r.zone),
      sql(r.instanceId ?? null),
      sql(r.size ?? null),
      int(r.startT || r.id),
      r.endT ? int(r.endT) : null,
      r.lootMethod === undefined ? null : text(r.lootMethod),
      r.masterLooter === undefined ? null : text(r.masterLooter),
    );
    const after = db.prepare(`SELECT * FROM raids WHERE id = ?`).get(r.id);
    return JSON.stringify(before) !== JSON.stringify(after);
  }

  const raidKnown = (id) => {
    if (id) st.ensureRaid.run(int(id), int(id));
    return id ? int(id) : null;
  };

  function applySnapshot({ raid, t, kind, boss, names }) {
    const id = raidKnown(raid);
    if (!id || !t) return false;
    return st.addSnapshot.run(id, int(t), text(kind), text(boss), csv(names)).changes > 0;
  }

  function applyEncounter({ raid, t, id, name, difficulty, size, success, endT }) {
    const raidId = raidKnown(raid);
    if (!raidId || !t) return false;
    const before = db.prepare(`SELECT * FROM encounters WHERE raid_id = ? AND at = ? AND encounter_id = ?`).get(raidId, int(t), int(id));
    st.upsertEncounter.run(raidId, int(t), int(id), text(name), int(difficulty), int(size), success === null || success === undefined ? null : success ? 1 : 0, endT ? int(endT) : null);
    const after = db.prepare(`SELECT * FROM encounters WHERE raid_id = ? AND at = ? AND encounter_id = ?`).get(raidId, int(t), int(id));
    return JSON.stringify(before) !== JSON.stringify(after);
  }

  function applyLoot({ raid, t, who, itemId, name, quality, count, boss }) {
    if (!who || !itemId || !t) return false;
    return st.addLoot.run(int(t), raid ? raidKnown(raid) : null, who, int(itemId), text(name), int(quality), int(count) || 1, text(boss)).changes > 0;
  }

  function applyReadyCheck({ t, initiator, ready, notReady, afk, done }) {
    if (!t || !initiator) return false;
    if (!done) return st.startReady.run(int(t), initiator).changes > 0;
    return st.finishReady.run(int(t), initiator, csv(ready), csv(notReady), csv(afk)).changes > 0;
  }

  /** Replaces (full) or updates the current raid group. */
  function applyGroup(members, { full = false, removed = [] } = {}) {
    if (full) st.clearGroup.run();
    for (const m of members) {
      st.addGroup.run(m.name, text(m.class), int(m.level), int(m.subgroup) || 1, int(m.rank), text(m.role), m.online ? 1 : 0, m.dead ? 1 : 0, text(m.zone), m.masterLooter ? 1 : 0);
    }
    for (const n of removed) st.removeGroup.run(n);
    setMeta('group_at', now());
    return true;
  }

  // ---- from the strip ----

  /** Messages read off the strip: [{ kind, text }]. Returns which topics changed. */
  function ingestLive(messages) {
    const changed = new Set();
    tx(() => {
      for (const { kind, text: body } of messages) {
        try {
          liveOne(kind, body, changed);
        } catch {
          // One message that doesn't make sense is skipped; the rest still count.
        }
      }
    });
    return [...changed];
  }

  function liveOne(kind, body, changed) {
    if (kind === KIND_GUILD) {
      const msg = parseRosterMessage(KIND_GUILD, body);
      if (!msg) return;
      if (msg.type === 'info') {
        const r = applyGuildInfo(msg);
        liveBlocked = !r.ok;
        if (r.changed) changed.add('guild');
        return;
      }
      if (liveBlocked) return;
      const r = guildTracker.apply(msg);
      if (r && applyRoster(r.members, { full: r.full })) changed.add('guild');
      if (r && !r.full) for (const n of r.removed) if (st.markLeft.run(now(), n).changes) changed.add('guild');
    } else if (kind === KIND_GUILD_EVENTS) {
      if (liveBlocked) return;
      for (const e of parseGuildEvents(body)) if (applyGuildEvent(e)) changed.add('guild').add('events');
    } else if (kind === KIND_RAID) {
      const msg = parseRosterMessage(KIND_RAID, body);
      const r = msg && groupTracker.apply(msg);
      if (r && applyGroup(r.members, { full: r.full, removed: r.removed })) changed.add('raid');
    } else if (kind === KIND_RAID_EVENTS) {
      for (const e of parseRaidEvents(body)) {
        if (applyRaidEvent(e, { live: true })) changed.add('raid').add('raids');
        if (e.tag === 'loot') changed.add('loot');
        if (e.tag.startsWith('readycheck')) changed.add('readychecks');
      }
    }
  }

  /** One kind-7 record. Returns true if it changed anything. */
  function applyRaidEvent(e, opts) {
    switch (e.tag) {
      case 'raid':
        return applyRaid({ id: e.id, zone: e.zone, instanceId: e.instanceId, size: e.size, endT: e.endT, lootMethod: e.lootMethod, masterLooter: e.masterLooter }, opts);
      case 'attendance':
        return applySnapshot(e);
      case 'encounter':
        return applyEncounter(e);
      case 'loot':
        return applyLoot(e);
      case 'readycheck':
        return applyReadyCheck({ ...e, done: false });
      case 'readycheck_done':
        return applyReadyCheck({ ...e, done: true });
      default:
        return false;
    }
  }

  // ---- from SavedVariables ----

  /** The saved guild for this database: ours by name, or (with none yet) the most recently saved. */
  function pickGuild(guilds) {
    const entries = Object.entries(guilds && typeof guilds === 'object' ? guilds : {}).filter(([, g]) => g && typeof g === 'object');
    const have = meta('guild');
    if (have) return entries.find(([name]) => sameName(name, have))?.[1] ?? null;
    entries.sort((a, b) => (b[1].savedAt ?? 0) - (a[1].savedAt ?? 0));
    return entries[0]?.[1] ?? null;
  }

  /**
   * UncboxDB from a SavedVariables file. Returns { changed: [topics], otherGuilds: [names] }.
   * Safe to ingest again: everything in it is keyed by the game's own time.
   */
  function ingestSaved(saved) {
    const changed = new Set();
    const db0 = saved && typeof saved === 'object' ? saved : {};
    const otherGuilds = [];
    tx(() => {
      const g = pickGuild(db0.guilds);
      const mine = meta('guild');
      for (const name of Object.keys(db0.guilds && typeof db0.guilds === 'object' ? db0.guilds : {})) if (g?.name !== name && !(mine && sameName(name, mine))) otherGuilds.push(name);
      if (g) {
        const savedAt = int(g.savedAt) || now();
        if (applyGuildInfo({ name: g.name, motd: g.motd, info: g.info, ranks: list(g.ranks) }, savedAt).changed) changed.add('guild');
        // Events first, so a promotion has set the rank before the roster is compared with it.
        const events = list(g.events)
          .map((e) => ({ type: e.type, t: e.t, name: e.name, a: e.a, b: e.b }))
          .sort((a, b) => a.t - b.t);
        for (const e of events) if (applyGuildEvent(e)) changed.add('guild').add('events');
        const members = list(g.members).map((m) => ({
          name: m.name,
          rank: m.rank,
          rankIndex: m.rankIndex,
          level: m.level,
          class: m.class,
          zone: m.zone,
          note: text(m.note),
          officerNote: text(m.officerNote),
          online: m.online === true,
          status: m.status,
          lastOnline: m.lastOnline,
        }));
        if (members.length && applyRoster(members, { full: true, at: savedAt })) changed.add('guild');
      }

      const group = db0.raid;
      if (group && typeof group === 'object' && int(group.t) > int(meta('group_at'))) {
        const members = list(group.members);
        applyGroup(members, { full: true });
        setMeta('group_at', int(group.t));
        changed.add('raid');
      }

      for (const r of list(db0.raids).sort((a, b) => a.id - b.id)) {
        if (applyRaid({ id: r.id, zone: r.zone, instanceId: r.instanceId, size: r.size, startT: r.startT, endT: r.endT, lootMethod: r.lootMethod, masterLooter: r.masterLooter })) changed.add('raid').add('raids');
        for (const b of list(r.bosses)) {
          if (applyEncounter({ raid: r.id, t: b.t, id: b.id, name: b.name, difficulty: b.difficulty, size: b.size, success: b.success, endT: b.endT })) changed.add('raids');
        }
        for (const s of list(r.snapshots)) if (applySnapshot({ raid: r.id, t: s.t, kind: s.kind, boss: s.boss, names: s.names })) changed.add('raids');
        for (const l of list(r.loot)) if (applyLoot({ ...l, raid: r.id })) changed.add('loot');
      }
      for (const l of list(db0.looseLoot)) if (applyLoot({ ...l, raid: 0 })) changed.add('loot');
      for (const c of list(db0.readyChecks)) {
        if (applyReadyCheck({ t: c.t, initiator: c.initiator, ready: c.ready, notReady: c.notReady, afk: c.afk, done: true })) changed.add('readychecks');
      }
    });
    return { changed: [...changed], otherGuilds };
  }

  /** Forgets the guild (not raids or loot), so the next sync starts fresh, for someone who changed guilds. */
  function resetGuild() {
    tx(() => {
      for (const t of ['members', 'rank_history', 'guild_events', 'sessions']) db.exec(`DELETE FROM ${t}`);
      for (const k of ['guild', 'motd', 'info', 'ranks', 'guild_at']) db.prepare(`DELETE FROM meta WHERE key = ?`).run(k);
    });
    guildTracker.members.clear();
    guildTracker.sync = -1;
    liveBlocked = false;
  }

  // ---- reading ----

  const memberOut = (r, officer) => ({
    name: r.name,
    rankIndex: r.rank_index ?? 0,
    rank: r.rank ?? '',
    level: r.level ?? 0,
    class: r.class ?? '',
    zone: r.zone ?? '',
    note: r.note ?? '',
    ...(officer ? { officerNote: r.officer_note ?? '' } : {}),
    online: Boolean(r.online),
    status: r.status === 1 ? 'afk' : r.status === 2 ? 'dnd' : '',
    lastSeen: r.online ? ms(now()) : ms(r.last_seen),
    firstSeen: ms(r.first_seen),
    ...(r.present ? {} : { leftAt: ms(r.left_at) }),
  });

  /** The guild: the roster and the numbers worth showing (how many online, by class and by rank). */
  function guild({ officer = false, former = false } = {}) {
    const name = meta('guild');
    const rows = db.prepare(`SELECT * FROM members WHERE present = 1 ORDER BY rank_index, name`).all();
    const names = ranks();
    const members = rows.map((r) => memberOut(r, officer));
    const byClass = {};
    const byRank = new Map();
    for (const m of members) {
      const c = (byClass[m.class || 'UNKNOWN'] ??= { total: 0, online: 0 });
      c.total++;
      if (m.online) c.online++;
      const r = byRank.get(m.rankIndex) ?? { rankIndex: m.rankIndex, rank: names[m.rankIndex] ?? m.rank, total: 0, online: 0 };
      r.total++;
      if (m.online) r.online++;
      byRank.set(m.rankIndex, r);
    }
    return {
      available: Boolean(name) && members.length > 0,
      guild: { name: name ?? '', motd: meta('motd') ?? '', info: meta('info') ?? '', ranks: names, updatedAt: ms(Number(meta('guild_at')) || 0) },
      members,
      counts: { total: members.length, online: members.filter((m) => m.online).length, byClass, byRank: [...byRank.values()].sort((a, b) => a.rankIndex - b.rankIndex) },
      ...(former ? { former: db.prepare(`SELECT * FROM members WHERE present = 0 ORDER BY left_at DESC, name`).all().map((r) => memberOut(r, officer)) } : {}),
    };
  }

  /** Guild news, newest first. `since` is in milliseconds. */
  function events({ since = 0, limit = 100, type = '' } = {}) {
    const rows = db
      .prepare(`SELECT id, at, type, name, a, b FROM guild_events WHERE at > ? ${type ? 'AND type = ?' : ''} ORDER BY at DESC, id DESC LIMIT ?`)
      .all(...[Math.floor(since / 1000), ...(type ? [type] : []), Math.min(500, Math.max(1, limit))]);
    return { events: rows.map((r) => ({ id: r.id, at: ms(r.at), type: r.type, name: r.name, a: r.a, b: r.b })) };
  }

  function sessions({ member = '', since = 0, limit = 100 } = {}) {
    const rows = db
      .prepare(`SELECT name, start, end FROM sessions WHERE start > ? ${member ? 'AND name = ?' : ''} ORDER BY start DESC LIMIT ?`)
      .all(...[Math.floor(since / 1000), ...(member ? [member] : []), Math.min(1000, Math.max(1, limit))]);
    return { sessions: rows.map((r) => ({ name: r.name, start: ms(r.start), end: r.end ? ms(r.end) : null })) };
  }

  const raidRows = (limit) => db.prepare(`SELECT * FROM raids ORDER BY id DESC LIMIT ?`).all(limit);

  function raidOut(r) {
    const bosses = db.prepare(`SELECT * FROM encounters WHERE raid_id = ? ORDER BY at, encounter_id`).all(r.id).map((e) => ({
      id: e.encounter_id,
      name: e.name,
      difficulty: e.difficulty,
      size: e.size,
      startedAt: ms(e.at),
      endedAt: e.ended_at ? ms(e.ended_at) : null,
      success: e.success === null ? null : Boolean(e.success),
    }));
    const snaps = db.prepare(`SELECT names, kind FROM snapshots WHERE raid_id = ? ORDER BY at`).all(r.id);
    const present = new Map();
    for (const s of snaps) for (const n of unCsv(s.names)) present.set(n, (present.get(n) ?? 0) + 1);
    const attendees = [...present.entries()]
      .map(([name, n]) => ({ name, pct: Math.round((n / snaps.length) * 100) }))
      .sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name));
    return {
      id: r.id,
      zone: r.zone,
      instanceId: r.instance_id,
      size: r.size,
      startedAt: ms(r.started_at),
      endedAt: r.ended_at ? ms(r.ended_at) : null,
      lootMethod: r.loot_method ?? '',
      masterLooter: r.master_looter ?? '',
      bosses,
      kills: bosses.filter((b) => b.success).length,
      snapshots: snaps.length,
      attendees,
      lootCount: db.prepare(`SELECT COUNT(*) AS n FROM loot WHERE raid_id = ?`).get(r.id).n,
    };
  }

  /** Raids, newest first, with their bosses and who was there. */
  function raids({ limit = 20 } = {}) {
    return { raids: raidRows(Math.min(100, Math.max(1, limit))).map(raidOut) };
  }

  /** The current raid group, and the raid it is in if one is going. */
  function raid() {
    const members = db.prepare(`SELECT * FROM raid_group ORDER BY subgroup, rank DESC, name`).all().map((r) => ({
      name: r.name,
      class: r.class,
      level: r.level,
      subgroup: r.subgroup,
      rank: r.rank === 2 ? 'leader' : r.rank === 1 ? 'assist' : 'member',
      role: r.role === 'T' ? 'tank' : r.role === 'A' ? 'assist' : '',
      online: Boolean(r.online),
      dead: Boolean(r.dead),
      zone: r.zone,
      masterLooter: Boolean(r.master_looter),
    }));
    const byClass = {};
    for (const m of members) byClass[m.class || 'UNKNOWN'] = (byClass[m.class || 'UNKNOWN'] ?? 0) + 1;
    const open = db.prepare(`SELECT * FROM raids WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1`).get();
    const check = db.prepare(`SELECT * FROM ready_checks ORDER BY at DESC LIMIT 1`).get();
    return {
      inRaid: members.length > 0,
      size: members.length,
      members,
      counts: { online: members.filter((m) => m.online).length, dead: members.filter((m) => m.dead).length, byClass },
      raid: open ? raidOut(open) : null,
      lastReadyCheck: check ? readyOut(check) : null,
      updatedAt: ms(Number(meta('group_at')) || 0),
    };
  }

  const readyOut = (r) => ({ at: ms(r.at), initiator: r.initiator, ready: unCsv(r.ready), notReady: unCsv(r.not_ready), afk: unCsv(r.afk), done: Boolean(r.done) });

  function readyChecks({ limit = 20 } = {}) {
    return { readyChecks: db.prepare(`SELECT * FROM ready_checks ORDER BY at DESC LIMIT ?`).all(Math.min(100, Math.max(1, limit))).map(readyOut) };
  }

  /** Loot, newest first, for everyone or one member. `since` is in milliseconds. */
  function loot({ member = '', since = 0, raid: raidId = 0, limit = 100 } = {}) {
    const where = ['at > ?'];
    const args = [Math.floor(since / 1000)];
    if (member) (where.push('who = ? COLLATE NOCASE'), args.push(member));
    if (raidId) (where.push('raid_id = ?'), args.push(int(raidId)));
    const rows = db.prepare(`SELECT * FROM loot WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC LIMIT ?`).all(...args, Math.min(500, Math.max(1, limit)));
    return {
      loot: rows.map((r) => ({ id: r.id, at: ms(r.at), raidId: r.raid_id, who: r.who, itemId: r.item_id, name: r.name, quality: r.quality, count: r.count, boss: r.boss })),
    };
  }

  /**
   * Who turned up to the last `last` raids. In a raid, someone attended if they were in at least
   * half its snapshots; bosses counts the boss-kill snapshots they were in.
   */
  function attendance({ last = 10 } = {}) {
    const rows = raidRows(Math.min(100, Math.max(1, last)));
    const stats = new Map();
    const stat = (name) => {
      let s = stats.get(name);
      if (!s) stats.set(name, (s = { name, attended: 0, bossesAttended: 0, lastRaidAt: 0 }));
      return s;
    };
    let bosses = 0;
    const counted = [];
    for (const r of rows) {
      const snaps = db.prepare(`SELECT names, kind FROM snapshots WHERE raid_id = ? ORDER BY at`).all(r.id);
      if (!snaps.length) continue;
      counted.push(r);
      const kills = snaps.filter((s) => s.kind === 'boss');
      bosses += kills.length;
      const times = new Map();
      for (const s of snaps) for (const n of unCsv(s.names)) times.set(n, (times.get(n) ?? 0) + 1);
      for (const [name, n] of times) {
        if (n * 2 >= snaps.length) {
          const s = stat(name);
          s.attended++;
          s.lastRaidAt = Math.max(s.lastRaidAt, r.started_at ?? 0);
        }
      }
      for (const s of kills) for (const n of unCsv(s.names)) stat(n).bossesAttended++;
    }
    const info = new Map(db.prepare(`SELECT name, class, rank_index, present FROM members`).all().map((m) => [m.name, m]));
    // Members who never came are in the list too, at 0%.
    for (const [name, m] of info) if (m.present) stat(name);
    const out = [...stats.values()].map((s) => {
      const m = info.get(s.name);
      return {
        name: s.name,
        class: m?.class ?? '',
        rankIndex: m?.rank_index ?? null,
        inGuild: Boolean(m?.present),
        attended: s.attended,
        raids: counted.length,
        pct: counted.length ? Math.round((s.attended / counted.length) * 100) : 0,
        bossesAttended: s.bossesAttended,
        bosses,
        lastRaidAt: ms(s.lastRaidAt),
      };
    });
    out.sort((a, b) => b.pct - a.pct || b.bossesAttended - a.bossesAttended || a.name.localeCompare(b.name));
    return { raids: counted.length, since: counted.length ? ms(counted.at(-1).started_at) : 0, members: out };
  }

  /** One member, with their rank history, recent sessions and loot. Null if there's no such member. */
  function member(name, { officer = false } = {}) {
    const row = db.prepare(`SELECT * FROM members WHERE name = ? COLLATE NOCASE`).get(name);
    if (!row) return null;
    return {
      member: memberOut(row, officer),
      rankHistory: db
        .prepare(`SELECT * FROM rank_history WHERE name = ? ORDER BY at DESC`)
        .all(row.name)
        .map((h) => ({ at: ms(h.at), kind: h.kind, fromIndex: h.from_index, toIndex: h.to_index, rank: h.rank, by: h.actor ?? '' })),
      ...sessions({ member: row.name, limit: 20 }),
      ...loot({ member: row.name, limit: 20 }),
      attendance: attendance({ last: 10 }).members.find((m) => m.name === row.name) ?? null,
    };
  }

  return {
    meta,
    setMeta,
    tx,
    applyGuildInfo,
    applyRoster,
    applyGuildEvent,
    applyRaidEvent,
    applyGroup,
    ingestLive,
    ingestSaved,
    resetGuild,
    guild,
    events,
    sessions,
    raid,
    raids,
    readyChecks,
    loot,
    attendance,
    member,
  };
}
