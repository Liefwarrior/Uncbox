// Runs the addon's real Lua (Codec, Util, Outbox, Sync, Guild, Raid, Uncbox) in fengari against a
// pretend WoW (wowmock.lua), and reads what it draws on the strip the way Uncbox's page does.

import { describe, expect, it } from 'vitest';
import { type Message, World, lit } from './addonWorld';
import { KIND_CHARACTER, KIND_GUILD, KIND_GUILD_EVENTS, KIND_RAID, KIND_RAID_EVENTS, PAGE_BYTES, paginate } from './codec';
import * as messages from './messages.mjs';
import type { GroupMember, GuildMember } from './messages.mjs';
import { parseCharacter, parseGuildEvents, parseRaidEvents, parseRosterMessage, RosterTracker } from './parse';

const utf8 = (s: string) => new TextEncoder().encode(s);
const kinds = (list: Message[], kind: number) => list.filter((m) => m.kind === kind);

const SAVED = `(UncboxDB.guilds or {})["Night's Watch"]`;
const GUILD = `
  __world.guild = { name = "Night's Watch", motd = "Raid Tuesday 8pm", info = "Be nice.", ranks = { "Guild Master", "Officer", "Raider", "Member" }, members = {} }
  local classes = { "WARRIOR", "PRIEST", "MAGE", "DRUID", "ROGUE" }
  for i = 1, N do
    __world.guild.members[i] = {
      name = string.format("Member%02d", i), rank = "Raider", rankIndex = 2, level = 50 + i % 10,
      class = "Class", classFile = classes[i % 5 + 1], zone = "Orgrimmar", note = "main", officerNote = "", online = i % 3 ~= 0,
      status = 0, ago = { 0, 0, 1, 2 },
    }
  end
`;

/** A guild of n members (Member01…), set up before login. */
function guildWorld(n: number, config?: string) {
  const w = new World(config);
  w.run(`local N = ${n}\n${GUILD}`);
  return w;
}

/** A raid of n players (Raider01…), you being the first. */
function raidWorld(n: number, config?: string) {
  const w = new World(config);
  w.run(`
    local classes = { "WARRIOR", "PRIEST", "MAGE", "DRUID", "ROGUE" }
    __world.raid = {}
    for i = 1, ${n} do
      __world.raid[i] = { name = i == 1 and "Lief" or string.format("Raider%02d", i), rank = i == 1 and 2 or 0, subgroup = (i - 1) // 5 + 1, level = 60, class = classes[i % 5 + 1], zone = "Molten Core" }
    end
  `);
  return w;
}

const MC = `__world.instance = { name = "Molten Core", kind = "raid", maxPlayers = 40, id = 409 }`;

describe('codec: Lua and TypeScript agree', () => {
  it('has the same kinds', () => {
    const w = new World();
    expect(w.json('{UncboxCodec.KIND_CHARACTER, UncboxCodec.KIND_GUILD, UncboxCodec.KIND_GUILD_EVENTS, UncboxCodec.KIND_RAID, UncboxCodec.KIND_RAID_EVENTS}')).toEqual([
      KIND_CHARACTER,
      KIND_GUILD,
      KIND_GUILD_EVENTS,
      KIND_RAID,
      KIND_RAID_EVENTS,
    ]);
    expect([messages.KIND_GUILD, messages.KIND_GUILD_EVENTS, messages.KIND_RAID, messages.KIND_RAID_EVENTS]).toEqual([KIND_GUILD, KIND_GUILD_EVENTS, KIND_RAID, KIND_RAID_EVENTS]);
  });

  it('cuts the new kinds into the same pages', () => {
    const w = new World();
    const text = `M\x1fZoë ${'x'.repeat(400)}\x1eD\x1f1`;
    for (const kind of [KIND_GUILD, KIND_GUILD_EVENTS, KIND_RAID, KIND_RAID_EVENTS]) {
      const lual = w.json<number[][]>(`UncboxCodec.paginate(${kind}, 261, ${lit(text)})`);
      expect(lual).toEqual(paginate(kind, 261, utf8(text)));
    }
  });
});

