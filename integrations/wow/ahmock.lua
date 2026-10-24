-- A stand-in for the parts of the WoW Classic Era API that the UncboxAH addon calls, so the addon
-- can run in a plain Lua interpreter (see ah.test.ts). Not shipped with the addon.
--
-- Mock.* holds the fake world: the auctions on the house, your mail, your bags, the clock. The
-- tests change it and call Mock.deliver() when "the server answers" a query, Mock.pump() to run the
-- addon's timers, and Mock.fire(event) to send a game event.

Mock = {
  now = 1700000000,
  realm = "Stalagg",
  faction = "Alliance",
  zone = "Stormwind City",
  name = "Lief",
  money = 123456,
  auctions = {}, -- what's on the auction house (everyone's)
  owned = {}, -- your own auctions, as the "owner" list
  items = {}, -- id -> { name, quality, ilvl, class, sub, vendor, stack, icon }
  queries = {}, -- every QueryAuctionItems call
  calls = {}, -- StartAuction, PlaceAuctionBid, CancelAuction, ...
  inbox = {},
  bags = {}, -- [bag] = { [slot] = { id, count } }
  chat = {},
  timers = {},
  canQuery = true,
  canAll = true,
  layout = "old",
  frames = {},
}

-- ---- Lua 5.1 things the addon may rely on ----
unpack = unpack or table.unpack
table.getn = table.getn or function(t) return #t end
strsplit = strsplit or function(sep, s) return s end
wipe = wipe or function(t) for k in pairs(t) do t[k] = nil end return t end
tinsert, tremove = table.insert, table.remove
format = string.format
floor = math.floor
loadstring = loadstring or load

