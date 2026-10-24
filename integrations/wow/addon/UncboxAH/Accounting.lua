-- Your auction house books. The game tells you what happened to your auctions by mail, so the
-- inbox is read for:
--
--   sold       "Auction successful: <item>"   price, the AH's cut, the deposit, who bought
--   bought     "Auction won: <item>"          what you paid
--   expired    "Auction expired: <item>"      the item comes back
--   cancelled  "Auction cancelled: <item>"    the item comes back (a cancelled auction loses its deposit)
--   outbid     "Outbid on <item>"             your bid comes back
--
-- The subjects come from the game's own text (AUCTION_SOLD_MAIL_SUBJECT and friends), so this works
-- in every language. Posting (StartAuction) and buying (PlaceAuctionBid) are noted as they happen.
-- Each entry gets an id built from the mail, so reading the same mail twice, or the same file twice
-- on the server side, never counts it twice.

local ADDON, ns = ...
local U = ns.Util
local Db = ns.Db

local Acct = {}
ns.Acct = Acct

local MAIL_LIFETIME = 30 * 86400 -- an auction mail stays 30 days
local BUCKET = 20 -- seconds: the same mail seen twice computes its send time to within this
local KEEP_SEEN = 40 * 86400

-- ---- reading mail subjects ----

--- A pattern from a game string like "Auction successful: %s" that captures the item name.
function Acct.PatternFor(format)
  if not format or format == "" then
    return nil
  end
  -- %s and %1$s become a mark, the rest is made literal, then the mark becomes the capture.
  local p = string.gsub(format, "%%%d?%$?s", "\1")
  p = U.Escape(p)
  p = string.gsub(p, "\1", "(.+)")
  return "^" .. p .. "$"
end

-- The order matters little: the subjects differ in their text, not just a word.
local SUBJECTS = {
  { "sold", "AUCTION_SOLD_MAIL_SUBJECT" },
  { "expired", "AUCTION_EXPIRED_MAIL_SUBJECT" },
  { "bought", "AUCTION_WON_MAIL_SUBJECT" },
  { "outbid", "AUCTION_OUTBID_MAIL_SUBJECT" },
  { "cancelled", "AUCTION_REMOVED_MAIL_SUBJECT" },
}

local patterns