describe('Blizzard message formats as patterns', () => {
  const match = (w: World, fmt: string, text: string) => w.json(`UncboxUtil.match(UncboxUtil.matcher(${fmt}), ${lit(text)})`);

  it('reads the real English formats', () => {
    const w = new World();
    expect(match(w, 'ERR_FRIEND_ONLINE_SS', '|Hplayer:Lief|h[Lief]|h has come online.')).toEqual(['Lief', 'Lief']);
    expect(match(w, 'ERR_FRIEND_OFFLINE_S', 'Lief has gone offline.')).toEqual(['Lief']);
    expect(match(w, 'ERR_GUILD_JOIN_S', 'Bumta has joined the guild.')).toEqual(['Bumta']);
    expect(match(w, 'ERR_GUILD_LEAVE_S', 'Bumta has left the guild.')).toEqual(['Bumta']);
    expect(match(w, 'ERR_GUILD_REMOVE_SS', 'Bumta has been kicked out of the guild by Lief.')).toEqual(['Bumta', 'Lief']);
    expect(match(w, 'ERR_GUILD_PROMOTE_SSS', 'Lief has promoted Bumta to Officer.')).toEqual(['Lief', 'Bumta', 'Officer']);
    expect(match(w, 'ERR_GUILD_DEMOTE_SSS', 'Lief has demoted Bumta to Member.')).toEqual(['Lief', 'Bumta', 'Member']);
    expect(match(w, 'LOOT_ITEM_SELF_MULTIPLE', 'You receive loot: |cff1eff00|Hitem:2589::::|h[Linen Cloth]|h|rx5.')).toEqual(['|cff1eff00|Hitem:2589::::|h[Linen Cloth]|h|r', '5']);
  });

  it('keeps the order of the format when a language reorders its arguments', () => {
    const w = new World();
    w.run('GERMAN = "%2$s wurde von %1$s zum Rang %3$s befördert."');
    expect(match(w, 'GERMAN', 'Bumta wurde von Lief zum Rang Offizier befördert.')).toEqual(['Lief', 'Bumta', 'Offizier']);
  });

  it('escapes everything that is not a placeholder', () => {
    const w = new World();
    w.run('ODD = "Level (%d) [%s] is 50%% + more? ^$."');
    expect(match(w, 'ODD', 'Level (5) [Lief] is 50% + more? ^$.')).toEqual(['5', 'Lief']);
    // The same text with other characters where the escaped ones were is not a match.
    expect(match(w, 'ODD', 'Level 5 Lief is 50 more')).toBeNull();
    expect(match(w, 'ERR_GUILD_JOIN_S', 'Nothing to do with guilds')).toBeNull();
    expect(w.json('UncboxUtil.matcher(nil)')).toBeNull();
  });
});

describe('character, quests and party still go over the strip', () => {
  it('sends the character', () => {
    const w = new World();
    w.login();
    const sent = kinds(w.messages(3), KIND_CHARACTER);
    expect(parseCharacter(sent[0].text)).toMatchObject({ name: 'Lief', realm: 'Doomhowl', cls: 'Druid', level: 23, zone: 'Darkshore' });
  });
});

