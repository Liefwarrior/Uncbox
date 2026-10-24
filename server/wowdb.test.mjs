import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { World } from '../integrations/wow/addonWorld';
import { parseSavedVariables } from '../integrations/wow/savedvars.mjs';
import { createStore } from './wowdb.mjs';

const T0 = 1_760_000_000;
let clock = T0 + 100_000;
const fresh = () => createStore(new DatabaseSync(':memory:'), { now: () => clock });

const member = (name, extra = {}) => ({ name, rankIndex: 2, level: 60, class: 'MAGE', zone: 'Orgrimmar', online: false, status: 0, ...extra });

describe('the guild', () => {
  it('keeps the roster, with counts by class and rank, and former members apart', () => {
    const s = fresh();
    s.applyGuildInfo({ name: 'Night Watch', motd: 'Raid Tue', ranks: ['Guild Master', 'Officer', 'Raider'] });
    s.applyRoster(
      [member('Lief', { rankIndex: 0, online: true, class: 'DRUID', note: 'GM' }), member('Bumta', { rankIndex: 1, class: 'WARRIOR', online: true, status: 1 }), member('Ghost', { hoursOffline: 48 }), member('Gone')],
      { full: true, at: T0 },
    );
    s.applyRoster([member('Lief', { rankIndex: 0, online: true, class: 'DRUID' }), member('Bumta', { rankIndex: 1, class: 'WARRIOR', online: true, status: 1 }), member('Ghost', { hoursOffline: 48 })], { full: true, at: T0 + 60 });
    const g = s.guild({ former: true });
    expect(g.available).toBe(true);
    expect(g.guild).toMatchObject({ name: 'Night Watch', motd: 'Raid Tue', ranks: ['Guild Master', 'Officer', 'Raider'] });
    expect(g.members.map((m) => m.name)).toEqual(['Lief', 'Bumta', 'Ghost']);
    expect(g.members[0]).toMatchObject({ rank: 'Guild Master', note: 'GM', online: true, class: 'DRUID' });
    expect(g.members[1]).toMatchObject({ status: 'afk', rank: 'Officer' });
    // Online now, so seen now; offline 48 hours is seen 48 hours before the roster.
    expect(g.members[0].lastSeen).toBe(clock * 1000);
    expect(g.members[2].lastSeen).toBe((T0 + 60 - 48 * 3600) * 1000);
    expect(g.counts).toMatchObject({ total: 3, online: 2 });
    expect(g.counts.byClass).toEqual({ DRUID: { total: 1, online: 1 }, WARRIOR: { total: 1, online: 1 }, MAGE: { total: 1, online: 0 } });
    expect(g.counts.byRank).toEqual([
      { rankIndex: 0, rank: 'Guild Master', total: 1, online: 1 },
      { rankIndex: 1, rank: 'Officer', total: 1, online: 1 },
      { rankIndex: 2, rank: 'Raider', total: 1, online: 0 },
    ]);
    expect(g.former).toMatchObject([{ name: 'Gone', leftAt: (T0 + 60) * 1000 }]);
    // Officer notes are only given when asked for.
    expect(g.members[0]).not.toHaveProperty('officerNote');
    expect(s.guild({ officer: true }).members[0]).toHaveProperty('officerNote');
  });

  it('does not take a roster without most of the guild for everyone leaving', () => {
    const s = fresh();
    const everyone = Array.from({ length: 10 }, (_, i) => member(`P${i}`));
    s.applyRoster(everyone, { full: true, at: T0 });
    // Only the people online: the rest are not gone.
    s.applyRoster(everyone.slice(0, 3), { full: true, at: T0 + 60 });
    expect(s.guild().members).toHaveLength(10);
    s.applyRoster(everyone.slice(0, 8), { full: true, at: T0 + 120 });
    expect(s.guild().members).toHaveLength(8);
  });

  it('builds sessions from online and offline events, and counts an event once', () => {
    const s = fresh();
    s.applyRoster([member('Lief', { online: true })], { at: T0 });
    for (const e of [
      { type: 'on', t: T0, name: 'Lief' },
      { type: 'off', t: T0 + 600, name: 'Lief' },
      { type: 'on', t: T0 + 900, name: 'Lief' },
      // The same facts again (from the other source), and a stray off.
      { type: 'on', t: T0, name: 'Lief' },
      { type: 'off', t: T0 + 600, name: 'Lief' },
    ]) s.applyGuildEvent(e);
    expect(s.events().events.map((e) => e.type)).toEqual(['on', 'off', 'on']);
    expect(s.sessions({ member: 'Lief' }).sessions).toEqual([
      { name: 'Lief', start: (T0 + 900) * 1000, end: null },
      { name: 'Lief', start: T0 * 1000, end: (T0 + 600) * 1000 },
    ]);
    // An event that arrives late still lands in the right place.
    s.applyGuildEvent({ type: 'off', t: T0 + 1200, name: 'Lief' });
    expect(s.sessions({ member: 'Lief' }).sessions[0]).toEqual({ name: 'Lief', start: (T0 + 900) * 1000, end: (T0 + 1200) * 1000 });
    expect(s.events({ since: (T0 + 600) * 1000 }).events.map((e) => e.type)).toEqual(['off', 'on']);
    expect(s.events({ type: 'off' }).events).toHaveLength(2);
  });

  it('follows joins, leaves, promotions and level-ups, with a rank history', () => {
    const s = fresh();
    s.applyGuildInfo({ name: 'Night Watch', ranks: ['Guild Master', 'Officer', 'Raider'] });
    s.applyRoster([member('Bumta', { rankIndex: 2, level: 50 })], { at: T0 });
    s.applyGuildEvent({ type: 'join', t: T0 + 10, name: 'Newbie' });
    expect(s.guild().members.map((m) => m.name)).toContain('Newbie');
    s.applyGuildEvent({ type: 'promote', t: T0 + 20, name: 'Bumta', a: 'Officer', b: 'Lief' });
    s.applyGuildEvent({ type: 'level', t: T0 + 30, name: 'Bumta', a: '51' });
    expect(s.guild().members.find((m) => m.name === 'Bumta')).toMatchObject({ rankIndex: 1, rank: 'Officer', level: 51 });
    // The roster agreeing with the event adds no second history row.
    s.applyRoster([member('Bumta', { rankIndex: 1, level: 51 })], { at: T0 + 40 });
    s.applyGuildEvent({ type: 'demote', t: T0 + 50, name: 'Bumta', a: 'Raider', b: 'Lief' });
    // An older event arriving late doesn't undo a newer rank.
    s.applyGuildEvent({ type: 'promote', t: T0 + 5, name: 'Bumta', a: 'Guild Master', b: 'Lief' });
    const m = s.member('bumta');
    expect(m.member).toMatchObject({ rank: 'Raider', rankIndex: 2 });
    expect(m.rankHistory.map((h) => [h.kind, h.rank, h.by])).toEqual([
      ['demote', 'Raider', 'Lief'],
      ['promote', 'Officer', 'Lief'],
      ['promote', 'Guild Master', 'Lief'],
    ]);
    // A rank change nobody announced is found in the roster.
    s.applyRoster([member('Bumta', { rankIndex: 0 })], { at: T0 + 100_000 });
    expect(s.member('Bumta').rankHistory[0]).toMatchObject({ kind: 'promote', toIndex: 0, by: '' });
    s.applyGuildEvent({ type: 'leave', t: T0 + 200_000, name: 'Bumta' });
    expect(s.guild({ former: true }).former.map((f) => f.name)).toEqual(['Bumta']);
    expect(s.member('Nobody')).toBeNull();
  });

  it('ignores another guild’s live messages, and another guild’s saved data', () => {
    const s = fresh();
    s.applyGuildInfo({ name: 'Night Watch', ranks: ['GM'] });
    const info = (name) => ({ kind: 4, text: ['I', name, 'hi', 'GM'].join('\x1f') });
    const full = { kind: 4, text: ['R', '3', '1', '1'].join('\x1f') + '\x1e' + ['M', 'Alt', '0', '10', 'MAGE', 'Durotar', '1', '0', ''].join('\x1f') };
    expect(s.ingestLive([info('Other Guild'), full])).toEqual([]);
    expect(s.guild().members).toHaveLength(0);
    expect(s.ingestLive([info('night watch'), full])).toContain('guild');
    expect(s.guild().members.map((m) => m.name)).toEqual(['Alt']);
    const saved = { guilds: { 'Other Guild': { name: 'Other Guild', savedAt: T0, members: [member('Stranger')] } } };
    expect(s.ingestSaved(saved)).toEqual({ changed: [], otherGuilds: ['Other Guild'] });
    expect(s.guild().members.map((m) => m.name)).toEqual(['Alt']);
    s.resetGuild();
    expect(s.guild().available).toBe(false);
    expect(s.ingestSaved(saved).changed).toContain('guild');
    expect(s.guild().members.map((m) => m.name)).toEqual(['Stranger']);
  });

  it('skips a live message that makes no sense and carries on', () => {
    const s = fresh();
    const bad = { kind: 5, text: '\x1e\x1f\x1f' };
    const ok = { kind: 5, text: ['join', String(T0), 'Fine', '', ''].join('\x1f') };
    expect(s.ingestLive([bad, { kind: 99, text: 'x' }, { kind: 4, text: 'garbage' }, ok])).toContain('events');
    expect(s.events().events.map((e) => e.name)).toEqual(['Fine']);
  });
});

