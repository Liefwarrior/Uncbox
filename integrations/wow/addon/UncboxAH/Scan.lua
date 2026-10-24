-- Scanning the auction house. Two kinds:
--
--   full scan   one "get all" query (the game allows it every 15 minutes) that returns every auction. The
--               listings are read a few hundred per frame so the game doesn't freeze, and boiled down
--               per item as they come: cheapest buyout, total quantity, number of auctions and the
--               cheapest price points. Only that goes into the saved file.
--   search      one query per item name (with its pages), for shopping lists, "check this item" and
--               the cancel scan. These keep the actual listings (price, count, seller, time left).
--
-- QueryAuctionItems changed its arguments between game versions, so Scan.Query picks the layout:
--   new:  (text, minLevel, maxLevel, page, usable, quality, getAll, exact, filterData)
--   old:  (text, minLevel, maxLevel, invType, class, subclass, page, usable, quality, getAll, exact)
-- It uses "new" when the game has AuctionCategories (the 8.3-style auction UI), otherwise "old";
-- /uah layout new|old|auto overrides.

local ADDON, ns = ...
local U = ns.Util
local Db = ns.Db

local Scan = {}
ns.Scan = Scan

local PER_FRAME = 400 -- listings read per frame during a full scan
local FRAME_MS = 6 -- or this many milliseconds, whichever comes first
local PAGE_SIZE = 50
local THROTTLE_SECONDS = 15 * 60
local TIMEOUT = 90

Scan.state = nil -- the scan running now, or nil

-- ---- boiling listings down ----

--- A new accumulator. `isMine(listing)` says whether a listing is one of yours; keepListings keeps each listing.
function Scan.NewAcc(isMine, keepListings)
  return { items = {}, listings = 0, skipped = 0, isMine = isMine, keepListings = keepListings }
end

