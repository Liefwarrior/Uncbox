-- What the Uncbox tab does, without the windows: working out a post, finding undercut auctions,
-- running shopping lists, and the one-click actions. Posting, cancelling and buying are protected
-- by the game: each needs a real click, so every function that does one is called from a button
-- and does exactly one auction.

local ADDON, ns = ...
local U = ns.Util
local Db = ns.Db
local Rules = ns.Rules
local Scan = ns.Scan
local Collect = ns.Collect

local A = {}
ns.Actions = A

-- ---- posting ----

--- How the game wants the auction length: hours (12, 24, 48) as 1/2/3, or minutes on clients that use those.
function A.RunTime(hours)
  local index = hours == 12 and 1 or hours == 48 and 3 or 2
  local current = AuctionFrameAuctions and AuctionFrameAuctions.duration
  if type(current) == "number" and current > 3 then
    return hours * 60
  end
  return index
end

--- Everything the Post tab shows for an item: the price Uncbox would post at and why, and how many
--- stacks of what size. nil if there are no prices for the item at all.
function A.PostPlan(key, inBags)
  local rule, fromGroup = Rules.RuleFor(key)
  if not rule then
    return nil
  end
  local realm = Db.Realm()
  local rec, seen = Db.Latest(realm, key)
  local others, mineLow = Rules.OthersFromRecord(rec)
  local price, why, target = Rules.PostPrice(rule, others or {}, mineLow and { mineLow } or {})
  local size, stacks = Rules.Stacks(rule, inBags)
  local item = Rules.Item(key)
  return {
    key = key,
    rule = rule,
    fromGroup = fromGroup,
    price = price,
    why = why,
    target = target,
    lowest = others and others[1],
    market = item and item.market,
    seen = seen,
    stackSize = size,
    stacks = stacks,
    duration = rule.duration or 24,
  }
end

local function pickup(bag, slot)
  if C_Container and C_Container.PickupContainerItem then
    C_Container.PickupContainerItem(bag, slot)
  else
    PickupContainerItem(bag, slot)
  end
end

--- Posts one stack. Call it from a click. `price` is per item (copper). Returns true, or false and why.
function A.PostOne(key, price, stackSize, hours)
  if not price or price < 1 then
    return false, "There's no price to post at."
  end
  local entry
  for _, e in ipairs(Collect.BagItems()) do
    if e.key == key then
      entry = e
    end
  end
  if not entry then
    return false, "That item isn't in your bags."
  end
  -- A stack big enough (the smallest of those), else the biggest there is.
  local chosen
  for _, s in ipairs(entry.stacks) do
    if s.count >= stackSize and (not chosen or s.count < chosen.count) then
      chosen = s
    end
  end
  if not chosen then
    for _, s in ipairs(entry.stacks) do
      if not chosen or s.count > chosen.count then
        chosen = s
      end
    end
  end
  local size = math.min(stackSize, chosen.count)
  ClearCursor()
  pickup(chosen.bag, chosen.slot)
  ClickAuctionSellItemButton()
  ClearCursor()
  if not GetAuctionSellItemInfo() then
    return false, "The game hadn't loaded the item yet. Click again."
  end
  local buyout = price * size
  ns.posting = { key = key, name = entry.name }
  StartAuction(buyout, buyout, A.RunTime(hours), size, 1)
  return true, size
end

--- Looks up the competition for an item (its name, up to 3 pages), then calls cb.
function A.CheckCompetition(key, name, cb)
  local ok, why = Scan.Search({ { name = name, key = key, pages = 3 } }, nil, cb)
  if not ok then
    U.Print(why)
  end
  return ok
end

-- ---- cancelling ----

A.cancelQueue = {}

