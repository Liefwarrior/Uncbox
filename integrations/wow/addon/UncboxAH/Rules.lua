-- The decisions the auction house tab makes, kept free of the game's API so they can be tested:
-- what price to post at, which of your auctions to cancel, which listings to buy. The prices and
-- rules come from UncboxAHData, the file Uncbox writes (formulas already worked out to copper).

local ADDON, ns = ...
local U = ns.Util
local Db = ns.Db

local Rules = {}
ns.Rules = Rules

-- ---- the data file ----

--- The data file's table for this realm and faction, or nil.
function Rules.Realm(key)
  local data = UncboxAHData
  if not data or not data.realms then
    return nil
  end
  return data.realms[key or U.RealmKey()]
end

--- { market, minBuyout, historical, saleRate, avgSell, vendor } for an item key, or nil.
function Rules.Item(key, realmKey)
  local r = Rules.Realm(realmKey)
  return r and r.items and r.items[key] or nil
end

--- Seconds since the latest full scan Uncbox knows of, or nil.
function Rules.DataAge(now, realmKey)
  local r = Rules.Realm(realmKey)
  if not r or not r.scanTime then
    return nil
  end
  return math.max(0, (now or time()) - r.scanTime)
end

--- The posting rule for an item: its group's (worked out by Uncbox), or a plain one built from its market value.
function Rules.RuleFor(key, realmKey)
  local r = Rules.Realm(realmKey)
  local rule = r and r.rules and r.rules[key]
  if rule then
    return rule, rule.group ~= nil
  end
  local item = Rules.Item(key, realmKey)
  local base = item and (item.market or item.minBuyout or item.historical)
  if not base then
    return nil, false
  end
  return {
    min = math.floor(base * 0.7),
    normal = base,
    max = base * 3,
    undercut = 1,
    stackSize = 1,
    stacks = 1,
    duration = 24,
    keep = 0,
    shopMax = math.floor(base * 0.8),
  }, false
end

-- ---- posting ----

local function lowest(list)
  local best
  for _, p in ipairs(list or {}) do
    if not best or p < best then
      best = p
    end
  end
  return best
end

--- The price to post one item at.
---   rule     { min, normal, max, undercut } in copper per item (min/max may be nil)
---   others   per-item buyout prices of other sellers' auctions
---   mine     per-item buyout prices of your own auctions in the same ladder (they are matched, not undercut)
--- Returns the price and why: "undercut" (one under the lowest other seller), "match" (your own is lowest),
--- "no competition" (the normal price), "below min" (undercutting would go under your min price, so the
--- normal price), "capped" (above your max, so the max). The third result is the raw undercut target.
function Rules.PostPrice(rule, others, mine)
  local min = rule.min or 0
  local max = rule.max
  local normal = rule.normal
  local function clamp(p)
    if p < min then
      p = min
    end
    if max and p > max then
      p = max
    end
    return p
  end
  local low = lowest(others)
  local mineLow = lowest(mine)
  if not low then
    if not normal then
      return nil, "no price"
    end
    return clamp(normal), "no competition", nil
  end
  local target, why
  if mineLow and mineLow <= low then
    target, why = mineLow, "match"
  else
    target, why = low - (rule.undercut or 1), "undercut"
  end
  if target < 1 then
    target = 1
  end
  if target < min then
    if not normal then
      return min, "below min", target
    end
    return clamp(normal), "below min", target
  end
  if max and target > max then
    return max, "capped", target
  end
  return target, why, target
end

--- Stack size, number of stacks and how many you can post, from the rule and what's in your bags.
--- Keeps `rule.keep` in your bags. Returns stackSize, stacks (stacks may be 0).
function Rules.Stacks(rule, inBags)
  local size = math.max(1, rule.stackSize or 1)
  local available = math.max(0, (inBags or 0) - (rule.keep or 0))
  local stacks = math.min(rule.stacks or 1, math.floor(available / size))
  return size, math.max(0, stacks)
end

-- ---- cancelling ----

