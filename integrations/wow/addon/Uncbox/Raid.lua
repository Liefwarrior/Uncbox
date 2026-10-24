-- Your raid or party and what happens to it: who's in it, ready checks, boss fights, loot, and who
-- was there (a snapshot of the group at each boss kill and every 15 minutes inside a raid).
--
-- Over the strip: the group (kind 6, the pieces from Sync.lua) and raid news (kind 7). In
-- SavedVariables: UncboxDB.raid (the group now), UncboxDB.raids (the last 30 raids with their
-- bosses, snapshots, loot and master looter) and UncboxDB.readyChecks (the last 40).
--
-- Kind 6 M records: name, class, level, subgroup, rank (0 member, 1 assist, 2 leader), role (T main
-- tank, A main assist, or empty), online (1/0), dead (1/0), zone, master looter (1/0).
-- Kind 7 records, one per message; the first field says what it is. A raid's id is the time it
-- started, and every record after the first names it:
--   Z id zone instanceId endTime size lootMethod masterLooter   a raid started, ended (endTime) or changed
--   A time raid kind boss names                                  who was there (kind: start, boss, timer)
--   E time raid encounterId name difficulty size success endTime a boss fight (success: empty, 1 or 0)
--   L time raid who itemId name quality count boss               loot
--   C time initiator                                             a ready check started
--   F time initiator ready notReady afk                          it finished (names split by commas)

local C, U, O, S = UncboxCodec, UncboxUtil, UncboxOutbox, UncboxSync
local FIELD = U.FIELD

local RAID_CAP = 30
local READY_CAP = 40
local LOOT_CAP = 300
local SNAPSHOT_CAP = 40
local GROUP_EVERY = 3 -- seconds between looks at the group
local FULL_EVERY = 300 -- seconds between full syncs of the group
local SNAPSHOT_EVERY = 900 -- who's in the raid, every 15 minutes
local RESUME_WITHIN = 1800 -- coming back to the same raid within this long is still the same raid
local BOSS_MEMORY = 600 -- loot this soon after a kill is from that boss

local R = { members = {}, sync = S.new(C.KIND_RAID), run = nil, started = false }
local forceFull = true
local hadGroup = false
local signature = nil
local debouncing = false
local readyCheck = nil
local lastBoss = nil
local lootMatchers = {}

local function db()
  UncboxDB = UncboxDB or {}
  UncboxDB.raids = UncboxDB.raids or {}
  UncboxDB.readyChecks = UncboxDB.readyChecks or {}
  return UncboxDB
end

local function after(seconds, fn)
  if C_Timer and C_Timer.After then
    C_Timer.After(seconds, fn)
  else
    fn()
  end
end

local function send(...)
  local parts = { ... }
  for i = 1, #parts do
    parts[i] = U.clean(parts[i])
  end
  O.push(C.KIND_RAID_EVENTS, table.concat(parts, FIELD))
end

local function inRaid()
  if IsInRaid then
    return IsInRaid()
  end
  return GetNumRaidMembers and GetNumRaidMembers() > 0
end

local function inGroup()
  if IsInGroup then
    return IsInGroup()
  end
  return inRaid() or (GetNumPartyMembers and GetNumPartyMembers() > 0)
end

local function assignment(kind, unit)
  if not GetPartyAssignment then
    return false
  end
  local ok, yes = pcall(GetPartyAssignment, kind, unit)
  return ok and yes and true or false
end

-- ---- the group ----

-- Everyone in your raid or party as a list of tables, you first in a party; empty when you're alone.
function R.collect()
  local list = {}
  if inRaid() then
    local n = GetNumGroupMembers and GetNumGroupMembers() or GetNumRaidMembers()
    for i = 1, n do
      local name, rank, subgroup, level, _, fileName, zone, online, isDead, role, isML = GetRaidRosterInfo(i)
      if name then
        local unit = "raid" .. i
        local assigned = ""
        if role == "MAINTANK" or assignment("MAINTANK", unit) then
          assigned = "T"
        elseif role == "MAINASSIST" or assignment("MAINASSIST", unit) then
          assigned = "A"
        end
        list[#list + 1] = {
          name = U.shortName(name),
          class = fileName or "",
          level = level or 0,
          subgroup = subgroup or 1,
          rank = rank or 0,
          role = assigned,
          online = online and true or false,
          dead = isDead and true or false,
          zone = zone or "",
          masterLooter = isML and true or false,
          unit = unit,
        }
      end
    end
  elseif inGroup() then
    local leader = UnitIsGroupLeader or UnitIsPartyLeader
    for _, unit in ipairs({ "player", "party1", "party2", "party3", "party4" }) do
      if UnitExists(unit) then
        local _, token = UnitClass(unit)
        list[#list + 1] = {
          name = U.shortName(UnitName(unit)),
          class = token or "",
          level = UnitLevel(unit) or 0,
          subgroup = 1,
          rank = leader and leader(unit) and 2 or 0,
          role = "",
          online = UnitIsConnected(unit) and true or false,
          dead = UnitIsDeadOrGhost(unit) and true or false,
          zone = "",
          masterLooter = false,
          unit = unit,
        }
      end
    end
  end
  return list
