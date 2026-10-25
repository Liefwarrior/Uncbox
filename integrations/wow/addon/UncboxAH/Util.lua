-- Small helpers the other files share: item keys, money, splitting text, running work over frames.
-- Written for the Lua 5.1 WoW uses (it also runs on 5.3, which the tests use): no integer
-- division, no goto, no bit operators, and numbers that become text are always whole.

local ADDON, ns = ...

local U = {}
ns.Util = U

-- Fields of a link after "item:": id, enchant, gem1-4, suffix, unique id, ...
local SUFFIX_FIELD = 7

--- Splits text at a separator (plain), keeping empty pieces: "a::b" -> { "a", "", "b" }.
function U.Split(text, sep)
  local out = {}
  local from = 1
  while true do
    local at = string.find(text, sep, from, true)
    if not at then
      out[#out + 1] = string.sub(text, from)
      return out
    end
    out[#out + 1] = string.sub(text, from, at - 1)
    from = at + #sep
  end
end

--- "i:2589" or "i:2589:-12" from an item link, "item:2589:..." text or an item id; nil if it isn't one.
--- The second number is the random suffix ("of the Eagle"), only there when it isn't 0.
function U.ItemKey(link)
  if type(link) == "number" then
    return "i:" .. math.floor(link)
  end
  if type(link) ~= "string" then
    return nil
  end
  local body = string.match(link, "item:([%-%d:]*)")
  if not body then
    local bare = string.match(link, "^i:(%d+)")
    if bare then
      return link
    end
    return nil
  end
  local parts = U.Split(body, ":")
  local id = tonumber(parts[1])
  if not id then
    return nil
  end
  local suffix = tonumber(parts[SUFFIX_FIELD]) or 0
  if suffix ~= 0 then
    return "i:" .. math.floor(id) .. ":" .. math.floor(suffix)
  end
  return "i:" .. math.floor(id)
end

--- The item id out of a key: "i:2589:-12" -> 2589.
function U.ItemId(key)
  return tonumber(string.match(key or "", "^i:(%d+)"))
end

--- 123456 -> "12g 34s 56c". Zero parts are left out and zero is "0c". colored = gold/silver/copper colors.
function U.Money(copper, colored)
  copper = math.floor((tonumber(copper) or 0) + 0.5)
  local sign = ""
  if copper < 0 then
    sign = "-"
    copper = -copper
  end
  local g = math.floor(copper / 10000)
  local s = math.floor(copper / 100) % 100
  local c = copper % 100
  local function unit(n, letter, color)
    if colored then
      return "|cff" .. color .. n .. letter .. "|r"
    end
    return n .. letter
  end
  local parts = {}
  if g > 0 then
    parts[#parts + 1] = unit(g, "g", "ffd700")
  end
  if s > 0 then
    parts[#parts + 1] = unit(s, "s", "c7c7cf")
  end
  if c > 0 or #parts == 0 then
    parts[#parts + 1] = unit(c, "c", "eda55f")
  end
  return sign .. table.concat(parts, " ")
end

--- "12g 34s 56c", "1g50s", "75s" or "250" (copper) -> copper; nil if it isn't money.
function U.ParseMoney(text)
  text = string.lower(string.gsub(tostring(text or ""), "%s+", ""))
  if text == "" then
    return nil
  end
  if string.match(text, "^%d+$") then
    return tonumber(text)
  end
  local total, any = 0, false
  local rest = text
  for _, unit in ipairs({ { "g", 10000 }, { "s", 100 }, { "c", 1 } }) do
    local n, after = string.match(rest, "^(%d+)" .. unit[1] .. "(.*)$")
    if n then
      total = total + tonumber(n) * unit[2]
      rest = after
      any = true
    end
  end
  if rest ~= "" or not any then
    return nil
  end
  return total
end

--- "5m", "3h 20m", "2d" from seconds.
function U.Age(seconds)
  if not seconds then
    return "never"
  end
  seconds = math.max(0, math.floor(seconds))
  if seconds < 90 then
    return seconds .. "s"
  end
  if seconds < 5400 then
    return math.floor(seconds / 60 + 0.5) .. "m"
  end
  if seconds < 172800 then
    return math.floor(seconds / 3600) .. "h " .. math.floor((seconds % 3600) / 60) .. "m"
  end
  return math.floor(seconds / 86400) .. "d"
end

--- Prints in the chat window with the addon's name in front.
function U.Print(...)
  local text = table.concat({ ... }, " ")
  if DEFAULT_CHAT_FRAME then
    DEFAULT_CHAT_FRAME:AddMessage("|cff6cb4ffUncboxAH|r " .. text)
  end
  if ns.printed then
    ns.printed[#ns.printed + 1] = text
  end
end

--- Runs fn on the next frame (or after `seconds`).
function U.After(seconds, fn)
  if C_Timer and C_Timer.After then
    C_Timer.After(seconds or 0, fn)
  else
    fn()
  end
end

-- A tiny event bus between the files: U.On("scan", fn), U.Fire("scan", ...). The UI listens on it.
local listeners = {}

function U.On(event, fn)
  listeners[event] = listeners[event] or {}
  table.insert(listeners[event], fn)
end

function U.Fire(event, ...)
  for _, fn in ipairs(listeners[event] or {}) do
    local ok, err = pcall(fn, ...)
    if not ok then
      if ns.errors then
        ns.errors[#ns.errors + 1] = tostring(err)
      else
        U.Print("|cffff5555error|r " .. tostring(err))
      end
    end
  end
end

--- A Lua list with the keys of a table, sorted.
function U.SortedKeys(t)
  local keys = {}
  for k in pairs(t) do
    keys[#keys + 1] = k
  end
  table.sort(keys, function(a, b)
    return tostring(a) < tostring(b)
  end)
  return keys
end

--- Escapes a string so it matches itself in a Lua pattern.
function U.Escape(text)
  return (string.gsub(text, "([%^%$%(%)%%%.%[%]%*%+%-%?])", "%%%1"))
end

-- The auction houses that every faction shares: Booty Bay, Gadgetzan, Everlook and Ratchet. The
-- house you scan there is not your faction's, so its prices are kept apart.
local NEUTRAL_ZONES = {
  ["Booty Bay"] = true,
  ["Gadgetzan"] = true,
  ["Everlook"] = true,
  ["Ratchet"] = true,
}

--- "Neutral" while you're in a neutral town, otherwise your faction ("Alliance" or "Horde").
function U.Faction()
  local zone = GetSubZoneText and GetSubZoneText() or ""
  local main = GetZoneText and GetZoneText() or ""
  if NEUTRAL_ZONES[zone] or NEUTRAL_ZONES[main] then
    return "Neutral"
  end
  local faction = UnitFactionGroup and UnitFactionGroup("player")
  return faction or "Neutral"
end

--- "Realm|Faction": what scans and rules are kept under.
function U.RealmKey()
  return (GetRealmName and GetRealmName() or "Unknown") .. "|" .. U.Faction()
end

--- Your character's name (no realm).
function U.Me()
  return UnitName and UnitName("player") or "Unknown"
end
