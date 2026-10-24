# WoW live link

In the WoW Forever preset, the Character panel, the Quest log and the Party panel fill themselves
in from the game, and Uncbox keeps a database of your guild and raids (roster, who was online,
raids with their bosses, who was there, loot, ready checks) for guild widgets to show.

WoW addons can't save files or go online while you play: the only files they write are saved when
you log out or `/reload`, and there's no network or clipboard access. So the Uncbox addon draws a
thin strip of colored blocks, 512 × 4 pixels, along the top-left (or top-right) edge of your
screen. Uncbox already captures the WoW window for the game panel, so it reads the strip from that
video and crops it out. Viewers never see it. Everything the addon collects is also saved in
`UncboxDB` when WoW saves, and Uncbox reads that file too.

The strip only shows while there's something to send: for a moment after something changes, and
briefly once a minute so a dashboard opened later catches up.

## Setup is automatic

When the WoW preset is on (and when Uncbox starts with it on), Uncbox finds WoW and installs or
updates the addon by itself if it's missing or a different version. It looks in the registry
(Battle.net's install path) and the usual folders, finds every flavor (`_classic_era_`,
`_classic_beta_`, `_classic_`, `_retail_`, `_ptr_`, and any other `_xxx_` folder with a `Wow*.exe`,
`Interface\AddOns` or `WTF` in it), and prefers WoW Forever (the beta folder) over Classic Era.
A toast says "Uncbox installed its WoW addon. Type /reload in WoW." with **Undo**, which removes it
and turns the automatic install off until you install it again. Other installs are offered under
**Get set up** ("Also install in…"). Uncbox only touches AddOns folders it found itself.

The **Get set up** list checks for you: *Game window* (WoW is picked as the game by itself in the
Uncbox app once it runs; in a browser a **Show WoW** button appears), *Addon installed* (with its
version), and *Seen in game* (the strip was read in the last 10 minutes).

If the character screen lists Uncbox as out of date, tick **Load out of date AddOns**.

### Settings

The sidebar's **WoW addon** section chooses what the addon collects (character, quests, party,
guild, raid, loot), whether the strip is on, its corner (top left or top right) and which install
to use. Uncbox writes them to `Interface\AddOns\Uncbox\UncboxConfig.lua`, which the addon loads, so
nobody edits Lua. Changes reach WoW at the next `/reload`. `/uncbox` still turns the strip off or on
in the game, and `/uncbox sync` sends everything again.

## What's live and what waits for `/reload`

| | Live over the strip | In `UncboxDB` (when WoW saves: `/reload` or logout) |
| --- | --- | --- |
| Character, quest log, party | yes | no |
| Guild roster | full sync every 10 minutes, changes as they happen | everything, with public and officer notes |
| Guild news (online, offline, join, leave, kick, promote, demote, level-up) | yes | last 500 per guild |
| Raid group (subgroup, class, rank, tank/assist, dead, online) | yes, changes within about 3 seconds | the group now |
| Ready checks, boss fights, loot, who was there | yes | last 30 raids, last 40 ready checks |
| Settings you change in Uncbox | | read on `/reload` |

Guild notes and the guild info text only come from the saved file. The strip carries each news item
with the game's own time, and so does the saved file: Uncbox counts an item once however it arrives.
If the strip can't be read (WoW not captured), the saved file fills the database in later.

## The guild link API (this PC only)

Times are milliseconds since 1970. A raid's `id` is the time it started in seconds (what `?raid=`
takes). Changes are pushed as the `wowguild` event on `/api/events`:
`{ at, what: ['guild' | 'events' | 'raid' | 'raids' | 'loot' | 'readychecks', …] }`; fetch what changed.