describe('guild roster', () => {
  it('sends the guild, its ranks and every member', () => {
    const w = guildWorld(3);
    w.run('__world.guild.members[3].online = false; __world.guild.members[3].ago = { 0, 0, 2, 5 }; __world.guild.members[1].status = 1');
    w.login();
    const sent = kinds(w.messages(10), KIND_GUILD);
    const info = parseRosterMessage(KIND_GUILD, sent[0].text);
    expect(info).toEqual({ type: 'info', name: "Night's Watch", motd: 'Raid Tuesday 8pm', ranks: ['Guild Master', 'Officer', 'Raider', 'Member'] });
    const tracker = new RosterTracker<GuildMember>();
    for (const m of sent.slice(1)) tracker.apply(parseRosterMessage(KIND_GUILD, m.text));
    expect([...tracker.members.keys()]).toEqual(['Member01', 'Member02', 'Member03']);
    expect(tracker.members.get('Member01')).toMatchObject({ rankIndex: 2, class: 'PRIEST', zone: 'Orgrimmar', online: true, status: 1, hoursOffline: null });
    // Offline for 2 days and 5 hours.
    expect(tracker.members.get('Member03')).toMatchObject({ online: false, hoursOffline: 53 });
  });

  it('saves everything, notes included, for SavedVariables', () => {
    const w = guildWorld(3);
    w.run('__world.guild.members[1].note = "Lief\'s alt"; __world.guild.members[1].officerNote = "owes 10g"');
    w.login();
    const saved = w.json<Record<string, unknown>>(SAVED);
    expect(saved).toMatchObject({ name: "Night's Watch", motd: 'Raid Tuesday 8pm', info: 'Be nice.', count: 3, ranks: ['Guild Master', 'Officer', 'Raider', 'Member'] });
    const members = saved.members as Record<string, unknown>[];
    expect(members[0]).toMatchObject({ name: 'Member01', rank: 'Raider', rankIndex: 2, class: 'PRIEST', note: "Lief's alt", officerNote: 'owes 10g', online: true, status: 0 });
    expect(members[2]).toMatchObject({ online: false, hours: 26 });
    expect(members[2].lastOnline).toBe(Number(saved.savedAt) - 26 * 3600);
  });

  it('leaves out officer notes the player cannot read', () => {
    const w = guildWorld(1);
    w.run('__world.guild.members[1].officerNote = "secret"; __world.canOfficer = false');
    w.login();
    expect(w.json<{ officerNote: string }[]>(`${SAVED}.members`)[0].officerNote).toBe('');
  });

  it('asks for the roster with either name the game has, and shows offline members', () => {
    const w = guildWorld(1);
    w.login();
    w.advance(3);
    expect(w.json<number>('__world.rosterRequests')).toBe(1);
    expect(w.json('__showOffline')).toBe(true);
    w.advance(60);
    expect(w.json<number>('__world.rosterRequests')).toBe(2);

    const old = guildWorld(1);
    old.run('__useOldRosterApi()');
    old.login();
    old.advance(3);
    expect(old.json<number>('__world.rosterRequests')).toBe(1);
  });

  it('spreads a big guild over several bursts of one-page messages', () => {
    const w = guildWorld(50);
    w.login();
    const early = kinds(w.messages(2), KIND_GUILD).filter((m) => m.text.startsWith('R'));
    expect(early.length).toBeGreaterThan(0);
    expect(early.length).toBeLessThanOrEqual(4);
    const rest = kinds(w.messages(40), KIND_GUILD);
    const all = [...early, ...rest.filter((m) => m.text.startsWith('R'))];
    const first = parseRosterMessage(KIND_GUILD, all[0].text);
    expect(first).toMatchObject({ type: 'full', index: 1 });
    expect(all).toHaveLength((first as { count: number }).count);
    expect(all.length).toBeGreaterThan(8);
    // Every message fits one page.
    for (const m of all) expect(utf8(m.text).length).toBeLessThanOrEqual(PAGE_BYTES - 8);
    const tracker = new RosterTracker<GuildMember>();
    for (const m of all) tracker.apply(parseRosterMessage(KIND_GUILD, m.text));
    expect(tracker.members.size).toBe(50);
  });

  it('sends only what changed afterward', () => {
    const w = guildWorld(10);
    w.login();
    const tracker = new RosterTracker<GuildMember>();
    for (const m of kinds(w.messages(30), KIND_GUILD)) tracker.apply(parseRosterMessage(KIND_GUILD, m.text));
    expect(tracker.members.size).toBe(10);

    // Nothing changed: nothing is sent.
    w.fire('GUILD_ROSTER_UPDATE');
    expect(kinds(w.messages(5), KIND_GUILD)).toHaveLength(0);

    // One person moves, one is gone, one is new.
    w.run('__world.guild.members[2].zone = "Stormwind City"; table.remove(__world.guild.members, 5); table.insert(__world.guild.members, { name = "Newbie", rank = "Member", rankIndex = 3, level = 8, classFile = "MAGE", zone = "Elwynn Forest", online = true })');
    w.fire('GUILD_ROSTER_UPDATE');
    const deltas = kinds(w.messages(5), KIND_GUILD).map((m) => parseRosterMessage(KIND_GUILD, m.text));
    expect(deltas).toHaveLength(1);
    const delta = deltas[0] as { type: string; members: { name: string }[]; removed: string[] };
    expect(delta.type).toBe('delta');
    expect(delta.members.map((m) => m.name).sort()).toEqual(['Member02', 'Newbie']);
    expect(delta.removed).toEqual(['Member05']);
    const change = tracker.apply(delta as never);
    expect(change?.full).toBe(false);
    expect(tracker.members.size).toBe(10);
    expect(tracker.members.get('Member02')).toMatchObject({ zone: 'Stormwind City' });
  });

  it('does a full sync again every ten minutes', () => {
    const w = guildWorld(4);
    w.login();
    const syncs = (list: Message[]) => [...new Set(kinds(list, KIND_GUILD).filter((m) => m.text.startsWith('R')).map((m) => (parseRosterMessage(KIND_GUILD, m.text) as { sync: number }).sync))];
    const first = syncs(w.messages(20));
    const again = syncs(w.messages(620));
    expect(first).toHaveLength(1);
    expect(again).toEqual([(first[0] + 1) % 256]);
  });

  it('does nothing without a guild, or with the guild module off', () => {
    const none = new World();
    none.login();
    expect(kinds(none.messages(5), KIND_GUILD)).toHaveLength(0);

    const off = guildWorld(3, '{ modules = { guild = false } }');
    off.login();
    expect(kinds(off.messages(5), KIND_GUILD)).toHaveLength(0);
    expect(off.json(SAVED)).toBeNull();
  });
});