--- Adds one listing: { key, name, quality, level, count, buyout (the stack's), price (per item), seller, timeLeft, link }.
--- Auctions with no buyout can't be bought now, so they only count as skipped.
function Scan.AddListing(acc, l)
  if not l.key or not l.count or l.count < 1 then
    return
  end
  if not l.buyout or l.buyout <= 0 then
    acc.skipped = acc.skipped + 1
    return
  end
  local price = l.price or math.floor(l.buyout / l.count)
  acc.listings = acc.listings + 1
  local it = acc.items[l.key]
  if not it then
    it = { q = 0, a = 0, prices = {}, mine = {}, name = l.name, quality = l.quality, link = l.link, level = l.level }
    if acc.keepListings then
      it.L = {}
    end
    acc.items[l.key] = it
  end
  it.q = it.q + l.count
  it.a = it.a + 1
  it.prices[price] = (it.prices[price] or 0) + l.count
  if acc.isMine and acc.isMine(l) then
    it.mine[price] = (it.mine[price] or 0) + l.count
  end
  if it.L then
    it.L[#it.L + 1] = { price, l.count, l.seller or "", l.timeLeft or 0 }
  end
end

local function flatten(byPrice, max)
  local prices = {}
  for price in pairs(byPrice) do
    prices[#prices + 1] = price
  end
  table.sort(prices)
  local flat = {}
  for i = 1, math.min(#prices, max) do
    flat[#flat + 1] = prices[i]
    flat[#flat + 1] = byPrice[prices[i]]
  end
  return flat, prices[1]
end

--- The accumulator as saved records: key -> { mb, q, a, p, m, L }. See Db.lua.
function Scan.Finish(acc, maxPoints, maxListings)
  local opts = Db.Options()
  maxPoints = maxPoints or opts.maxPoints
  maxListings = maxListings or opts.maxListings
  local out = {}
  for key, it in pairs(acc.items) do
    local p, mb = flatten(it.prices, maxPoints)
    local rec = { mb = mb, q = it.q, a = it.a, p = p }
    if next(it.mine) then
      rec.m = flatten(it.mine, 10)
    end
    if it.L then
      table.sort(it.L, function(x, y)
        return x[1] < y[1]
      end)
      while #it.L > maxListings do
        table.remove(it.L)
      end
      rec.L = it.L
    end
    out[key] = rec
  end
  return out
end

-- ---- reading the auction house ----

--- One listing from the auction house list ("list", "owner" or "bidder") as a table, or nil.
function Scan.ReadListing(listType, index)
  local r = { GetAuctionItemInfo(listType, index) }
  local name = r[1]
  if not name then
    return nil
  end
  local l = { index = index, name = name, texture = r[2], count = r[3] or 1, quality = r[4], level = r[6] }
  if type(r[7]) == "number" then
    -- The older layout has no column header after the level.
    l.minBid, l.buyout, l.bidAmount, l.seller, l.saleStatus, l.itemId = r[7], r[9], r[10], r[12], r[13], r[14]
  else
    l.minBid, l.buyout, l.bidAmount, l.seller, l.saleStatus, l.itemId = r[8], r[10], r[11], r[14], r[16], r[17]
  end
  if l.seller == "" then
    l.seller = nil
  end
  l.link = GetAuctionItemLink and GetAuctionItemLink(listType, index) or nil
  l.key = U.ItemKey(l.link) or U.ItemKey(l.itemId)
  l.timeLeft = GetAuctionItemTimeLeft and GetAuctionItemTimeLeft(listType, index) or 0
  l.buyout = l.buyout or 0
  l.price = (l.buyout > 0 and l.count > 0) and math.floor(l.buyout / l.count) or 0
  return l
end

--- True for one of your listings: your name as the seller, or (when the seller isn't loaded yet) the
--- same item at the same price as one of your own auctions.
function Scan.MineTest(ownSet)
  return function(l)
    if l.seller and l.seller ~= "" then
      return Db.IsMine(l.seller)
    end
    return ownSet and l.key and ownSet[l.key .. "/" .. l.price] or false
  end
end

--- Set of "key/price" for the auctions you have up (from the last owned-auctions read).
function Scan.OwnSet(realm)
  local set = {}
  for _, rec in pairs(realm.owned or {}) do
    for _, a in ipairs(rec.list or {}) do
      if a.k and a.b then
        set[a.k .. "/" .. a.b] = true
      end
    end
  end
  return set
end

-- ---- asking ----

--- The argument layout in use: "new" or "old".
function Scan.Layout()
  local choice = Db.Options().queryLayout
  if choice == "new" or choice == "old" then
    return choice
  end
  if AuctionCategories ~= nil then
    return "new"
  end
  return "old"
end

--- Sends a query. page is 0-based; exact asks for the item name to match exactly.
function Scan.Query(text, page, getAll, exact)
  if Scan.Layout() == "new" then
    QueryAuctionItems(text, nil, nil, page or 0, false, -1, getAll and true or false, exact and true or false, nil)
  else
    QueryAuctionItems(text, nil, nil, 0, 0, 0, page or 0, false, -1, getAll and true or false, exact and true or false)
  end
end

--- Whether a full scan can start now, and if not, how many seconds until it can (a guess from the last one).
function Scan.CanFull()
  local canQuery, canAll = false, false
  if CanSendAuctionQuery then
    canQuery, canAll = CanSendAuctionQuery()
  end
  if canAll then
    return true, 0
  end
  local last = UncboxAHDB and UncboxAHDB.lastGetAll
  local left = last and math.max(0, THROTTLE_SECONDS - (time() - last)) or 0
  if canQuery and left == 0 then
    return false, 5
  end
  return false, left
end

local function notify()
  U.Fire("scan", Scan.state)
end

--- 0..1 progress of the scan running now (nil if none).
function Scan.Progress()
  local st = Scan.state
  if not st then
    return nil
  end
  if st.phase == "processing" and st.total and st.total > 0 then
    return (st.index - 1) / st.total
  end
  return 0
end

local function finishState(message)
  local st = Scan.state
  Scan.state = nil
  if message then
    U.Print(message)
  end
  U.Fire("scan", nil, st)
end

--- Gives up on the scan running now.
function Scan.Cancel(message)
  if Scan.state then
    finishState(message or "Scan stopped.")
  end
end

local function checkTimeout(token)
  local st = Scan.state
  if st and st.token == token and st.phase == "waiting" then
    if st.kind == "full" then
      finishState("The full scan got no answer. Try again in a few minutes.")
    else
      st.timeouts = (st.timeouts or 0) + 1
      Scan.NextRequest(true)
    end
  end
end

-- ---- the full scan ----

--- Starts a full ("get all") scan. Returns true, or false and why.
function Scan.StartFull()
  if Scan.state then
    return false, "A scan is already running."
  end
  local can, left = Scan.CanFull()
  if not can then
    return false, "A full scan can run again in " .. U.Age(left) .. "."
  end
  local realmKey = U.RealmKey()
  local realm = Db.Realm(realmKey)
  Scan.state = {
    kind = "full",
    phase = "waiting",
    token = {},
    realmKey = realmKey,
    t = time(),
    acc = Scan.NewAcc(Scan.MineTest(Scan.OwnSet(realm)), false),
  }
  UncboxAHDB.lastGetAll = time()
  Scan.Query("", 0, true, false)
  local token = Scan.state.token
  U.After(TIMEOUT, function()
    checkTimeout(token)
  end)
  notify()
  return true
end

local function now_ms()
  return debugprofilestop and debugprofilestop() or 0
end

local function stepFull()
  local st = Scan.state
  if not st or st.kind ~= "full" or st.phase ~= "processing" then
    return
  end
  local deadline = now_ms() + FRAME_MS
  local i, count = st.index, 0
  while i <= st.total and count < PER_FRAME and (now_ms() <= deadline or count == 0) do
    local l = Scan.ReadListing("list", i)
    if l then
      Scan.AddListing(st.acc, l)
    else
      st.missing = (st.missing or 0) + 1
    end
    i = i + 1
    count = count + 1
  end
  st.index = i
  notify()
  if i <= st.total then
    U.After(0, stepFull)
    return
  end
  -- Done: save the snapshot.
  local items = Scan.Finish(st.acc)
  local realm = Db.Realm(st.realmKey)
  Db.AddScan(realm, { t = st.t, kind = "full", n = st.acc.listings, items = items })
  Db.UpdateDaily(realm, items, st.t)
  if ns.Collect then
    ns.Collect.QueueItemInfo(st.acc.items)
  end
  local n = 0
  for _ in pairs(items) do
    n = n + 1
  end
  finishState("Scan finished: " .. n .. " items, " .. st.acc.listings .. " auctions.")
  U.Fire("scandone", "full", st.realmKey, n)
end

-- ---- searches ----

--- Searches for items by name. `requests` is a list of { name = "Linen Cloth", key = "i:2589" (optional), pages = 2 }.
--- onItem(request, listings, records) runs after each (listings are the raw listings, records the saved
--- form by item key); onDone() runs after the last. Returns true, or false and why.
function Scan.Search(requests, onItem, onDone, opts)
  if Scan.state then
    return false, "A scan is already running."
  end
  if #requests == 0 then
    if onDone then
      onDone()
    end
    return true
  end
  local realmKey = U.RealmKey()
  Scan.state = {
    kind = "search",
    phase = "queue",
    token = {},
    realmKey = realmKey,
    requests = requests,
    at = 0,
    onItem = onItem,
    onDone = onDone,
    silent = opts and opts.silent,
  }
  Scan.NextRequest()
  return true
end

local function trySend()
  local st = Scan.state
  if not st or st.kind ~= "search" or st.phase ~= "queue" then
    return
  end
  if CanSendAuctionQuery and not CanSendAuctionQuery() then
    U.After(0.2, trySend)
    return
  end
  st.phase = "waiting"
  st.token = {}
  local req = st.requests[st.at]
  Scan.lastQuery = { name = req.name, page = st.page }
  Scan.Query(req.name, st.page, false, true)
  local token = st.token
  U.After(TIMEOUT / 3, function()
    checkTimeout(token)
  end)
  notify()
end

--- Moves to the next request (or the next page of the same one when `retry`).
function Scan.NextRequest(retry)
  local st = Scan.state
  if not st or st.kind ~= "search" then
    return
  end
  if not retry then
    st.at = st.at + 1
    st.page = st.requests[st.at] and st.requests[st.at].page or 0
    st.listings = {}
  end
  if st.at > #st.requests then
    local done = st.onDone
    finishState(nil)
    U.Fire("scandone", "search", st.realmKey)
    if done then
      done()
    end
    return
  end
  if retry and (st.timeouts or 0) > 2 then
    -- The auction house isn't answering for this one; skip it.
    st.timeouts = 0
    st.at = st.at + 1
    st.page = st.requests[st.at] and st.requests[st.at].page or 0
    st.listings = {}
    if st.at > #st.requests then
      return Scan.NextRequest(true)
    end
  end
  st.phase = "queue"
  trySend()
end

local function finishRequest(st)
  local req = st.requests[st.at]
  local realm = Db.Realm(st.realmKey)
  local acc = Scan.NewAcc(Scan.MineTest(Scan.OwnSet(realm)), true)
  for _, l in ipairs(st.listings) do
    Scan.AddListing(acc, l)
  end
  local records = Scan.Finish(acc)
  local t = time()
  for key, rec in pairs(records) do
    rec.t = t
    realm.pages[key] = rec
  end
  if req.key and not records[req.key] then
    -- Nothing is listed: that is worth knowing too.
    realm.pages[req.key] = { t = t, q = 0, a = 0, p = {} }
  end
  if ns.Collect then
    ns.Collect.QueueItemInfo(acc.items)
  end
  if st.onItem then
    st.onItem(req, st.listings, records)
  end
end

-- ---- the game told us the list changed ----

--- AUCTION_ITEM_LIST_UPDATE: reads what came back if a scan is waiting for it.
function Scan.OnListUpdate()
  local st = Scan.state
  if not st or st.phase ~= "waiting" then
    return
  end
  local n, total = GetNumAuctionItems("list")
  n, total = n or 0, total or n or 0
  if st.kind == "full" then
    if n == 0 then
      return -- not the answer yet; the timeout ends the wait
    end
    st.total = n
    st.index = 1
    st.phase = "processing"
    notify()
    U.After(0, stepFull)
    return
  end
  -- A search page: it is small, so read it all now.
  for i = 1, n do
    local l = Scan.ReadListing("list", i)
    if l then
      l.page = st.page
      st.listings[#st.listings + 1] = l
    end
  end
  local req = st.requests[st.at]
  local more = total > (st.page + 1) * PAGE_SIZE and (st.page + 1) < (req.page or 0) + (req.pages or 1)
  if more then
    st.page = st.page + 1
    st.phase = "queue"
    trySend()
    return
  end
  finishRequest(st)
  Scan.NextRequest()
end

-- ---- your own auctions ----

--- Reads the "owner" list (your auctions) into the saved file; returns the list of auctions.
function Scan.ReadOwned()
  local realm = Db.Realm()
  local me = U.Me()
  local out, list = {}, {}
  local n = GetNumAuctionItems("owner") or 0
  for i = 1, n do
    local l = Scan.ReadListing("owner", i)
    if l and l.key and l.saleStatus ~= 1 and l.buyout > 0 then
      out[#out + 1] = l
      list[#list + 1] = { k = l.key, q = l.count, b = l.price, mb = l.minBid, tl = l.timeLeft, n = l.name }
    end
  end
  realm.owned[me] = { t = time(), list = list }
  return out
end
