-- UncboxAHDB: what the addon saves for Uncbox to read (WTF\...\SavedVariables\UncboxAH.lua, written
-- by WoW on /reload and logout). Everything is numbers, strings and tables of them. Layout:
--
--   UncboxAHDB = {
--     version = 1,
--     options = { scans = 3, ... },
--     items = { ["i:2589"] = { n = name, q = quality, l = item level, c = class, s = subclass,
--                              v = vendor sell price, i = icon file id, k = stack size } },
--     vendorBuy = { ["i:2320"] = copper },                    -- what vendors charge for items they always stock
--     recipes = { ["Alchemy"] = { ["i:118"] = { n = name, m = made, r = { "i:2447", 1, ... } } } },
--     realms = { ["Stalagg|Alliance"] = {
--       scans = { { t = time, kind = "full", n = auctions, items = { ["i:2589"] = Rec } } },   -- the latest few
--       pages = { ["i:2589"] = Rec + { t = time } },          -- the latest search for each item
--       daily = { ["i:2589"] = { day, scans, sumOfMinBuyouts, day, ... } },
--       acct  = { { id, t, c = char, ty = "sold", k = item, n = name, q = qty, p = price, d = deposit, f = ah cut, o = other player } },
--       inv   = { Char = { t, bags = { [item] = n }, bank = { [item] = n }, bankT } },
--       owned = { Char = { t, list = { { k = item, q = qty, b = buyout per item, tl = time left, ... } } } },
--       gold  = { Char = { t1, copper1, t2, copper2, ... } },
--     } },
--   }
--   Rec = { mb = min buyout per item, q = total quantity, a = number of auctions,
--           p = { price, qty, price, qty, ... } the cheapest price points, lowest first,
--           m = { price, qty, ... } the same for your own auctions,
--           L = { { price, count, seller, timeLeft }, ... } the listings (searches only) }
-- Prices are copper per item. "ty" is sold, bought, expired, cancelled, outbid, post or buy.

local ADDON, ns = ...
local U = ns.Util

local Db = {}
ns.Db = Db

Db.VERSION = 1

Db.DEFAULTS = {
  scans = 3, -- full scans to keep (the server keeps them all)
  maxPoints = 20, -- price points kept per item per scan
  maxListings = 40, -- listings kept per item in a search
  maxAccounting = 4000,
  maxGold = 600, -- numbers per character (time and copper pairs)
  dailyDays = 21,
  queryLayout = "auto", -- "auto", "new" or "old": how QueryAuctionItems wants its arguments
  tooltip = true,
}

local DAY = 86400

function Db.Init()
  UncboxAHDB = UncboxAHDB or {}
  local d = UncboxAHDB
  d.version = Db.VERSION
  d.options = d.options or {}
  for k, v in pairs(Db.DEFAULTS) do
    if d.options[k] == nil then
      d.options[k] = v
    end
  end
  d.items = d.items or {}
  d.vendorBuy = d.vendorBuy or {}
  d.recipes = d.recipes or {}
  d.realms = d.realms or {}
  d.chars = d.chars or {}
  d.seenMail = d.seenMail or {}
  return d
end

function Db.Options()
  return (UncboxAHDB or Db.Init()).options
end

--- The saved tables for a realm key ("Stalagg|Alliance"), made on first use.
function Db.Realm(key)
  local d = UncboxAHDB or Db.Init()
  key = key or U.RealmKey()
  local r = d.realms[key]
  if not r then
    r = {}
    d.realms[key] = r
  end
  r.scans = r.scans or {}
  r.pages = r.pages or {}
  r.daily = r.daily or {}
  r.acct = r.acct or {}
  r.inv = r.inv or {}
  r.owned = r.owned or {}
  r.gold = r.gold or {}
  return r
end

--- Remembers that this character belongs to you (so your own auctions are known as yours).
function Db.RegisterChar(name, realmName)
  local d = UncboxAHDB or Db.Init()
  d.chars[(name or U.Me()) .. "-" .. (realmName or GetRealmName())] = true