describe('guild events', () => {
  const say = (w: World, text: string) => w.fire('CHAT_MSG_SYSTEM', text);
  const events = (list: Message[]) => kinds(list, KIND_GUILD_EVENTS).flatMap((m) => parseGuildEvents(m.text));

  it('sees members come online and go offline, but not friends', () => {
    const w = guildWorld(3);
    w.login();
    w.messages(1);
    say(w, '|Hplayer:Member03|h[Member03]|h has come online.');
    say(w, 'Member01 has gone offline.');
    say(w, '|Hplayer:Somefriend|h[Somefriend]|h has come online.');
    const got = events(w.messages(3));
    expect(got).toEqual([
      { type: 'on', t: expect.any(Number), name: 'Member03', a: '', b: '' },
      { type: 'off', t: expect.any(Number), name: 'Member01', a: '', b: '' },
    ]);
    // The same facts are in SavedVariables, with the same time, so Uncbox can tell it's the same event.
    const saved = w.json<{ type: string; t: number; name: string }[]>(`${SAVED}.events`);
    expect(saved.map((e) => [e.type, e.t, e.name])).toEqual(got.map((e) => [e.type, e.t, e.name]));
  });

  it('sees joins, leaves, kicks, promotions and demotions', () => {
    const w = guildWorld(3);
    w.login();
    w.messages(1);
    say(w, 'Newbie has joined the guild.');
    say(w, 'Member02 has left the guild.');
    say(w, 'Member03 has been kicked out of the guild by Member01.');
    say(w, 'Member01 has promoted Member02 to Officer.');
    say(w, 'Member01 has demoted Member02 to Member.');
    const got = events(w.messages(3)).map(({ type, name, a, b }) => ({ type, name, a, b }));
    expect(got).toEqual([
      { type: 'join', name: 'Newbie', a: '', b: '' },
      { type: 'leave', name: 'Member02', a: '', b: '' },
      { type: 'kick', name: 'Member03', a: '', b: 'Member01' },
      { type: 'promote', name: 'Member02', a: 'Officer', b: 'Member01' },
      { type: 'demote', name: 'Member02', a: 'Member', b: 'Member01' },
    ]);
  });

  it('works in another language, from the game’s own strings', () => {
    const w = guildWorld(2);
    w.run('ERR_GUILD_JOIN_S = "%s ist der Gilde beigetreten."; ERR_GUILD_PROMOTE_SSS = "%1$s hat %2$s zum Rang %3$s befördert."');
    w.login();
    w.messages(1);
    say(w, 'Hanna ist der Gilde beigetreten.');
    say(w, 'Member01 hat Member02 zum Rang Offizier befördert.');
    // The English text means nothing to this client.
    say(w, 'Karl has joined the guild.');
    const got = events(w.messages(3)).map(({ type, name, a, b }) => ({ type, name, a, b }));
    expect(got).toEqual([
      { type: 'join', name: 'Hanna', a: '', b: '' },
      { type: 'promote', name: 'Member02', a: 'Offizier', b: 'Member01' },
    ]);
  });

  it('batches events close together and ignores the game saying one twice', () => {
    const w = guildWorld(3);
    w.login();
    w.messages(1);
    say(w, 'Member01 has gone offline.');
    say(w, 'Member01 has gone offline.');
    say(w, 'Member02 has gone offline.');
    const sent = kinds(w.messages(3), KIND_GUILD_EVENTS);
    expect(sent).toHaveLength(1);
    expect(parseGuildEvents(sent[0].text).map((e) => e.name)).toEqual(['Member01', 'Member02']);
  });

  it('spots level-ups in the roster, which the game does not announce', () => {
    const w = guildWorld(3);
    w.login();
    w.messages(30);
    w.run('__world.guild.members[2].level = 60');
    w.fire('GUILD_ROSTER_UPDATE');
    const sent = w.messages(5);
    expect(events(sent).map(({ type, name, a }) => ({ type, name, a }))).toEqual([{ type: 'level', name: 'Member02', a: '60' }]);
    expect(parseRosterMessage(KIND_GUILD, kinds(sent, KIND_GUILD)[0].text)).toMatchObject({ type: 'delta', members: [{ name: 'Member02', level: 60 }] });
  });

  it('keeps the last 500 events in SavedVariables', () => {
    const w = guildWorld(1);
    w.login();
    for (let i = 0; i < 520; i++) {
      w.run(`UncboxGuild.addEvent("join", "P${i}")`);
      w.advance(0.1);
    }
    expect(w.json<number>(`#${SAVED}.events`)).toBe(500);
    expect(w.json<string>(`${SAVED}.events[1].name`)).toBe('P20');
  });
});