describe('raids', () => {
  const raid = { id: T0, zone: 'Molten Core', instanceId: 409, size: 40, startT: T0, endT: null };

  function seed(s) {
    s.applyRoster([member('Lief', { class: 'DRUID' }), member('Bumta', { class: 'WARRIOR' }), member('Ghost', { class: 'PRIEST' })], { at: T0 });
    s.applyRaidEvent({ tag: 'raid', id: T0, zone: 'Molten Core', instanceId: 409, endT: null, size: 40, lootMethod: 'master', masterLooter: 'Lief' }, { live: true });
    const snap = (t, kind, boss, names) => s.applyRaidEvent({ tag: 'attendance', t, raid: T0, kind, boss, names });
    snap(T0, 'start', '', ['Lief', 'Bumta', 'Ghost']);
    snap(T0 + 600, 'boss', 'Lucifron', ['Lief', 'Bumta', 'Ghost']);
    snap(T0 + 1500, 'timer', '', ['Lief', 'Bumta']);
    snap(T0 + 2400, 'boss', 'Magmadar', ['Lief', 'Bumta']);
    s.applyRaidEvent({ tag: 'encounter', t: T0 + 500, raid: T0, id: 663, name: 'Lucifron', difficulty: 9, size: 40, success: null, endT: null });
    s.applyRaidEvent({ tag: 'encounter', t: T0 + 500, raid: T0, id: 663, name: 'Lucifron', difficulty: 9, size: 40, success: true, endT: T0 + 600 });
    s.applyRaidEvent({ tag: 'encounter', t: T0 + 2000, raid: T0, id: 664, name: 'Magmadar', difficulty: 9, size: 40, success: false, endT: T0 + 2100 });
    s.applyRaidEvent({ tag: 'loot', t: T0 + 650, raid: T0, who: 'Bumta', itemId: 16922, name: 'Leggings', quality: 4, count: 1, boss: 'Lucifron' });
    s.applyRaidEvent({ tag: 'loot', t: T0 + 700, raid: T0, who: 'Lief', itemId: 16800, name: 'Boots', quality: 3, count: 1, boss: 'Lucifron' });
  }

  it('lists raids with bosses and who was there', () => {
    const s = fresh();
    seed(s);
    const { raids } = s.raids();
    expect(raids).toHaveLength(1);
    expect(raids[0]).toMatchObject({ zone: 'Molten Core', size: 40, startedAt: T0 * 1000, endedAt: null, kills: 1, snapshots: 4, lootCount: 2, masterLooter: 'Lief', lootMethod: 'master' });
    // Lucifron's start and end are one fight.
    expect(raids[0].bosses).toEqual([
      { id: 663, name: 'Lucifron', difficulty: 9, size: 40, startedAt: (T0 + 500) * 1000, endedAt: (T0 + 600) * 1000, success: true },
      { id: 664, name: 'Magmadar', difficulty: 9, size: 40, startedAt: (T0 + 2000) * 1000, endedAt: (T0 + 2100) * 1000, success: false },
    ]);
    expect(raids[0].attendees).toEqual([
      { name: 'Bumta', pct: 100 },
      { name: 'Lief', pct: 100 },
      { name: 'Ghost', pct: 50 },
    ]);
  });

  it('works out attendance over the last raids', () => {
    const s = fresh();
    seed(s);
    // A second raid only Lief came to.
    s.applyRaidEvent({ tag: 'raid', id: T0 + 86400, zone: 'Onyxia’s Lair', instanceId: 249, endT: T0 + 90000, size: 40, lootMethod: '', masterLooter: '' }, { live: true });
    s.applyRaidEvent({ tag: 'attendance', t: T0 + 86400, raid: T0 + 86400, kind: 'start', boss: '', names: ['Lief'] });
    const a = s.attendance({ last: 10 });
    expect(a.raids).toBe(2);
    expect(a.members.map((m) => [m.name, m.attended, m.pct, m.bossesAttended, m.bosses])).toEqual([
      ['Lief', 2, 100, 2, 2],
      ['Bumta', 1, 50, 2, 2],
      // Present for half of the first raid's snapshots counts as attending it.
      ['Ghost', 1, 50, 1, 2],
    ]);
    expect(a.members[0]).toMatchObject({ class: 'DRUID', inGuild: true, lastRaidAt: (T0 + 86400) * 1000 });
    // Only the latest raid.
    expect(s.attendance({ last: 1 }).members.map((m) => [m.name, m.pct])).toEqual([['Lief', 100], ['Bumta', 0], ['Ghost', 0]]);
  });

  it('keeps loot by member, time and raid', () => {
    const s = fresh();
    seed(s);
    expect(s.loot().loot.map((l) => l.who)).toEqual(['Lief', 'Bumta']);
    expect(s.loot({ member: 'bumta' }).loot).toMatchObject([{ who: 'Bumta', itemId: 16922, name: 'Leggings', quality: 4, boss: 'Lucifron', raidId: T0, at: (T0 + 650) * 1000 }]);
    expect(s.loot({ since: (T0 + 660) * 1000 }).loot.map((l) => l.who)).toEqual(['Lief']);
    expect(s.loot({ raid: 5 }).loot).toEqual([]);
    // The same drop from the other source is not a second drop.
    s.applyRaidEvent({ tag: 'loot', t: T0 + 650, raid: T0, who: 'Bumta', itemId: 16922, name: 'Leggings', quality: 4, count: 1, boss: 'Lucifron' });
    expect(s.loot().loot).toHaveLength(2);
  });

  it('pieces a ready check together', () => {
    const s = fresh();
    s.applyRaidEvent({ tag: 'readycheck', t: T0, initiator: 'Lief' });
    expect(s.readyChecks().readyChecks).toMatchObject([{ initiator: 'Lief', ready: [], done: false }]);
    const done = { tag: 'readycheck_done', t: T0, initiator: 'Lief', ready: ['Lief'], notReady: ['Bumta'], afk: ['Ghost'] };
    s.applyRaidEvent(done);
    s.applyRaidEvent(done);
    s.applyRaidEvent({ tag: 'readycheck', t: T0, initiator: 'Lief' });
    expect(s.readyChecks().readyChecks).toEqual([{ at: T0 * 1000, initiator: 'Lief', ready: ['Lief'], notReady: ['Bumta'], afk: ['Ghost'], done: true }]);
  });

  it('creates a raid for news about one it never saw start', () => {
    const s = fresh();
    s.applyRaidEvent({ tag: 'attendance', t: T0 + 5, raid: T0, kind: 'timer', boss: '', names: ['Lief'] });
    expect(s.raids().raids).toMatchObject([{ id: T0, zone: '', snapshots: 1 }]);
    // And when the raid's own record turns up, it fills in.
    s.applyRaidEvent({ tag: 'raid', id: T0, zone: 'Molten Core', instanceId: 409, endT: null, size: 40, lootMethod: '', masterLooter: '' }, { live: true });
    expect(s.raids().raids[0]).toMatchObject({ zone: 'Molten Core', snapshots: 1 });
  });

  it('does not reopen a raid with older saved data, but a live message can', () => {
    const s = fresh();
    s.applyRaidEvent({ tag: 'raid', ...raid, id: T0, endT: T0 + 5000, zone: 'Molten Core', lootMethod: '', masterLooter: '' }, { live: true });
    s.ingestSaved({ raids: [{ id: T0, zone: 'Molten Core', instanceId: 409, size: 40, startT: T0, bosses: {}, snapshots: {}, loot: {} }] });
    expect(s.raids().raids[0].endedAt).toBe((T0 + 5000) * 1000);
    s.applyRaidEvent({ tag: 'raid', id: T0, zone: 'Molten Core', instanceId: 409, endT: null, size: 40, lootMethod: '', masterLooter: '' }, { live: true });
    expect(s.raids().raids[0].endedAt).toBeNull();
  });

  it('keeps the raid group, from full syncs and changes', () => {
    const s = fresh();
    const rec = (name, subgroup, rank, role, dead) => ['M', name, 'MAGE', '60', subgroup, rank, role, '1', dead, 'Molten Core', '0'].join('\x1f');
    const full = (n, records) => ({ kind: 6, text: [['R', '9', String(n), '2'].join('\x1f'), ...records].join('\x1e') });
    expect(s.ingestLive([full(1, [rec('Lief', '1', '2', 'T', '0')])])).toEqual([]);
    expect(s.ingestLive([full(2, [rec('Bumta', '2', '1', '', '0')])])).toEqual(['raid']);
    const delta = { kind: 6, text: [['D', '9'].join('\x1f'), rec('Bumta', '2', '1', '', '1'), ['X', 'Lief'].join('\x1f')].join('\x1e') };
    s.ingestLive([delta]);
    const r = s.raid();
    expect(r).toMatchObject({ inRaid: true, size: 1, counts: { online: 1, dead: 1 } });
    expect(r.members).toEqual([{ name: 'Bumta', class: 'MAGE', level: 60, subgroup: 2, rank: 'assist', role: '', online: true, dead: true, zone: 'Molten Core', masterLooter: false }]);
    // A change to a roster that never arrived is ignored.
    expect(s.ingestLive([{ kind: 6, text: ['D', '77'].join('\x1f') + '\x1e' + rec('Zed', '1', '0', '', '0') }])).toEqual([]);
    expect(s.raid().members.map((m) => m.name)).toEqual(['Bumta']);
  });
});