--- Whether to cancel one of your auctions.
---   auction  { price = per-item buyout }
---   rule     as for PostPrice
---   others   per-item buyout prices of other sellers' auctions
--- Returns "cancel" or "keep", a reason, and the price it would be reposted at.
---   cancel / "undercut"   someone is cheaper, and repricing stays at or above your min price
---   keep / "at min"       someone is cheaper but you can't go lower without going under your min price
---   keep / "lowest"       nobody is cheaper
function Rules.CancelDecision(auction, rule, others)
  local low = lowest(others)
  if not low or low >= auction.price then
    return "keep", "lowest", nil
  end
  local price, why, target = Rules.PostPrice(rule, others, nil)
  if why == "below min" then
    return "keep", "at min", price, target
  end
  return "cancel", "undercut", price, target
end

--- Which of your auctions to cancel. `mine` is a list of { key, name, count, price (per item), link, index };
--- `othersFor(key)` gives the other sellers' per-item prices for that item. Returns the ones to cancel, each with
--- its `lowest` competitor and `newPrice`, biggest undercut first.
function Rules.CancelList(mine, ruleFor, othersFor)
  local out = {}
  for _, a in ipairs(mine) do
    local rule = ruleFor(a.key)
    local others = othersFor(a.key)
    if rule and others then
      local verdict, reason, newPrice = Rules.CancelDecision(a, rule, others)
      if verdict == "cancel" then
        local low = lowest(others)
        out[#out + 1] = {
          key = a.key,
          name = a.name,
          link = a.link,
          count = a.count,
          price = a.price,
          lowest = low,
          newPrice = newPrice,
          reason = reason,
          index = a.index,
        }
      end
    end
  end
  table.sort(out, function(x, y)
    return (x.price - x.lowest) * x.count > (y.price - y.lowest) * y.count
  end)
  return out
end

-- ---- shopping ----

--- Listings worth buying. Each listing is { key, name, count, buyout (stack), price (per item), seller, ... }.
---   opts.maxPrice   buy at or under this per-item price
---   opts.percent    buy under this share (0.6 = 60%) of opts.market
---   opts.market     market value for percent
---   opts.isMine     function(seller) -> true to skip your own auctions
--- Returns { listing, price, percent } sorted cheapest first; percent is nil without a market.
function Rules.ShopMatches(listings, opts)
  local out = {}
  for _, l in ipairs(listings) do
    local price = l.price
    if price and price > 0 and not (opts.isMine and opts.isMine(l.seller)) then
      local ok = true
      if opts.maxPrice and price > opts.maxPrice then
        ok = false
      end
      if opts.percent and opts.market and price > opts.market * opts.percent then
        ok = false
      end
      if not opts.maxPrice and not (opts.percent and opts.market) then
        ok = false
      end
      if ok then
        out[#out + 1] = {
          listing = l,
          price = price,
          percent = opts.market and (price / opts.market) or nil,
        }
      end
    end
  end
  table.sort(out, function(a, b)
    if a.price == b.price then
      return (a.listing.count or 1) > (b.listing.count or 1)
    end
    return a.price < b.price
  end)
  return out
end

--- The max price to pay for an item in a shopping list: the entry's own, else the item's rule.
function Rules.ShopMax(entry, key, realmKey)
  if entry and entry.maxPrice then
    return entry.maxPrice
  end
  local rule = key and Rules.RuleFor(key, realmKey)
  return rule and rule.shopMax or nil
end

--- The other sellers' prices out of a saved record (Db layout): the price points minus yours.
--- Returns a list of per-item prices (one per unit), capped at 50 units, and your own lowest price.
function Rules.OthersFromRecord(rec)
  if not rec then
    return nil
  end
  local mine = {}
  local m = rec.m or {}
  for i = 1, #m - 1, 2 do
    mine[m[i]] = (mine[m[i]] or 0) + m[i + 1]
  end
  local others, mineLow = {}, nil
  local p = rec.p or {}
  for i = 1, #p - 1, 2 do
    local price, qty = p[i], p[i + 1]
    local mineHere = mine[price] or 0
    if mineHere > 0 and (not mineLow or price < mineLow) then
      mineLow = price
    end
    local theirs = qty - mineHere
    if theirs > 0 and #others < 50 then
      others[#others + 1] = price
    end
  end
  return others, mineLow
end