describe('raid group', () => {
  const group = (list: Message[]) => kinds(list, KIND_RAID);

  it('sends the raid with subgroups, leader and main tank', () => {
    const w = raidWorld(25);
    w.run('__world.raid[2].role = "MAINTANK"; __world.raid[3].rank = 1; __world.raid[4].dead = true; __world.raid[5].online = false');
    w.login();
    const tracker = new RosterTracker<GroupMember>();
    for (const m of group(w.messages(30))) tracker.apply(parseRosterMessage(KIND_RAID, m.text));
    expect(tracker.members.size).toBe(25);
    expect(tracker.members.get('Lief')).toMatchObject({ rank: 2, subgroup: 1, level: 60, class: 'PRIEST' });
    expect(tracker.members.get('Raider02')).toMatchObject({ role: 'T', class: 'MAGE' });
    expect(tracker.members.get('Raider03')).toMatchObject({ rank: 1, role: '' });
    expect(tracker.members.get('Raider04')).toMatchObject({ dead: true });
    expect(tracker.members.get('Raider05')).toMatchObject({ online: false, subgroup: 1 });
    expect(tracker.members.get('Raider25')).toMatchObject({ subgroup: 5, zone: 'Molten Core' });
    expect(w.json('UncboxDB.raid.inRaid')).toBe(true);
    expect(w.json('#UncboxDB.raid.members')).toBe(25);
  });

  it('finds the main tank through GetPartyAssignment when the roster has no role', () => {
    const w = raidWorld(5);
    w.run('GetPartyAssignment = function(kind, unit) return kind == "MAINASSIST" and unit == "raid3" end');
    w.login();
    const tracker = new RosterTracker<GroupMember>();
    for (const m of group(w.messages(10))) tracker.apply(parseRosterMessage(KIND_RAID, m.text));
    expect(tracker.members.get('Raider03')).toMatchObject({ role: 'A' });
  });

  it('sends a death as a one-person change, within a few seconds', () => {
    const w = raidWorld(25);
    w.login();
    const tracker = new RosterTracker<GroupMember>();
    for (const m of group(w.messages(30))) tracker.apply(parseRosterMessage(KIND_RAID, m.text));
    w.run('__world.raid[7].dead = true');
    const sent = group(w.messages(5));
    expect(sent).toHaveLength(1);
    const delta = parseRosterMessage(KIND_RAID, sent[0].text) as { type: string; members: { name: string; dead: boolean }[] };
    expect(delta.type).toBe('delta');
    expect(delta.members).toMatchObject([{ name: 'Raider07', dead: true }]);
    tracker.apply(delta as never);
    expect(tracker.members.get('Raider07')).toMatchObject({ dead: true });
  });

  it('sends a party when you are not in a raid, and nothing when you are alone', () => {
    const w = new World();
    w.login();
    expect(group(w.messages(5))).toHaveLength(0);
    w.run('__world.party = { { name = "Bumta", class = "WARRIOR", level = 22, rank = 0 } }');
    const tracker = new RosterTracker<GroupMember>();
    for (const m of group(w.messages(8))) tracker.apply(parseRosterMessage(KIND_RAID, m.text));
    expect([...tracker.members.keys()].sort()).toEqual(['Bumta', 'Lief']);
    expect(w.json('UncboxDB.raid.inRaid')).toBe(false);
  });
});