end

--- True for a seller name that is one of your characters (a name, or Name-Realm).
function Db.IsMine(seller)
  if not seller or seller == "" then
    return false
  end
  local d = UncboxAHDB or Db.Init()
  if d.chars[seller] then
    return true
  end
  local name = string.match(seller, "^([^%-]+)")
  return d.chars[name .. "-" .. GetRealmName()] == true
end

--- Adds a scan snapshot and drops the oldest full scans beyond the limit.
function Db.AddScan(realm, scan)
  local keep = Db.Options().scans
  realm.scans[#realm.scans + 1] = scan
  local full = 0
  for i = #realm.scans, 1, -1 do
    if realm.scans[i].kind == "full" then
      full = full + 1
      if full > keep then
        table.remove(realm.scans, i)
      end
    end
  end
end

--- Adds a full scan's min buyouts to the per-item daily numbers: a flat list of (day, scans, sum of min buyouts).
function Db.UpdateDaily(realm, items, t)
  local day = math.floor(t / DAY)
  local oldest = day - Db.Options().dailyDays
  for key, rec in pairs(items) do
    if rec.mb then
      local list = realm.daily[key]
      if not list then
        list = {}
        realm.daily[key] = list
      end
      local n = #list
      if n >= 3 and list[n - 2] == day then
        list[n - 1] = list[n - 1] + 1
        list[n] = list[n] + rec.mb
      else
        list[n + 1] = day
        list[n + 2] = 1
        list[n + 3] = rec.mb
      end
      while #list >= 3 and list[1] < oldest do
        table.remove(list, 1)
        table.remove(list, 1)
        table.remove(list, 1)
      end
    end
  end
end

--- Appends an accounting entry (see the layout above); the oldest go when there are too many.
function Db.AddAccounting(realm, entry)
  realm.acct[#realm.acct + 1] = entry
  local max = Db.Options().maxAccounting
  while #realm.acct > max do
    table.remove(realm.acct, 1)
  end
end

--- Adds (time, copper) to a character's gold history, at most every `every` seconds unless the amount moved.
function Db.AddGold(realm, char, t, copper, every)
  local list = realm.gold[char]
  if not list then
    list = {}
    realm.gold[char] = list
  end
  local n = #list
  if n >= 2 and (t - list[n - 1]) < (every or 0) and list[n] == copper then
    return false
  end
  if n >= 2 and list[n - 1] == t then
    list[n] = copper
    return true
  end
  list[n + 1] = t
  list[n + 2] = copper
  local max = Db.Options().maxGold
  while #list > max do
    table.remove(list, 1)
    table.remove(list, 1)
  end
  return true
end

--- The newest record for an item: from a search or the latest full scan, whichever is newer. nil, t if none.
function Db.Latest(realm, key)
  local best, bestT = realm.pages[key], realm.pages[key] and realm.pages[key].t or 0
  for i = #realm.scans, 1, -1 do
    local scan = realm.scans[i]
    if scan.t > bestT then
      local rec = scan.items and scan.items[key]
      if rec then
        return rec, scan.t
      end
    end
  end
  if best then
    return best, bestT
  end
  return nil, nil
end

--- Time of the latest full scan for a realm, or nil.
function Db.LastFullScan(realm)
  for i = #realm.scans, 1, -1 do
    if realm.scans[i].kind == "full" then
      return realm.scans[i].t
    end
  end
  return nil
end

--- Stores what the game knows about an item for the server's item table. Keeps earlier values the game didn't return.
function Db.SetItemInfo(key, info)
  local d = UncboxAHDB or Db.Init()
  local cur = d.items[key]
  if not cur then
    cur = {}
    d.items[key] = cur
  end
  for k, v in pairs(info) do
    if v ~= nil and v ~= "" then
      cur[k] = v
    end
  end
end