end

local function stripRecord(m)
  return table.concat({
    U.clean(m.name),
    U.clean(m.class),
    U.num(m.level),
    U.num(m.subgroup),
    U.num(m.rank),
    m.role,
    m.online and "1" or "0",
    m.dead and "1" or "0",
    U.clean(m.zone),
    m.masterLooter and "1" or "0",
  }, FIELD)
end

-- Names of the people in the group who are online right now, sorted.
local function presentNames()
  local names = {}
  for _, m in ipairs(R.collect()) do
    if m.online then
      names[#names + 1] = m.name
    end
  end
  table.sort(names)
  return names
end

local function lootMethod()
  if not GetLootMethod then
    return "", ""
  end
  local method, partyMaster, raidMaster = GetLootMethod()
  local who = ""
  if method == "master" then
    if raidMaster and raidMaster > 0 and GetRaidRosterInfo then
      who = U.shortName((GetRaidRosterInfo(raidMaster)))
    elseif partyMaster == 0 then
      who = U.shortName(UnitName("player"))
    elseif partyMaster then
      who = U.shortName(UnitName("party" .. partyMaster))
    end
  end
  return method or "", who or ""
end

-- ---- the raid you're in ----

local function sendRun(run)
  send("Z", U.num(run.id), run.zone, U.num(run.instanceId), run.endT and U.num(run.endT) or "", U.num(run.size), run.lootMethod or "", run.masterLooter or "")
end

-- Takes a snapshot of who is in the raid: at its start, at each boss kill, and every 15 minutes.
function R.snapshot(kind, boss)
  local run = R.run
  if not run or run.endT then
    return
  end
  local snap = { t = U.now(), kind = kind, boss = boss or "", names = presentNames() }
  run.lastSnap = snap.t
  U.push(run.snapshots, snap, SNAPSHOT_CAP)
  send("A", U.num(snap.t), U.num(run.id), kind, snap.boss, table.concat(snap.names, ","))
end

local function startRun(name, instanceId, size)
  local raids = db().raids
  local last = raids[#raids]
  local at = U.now()
  -- Coming back to the same raid (a /reload, a release run) carries on its record.
  local lastAt = last and (last.endT or last.lastSnap or last.startT) or 0
  if last and last.instanceId == instanceId and last.zone == name and at - lastAt <= RESUME_WITHIN then
    last.endT = nil
    R.run = last
    sendRun(last)
    return
  end
  local run = { id = at, zone = name, instanceId = instanceId, size = size, startT = at, bosses = {}, snapshots = {}, loot = {} }
  run.lootMethod, run.masterLooter = lootMethod()
  U.push(raids, run, RAID_CAP)
  R.run = run
  sendRun(run)
  R.snapshot("start")
end

local function endRun()
  local run = R.run
  if not run then
    return
  end
  run.endT = U.now()
  R.run = nil
  sendRun(run)
end

-- Starts or ends the raid record as you walk into and out of a raid instance with a group.
function R.checkRun()
  local inInstance, kind = false, nil
  if IsInInstance then
    inInstance, kind = IsInInstance()
  end
  if inInstance and kind == "raid" and inGroup() then
    local name, _, _, _, maxPlayers, _, _, instanceId = GetInstanceInfo()
    if not R.run then
      startRun(name or "", instanceId or 0, maxPlayers or 0)
    else
      local method, who = lootMethod()
      if method ~= R.run.lootMethod or who ~= R.run.masterLooter then
        R.run.lootMethod, R.run.masterLooter = method, who
        sendRun(R.run)
      end
    end
  elseif R.run then
    endRun()
  end
end

-- ---- refreshing the group ----

function R.refresh()
  local list = R.collect()
  local byName, items, recs = {}, {}, {}
  for _, m in ipairs(list) do
    byName[m.name] = m
    local rec = stripRecord(m)
    items[#items + 1] = { key = m.name, rec = rec }
    recs[#recs + 1] = rec
  end
  R.members = byName
  local grouped = #list > 0
  local force = forceFull or (grouped and not hadGroup)
  forceFull, hadGroup = false, grouped
  R.sync:update(items, force)
  local sig = table.concat(recs, "\30")
  if sig ~= signature then
    signature = sig
    local saved = {}
    for i, m in ipairs(list) do
      saved[i] = {
        name = m.name,
        class = m.class,
        level = m.level,
        subgroup = m.subgroup,
        rank = m.rank,
        role = m.role,
        online = m.online,
        dead = m.dead,
        zone = m.zone,
        masterLooter = m.masterLooter,
      }
    end
    db().raid = { t = U.now(), inRaid = inRaid() and true or false, members = saved }
  end
  R.checkRun()
end

local function scheduleRefresh()
  if debouncing then
    return
  end
  debouncing = true
  after(0.5, function()
    debouncing = false
    R.refresh()
  end)
end

function R.syncNow()
  forceFull = true
  R.sync:reset()
  R.refresh()
end

-- ---- ready checks ----

local function nameOf(unit)
  return U.shortName((UnitName(unit)))
end

local function startReadyCheck(initiator)
  R.refresh()
  local who = U.shortName(initiator)
  readyCheck = { t = U.now(), initiator = who, answers = {} }
  readyCheck.answers[who] = true
  send("C", U.num(readyCheck.t), who)
end

local function answerReadyCheck(unit, isReady)
  if readyCheck and unit then
    local name = nameOf(unit)
    if name ~= "" then
      readyCheck.answers[name] = (isReady == true or isReady == 1)
    end
  end
end

local function finishReadyCheck()
  local rc = readyCheck
  readyCheck = nil
  if not rc then
    return
  end
  local ready, notReady, afk = {}, {}, {}
  for _, m in ipairs(R.collect()) do
    local name = m.name
    local answer = rc.answers[name]
    if answer == nil and GetReadyCheckStatus and m.unit then
      local status = GetReadyCheckStatus(m.unit)
      if status == "ready" then
        answer = true
      elseif status == "notready" then
        answer = false
      end
    end
    if answer == true then
      ready[#ready + 1] = name
    elseif answer == false then
      notReady[#notReady + 1] = name
    elseif m.online then
      afk[#afk + 1] = name
    end
  end
  table.sort(ready)
  table.sort(notReady)
  table.sort(afk)
  local record = { t = rc.t, initiator = rc.initiator, ready = ready, notReady = notReady, afk = afk }
  U.push(db().readyChecks, record, READY_CAP)
  send("F", U.num(rc.t), rc.initiator, table.concat(ready, ","), table.concat(notReady, ","), table.concat(afk, ","))
end

-- ---- boss fights ----

local function sendFight(raidId, f)
  send(
    "E",
    U.num(f.t),
    U.num(raidId),
    U.num(f.id),
    f.name,
    U.num(f.difficulty),
    U.num(f.size),
    f.success == nil and "" or (f.success and "1" or "0"),
    f.endT and U.num(f.endT) or ""
  )
end

local fight = nil

local function startFight(id, name, difficulty, size)
  if not R.run then
    return
  end
  fight = { t = U.now(), id = id, name = name or "", difficulty = difficulty or 0, size = size or 0 }
  sendFight(R.run.id, fight)
end

local function endFight(id, name, difficulty, size, success)
  local run = R.run
  if not run then
    return
  end
  local won = (success == 1 or success == true)
  if won and lastBoss and lastBoss.id == id and U.now() - lastBoss.t <= 10 then
    return
  end
  local f = fight
  if not f or f.id ~= id then
    f = { t = U.now(), id = id, name = name or "", difficulty = difficulty or 0, size = size or 0 }
  end
  fight = nil
  f.endT, f.success = U.now(), won
  U.push(run.bosses, { t = f.t, endT = f.endT, id = f.id, name = f.name, difficulty = f.difficulty, size = f.size, success = f.success }, 60)
  sendFight(run.id, f)
  if f.success then
    lastBoss = { name = f.name, id = f.id, t = f.endT }
    R.snapshot("boss", f.name)
  end
end

-- BOSS_KILL, where the game has no ENCOUNTER_END: endFight skips a kill it already has.
local function bossKill(id, name)
  endFight(id, name, 0, 0, true)
end

-- ---- loot ----

local function buildLootMatchers()
  lootMatchers = {}
  -- Multiples first: "x2" would otherwise end up inside the item.
  local defs = {
    { "LOOT_ITEM_SELF_MULTIPLE", 0, 1, 2 },
    { "LOOT_ITEM_SELF", 0, 1, 0 },
    { "LOOT_ITEM_MULTIPLE", 1, 2, 3 },
    { "LOOT_ITEM", 1, 2, 0 },
  }
  for _, d in ipairs(defs) do
    local m = U.matcher(_G[d[1]])
    if m then
      m.who, m.item, m.count = d[2], d[3], d[4]
      lootMatchers[#lootMatchers + 1] = m
    end
  end
end

-- A loot message: who got which item. Returns the record if it was kept.
function R.loot(text)
  if not inRaid() then
    return nil
  end
  for _, m in ipairs(lootMatchers) do
    local a = U.match(m, text)
    if a then
      local id, name, quality = U.itemFromLink(a[m.item])
      if not id then
        return nil
      end
      if quality < U.config().lootMinQuality then
        return nil
      end
      local who = m.who == 0 and nameOf("player") or U.shortName(a[m.who])
      local boss = ""
      if lastBoss and U.now() - lastBoss.t <= BOSS_MEMORY then
        boss = lastBoss.name
      end
      local run = R.run
      local rec = {
        t = U.now(),
        raid = run and run.id or 0,
        who = who,
        itemId = id,
        name = name,
        quality = quality,
        count = m.count > 0 and tonumber(a[m.count]) or 1,
        boss = boss,
      }
      if run then
        U.push(run.loot, rec, LOOT_CAP)
      else
        UncboxDB.looseLoot = UncboxDB.looseLoot or {}
        U.push(UncboxDB.looseLoot, rec, LOOT_CAP)
      end
      send("L", U.num(rec.t), U.num(rec.raid), who, U.num(id), name, U.num(quality), U.num(rec.count), boss)
      return rec
    end
  end
  return nil
end

-- ---- starting up ----

function R.start(config)
  if R.started then
    return
  end
  R.started = true
  local f = CreateFrame("Frame")
  if config.modules.raid then
    local events = {
      "GROUP_ROSTER_UPDATE",
      "RAID_ROSTER_UPDATE",
      "PARTY_LEADER_CHANGED",
      "PLAYER_ENTERING_WORLD",
      "ZONE_CHANGED_NEW_AREA",
      "PARTY_LOOT_METHOD_CHANGED",
      "READY_CHECK",
      "READY_CHECK_CONFIRM",
      "READY_CHECK_FINISHED",
      "ENCOUNTER_START",
      "ENCOUNTER_END",
      "BOSS_KILL",
    }
    -- Not every version of the game has every event; a missing one is skipped.
    for _, e in ipairs(events) do
      pcall(f.RegisterEvent, f, e)
    end
  end
  if config.modules.loot then
    buildLootMatchers()
    pcall(f.RegisterEvent, f, "CHAT_MSG_LOOT")
  end
  f:SetScript("OnEvent", function(_, event, a, b, c, d, e)
    if event == "READY_CHECK" then
      startReadyCheck(a)
    elseif event == "READY_CHECK_CONFIRM" then
      answerReadyCheck(a, b)
    elseif event == "READY_CHECK_FINISHED" then
      finishReadyCheck()
    elseif event == "ENCOUNTER_START" then
      startFight(a, b, c, d)
    elseif event == "ENCOUNTER_END" then
      endFight(a, b, c, d, e)
    elseif event == "BOSS_KILL" then
      bossKill(a, b)
    elseif event == "CHAT_MSG_LOOT" then
      R.loot(a)
    else
      scheduleRefresh()
    end
  end)
  if not config.modules.raid then
    return
  end
  C_Timer.NewTicker(GROUP_EVERY, function()
    if hadGroup or inGroup() then
      R.refresh()
    end
  end)
  C_Timer.NewTicker(FULL_EVERY, function()
    forceFull = true
  end)
  C_Timer.NewTicker(30, function()
    local run = R.run
    if run and not run.endT and U.now() - (run.lastSnap or run.startT) >= SNAPSHOT_EVERY then
      R.snapshot("timer")
    end
  end)
  R.refresh()
end

UncboxRaid = R