describe('ready checks', () => {
  it('records who was ready, not ready and away', () => {
    const w = raidWorld(6);
    w.run('__world.raid[6].online = false');
    w.login();
    w.messages(10);
    w.fire('READY_CHECK', 'Lief', 30);
    w.fire('READY_CHECK_CONFIRM', 'raid2', true);
    w.fire('READY_CHECK_CONFIRM', 'raid3', false);
    w.run('__world.readyStatus.raid4 = "ready"'); // the game knows about raid4 though we missed the event
    w.advance(30);
    w.fire('READY_CHECK_FINISHED', false);
    const got = kinds(w.messages(3), KIND_RAID_EVENTS).flatMap((m) => parseRaidEvents(m.text));
    expect(got).toEqual([
      { tag: 'readycheck', t: expect.any(Number), initiator: 'Lief' },
      { tag: 'readycheck_done', t: expect.any(Number), initiator: 'Lief', ready: ['Lief', 'Raider02', 'Raider04'], notReady: ['Raider03'], afk: ['Raider05'] },
    ]);
    const saved = w.json<{ ready: string[]; notReady: string[]; afk: string[]; initiator: string }[]>('UncboxDB.readyChecks');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ initiator: 'Lief', notReady: ['Raider03'], afk: ['Raider05'] });
    // The start and end carry the same time, which is how Uncbox matches them up.
    expect((got[0] as { t: number }).t).toBe((got[1] as { t: number }).t);
  });
});

