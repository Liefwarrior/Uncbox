-- Small helpers the other files share: cleaning text for the strip, turning Blizzard's message
-- formats into patterns, reading item links, and the settings Uncbox writes to UncboxConfig.lua.
-- Lua 5.1 (WoW) and 5.3 (the tests) both run it, so numbers are floored before they become text.

local U = {
  FIELD = "\31",
  RECORD = "\30",
}

-- Plain text only: no control characters (they separate fields) and no |c color codes.
function U.clean(s)
  if s == nil then
    return ""
  end
  s = tostring(s):gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", "")
  return (s:gsub("%c", ""))
end

-- A number as text without a ".0" (Lua 5.3 keeps one), or "" for nothing.
function U.num(n)
  n = tonumber(n)
  if not n then
    return ""
  end
  return string.format("%d", math.floor(n))
end

-- Splits on a separator that is plain text (not a pattern); empty pieces are kept.
function U.split(s, sep)
  local out, from = {}, 1
  s = s or ""
  while true do
    local at = s:find(sep, from, true)
    if not at then
      out[#out + 1] = s:sub(from)
      return out
    end
    out[#out + 1] = s:sub(from, at - 1)
    from = at + #sep
  end
end

-- "Name-Realm" becomes "Name": guild and raid lists show realm names for cross-realm players.
function U.shortName(name)
  if name == nil then
    return ""
  end
  return (tostring(name):gsub("%-.*$", ""))
end

-- Seconds since 1970 by the game's clock.
function U.now()
  if GetServerTime then
    return GetServerTime()
  end
  return time()
end

-- Adds an item to a list, dropping the oldest ones past a cap.
function U.push(list, item, cap)
  list[#list + 1] = item
  while #list > cap do
    table.remove(list, 1)
  end
end

local MAGIC = "[%^%$%(%)%%%.%[%]%*%+%-%?]"

-- A Blizzard format string ("%s has promoted %s to %s.") as a Lua pattern, and for each capture
-- which argument of the format it is (formats can reorder them: "%2$s ... %1$s"). Anchored at both
-- ends. Everything else in the string is escaped, so any language's text works.
function U.patternFromFormat(fmt)
  local out, order, i = { "^" }, {}, 1
  while i <= #fmt do
    local c = fmt:sub(i, i)
    if c == "%" then
      local pos, conv = fmt:match("^%%(%d+)%$([sd])", i)
      local len = 0
      if pos then
        len = #pos + 3
      else
        conv = fmt:match("^%%([sd])", i)
        len = 2
      end
      if fmt:sub(i + 1, i + 1) == "%" then
        out[#out + 1] = "%%"
        i = i + 2
      elseif conv then
        order[#order + 1] = tonumber(pos) or (#order + 1)
        out[#out + 1] = conv == "d" and "(%d+)" or "(.-)"
        i = i + len
      else
        out[#out + 1] = "%%"
        i = i + 1
      end
    else
      out[#out + 1] = (c:gsub(MAGIC, "%%%0"))
      i = i + 1
    end
  end
  out[#out + 1] = "$"
  return table.concat(out), order
end

-- A matcher for one format string, or nil when the game has no such string.
function U.matcher(fmt)
  if type(fmt) ~= "string" or fmt == "" then
    return nil
  end
  local pattern, order = U.patternFromFormat(fmt)
  return { pattern = pattern, order = order }
end

-- The arguments of the format in a message, in the format's own order, or nil if it doesn't match.
function U.match(m, text)
  if not m or type(text) ~= "string" then
    return nil
  end
  local caps = { text:match(m.pattern) }
  if #caps == 0 or (#m.order == 0) then
    return nil
  end
  local args = {}
  for k, at in ipairs(m.order) do
    args[at] = caps[k]
  end
  return args
end

local QUALITY = {
  ["9d9d9d"] = 0, -- poor
  ["ffffff"] = 1, -- common
  ["1eff00"] = 2, -- uncommon
  ["0070dd"] = 3, -- rare
  ["a335ee"] = 4, -- epic
  ["ff8000"] = 5, -- legendary
  ["e6cc80"] = 6, -- artifact
}

-- item id, name and quality from an item link (|cff0070dd|Hitem:1234:...|h[Name]|h|r), or nil.
function U.itemFromLink(link)
  if type(link) ~= "string" then
    return nil
  end
  local id = link:match("|Hitem:(%d+)")
  if not id then
    return nil
  end
  local name = link:match("|h%[(.-)%]|h") or ""
  local color = link:match("|c%x%x(%x%x%x%x%x%x)|Hitem")
  local quality = color and QUALITY[color:lower()] or nil
  if quality == nil and GetItemInfo then
    local _, _, q = GetItemInfo(link)
    quality = q
  end
  return tonumber(id), name, quality or 1
end

-- The settings Uncbox wrote to UncboxConfig.lua, with a default for anything missing.
function U.config()
  local c = UncboxConfig or {}
  local strip = c.strip or {}
  local modules = c.modules or {}
  local corner = strip.corner == "TOPRIGHT" and "TOPRIGHT" or "TOPLEFT"
  local function on(key)
    return modules[key] ~= false
  end
  return {
    strip = { enabled = strip.enabled ~= false, corner = corner },
    modules = {
      character = on("character"),
      quests = on("quests"),
      party = on("party"),
      guild = on("guild"),
      raid = on("raid"),
      loot = on("loot"),
    },
    lootMinQuality = tonumber(c.lootMinQuality) or 2,
  }
end

UncboxUtil = U
