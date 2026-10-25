-- A pretend WoW for addon.test.ts: just enough of the game's API (frames, events, timers, the guild
-- and raid functions, Blizzard's message formats) to run the addon's files in Lua 5.3 (fengari).
-- Tests set up the world by changing __world, fire events with __fire and move time with __advance.
-- Not part of the addon: the installer only copies what's under addon/.

-- ---- Lua 5.1 things the addon (written for WoW) uses ----
unpack = table.unpack
bit = {
  band = function(a, b) return a & b end,
  bor = function(a, b) return a | b end,
  bxor = function(a, b) return a ~ b end,
  lshift = function(a, b) return a << b end,
  rshift = function(a, b) return a >> b end,
}
format = string.format
tinsert = table.insert
strlower = string.lower
function strtrim(s) return (s:gsub("^%s+", ""):gsub("%s+$", "")) end
function wipe(t) for k in pairs(t) do t[k] = nil end return t end
function strsplit(sep, s, n)
  local out, from = {}, 1
  while true do
    local at = s:find(sep, from, true)
    if not at or (n and #out >= n - 1) then out[#out + 1] = s:sub(from) break end
    out[#out + 1] = s:sub(from, at - 1)
    from = at + #sep
  end
  return table.unpack(out)
end
print = function() end

-- ---- the clock ----
__now = 5000.0
__epoch = 1760000000 -- time() when __now is 0
function GetTime() return __now end
function time() return __epoch + math.floor(__now) end
function GetServerTime() return time() end

-- ---- frames and textures ----
__frames = {}
__missingEvents = {}
local NOOP = function() end
local methods = {}
function methods:RegisterEvent(e)
  if __missingEvents[e] then error("Frame:RegisterEvent(): Attempt to register unknown event \"" .. e .. "\"") end
  self.__events[e] = true
end
function methods:UnregisterEvent(e) self.__events[e] = nil end
function methods:SetScript(name, fn) self.__scripts[name] = fn end
function methods:GetScript(name) return self.__scripts[name] end
function methods:Show() self.__shown = true end
function methods:Hide() self.__shown = false end
function methods:IsShown() return self.__shown end
function methods:SetPoint(...) self.__point = { ... } end
function methods:CreateTexture()
  local t = setmetatable({ color = { 0, 0, 0 } }, { __index = function(_, k) return k == "SetColorTexture" and function(self, r, g, b) self.color = { r, g, b } end or NOOP end })
  self.__textures[#self.__textures + 1] = t
  return t
end
local FrameMT = { __index = function(_, k) return methods[k] or NOOP end }
function CreateFrame(_, name)
  local f = setmetatable({ __events = {}, __scripts = {}, __textures = {}, __shown = true }, FrameMT)
  __frames[#__frames + 1] = f
  if name then _G[name] = f end
  return f
end
WorldFrame = CreateFrame("Frame", "WorldFrame")
function __fire(event, ...)
  for _, f in ipairs(__frames) do
    if f.__events[event] and f.__scripts.OnEvent then f.__scripts.OnEvent(f, event, ...) end
  end
end

-- ---- timers ----
__timers = {}
C_Timer = {
  After = function(delay, fn) __timers[#__timers + 1] = { at = __now + delay, fn = fn } end,
  NewTicker = function(every, fn)
    local t = { at = __now + every, fn = fn, every = every }
    __timers[#__timers + 1] = t
    return t
  end,
}
local function runDue()
  repeat
    local due
    for _, t in ipairs(__timers) do
      if not t.done and t.at <= __now + 1e-6 and (not due or t.at < due.at) then due = t end
    end
    if due then
      if due.every then due.at = due.at + due.every else due.done = true end
      due.fn()
    end
  until not due
  local keep = {}
  for _, t in ipairs(__timers) do if not t.done then keep[#keep + 1] = t end end
  __timers = keep
end
function __advance(seconds)
  local target = __now + seconds
  while __now < target - 1e-6 do
    __now = math.min(__now + 0.05, target)
    runDue()
  end
end

-- What the strip shows after each 50 ms tick for this many seconds: one string of 512 digits (0-7)
-- for every tick it was up.
function __capture(seconds)
  local out = {}
  local target = __now + seconds
  while __now < target - 1e-6 do
    __advance(0.05)
    if UncboxStrip and UncboxStrip.__shown then
      local digits = {}
      for i, t in ipairs(UncboxStrip.__textures) do
        local c = t.color
        digits[i] = (c[1] > 0 and 4 or 0) + (c[2] > 0 and 2 or 0) + (c[3] > 0 and 1 or 0)
      end
      out[#out + 1] = table.concat(digits)
    end
  end
  return out
end

-- ---- JSON, for getting values out ----
local function esc(s)
  return (s:gsub('[%c"\\]', function(c)
    if c == '"' then return '\\"' elseif c == "\\" then return "\\\\" end
    return string.format("\\u%04x", c:byte())
  end))
end
function __json(v)
  local t = type(v)
  if v == nil then return "null"
  elseif t == "boolean" then return tostring(v)
  elseif t == "number" then
    if math.type(v) == "float" and v == math.floor(v) then return string.format("%d", v) end
    return tostring(v)
  elseif t == "string" then return '"' .. esc(v) .. '"'
  elseif t == "table" then
    if #v > 0 or next(v) == nil then
      local parts = {}
      for i = 1, #v do parts[i] = __json(v[i]) end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = tostring(k) end
    table.sort(keys)
    local parts = {}
    for _, k in ipairs(keys) do
      local val = v[k]
      if val == nil then val = v[tonumber(k)] end
      parts[#parts + 1] = '"' .. esc(k) .. '":' .. __json(val)
    end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return "null"
end

-- UncboxDB the way WoW saves it to WTF\Account\<ACCOUNT>\SavedVariables\Uncbox.lua: tabs, ["key"] =
-- value, trailing commas, "-- [n]" after list items, strings with \ddd for anything unusual.
function __savedvariables(name)
  local function str(s)
    return '"' .. s:gsub('[%c"\\]', function(c)
      if c == '"' then return '\\"' elseif c == "\\" then return "\\\\" elseif c == "\n" then return "\\n" end
      return string.format("\\%03d", c:byte())
    end) .. '"'
  end
  local function ser(v, indent)
    local t = type(v)
    if t == "string" then return str(v)
    elseif t == "boolean" then return tostring(v)
    elseif t == "number" then
      if math.type(v) == "integer" or v == math.floor(v) then return string.format("%d", v) end
      return string.format("%.14g", v)
    end
    local inner, out = indent .. "\t", {}
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = k end
    table.sort(keys, function(a, b)
      if type(a) == type(b) then return a < b end
      return type(a) == "number"
    end)
    for _, k in ipairs(keys) do
      if type(k) == "number" then
        out[#out + 1] = inner .. ser(v[k], inner) .. ", -- [" .. k .. "]"
      else
        out[#out + 1] = inner .. "[" .. str(k) .. "] = " .. ser(v[k], inner) .. ","
      end
    end
    if #out == 0 then return "{\n" .. indent .. "}" end
    return "{\n" .. table.concat(out, "\n") .. "\n" .. indent .. "}"
  end
  return name .. " = " .. ser(_G[name], "") .. "\n"
end

-- ---- Blizzard's own message formats (English) ----
ERR_FRIEND_ONLINE_SS = "|Hplayer:%s|h[%s]|h has come online."
ERR_FRIEND_OFFLINE_S = "%s has gone offline."
ERR_GUILD_JOIN_S = "%s has joined the guild."
ERR_GUILD_LEAVE_S = "%s has left the guild."
ERR_GUILD_REMOVE_SS = "%s has been kicked out of the guild by %s."
ERR_GUILD_PROMOTE_SSS = "%s has promoted %s to %s."
ERR_GUILD_DEMOTE_SSS = "%s has demoted %s to %s."
LOOT_ITEM_SELF = "You receive loot: %s."
LOOT_ITEM_SELF_MULTIPLE = "You receive loot: %sx%d."
LOOT_ITEM = "%s receives loot: %s."
LOOT_ITEM_MULTIPLE = "%s receives loot: %sx%d."

-- ---- the world ----
-- Tests replace pieces of this. guild: nil (no guild) or { name, motd, info, ranks, members }, a
-- member being { name, rank, rankIndex, level, class, classFile, zone, note, officerNote, online,
-- status, ago = {years, months, days, hours} }. raid and party: lists of { name, rank, subgroup,
-- level, class, zone, online, dead, role, ml }. instance: nil or { name, kind, maxPlayers, id }.
__world = {
  player = { name = "Lief", realm = "Doomhowl", class = "DRUID", race = "Night Elf", level = 23 },
  guild = nil,
  rosterRequests = 0,
  oldRosterApi = false,
  canOfficer = true,
  raid = nil,
  party = nil,
  instance = nil,
  lootMethod = "group",
  readyStatus = {},
}
local W = function() return __world end

UncboxConfig = nil
UncboxDB = nil
UncboxSyncCalls = 0
GetPhysicalScreenSize = function() return 1920, 1080 end
GetRealmName = function() return W().player.realm end
UnitRace = function() return W().player.race end
UnitXP = function() return 100 end
UnitXPMax = function() return 1000 end
GetMoney = function() return 12345 end
GetZoneText = function() return "Darkshore" end
GetNumQuestLogEntries = function() return 0 end
UnitExists = function(unit)
  local w = W()
  if unit == "player" then return true end
  local n = tonumber(unit:match("^party(%d)$"))
  return n ~= nil and w.party ~= nil and w.party[n] ~= nil
end
local function unitInfo(unit)
  local w = W()
  if unit == "player" then return { name = w.player.name, class = w.player.class, level = w.player.level } end
  local n = tonumber(unit:match("^party(%d)$"))
  if n and w.party then return w.party[n] end
  n = tonumber(unit:match("^raid(%d+)$"))
  if n and w.raid then return w.raid[n] end
end
UnitName = function(unit) local u = unitInfo(unit) return u and u.name end
UnitClass = function(unit) local u = unitInfo(unit) return u and u.class, u and u.class end
UnitLevel = function(unit) local u = unitInfo(unit) return u and u.level or 0 end
UnitIsDeadOrGhost = function(unit) local u = unitInfo(unit) return u and u.dead or false end
UnitIsConnected = function(unit) local u = unitInfo(unit) return not u or u.online ~= false end
UnitIsGroupLeader = function(unit) local u = unitInfo(unit) return u and u.rank == 2 or false end

-- guild
IsInGuild = function() return W().guild ~= nil end
GetNumGuildMembers = function()
  local g = W().guild
  local online = 0
  for _, m in ipairs(g.members) do if m.online then online = online + 1 end end
  return #g.members, online
end
GetGuildRosterInfo = function(i)
  local m = W().guild.members[i]
  if not m then return end
  local w = W()
  local officer = w.canOfficer and m.officerNote or ""
  return m.name .. "-" .. w.player.realm, m.rank, m.rankIndex, m.level, m.class, m.zone, m.note or "", officer, m.online, m.status or 0, m.classFile
end
GetGuildRosterLastOnline = function(i)
  local m = W().guild.members[i]
  if m.online or not m.ago then return nil end
  return m.ago[1], m.ago[2], m.ago[3], m.ago[4]
end
GuildControlGetNumRanks = function() return #W().guild.ranks end
GuildControlGetRankName = function(i) return W().guild.ranks[i] end
GetGuildRosterMOTD = function() return W().guild.motd end
GetGuildInfoText = function() return W().guild.info end
GetGuildInfo = function() local g = W().guild return g and g.name, "Member", 2 end
CanViewOfficerNote = function() return W().canOfficer end
SetGuildRosterShowOffline = function(on) __showOffline = on end
GetGuildRosterShowOffline = function() return __showOffline end
__showOffline = false
function __useOldRosterApi()
  C_GuildInfo = nil
  GuildRoster = function() __world.rosterRequests = __world.rosterRequests + 1 end
end
C_GuildInfo = { GuildRoster = function() __world.rosterRequests = __world.rosterRequests + 1 end }

-- groups and instances
IsInRaid = function() return W().raid ~= nil end
IsInGroup = function() return W().raid ~= nil or W().party ~= nil end
GetNumGroupMembers = function()
  local w = W()
  if w.raid then return #w.raid end
  return w.party and #w.party + 1 or 1
end
GetRaidRosterInfo = function(i)
  local m = W().raid[i]
  if not m then return end
  return m.name, m.rank or 0, m.subgroup or 1, m.level or 60, m.class, m.class, m.zone or "Molten Core", m.online ~= false, m.dead or false, m.role, m.ml or false
end
GetPartyAssignment = function() return false end
GetReadyCheckStatus = function(unit) return W().readyStatus[unit] end
IsInInstance = function() local i = W().instance return i ~= nil, i and i.kind or "none" end
GetInstanceInfo = function()
  local i = W().instance
  if not i then return "Darkshore", "none", 0, "", 0, 0, false, 1 end
  return i.name, i.kind, 9, "40 Player", i.maxPlayers, 0, false, i.id
end
GetLootMethod = function()
  local w = W()
  return w.lootMethod, nil, w.masterLooter
end

SlashCmdList = {}