describe('raids, boss fights, loot and attendance', () => {
  const news = (list: Message[]) => kinds(list, KIND_RAID_EVENTS).flatMap((m) => parseRaidEvents(m.text));

  function enter(w: World) {
    w.run(MC);
    w.fire('PLAYER_ENTERING_WORLD');
    return news(w.messages(5));
  }

  it('starts a raid when you zone into a raid instance in a group, with who is there', () => {
    const w = raidWorld(10);
    w.login();
    w.messages(10);
    const got = enter(w);
    const start = got.find((e) => e.tag === 'raid');
    expect(start).toMatchObject({ tag: 'raid', zone: 'Molten Core', instanceId: 409, endT: null, size: 40 });
    const snap = got.find((e) => e.tag === 'attendance');
    expect(snap).toMatchObject({ tag: 'attendance', kind: 'start', raid: (start as { id: number }).id });
    expect((snap as { names: string[] }).names).toHaveLength(10);
    expect(w.json('#UncboxDB.raids')).toBe(1);
  });

  it('does not start one in an instance when you are alone, or outside', () => {
    const w = new World();
    w.login();
    w.run(MC);
    w.fire('PLAYER_ENTERING_WORLD');
    expect(news(w.messages(5))).toEqual([]);
    expect(w.json('UncboxDB.raids')).toEqual([]);
  });

  it('records a boss kill and snapshots who was there', () => {
    const w = raidWorld(10);
    w.login();
    w.messages(5);
    enter(w);
    w.fire('ENCOUNTER_START', 663, 'Lucifron', 9, 40);
    w.advance(120);
    w.run('__world.raid[4].online = false');
    w.fire('ENCOUNTER_END', 663, 'Lucifron', 9, 40, 1);
    const got = news(w.messages(5));
    const fights = got.filter((e) => e.tag === 'encounter');
    expect(fights).toMatchObject([
      { id: 663, name: 'Lucifron', difficulty: 9, size: 40, success: null, endT: null },
      { id: 663, name: 'Lucifron', success: true, endT: expect.any(Number) },
    ]);
    // Same start time in both, so Uncbox merges them.
    expect((fights[0] as { t: number }).t).toBe((fights[1] as { t: number }).t);
    const boss = got.find((e) => e.tag === 'attendance') as { kind: string; boss: string; names: string[] };
    expect(boss.kind).toBe('boss');
    expect(boss.boss).toBe('Lucifron');
    expect(boss.names).toHaveLength(9);
    expect(boss.names).not.toContain('Raider04');
    const saved = w.json<{ bosses: { name: string; success: boolean }[]; snapshots: { kind: string }[] }>('UncboxDB.raids[1]');
    expect(saved.bosses).toMatchObject([{ name: 'Lucifron', success: true }]);
    expect(saved.snapshots.map((s) => s.kind)).toEqual(['start', 'boss']);
  });

  it('records a wipe as a try that did not succeed', () => {
    const w = raidWorld(10);
    w.login();
    w.messages(5);
    enter(w);
    w.fire('ENCOUNTER_START', 664, 'Magmadar', 9, 40);
    w.advance(30);
    w.fire('ENCOUNTER_END', 664, 'Magmadar', 9, 40, 0);
    const fights = news(w.messages(3)).filter((e) => e.tag === 'encounter');
    expect(fights[1]).toMatchObject({ success: false });
    expect(w.json('#UncboxDB.raids[1].snapshots')).toBe(1);
  });

  it('copes with a game that has no encounter events, using BOSS_KILL', () => {
    const w = raidWorld(10);
    w.run('__missingEvents.ENCOUNTER_START = true; __missingEvents.ENCOUNTER_END = true');
    w.login();
    w.messages(5);
    enter(w);
    w.fire('BOSS_KILL', 666, 'Gehennas');
    const got = news(w.messages(3));
    expect(got.filter((e) => e.tag === 'encounter')).toMatchObject([{ id: 666, name: 'Gehennas', success: true }]);
    // And a game that has both counts a kill once.
    const both = raidWorld(10);
    both.login();
    both.messages(5);
    enter(both);
    both.fire('ENCOUNTER_END', 667, 'Garr', 9, 40, 1);
    both.fire('BOSS_KILL', 667, 'Garr');
    expect(news(both.messages(3)).filter((e) => e.tag === 'encounter')).toHaveLength(1);
  });

  it('takes a snapshot every 15 minutes inside the raid', () => {
    const w = raidWorld(10);
    w.login();
    w.messages(5);
    enter(w);
    const later = news(w.messages(16 * 60)).filter((e) => e.tag === 'attendance');
    expect(later).toMatchObject([{ kind: 'timer' }]);
    expect(w.json('#UncboxDB.raids[1].snapshots')).toBe(2);
  });

  // Runs the addon in Lua through two whole raids; about 6 s on a busy PC, over the 5 s default.
  it('ends the raid when you leave, and carries on the same record if you come back', () => {
    const w = raidWorld(10);
    w.login();
    w.messages(5);
    const id = (enter(w).find((e) => e.tag === 'raid') as { id: number }).id;
    w.run('__world.instance = nil');
    w.fire('ZONE_CHANGED_NEW_AREA');
    const left = news(w.messages(5)).find((e) => e.tag === 'raid') as { id: number; endT: number };
    expect(left).toMatchObject({ id, endT: expect.any(Number) });
    w.advance(600);
    w.run(MC);
    w.fire('ZONE_CHANGED_NEW_AREA');
    const back = news(w.messages(5)).find((e) => e.tag === 'raid');
    expect(back).toMatchObject({ id, endT: null });
    expect(w.json('#UncboxDB.raids')).toBe(1);
    // A different day is a different raid.
    w.run('__world.instance = nil');
    w.fire('ZONE_CHANGED_NEW_AREA');
    w.advance(3600);
    w.run(MC);
    w.fire('ZONE_CHANGED_NEW_AREA');
    w.advance(1);
    expect(w.json('#UncboxDB.raids')).toBe(2);
  }, 30_000);

  it('carries on the raid after a /reload', () => {
    const w = raidWorld(10);
    w.login();
    w.messages(5);
    const id = (enter(w).find((e) => e.tag === 'raid') as { id: number }).id;
    // A reload keeps UncboxDB and loses everything else.
    const saved = w.json<unknown>('UncboxDB');
    const again = raidWorld(10);
    again.run(`${MC}; UncboxDB = ${lit(saved)}`);
    again.login();
    again.fire('PLAYER_ENTERING_WORLD');
    again.advance(5);
    expect(again.json('#UncboxDB.raids')).toBe(1);
    expect(again.json('UncboxDB.raids[1].id')).toBe(id);
  });

  describe('loot', () => {
    const EPIC = '|cffa335ee|Hitem:16922::::::::60:::::|h[Leggings of Transcendence]|h|r';
    const RARE = '|cff0070dd|Hitem:16800::::::::60:::::|h[Arcanist Boots]|h|r';
    const GREEN = '|cff1eff00|Hitem:2589::::::::60:::::|h[Linen Cloth]|h|r';
    const GRAY = '|cff9d9d9d|Hitem:1::::::::60:::::|h[Junk]|h|r';
    const loot = (w: World, text: string) => {
      w.fire('CHAT_MSG_LOOT', text);
      return news(w.messages(3)).filter((e) => e.tag === 'loot');
    };

    it('reads who got what, and from which boss', () => {
      const w = raidWorld(10);
      w.login();
      w.messages(5);
      enter(w);
      w.fire('ENCOUNTER_END', 663, 'Lucifron', 9, 40, 1);
      w.messages(1);
      expect(loot(w, `Raider03 receives loot: ${EPIC}.`)).toMatchObject([
        { who: 'Raider03', itemId: 16922, name: 'Leggings of Transcendence', quality: 4, count: 1, boss: 'Lucifron', raid: expect.any(Number) },
      ]);
      expect(loot(w, `You receive loot: ${RARE}.`)).toMatchObject([{ who: 'Lief', itemId: 16800, quality: 3 }]);
      expect(loot(w, `Raider04 receives loot: ${GREEN}x4.`)).toMatchObject([{ who: 'Raider04', itemId: 2589, count: 4, quality: 2 }]);
      expect(loot(w, `You receive loot: ${GREEN}x12.`)).toMatchObject([{ who: 'Lief', count: 12 }]);
      const saved = w.json<{ who: string; itemId: number }[]>('UncboxDB.raids[1].loot');
      expect(saved.map((l) => l.who)).toEqual(['Raider03', 'Lief', 'Raider04', 'Lief']);
    });

    it('skips cheap items, loot outside a raid, and other messages', () => {
      const w = raidWorld(10);
      w.login();
      w.messages(5);
      enter(w);
      expect(loot(w, `Raider03 receives loot: ${GRAY}.`)).toEqual([]);
      expect(loot(w, 'Raider03 is now Away.')).toEqual([]);
      w.run('__world.raid = nil; __world.party = { { name = "Bumta", class = "WARRIOR", level = 22 } }');
      expect(loot(w, `Bumta receives loot: ${EPIC}.`)).toEqual([]);
    });

    it('forgets the boss after ten minutes, and takes its minimum quality from the settings', () => {
      const w = raidWorld(10, '{ lootMinQuality = 4 }');
      w.login();
      w.messages(5);
      enter(w);
      w.fire('ENCOUNTER_END', 663, 'Lucifron', 9, 40, 1);
      w.advance(11 * 60);
      expect(loot(w, `Raider03 receives loot: ${EPIC}.`)).toMatchObject([{ boss: '' }]);
      expect(loot(w, `Raider03 receives loot: ${RARE}.`)).toEqual([]);
    });

    it('is off when the loot module is off', () => {
      const w = raidWorld(10, '{ modules = { loot = false } }');
      w.login();
      w.messages(5);
      enter(w);
      expect(loot(w, `Raider03 receives loot: ${EPIC}.`)).toEqual([]);
    });
  });

  it('keeps only the last 30 raids', () => {
    const w = raidWorld(3);
    w.login();
    for (let i = 0; i < 32; i++) {
      w.run(MC);
      w.fire('ZONE_CHANGED_NEW_AREA');
      w.advance(1);
      w.run('__world.instance = nil');
      w.fire('ZONE_CHANGED_NEW_AREA');
      w.advance(1);
      w.run('__epoch = __epoch + 7200');
    }
    expect(w.json('#UncboxDB.raids')).toBe(30);
  });
});