- `GET /api/wow/guild`: `{ available, guild: { name, motd, info, ranks, updatedAt }, members: [{ name, rankIndex, rank, level, class, zone, note, online, status: '' | 'afk' | 'dnd', lastSeen, firstSeen }], counts: { total, online, byClass: { DRUID: { total, online } }, byRank: [{ rankIndex, rank, total, online }] } }`. `?officer=1` adds `officerNote`, `?former=1` adds `former` (people who left, with `leftAt`).
- `GET /api/wow/guild/events?since=&limit=&type=`: `{ events: [{ id, at, type, name, a, b }] }`, newest first. Types: `on`, `off`, `join`, `leave`, `kick` (`b` is who), `promote`/`demote` (`a` the rank, `b` who), `level` (`a` the level).
- `GET /api/wow/guild/sessions?member=&since=&limit=`: `{ sessions: [{ name, start, end | null }] }`.
- `GET /api/wow/guild/member?name=`: `{ member, rankHistory, sessions, loot, attendance }`.
- `GET /api/wow/raid`: `{ inRaid, size, members: [{ name, class, level, subgroup, rank: 'leader' | 'assist' | 'member', role: 'tank' | 'assist' | '', online, dead, zone, masterLooter }], counts, raid: <a raid below> | null, lastReadyCheck, updatedAt }`.
- `GET /api/wow/raids?limit=`: `{ raids: [{ id, zone, instanceId, size, startedAt, endedAt | null, lootMethod, masterLooter, bosses: [{ id, name, difficulty, size, startedAt, endedAt, success }], kills, snapshots, attendees: [{ name, pct }], lootCount }] }`.
- `GET /api/wow/attendance?last=10`: `{ raids, since, members: [{ name, class, rankIndex, inGuild, attended, raids, pct, bossesAttended, bosses, lastRaidAt }] }`. In a raid someone attended if they were in at least half its snapshots (taken at the start, at each boss kill and every 15 minutes).
- `GET /api/wow/loot?member=&since=&raid=&limit=`: `{ loot: [{ id, at, raidId, who, itemId, name, quality, count, boss }] }`, newest first.
- `GET /api/wow/readychecks?limit=`: `{ readyChecks: [{ at, initiator, ready, notReady, afk, done }] }`.
- Setup: `GET /api/wow/status`, `GET`/`POST /api/wow/settings`, `POST /api/wow/install`, `/uninstall`, `/auto`, `/reveal`, `POST /api/wow/live` (what the page reads off the strip), `POST /api/wow/guild/reset` (for a new guild), `POST /api/wow/open` `{ item }` (opens that item's Wowhead page in the browser, and nothing else).

The data is in `data/wow.db` (SQLite) and the settings in `data/wow.json`. One guild is kept at a
time; saved data from a character in another guild is ignored until you reset the guild.

## Guild widgets

The WoW category of the widget library has six widgets that read this API: **Guild roster** (who is
online; search, filters, sorting; click a member for their rank history, sessions, attendance and
loot), **Guild news** (a live feed with filter chips; stream-friendly), **Raid composition** (the
raid by group with roles, buffs, who is down and the last ready check), **Raid attendance** (members
against the last raids, with Export CSV), **Raid loot** (history, "Fair share", Export CSV, items
open on Wowhead) and **Guild goals** (bosses killed per raid). Each refetches on the `wowguild` event and gently once a minute while the page shows. In stream
mode (F8) officer notes never show, public notes only with "Show notes on stream", and the attendance and loot widgets show
"Member 1", "Member 2"… instead of names unless "Show names on stream" is on. The palette has
"WoW: raid attendance" and "WoW: find member <name>".

## Good to know

- It's made for WoW Forever (Interface 16001) and also loads in Classic Era.
- The strip has to be visible on screen when it shows: keep other windows and addon frames off the
  top corner. Alt+Z doesn't hide it.
- The addon turns on "show offline members" in the guild window so the roster is complete.
- Level-ups and guild news are read from the game's own message texts, so they work in any
  language. Boss fights need the game to send `ENCOUNTER_START`/`ENCOUNTER_END` (or `BOSS_KILL`).
- The Party panel lists you and up to four others (your raid group, in a raid).
- Quests under a collapsed header in your quest log may be skipped.
- It works through a capture card too, as long as the picture isn't scaled down too far.

## What's in here

| File | What it does |
| --- | --- |
| `addon/Uncbox/` | The addon: `Codec.lua` (text to blocks), `Util.lua`, `Outbox.lua` (news queue), `Sync.lua` (roster full syncs and changes), `Guild.lua`, `Raid.lua`, `Uncbox.lua` (collects the basics and draws), `UncboxConfig.lua` (settings Uncbox writes). |
| `codec.ts`, `parse.ts`, `messages.mjs` | The same codec in TypeScript, and the readers for the addon's texts (`messages.mjs` is shared with the server). |
| `useWowLink.ts` | Reads every frame of the game video (up to 60 a second), updates the dashboard and passes guild and raid news to the server. |
| `install.mjs` | Finds WoW; installs, updates and removes every addon under `addon/`; writes the settings file. |
| `savedvars.mjs` | Reads SavedVariables and writes Lua data files. |
| `addon.test.ts`, `addonWorld.ts`, `wowmock.lua` | Runs the addon's real Lua in fengari against a pretend game. |

`../../server/wow.mjs` and `wowdb.mjs` hold the routes, the SavedVariables watcher and the database.

Each page of the strip is 256 × 2 blocks of 2 × 2 pixels, so it's 512 × 4 pixels: a sync pattern,
then up to 181 bytes of text with a checksum. Kinds: 1 character, 2 quests, 3 party, 4 guild roster,
5 guild news, 6 raid group, 7 raid news. While it shows, the addon draws 20 pages a second and sends
each change three times over. A 50-person roster goes out in pieces of one page, a few every few
seconds, and afterward only changes.