// ---- the real addon, saved and on the strip ----

/** Plays a night in the guild and a raid through the addon's own Lua. */
function night() {
  const w = new World();
  w.run(`
    __world.guild = { name = "Night's Watch", motd = "Raid Tuesday", info = "Be nice.", ranks = { "Guild Master", "Officer", "Raider" }, members = {
      { name = "Lief", rank = "Guild Master", rankIndex = 0, level = 60, class = "Druid", classFile = "DRUID", zone = "Molten Core", note = "Ö GM", officerNote = "", online = true, status = 0 },
      { name = "Bumta", rank = "Raider", rankIndex = 2, level = 60, class = "Warrior", classFile = "WARRIOR", zone = "Molten Core", note = "tank", officerNote = "owes 10g", online = true, status = 1 },
      { name = "Ghost", rank = "Raider", rankIndex = 2, level = 58, class = "Priest", classFile = "PRIEST", zone = "Stormwind", note = "", officerNote = "", online = false, status = 0, ago = { 0, 0, 2, 5 } },
      { name = "Pip", rank = "Raider", rankIndex = 2, level = 59, class = "Mage", classFile = "MAGE", zone = "Ironforge", note = "", officerNote = "", online = true, status = 0 },
    } }
  `);
  w.login();
  const sent = [...w.messages(30)];
  const say = (text) => w.fire('CHAT_MSG_SYSTEM', text);
  say('|Hplayer:Ghost|h[Ghost]|h has come online.');
  say('Pip has gone offline.');
  say('Lief has promoted Bumta to Officer.');
  w.run('__world.guild.members[2].rank = "Officer"; __world.guild.members[2].rankIndex = 1; __world.guild.members[4].level = 60; __world.guild.members[3].online = true');
  w.fire('GUILD_ROSTER_UPDATE');
  sent.push(...w.messages(10));
  w.run(`
    __world.raid = {
      { name = "Lief", rank = 2, subgroup = 1, level = 60, class = "DRUID" },
      { name = "Bumta", rank = 1, subgroup = 1, level = 60, class = "WARRIOR", role = "MAINTANK" },
      { name = "Ghost", subgroup = 2, level = 58, class = "PRIEST" },
      { name = "Pip", subgroup = 2, level = 60, class = "MAGE", online = false },
    }
    __world.instance = { name = "Molten Core", kind = "raid", maxPlayers = 40, id = 409 }
  `);
  w.fire('PLAYER_ENTERING_WORLD');
  sent.push(...w.messages(10));
  w.fire('READY_CHECK', 'Lief', 30);
  w.fire('READY_CHECK_CONFIRM', 'raid2', true);
  w.advance(5);
  w.fire('READY_CHECK_FINISHED', false);
  w.fire('ENCOUNTER_START', 663, 'Lucifron', 9, 40);
  w.advance(60);
  w.fire('ENCOUNTER_END', 663, 'Lucifron', 9, 40, 1);
  w.fire('CHAT_MSG_LOOT', 'Bumta receives loot: |cffa335ee|Hitem:16922::::::::60:::::|h[Leggings of Transcendence]|h|r.');
  w.fire('CHAT_MSG_LOOT', 'You receive loot: |cff0070dd|Hitem:16800::::::::60:::::|h[Arcanist Boots]|h|r.');
  w.fire('CHAT_MSG_LOOT', 'Bumta receives loot: |cff9d9d9d|Hitem:1::::::::60:::::|h[Junk]|h|r.');
  sent.push(...w.messages(16 * 60));
  say('Ghost has gone offline.');
  w.run('__world.instance = nil');
  w.fire('ZONE_CHANGED_NEW_AREA');
  sent.push(...w.messages(10));
  return { w, sent, saved: w.savedVariables() };
}