describe('settings from UncboxConfig.lua', () => {
  it('puts the strip in the chosen corner', () => {
    const w = new World('{ strip = { corner = "TOPRIGHT" } }');
    w.login();
    expect(w.json('UncboxStrip.__point[1]')).toBe('TOPRIGHT');
    const left = new World();
    left.login();
    expect(left.json('UncboxStrip.__point[1]')).toBe('TOPLEFT');
  });

  it('shows nothing while the strip is switched off, and collects nothing for a module that is off', () => {
    const off = guildWorld(3, '{ strip = { enabled = false } }');
    off.login();
    expect(off.messages(5)).toEqual([]);

    const chars = new World('{ modules = { character = false, quests = false, party = false, guild = false, raid = false, loot = false } }');
    chars.login();
    expect(chars.messages(5)).toEqual([]);
  });

  it('uses defaults for anything missing', () => {
    const w = new World('{ modules = { raid = false } }');
    expect(w.json('UncboxUtil.config()')).toEqual({
      strip: { enabled: true, corner: 'TOPLEFT' },
      modules: { character: true, quests: true, party: true, guild: true, raid: false, loot: true },
      lootMinQuality: 2,
    });
  });
});

describe('the strip', () => {
  it('stays quiet when nothing is going on', () => {
    const w = guildWorld(3);
    w.login();
    w.messages(60);
    expect(w.messages(20)).toEqual([]);
    expect(w.json('UncboxStrip.__shown')).toBe(false);
  });

  it('does not queue anything while the player has switched the strip off with /uncbox', () => {
    const w = guildWorld(3);
    w.login();
    w.messages(30);
    w.run('SlashCmdList.UNCBOX("")');
    w.run('UncboxGuild.addEvent("join", "Ghost")');
    expect(w.messages(5)).toEqual([]);
    w.run('SlashCmdList.UNCBOX("")');
    const back = w.messages(20);
    // Back on, everything is sent again from the start.
    expect(kinds(back, KIND_GUILD).some((m) => m.text.startsWith('R'))).toBe(true);
  });
});
