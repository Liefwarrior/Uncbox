-- Your guild: the roster (who, rank, level, class, zone, notes, online), the message of the day,
-- and the news as it happens (coming online, going offline, joining, leaving, promotions, level-ups).
--
-- Over the strip (small, live): the roster as a full sync every ten minutes and a delta whenever
-- someone changes (kind 4), and each event (kind 5). In SavedVariables (everything, when you log
-- out or /reload): UncboxDB.guilds[guild name] with every member's notes and the last 500 events.
-- Both carry the same event fields, so Uncbox can tell it has already counted one.
--
-- Kind 4 records: I name motd rank1 rank2 ...  then the roster pieces from Sync.lua, whose M
-- records are: name, rankIndex, level, class, zone, online (1/0), status (0 none, 1 AFK, 2 DND),
-- hours offline (or empty).
-- Kind 5 records: type, time, name, a, b. Types: on, off, join, leave, kick, promote, demote,
-- level. promote and demote: name was moved to rank a by b. kick: name was removed by b. level: a
-- is the new level.

local C, U, O, S = UncboxCodec, UncboxUtil, UncboxOutbox, UncboxSync
local FIELD = U.FIELD

local EVENT_CAP = 500
local ROSTER_EVERY = 60 -- seconds between asking the server for the roster
local FULL_EVERY = 600 -- seconds between full syncs over the strip
local FLUSH_AFTER = 0.5 -- events within this long share a message
local SAME_EVENT = 2 -- seconds: a repeat of the same event this soon is the game saying it twice

local G = { members = {}, sync = S.new(C.KIND_GUILD), started = false }
local forceFull = true
local lastInfo = nil
local pending, flushing, refreshing = {}, false, false
local recent = {}
local matchers = {}

-- What is saved about this guild. UncboxDB is shared by all your characters, so each guild has its own.
local function store()
  UncboxDB = UncboxDB or {}
  UncboxDB.guilds = UncboxDB.guilds or {}
  if not G.name or G.name == "" then
    G.name = GetGuildInfo and GetGuildInfo("player") or ""
  end
  local s = UncboxDB.guilds[G.name]
  if not s then
    s = { name = G.name, events = {} }
    UncboxDB.guilds[G.name] = s
  end
  s.events = s.events or {}
  return s
end

local function after(seconds, fn)
  if C_Timer and C_Timer.After then
    C_Timer.After(seconds, fn)
  else
    fn()
  end
end

local function statusOf(s)
  if type(s) == "number" then
    return s
  end
  s = tostring(s or ""):upper()
  if s:find("AFK") then
    return 1
  elseif s:find("DND") then
    return 2
  end
  return 0
end

local function classToken(token, display)
  if token and token ~= "" then
    return token
  end
  return (tostring(display or ""):upper():gsub("%s", ""))
end