--- "sold" / "bought" / "expired" / "cancelled" / "outbid" and the item name in a mail subject, or nil.
function Acct.Classify(subject)
  if type(subject) ~= "string" then
    return nil
  end
  if not patterns then
    patterns = {}
    for _, s in ipairs(SUBJECTS) do
      local p = Acct.PatternFor(_G[s[2]])
      if p then
        patterns[#patterns + 1] = { s[1], p }
      end
    end
  end
  for _, entry in ipairs(patterns) do
    local name = string.match(subject, entry[2])
    if name then
      return entry[1], name
    end
  end
  return nil
end

--- Forgets the compiled patterns (the tests change the game strings).
function Acct.Reset()
  patterns = nil
end

-- ---- the inbox ----

local function bucket(sentAt)
  return math.floor(sentAt / BUCKET)
end

local function entryId(char, ty, name, q, p, b)
  return char .. ":" .. ty .. ":" .. b .. ":" .. name .. ":" .. q .. ":" .. p
end

--- The entry for mail `index`, or nil when it isn't an auction mail. Opens the mail text, which is what
--- makes the game load its invoice.
function Acct.ReadMail(index, now)
  local _, _, sender, subject, money, cod, daysLeft, hasItem = GetInboxHeaderInfo(index)
  local ty, name = Acct.Classify(subject)
  if not ty then
    return nil
  end
  now = now or time()
  local sentAt = math.floor(now + (daysLeft or MAIL_LIFETIME / 86400) * 86400 - MAIL_LIFETIME)
  local entry = { t = sentAt, ty = ty, n = name, q = 1, p = 0, d = 0, f = 0 }
  if GetInboxText then
    GetInboxText(index)
  end
  local itemName, itemCount
  if hasItem and GetInboxItem then
    local iname, _, _, count = GetInboxItem(index, 1)
    itemName, itemCount = iname, count
    local link = GetInboxItemLink and GetInboxItemLink(index, 1)
    entry.k = U.ItemKey(link)
  end
  local invoice = {}
  if GetInboxInvoiceInfo then
    invoice = { GetInboxInvoiceInfo(index) }
  end
  local invoiceType = invoice[1]
  if ty == "sold" then
    -- invoiceType, itemName, buyer, bid, buyout, deposit, cut, moneyDelay, etaTime, notes, count
    if invoiceType == "seller" then
      entry.p = (invoice[4] and invoice[4] > 0) and invoice[4] or (invoice[5] or 0)
      entry.d = invoice[6] or 0
      entry.f = invoice[7] or 0
      entry.o = invoice[3]
      entry.q = invoice[11] or 1
      entry.n = invoice[2] or name
    else
      entry.p = money or 0
    end
  elseif ty == "bought" then
    entry.q = itemCount or invoice[11] or 1
    if invoiceType == "buyer" then
      entry.p = (invoice[4] and invoice[4] > 0) and invoice[4] or (invoice[5] or 0)
      entry.o = invoice[3]
    end
    if itemName then
      entry.n = itemName
    end
  elseif ty == "expired" or ty == "cancelled" then
    entry.q = itemCount or 1
    if itemName then
      entry.n = itemName
    end
  elseif ty == "outbid" then
    entry.p = money or 0
  end
  entry.q = math.max(1, math.floor(entry.q))
  entry.p = math.floor(entry.p)
  return entry
end

--- Reads the inbox and adds the auction mails not seen before. Returns how many were added.
function Acct.ReadInbox(now)
  now = now or time()
  local count = GetInboxNumItems and GetInboxNumItems() or 0
  if count == 0 then
    return 0
  end
  local d = UncboxAHDB or Db.Init()
  local char = U.Me()
  local realm = Db.Realm()
  local seen = d.seenMail[char]
  if not seen then
    seen = {}
    d.seenMail[char] = seen
  end
  local added = 0
  for i = 1, count do
    local e = Acct.ReadMail(i, now)
    if e then
      local b = bucket(e.t)
      -- The send time is worked out from "days left", which wobbles a little: look in the buckets either side too.
      local known = false
      for _, nb in ipairs({ b, b - 1, b + 1 }) do
        if seen[entryId(char, e.ty, e.n, e.q, e.p, nb)] then
          known = true
        end
      end
      if not known then
        local id = entryId(char, e.ty, e.n, e.q, e.p, b)
        seen[id] = now
        e.id = id
        e.c = char
        if not e.k then
          e.k = Acct.KeyForName(e.n)
        end
        Db.AddAccounting(realm, e)
        added = added + 1
      end
    end
  end
  for id, t in pairs(seen) do
    if now - t > KEEP_SEEN then
      seen[id] = nil
    end
  end
  if added > 0 then
    U.Fire("accounting", added)
  end
  return added
end

--- The item key we've seen for an item name, if any (from items the addon has recorded).
function Acct.KeyForName(name)
  for key, info in pairs((UncboxAHDB or {}).items or {}) do
    if info.n == name then
      return key
    end
  end
  return nil
end

-- ---- what you post and buy ----

local seq = 0

local function logEvent(ty, key, name, qty, price, deposit)
  local realm = Db.Realm()
  seq = seq + 1
  local t = time()
  Db.AddAccounting(realm, {
    id = U.Me() .. ":" .. ty .. ":" .. t .. ":" .. seq .. ":" .. (key or name or "?"),
    t = t,
    c = U.Me(),
    ty = ty,
    k = key,
    n = name,
    q = qty,
    p = price,
    d = deposit or 0,
    f = 0,
  })
end

--- Noted when something goes into the auction slot, so StartAuction knows what it posted.
function Acct.NoteSellItem()
  if GetAuctionSellItemInfo then
    local name, _, count, _, _, _, _, stack, total, itemId = GetAuctionSellItemInfo()
    if name then
      ns.sellItem = { name = name, count = count, key = U.ItemKey(itemId) }
    end
  end
end

--- StartAuction(minBid, buyout, runTime, stackSize, numStacks) happened.
function Acct.OnPost(minBid, buyout, runTime, stackSize, numStacks)
  local item = ns.sellItem or {}
  if GetAuctionSellItemInfo then
    local name, _, _, _, _, _, _, _, _, itemId = GetAuctionSellItemInfo()
    if name then
      item = { name = name, key = U.ItemKey(itemId) or item.key }
    end
  end
  local posted = ns.posting
  if posted and posted.key then
    item = { name = posted.name or item.name, key = posted.key }
  end
  local stacks = numStacks or 1
  local size = stackSize or 1
  logEvent("post", item.key, item.name, size * stacks, buyout or 0, 0)
  ns.posting = nil
end

--- PlaceAuctionBid(listType, index, bid) happened.
function Acct.OnBid(listType, index, bid)
  local l = ns.Scan.ReadListing(listType, index)
  if not l then
    return
  end
  logEvent("buy", l.key, l.name, l.count, bid or l.buyout, 0)
end

-- ---- gold ----

--- Notes how much gold each character has, at most every 15 minutes unless it changed.
function Acct.SnapshotGold(force)
  local realm = Db.Realm()
  Db.AddGold(realm, U.Me(), time(), GetMoney and GetMoney() or 0, force and 0 or 900)
end

function Acct.Hook()
  if Acct.hooked then
    return
  end
  Acct.hooked = true
  if hooksecurefunc then
    hooksecurefunc("StartAuction", function(...)
      local ok, err = pcall(Acct.OnPost, ...)
      if not ok then
        U.Print("|cffff5555error|r " .. tostring(err))
      end
    end)
    hooksecurefunc("PlaceAuctionBid", function(...)
      local ok, err = pcall(Acct.OnBid, ...)
      if not ok then
        U.Print("|cffff5555error|r " .. tostring(err))
      end
    end)
    if ClickAuctionSellItemButton then
      hooksecurefunc("ClickAuctionSellItemButton", Acct.NoteSellItem)
    end
  end
end