--- Reads your auctions, searches for each item, and builds the list of undercut ones to cancel.
--- onDone(list) gets the list (also in A.cancelQueue).
function A.CancelScan(onDone)
  local mine = Scan.ReadOwned()
  local seen, requests = {}, {}
  for _, a in ipairs(mine) do
    if not seen[a.key] then
      seen[a.key] = true
      requests[#requests + 1] = { name = a.name, key = a.key, pages = 3 }
    end
  end
  local started = time()
  local realm = Db.Realm()
  local function done()
    local list = Rules.CancelList(mine, function(key)
      return (Rules.RuleFor(key))
    end, function(key)
      local rec = realm.pages[key]
      if rec and rec.t >= started then
        return (Rules.OthersFromRecord(rec))
      end
      return nil
    end)
    A.cancelQueue = list
    U.Fire("cancellist", list)
    if onDone then
      onDone(list)
    end
  end
  if #requests == 0 then
    A.cancelQueue = {}
    done()
    return true
  end
  local ok, why = Scan.Search(requests, nil, done)
  if not ok then
    U.Print(why)
  end
  return ok
end

--- Cancels the next auction in the queue. Call it from a click.
function A.CancelNext()
  local c = table.remove(A.cancelQueue, 1)
  if not c then
    return false, "Nothing left to cancel."
  end
  local n = GetNumAuctionItems("owner") or 0
  -- Positions shift as auctions go, so find it again by what it is.
  for i = 1, n do
    local l = Scan.ReadListing("owner", i)
    if l and l.key == c.key and l.price == c.price and l.count == c.count and l.saleStatus ~= 1 then
      CancelAuction(i)
      U.Fire("cancellist", A.cancelQueue)
      return true, c
    end
  end
  U.Fire("cancellist", A.cancelQueue)
  return false, "Couldn't find that auction any more."
end

-- ---- shopping ----

A.results = {}

--- The shopping lists in the data file: { { name, items }, ... }.
function A.Lists()
  local r = Rules.Realm()
  return r and r.shopping or {}
end

local function itemName(key, fallback)
  local info = (UncboxAHDB or {}).items and UncboxAHDB.items[key]
  return fallback or (info and info.n)
end

--- Runs a shopping list (by position) or the "deals" search (list = "deals"); onDone(results) gets
--- { listing, price, percent, key, name, query } sorted cheapest first.
function A.Shop(list, onDone)
  local requests, entries = {}, {}
  local r = Rules.Realm() or {}
  if list == "deals" then
    local deals = r.deals or {}
    for _, w in ipairs(deals.watch or {}) do
      requests[#requests + 1] = { name = w.name, key = w.item, pages = 2 }
      entries[w.item] = { deals = deals }
    end
  else
    local l = A.Lists()[list]
    if not l then
      return false, "There's no such shopping list."
    end
    for _, e in ipairs(l.items or {}) do
      local name = e.name or itemName(e.item)
      if name then
        requests[#requests + 1] = { name = name, key = e.item, pages = 2 }
        entries[e.item or name] = e
      end
    end
  end
  A.results = {}
  local function onItem(req, listings)
    local entry = entries[req.key or req.name]
    local matches = {}
    for _, l in ipairs(listings) do
      if not req.key or l.key == req.key then
        matches[#matches + 1] = l
      end
    end
    local opts = { isMine = Db.IsMine }
    local item = req.key and Rules.Item(req.key)
    if entry and entry.deals then
      opts.percent = entry.deals.percent
      opts.market = item and item.market
    else
      opts.maxPrice = Rules.ShopMax(entry, req.key)
      opts.market = item and item.market
    end
    for _, m in ipairs(Rules.ShopMatches(matches, opts)) do
      A.results[#A.results + 1] = {
        listing = m.listing,
        price = m.price,
        percent = m.percent,
        key = m.listing.key,
        name = m.listing.name,
        query = { name = req.name, page = m.listing.page or 0 },
      }
    end
  end
  local ok, why = Scan.Search(requests, onItem, function()
    table.sort(A.results, function(a, b)
      return (a.percent or 1) < (b.percent or 1)
    end)
    U.Fire("results", A.results)
    if onDone then
      onDone(A.results)
    end
  end)
  if not ok then
    return false, why
  end
  return true
end

local function sameListing(a, b)
  return a and b and a.key == b.key and a.count == b.count and a.buyout == b.buyout
end

--- Buys a result. If the auction house's list still shows it, it is bought now (one click); if not,
--- the page is looked up again and the result is marked ready for the next click.
--- Returns "bought", "searching" or false and why.
function A.Buy(result)
  local l = result.listing
  local now = Scan.ReadListing("list", l.index)
  local q = Scan.lastQuery
  if sameListing(now, l) and q and q.name == result.query.name and q.page == result.query.page then
    PlaceAuctionBid("list", l.index, l.buyout)
    for i, r in ipairs(A.results) do
      if r == result then
        table.remove(A.results, i)
        break
      end
    end
    U.Fire("results", A.results)
    return "bought"
  end
  local ok, why = Scan.Search({ { name = result.query.name, key = l.key, page = result.query.page, pages = 1 } }, function(_, listings)
    for _, found in ipairs(listings) do
      if sameListing(found, l) and found.seller == l.seller then
        result.listing = found
        result.ready = true
        return
      end
    end
    result.gone = true
  end, function()
    U.Fire("results", A.results)
  end)
  if not ok then
    return false, why
  end
  return "searching"
end