-- The guild's members as a list of tables, or nil when you're not in a guild.
function G.collect()
  if not IsInGuild or not IsInGuild() then
    return nil
  end
  local list = {}
  local now = U.now()
  local canOfficer = not CanViewOfficerNote or CanViewOfficerNote()
  for i = 1, (GetNumGuildMembers and GetNumGuildMembers() or 0) do
    local fullName, rank, rankIndex, level, classDisplay, zone, note, officerNote, online, status, classFile = GetGuildRosterInfo(i)
    if fullName then
      local m = {
        name = U.shortName(fullName),
        rank = rank or "",
        rankIndex = rankIndex or 0,
        level = level or 0,
        class = classToken(classFile, classDisplay),
        zone = zone or "",
        note = note or "",
        officerNote = canOfficer and officerNote or "",
        online = online and true or false,
        status = statusOf(status),
      }
      if m.online then
        m.lastOnline = now
      elseif GetGuildRosterLastOnline then
        local years, months, days, hours = GetGuildRosterLastOnline(i)
        if years then
          m.hours = (((years * 12 + (months or 0)) * 30 + (days or 0)) * 24) + (hours or 0)
          m.lastOnline = now - m.hours * 3600
        end
      end
      list[#list + 1] = m
    end
  end
  return list
end

-- Rank names in order, Guild Master first.
local function rankNames(list)
  local names = {}
  if GuildControlGetNumRanks and GuildControlGetRankName then
    for i = 1, GuildControlGetNumRanks() do
      names[i] = GuildControlGetRankName(i) or ""
    end
  end
  if #names == 0 then
    for _, m in ipairs(list) do
      names[m.rankIndex + 1] = m.rank
    end
    for i = 1, #names do
      names[i] = names[i] or ""
    end
  end
  return names
end

local function stripRecord(m)
  return table.concat({
    U.clean(m.name),
    U.num(m.rankIndex),
    U.num(m.level),
    U.clean(m.class),
    U.clean(m.zone),
    m.online and "1" or "0",
    U.num(m.status),
    m.hours and U.num(m.hours) or "",
  }, FIELD)
end

local function trim(s, n)
  s = U.clean(s)
  return #s > n and s:sub(1, n) or s
end

-- ---- events ----

local function flush()
  flushing = false
  local records = {}
  for _, ev in ipairs(pending) do
    records[#records + 1] = table.concat({ ev.type, U.num(ev.t), U.clean(ev.name), U.clean(ev.a), U.clean(ev.b) }, FIELD)
  end
  pending = {}
  for _, piece in ipairs(S.pack(records, "")) do
    if #piece > 0 then
      O.push(C.KIND_GUILD_EVENTS, table.concat(piece, U.RECORD))
    end
  end
end

local function addEvent(kind, name, a, b)
  if name == nil or name == "" then
    return
  end
  local key = kind .. "\31" .. name
  local at = U.now()
  if recent[key] and at - recent[key] < SAME_EVENT then
    return
  end
  recent[key] = at
  local ev = { t = at, type = kind, name = name, a = a and tostring(a) or "", b = b and tostring(b) or "" }
  U.push(store().events, ev, EVENT_CAP)
  pending[#pending + 1] = ev
  if not flushing then
    flushing = true
    after(FLUSH_AFTER, flush)
  end
  return ev
end

G.addEvent = addEvent

-- Asks the game for a fresh roster. Both names exist in some version of Classic.
function G.request()
  if C_GuildInfo and C_GuildInfo.GuildRoster then
    C_GuildInfo.GuildRoster()
  elseif GuildRoster then
    GuildRoster()
  end
end

local function buildMatchers()
  matchers = {}
  local defs = {
    { "on", "ERR_FRIEND_ONLINE_SS" },
    { "off", "ERR_FRIEND_OFFLINE_S" },
    { "join", "ERR_GUILD_JOIN_S" },
    { "leave", "ERR_GUILD_LEAVE_S" },
    { "kick", "ERR_GUILD_REMOVE_SS" },
    { "promote", "ERR_GUILD_PROMOTE_SSS" },
    { "demote", "ERR_GUILD_DEMOTE_SSS" },
  }
  for _, d in ipairs(defs) do
    local m = U.matcher(_G[d[2]])
    if m then
      m.type = d[1]
      matchers[#matchers + 1] = m
    end
  end
end

-- A system message, looked at for guild news. Returns the event if it was one.
function G.system(text)
  for _, m in ipairs(matchers) do
    local a = U.match(m, text)
    if a then
      local kind = m.type
      if kind == "on" or kind == "off" then
        -- Friends coming online say the same thing: only guild members count.
        local name = U.shortName(kind == "on" and (a[2] or a[1]) or a[1])
        if G.members[name] then
          return addEvent(kind, name)
        end
        return nil
      elseif kind == "join" or kind == "leave" then
        G.request()
        return addEvent(kind, U.shortName(a[1]))
      elseif kind == "kick" then
        G.request()
        return addEvent(kind, U.shortName(a[1]), "", U.shortName(a[2]))
      else
        -- promote/demote: actor, target, rank name.
        return addEvent(kind, U.shortName(a[2]), a[3], U.shortName(a[1]))
      end
    end
  end
  return nil
end

-- ---- roster ----

-- Reads the roster, tells the strip what changed and keeps the full copy for SavedVariables.
function G.refresh()
  local list = G.collect()
  if not list then
    return
  end
  local known = {}
  for _, m in ipairs(list) do
    known[m.name] = m
  end
  -- The game announces other news but not level-ups: see them in the roster.
  if G.loaded then
    for _, m in ipairs(list) do
      local before = G.members[m.name]
      if before and before.level > 0 and m.level > before.level then
        addEvent("level", m.name, m.level)
      end
    end
  end
  G.members, G.loaded = known, true

  local name = GetGuildInfo and GetGuildInfo("player") or nil
  local ranks = rankNames(list)
  local motd = GetGuildRosterMOTD and GetGuildRosterMOTD() or ""
  local online = 0
  for _, m in ipairs(list) do
    if m.online then
      online = online + 1
    end
  end
  G.name = name or G.name or ""
  local saved = store()
  saved.name = G.name
  saved.motd = motd or ""
  saved.info = GetGuildInfoText and GetGuildInfoText() or ""
  saved.ranks = ranks
  saved.members = list
  saved.count = #list
  saved.online = online
  saved.savedAt = U.now()

  local info = { "I", trim(name, 40), trim(motd, 180) }
  for _, r in ipairs(ranks) do
    info[#info + 1] = trim(r, 24)
  end
  local infoText = table.concat(info, FIELD)
  if infoText ~= lastInfo or forceFull then
    lastInfo = infoText
    O.push(C.KIND_GUILD, infoText)
  end

  local items = {}
  for _, m in ipairs(list) do
    items[#items + 1] = { key = m.name, rec = stripRecord(m) }
  end
  local force = forceFull
  forceFull = false
  G.sync:update(items, force)
end

local function scheduleRefresh()
  if refreshing then
    return
  end
  refreshing = true
  after(1, function()
    refreshing = false
    G.refresh()
  end)
end

-- /uncbox sync: send the whole roster again.
function G.syncNow()
  forceFull = true
  G.sync:reset()
  G.request()
  G.refresh()
end

function G.start()
  if G.started then
    return
  end
  G.started = true
  buildMatchers()
  if SetGuildRosterShowOffline and GetGuildRosterShowOffline and not GetGuildRosterShowOffline() then
    -- Without offline members the roster is only the people online right now.
    SetGuildRosterShowOffline(true)
  end
  local f = CreateFrame("Frame")
  f:RegisterEvent("GUILD_ROSTER_UPDATE")
  f:RegisterEvent("PLAYER_GUILD_UPDATE")
  f:RegisterEvent("CHAT_MSG_SYSTEM")
  f:SetScript("OnEvent", function(_, event, text)
    if event == "CHAT_MSG_SYSTEM" then
      G.system(text)
    elseif event == "GUILD_ROSTER_UPDATE" then
      scheduleRefresh()
    else
      G.request()
    end
  end)
  C_Timer.NewTicker(ROSTER_EVERY, G.request)
  C_Timer.NewTicker(FULL_EVERY, function()
    forceFull = true
    G.refresh()
  end)
  after(2, G.request)
  G.refresh()
end

UncboxGuild = G