-- ---- clock, timers ----
function time() return Mock.now end
function GetTime() return Mock.now end
function debugprofilestop() return 0 end
Mock.clock = 0 -- seconds of fake time; only Mock.advance moves it
C_Timer = { After = function(sec, fn) Mock.timers[#Mock.timers + 1] = { fn = fn, due = Mock.clock + (sec or 0) } end }

local function takeDue()
  for i, t in ipairs(Mock.timers) do
    if t.due <= Mock.clock then
      table.remove(Mock.timers, i)
      return t.fn
    end
  end
end

--- Runs the timers that are due (and the ones they add) until none are (up to `limit` rounds, so a loop that never ends fails).
function Mock.pump(limit)
  limit = limit or 5000
  local rounds = 0
  while true do
    local fn = takeDue()
    if not fn then return rounds end
    rounds = rounds + 1
    assert(rounds <= limit, "timers never settled")
    fn()
  end
end

--- Runs only the timers that are due right now (not the ones they add).
function Mock.step()
  local due = {}
  while true do
    local fn = takeDue()
    if not fn then break end
    due[#due + 1] = fn
  end
  for _, fn in ipairs(due) do fn() end
  return #due
end

--- Lets `seconds` go by and runs what comes due.
function Mock.advance(seconds)
  Mock.clock = Mock.clock + seconds
  return Mock.pump()
end

function Mock.fire(event, ...)
  ns.Core.OnEvent(event, ...)
end

-- ---- chat and the player ----
DEFAULT_CHAT_FRAME = { AddMessage = function(_, text) Mock.chat[#Mock.chat + 1] = text end }
function GetRealmName() return Mock.realm end
function UnitName() return Mock.name end
function UnitFactionGroup() return Mock.faction end
function GetZoneText() return Mock.zone end
function GetSubZoneText() return "" end
function GetMoney() return Mock.money end

-- ---- game strings the addon reads ----
AUCTION_SOLD_MAIL_SUBJECT = "Auction successful: %s"
AUCTION_EXPIRED_MAIL_SUBJECT = "Auction expired: %s"
AUCTION_WON_MAIL_SUBJECT = "Auction won: %s"
AUCTION_OUTBID_MAIL_SUBJECT = "Outbid on %s"
AUCTION_REMOVED_MAIL_SUBJECT = "Auction cancelled: %s"

-- ---- items ----
function Mock.link(id, suffix)
  local it = Mock.items[id] or { name = "Item " .. id }
  return "|cffffffff|Hitem:" .. id .. ":0:0:0:0:0:" .. (suffix or 0) .. ":0:60|h[" .. it.name .. "]|h|r"
end

function Mock.item(id, name, extra)
  local it = extra or {}
  it.name = name
  it.quality = it.quality or 1
  it.ilvl = it.ilvl or 10
  it.class = it.class or 7
  it.sub = it.sub or 0
  it.vendor = it.vendor or 0
  it.stack = it.stack or 20
  it.icon = it.icon or (100000 + id)
  Mock.items[id] = it
end

function GetItemInfo(x)
  local id = type(x) == "number" and x or tonumber(string.match(tostring(x), "item:(%d+)"))
  local it = id and Mock.items[id]
  if not it then return nil end
  return it.name, Mock.link(id), it.quality, it.ilvl, 1, "Misc", "Junk", it.stack, "", it.icon, it.vendor, it.class, it.sub
end

-- ---- the auction house ----
--- Puts an auction on the house. t = { id, name, count, buyout (the stack's), minBid, owner, suffix, timeLeft }.
function Mock.auction(t)
  if not Mock.items[t.id] then Mock.item(t.id, t.name or ("Item " .. t.id)) end
  local a = {
    id = t.id, name = Mock.items[t.id].name, count = t.count or 1, buyout = t.buyout or 0,
    minBid = t.minBid or t.buyout or 1, owner = t.owner, suffix = t.suffix or 0, timeLeft = t.timeLeft or 3,
    saleStatus = t.saleStatus or 0,
  }
  Mock.auctions[#Mock.auctions + 1] = a
  return a
end

local function info(a)
  return a.name, "icon", a.count, Mock.items[a.id].quality, true, 1, "REQ", a.minBid, 1, a.buyout, 0, "", "",
    a.owner, a.owner, a.saleStatus, a.id, true
end

Mock.list, Mock.total = {}, 0

function CanSendAuctionQuery() return Mock.canQuery, Mock.canAll end

function QueryAuctionItems(...)
  local n = select("#", ...)
  local a = { ... }
  local q
  if Mock.layout == "new" then
    assert(n == 9, "the new layout takes 9 arguments, got " .. n)
    q = { text = a[1], page = a[4], getAll = a[7], exact = a[8] }
  else
    assert(n == 11, "the old layout takes 11 arguments, got " .. n)
    q = { text = a[1], page = a[7], getAll = a[10], exact = a[11] }
  end
  assert(type(q.page) == "number", "page must be a number")
  Mock.queries[#Mock.queries + 1] = q
end

--- The auction house answers the last query, and fires AUCTION_ITEM_LIST_UPDATE.
function Mock.deliver()
  local q = Mock.queries[#Mock.queries]
  local matches = {}
  for _, a in ipairs(Mock.auctions) do
    if q.getAll or q.text == "" or (q.exact and a.name == q.text) or (not q.exact and string.find(a.name, q.text, 1, true)) then
      matches[#matches + 1] = a
    end
  end
  Mock.total = #matches
  Mock.list = {}
  if q.getAll then
    Mock.list = matches
  else
    for i = q.page * 50 + 1, math.min(#matches, q.page * 50 + 50) do
      Mock.list[#Mock.list + 1] = matches[i]
    end
  end
  Mock.fire("AUCTION_ITEM_LIST_UPDATE")
end

local function pick(listType)
  return listType == "owner" and Mock.owned or Mock.list
end

function GetNumAuctionItems(listType)
  local l = pick(listType)
  return #l, listType == "owner" and #l or Mock.total
end
function GetAuctionItemInfo(listType, i)
  local a = pick(listType)[i]
  if not a then return nil end
  return info(a)
end
function GetAuctionItemLink(listType, i)
  local a = pick(listType)[i]
  return a and Mock.link(a.id, a.suffix)
end
function GetAuctionItemTimeLeft(listType, i)
  local a = pick(listType)[i]
  return a and a.timeLeft
end
function GetOwnerAuctionItems() Mock.calls[#Mock.calls + 1] = { "GetOwnerAuctionItems" } end

function StartAuction(...) Mock.calls[#Mock.calls + 1] = { "StartAuction", ... } end
function PlaceAuctionBid(...) Mock.calls[#Mock.calls + 1] = { "PlaceAuctionBid", ... } end
function CancelAuction(i) Mock.calls[#Mock.calls + 1] = { "CancelAuction", i } end

-- The sell slot
function ClickAuctionSellItemButton()
  Mock.sell = Mock.cursor
  Mock.cursor = nil
  Mock.calls[#Mock.calls + 1] = { "ClickAuctionSellItemButton" }
end
function GetAuctionSellItemInfo()
  local s = Mock.sell
  if not s then return nil end
  local it = Mock.items[s.id]
  return it.name, "icon", s.count, it.quality, true, 0, 0, s.count, s.count, s.id
end
function ClearCursor() Mock.cursor = nil end

-- ---- bags (the older global API) ----
function GetContainerNumSlots(bag) local b = Mock.bags[bag]; return b and (b.size or 16) or 0 end
function GetContainerItemLink(bag, slot)
  local s = Mock.bags[bag] and Mock.bags[bag][slot]
  return s and Mock.link(s.id)
end
function GetContainerItemInfo(bag, slot)
  local s = Mock.bags[bag] and Mock.bags[bag][slot]
  if not s then return nil end
  return "icon", s.count
end
function PickupContainerItem(bag, slot)
  Mock.cursor = Mock.bags[bag] and Mock.bags[bag][slot]
  Mock.calls[#Mock.calls + 1] = { "PickupContainerItem", bag, slot }
end
NUM_BAG_SLOTS = 4
NUM_BANKBAGSLOTS = 7
BANK_CONTAINER = -1

-- ---- mail ----
--- Puts a mail in the inbox. m = { subject, money, daysLeft, item = { id, count }, invoice = { ...GetInboxInvoiceInfo values } }.
function Mock.mail(m)
  m.daysLeft = m.daysLeft or 29.5
  m.money = m.money or 0
  Mock.inbox[#Mock.inbox + 1] = m
end
function GetInboxNumItems() return #Mock.inbox end
function GetInboxHeaderInfo(i)
  local m = Mock.inbox[i]
  return "icon", "stationery", m.sender or "Auction House", m.subject, m.money, 0, m.daysLeft, m.item ~= nil, false, false, false, false, false
end
function GetInboxText(i) Mock.inbox[i].read = true end
function GetInboxItem(i, n)
  local m = Mock.inbox[i]
  if not m.item then return nil end
  local it = Mock.items[m.item.id]
  return it.name, m.item.id, "icon", m.item.count, it.quality, true
end
function GetInboxItemLink(i, n)
  local m = Mock.inbox[i]
  return m.item and Mock.link(m.item.id)
end
function GetInboxInvoiceInfo(i)
  local m = Mock.inbox[i]
  if not m.invoice or not m.read then return nil end
  return table.unpack(m.invoice)
end

-- ---- crafting, vendors ----
Mock.skill = nil
function GetTradeSkillLine() return Mock.skill and Mock.skill.name end
function GetNumTradeSkills() return Mock.skill and #Mock.skill.rows or 0 end
function GetTradeSkillInfo(i)
  local r = Mock.skill.rows[i]
  return r.name, r.header and "header" or "optimal", 0, r.expanded
end
function GetTradeSkillItemLink(i) local r = Mock.skill.rows[i]; return r.id and Mock.link(r.id) end
function GetTradeSkillNumMade(i) local r = Mock.skill.rows[i]; return r.made or 1, r.made or 1 end
function GetTradeSkillNumReagents(i) local r = Mock.skill.rows[i]; return r.reagents and #r.reagents or 0 end
function GetTradeSkillReagentInfo(i, j)
  local re = Mock.skill.rows[i].reagents[j]
  return Mock.items[re[1]].name, "icon", re[2], re[2]
end
function GetTradeSkillReagentItemLink(i, j) return Mock.link(Mock.skill.rows[i].reagents[j][1]) end
function ExpandTradeSkillSubClass(i) Mock.skill.rows[i].expanded = true end
function CollapseTradeSkillSubClass(i) Mock.skill.rows[i].expanded = false end

Mock.merchant = {}
function GetMerchantNumItems() return #Mock.merchant end
function GetMerchantItemInfo(i)
  local m = Mock.merchant[i]
  return Mock.items[m.id].name, "icon", m.price, m.quantity or 1, m.available or -1, true, m.extended
end
function GetMerchantItemLink(i) return Mock.link(Mock.merchant[i].id) end

-- ---- hooks and frames ----
function hooksecurefunc(name, fn)
  local orig = _G[name]
  _G[name] = function(...)
    local r = { orig and orig(...) }
    fn(...)
    return table.unpack(r)
  end
end

local Frame = {}
Frame.__index = function(t, k)
  local m = rawget(Frame, k)
  if m then return m end
  if type(k) == "string" and k:match("^%u") then
    return function() end -- every other method (they start with a capital) does nothing
  end
  return nil
end
function Frame:SetScript(name, fn) self.scripts[name] = fn end
function Frame:GetScript(name) return self.scripts[name] end
function Frame:HookScript(name, fn) self.hooks[name] = self.hooks[name] or {}; table.insert(self.hooks[name], fn) end
function Frame:RegisterEvent(e) self.events[e] = true end
function Frame:SetText(t) self.text = t end
function Frame:GetText() return self.text or "" end
function Frame:SetID(i) self.id = i end
function Frame:GetID() return self.id or 0 end
function Frame:Show() self.shown = true end
function Frame:Hide() self.shown = false end
function Frame:SetShown(s) self.shown = s end
function Frame:IsShown() return self.shown and true or false end
function Frame:GetParent() return self.parent end
function Frame:GetFrameLevel() return 1 end
function Frame:CreateFontString() return CreateFrame("FontString") end
function Frame:CreateTexture() return CreateFrame("Texture") end

function CreateFrame(kind, name, parent)
  local f = setmetatable({ kind = kind, parent = parent, scripts = {}, hooks = {}, events = {} }, Frame)
  if name then _G[name] = f end
  Mock.frames[#Mock.frames + 1] = f
  return f
end

-- tooltips
function Mock.tooltip(link, owner)
  local tip = CreateFrame("GameTooltip")
  tip.lines = {}
  tip.GetItem = function() return "name", link end
  tip.GetOwner = function() return owner end
  tip.AddDoubleLine = function(self, l, r) self.lines[#self.lines + 1] = { l, r } end
  return tip
end

-- ---- looking at the addon's data from outside ----
local function isArray(t)
  local n = 0
  for _ in pairs(t) do n = n + 1 end
  for i = 1, n do if t[i] == nil then return false end end
  return true
end

local function num(v)
  if v == math.floor(v) then return string.format("%d", v) end
  return string.format("%.14g", v)
end

--- JSON for a Lua value (tests read results through it).
function json(v)
  local t = type(v)
  if v == nil then return "null" end
  if t == "number" then return num(v) end
  if t == "boolean" then return tostring(v) end
  if t == "string" then return '"' .. v:gsub('[%c"\\]', function(c) return string.format("\\u%04x", c:byte()) end) .. '"' end
  if t ~= "table" then return "null" end
  if isArray(v) then
    local out = {}
    for i = 1, #v do out[i] = json(v[i]) end
    return "[" .. table.concat(out, ",") .. "]"
  end
  local keys = {}
  for k in pairs(v) do keys[#keys + 1] = k end
  table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
  local out = {}
  for _, k in ipairs(keys) do out[#out + 1] = json(tostring(k)) .. ":" .. json(v[k]) end
  return "{" .. table.concat(out, ",") .. "}"
end

--- A global as WoW writes it into SavedVariables (so the server's parser reads exactly this shape).
function Mock.serialize(name)
  local function str(s)
    return '"' .. s:gsub('[\\"]', "\\%0"):gsub("\n", "\\n") .. '"'
  end
  local function write(v, indent)
    local t = type(v)
    if t == "number" then return num(v) end
    if t == "boolean" then return tostring(v) end
    if t == "string" then return str(v) end
    local inner = indent .. "\t"
    local out = { "{" }
    if isArray(v) and next(v) ~= nil then
      for i = 1, #v do out[#out + 1] = inner .. write(v[i], inner) .. ", -- [" .. i .. "]" end
    else
      local keys = {}
      for k in pairs(v) do keys[#keys + 1] = k end
      table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
      for _, k in ipairs(keys) do
        local key = type(k) == "number" and ("[" .. num(k) .. "]") or ("[" .. str(k) .. "]")
        out[#out + 1] = inner .. key .. " = " .. write(v[k], inner) .. ","
      end
    end
    out[#out + 1] = indent .. "}"
    return table.concat(out, "\n")
  end
  return name .. " = " .. write(_G[name], "") .. "\n"
end