/** Everything the API can say, for comparing two databases. */
function everything(s) {
  const clean = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'lastSeen' || k === 'updatedAt' ? undefined : x)));
  return clean({
    guild: s.guild({ former: true, officer: true }),
    events: s.events(),
    sessions: s.sessions(),
    raids: s.raids(),
    attendance: s.attendance(),
    loot: s.loot(),
    ready: s.readyChecks(),
  });
}

describe('what the addon really sends and saves', () => {
  const { sent, saved } = night();

  it('saves the way WoW does, and the saved file reads', () => {
    const sv = parseSavedVariables(saved).UncboxDB;
    expect(Object.keys(sv.guilds)).toEqual(["Night's Watch"]);
    const g = sv.guilds["Night's Watch"];
    expect(g.members.map((m) => m.name)).toEqual(['Lief', 'Bumta', 'Ghost', 'Pip']);
    expect(g.members[1]).toMatchObject({ note: 'tank', officerNote: 'owes 10g', rankIndex: 1, status: 1 });
    expect(g.members[0].note).toBe('Ö GM');
    expect(g.events.map((e) => e.type)).toEqual(['on', 'off', 'promote', 'level', 'off']);
    expect(sv.raids).toHaveLength(1);
    expect(sv.raids[0].loot).toHaveLength(2);
    expect(sv.readyChecks).toHaveLength(1);
  });

  it('puts the same facts in the database from either source, and in any order', () => {
    const live = fresh();
    for (const m of sent) live.ingestLive([m]);
    const savedFirst = fresh();
    const viaSaved = savedFirst.ingestSaved(parseSavedVariables(saved).UncboxDB);
    expect(viaSaved.changed).toEqual(expect.arrayContaining(['guild', 'events', 'raids', 'loot', 'readychecks']));
    const a = everything(live);
    const b = everything(savedFirst);

    // Counted from the strip: 5 events, a raid with its boss, 2 loot (not the junk), one ready check.
    expect(a.events.events.map((e) => [e.type, e.name])).toEqual([
      ['off', 'Ghost'],
      ['level', 'Pip'],
      ['promote', 'Bumta'],
      ['off', 'Pip'],
      ['on', 'Ghost'],
    ]);
    expect(a.loot.loot.map((l) => l.who)).toEqual(['Lief', 'Bumta']);
    expect(a.raids.raids[0]).toMatchObject({ zone: 'Molten Core', kills: 1, lootCount: 2, endedAt: expect.any(Number) });
    expect(a.ready.readyChecks).toMatchObject([{ initiator: 'Lief', ready: ['Bumta', 'Lief'], notReady: [], afk: ['Ghost'] }]);

    // Only SavedVariables carries notes and the guild info; everything else is the same.
    const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (['note', 'officerNote', 'info', 'firstSeen'].includes(k) ? undefined : x)));
    expect(strip(b)).toEqual(strip(a));
    expect(b.guild.members.find((m) => m.name === 'Bumta')).toMatchObject({ note: 'tank', officerNote: 'owes 10g' });
    expect(a.guild.members.find((m) => m.name === 'Bumta')).toMatchObject({ note: '' });

    // The other source on top of either one counts nothing twice.
    const before = JSON.stringify(a);
    const again = live.ingestSaved(parseSavedVariables(saved).UncboxDB);
    expect(again.changed).toEqual(expect.not.arrayContaining(['events', 'raids', 'loot', 'readychecks']));
    expect(JSON.stringify(strip(everything(live)))).toBe(JSON.stringify(strip(JSON.parse(before))));
    const second = savedFirst.ingestSaved(parseSavedVariables(saved).UncboxDB);
    expect(second.changed).toEqual([]);
    for (const m of sent) savedFirst.ingestLive([m]);
    expect(strip(everything(savedFirst))).toEqual(strip(b));
    // The notes the saved file gave survive the strip that has none.
    expect(savedFirst.guild({ officer: true }).members.find((m) => m.name === 'Bumta')).toMatchObject({ note: 'tank', officerNote: 'owes 10g' });
  });

  it('reads sessions, ranks and attendance out of it', () => {
    const s = fresh();
    s.ingestSaved(parseSavedVariables(saved).UncboxDB);
    expect(s.sessions({ member: 'Ghost' }).sessions).toEqual([{ name: 'Ghost', start: expect.any(Number), end: expect.any(Number) }]);
    expect(s.member('Bumta')).toMatchObject({ member: { rank: 'Officer', rankIndex: 1 }, rankHistory: [{ kind: 'promote', rank: 'Officer', by: 'Lief' }] });
    const a = s.attendance({ last: 5 });
    expect(a.raids).toBe(1);
    expect(a.members.find((m) => m.name === 'Lief')).toMatchObject({ pct: 100, bossesAttended: 1, bosses: 1 });
    // Pip was offline during the raid, so not there.
    expect(a.members.find((m) => m.name === 'Pip')).toMatchObject({ pct: 0 });
    expect(s.guild().members.find((m) => m.name === 'Pip')).toMatchObject({ level: 60 });
  });
});
