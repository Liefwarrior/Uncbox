-- Everything the addon notes about your characters that isn't the auction house itself: item
-- details, what's in your bags and bank, the recipes your professions know, and what vendors
-- charge. Uncbox uses these to work out what to sell and what crafting costs.

local ADDON, ns = ...
local U = ns.Util
local Db = ns.Db

local Collect = {}
ns.Collect = Collect

-- ---- item details ----

local pending = {} -- key -> link, waiting for the game to know the item
local tries = {}
local pumping = false
local PER_FRAME = 100

--- Notes what the game knows about an item: name, quality, item level, class, vendor price, icon, stack size.
--- Returns true when it knew.
function Collect.RecordItem(key, link)
  if not GetItemInfo then
    return false
  end
  local name, _, quality, ilvl, _, _, _, stack, _, icon, vendor, classId, subclassId = GetItemInfo(link or key)
  if not name then
    return false
  end
  Db.SetItemInfo(key, { n = name, q = quality, l = ilvl, c = classId, s = subclassId, v = vendor, i = icon, k = stack })
  return true
end

local function pump()
  local n = 0
  for key, link in pairs(pending) do
    if Collect.RecordItem(key, link) then
      pending[key] = nil
    else
      tries[key] = (tries[key] or 0) + 1
      if tries[key] >= 3 then
        pending[key] = nil
      end
    end
    n = n + 1
    if n >= PER_FRAME then
      break
    end
  end
  if next(pending) then
    U.After(n >= PER_FRAME and 0 or 2, pump)
  else
    pumping = false
  end
end

--- Queues the items of a scan (key -> { name, quality, link }) for their details, a batch per frame.
function Collect.QueueItemInfo(items)
  local d = UncboxAHDB or Db.Init()
  for key, it in pairs(items) do
    Db.SetItemInfo(key, { n = it.name, q = it.quality })
    local have = d.items[key]
    if it.link and not (have and have.v ~= nil and have.l ~= nil) then
      pending[key] = it.link
    end
  end
  if next(pending) and not pumping then
    pumping = true
    U.After(0, pump)
  end
end

--- The game found an item it didn't know; try the waiting ones again.
function Collect.RetryInfo()
  if next(pending) and not pumping then
    pumping = true
    U.After(0, pump)
  end
end

-- ---- bags and bank ----

local function numSlots(bag)
  if C_Container and C_Container.GetContainerNumSlots then
    return C_Container.GetContainerNumSlots(bag)
  end
  return GetContainerNumSlots and GetContainerNumSlots(bag) or 0
end

local function slotLink(bag, slot)
  if C_Container and C_Container.GetContainerItemLink then
    return C_Container.GetContainerItemLink(bag, slot)
  end
  return GetContainerItemLink and GetContainerItemLink(bag, slot)
end

local function slotCount(bag, slot)
  if C_Container and C_Container.GetContainerItemInfo then
    local info = C_Container.GetContainerItemInfo(bag, slot)
    return info and info.stackCount or 1
  end
  local _, count = GetContainerItemInfo(bag, slot)
  return count or 1
end

--- The bag ids to read: your bags (0 to 4), or with bank = true the bank (-1) and its bags.
function Collect.BagIds(bank)
  local bags = NUM_BAG_SLOTS or 4
  local ids = {}
  if bank then
    ids[#ids + 1] = BANK_CONTAINER or -1
    for b = bags + 1, bags + (NUM_BANKBAGSLOTS or 7) do
      ids[#ids + 1] = b
    end
  else
    for b = 0, bags do
      ids[#ids + 1] = b
    end
  end
  return ids
end

--- { [key] = count } for the given bags.
function Collect.Count(ids)
  local out = {}
  for _, bag in ipairs(ids) do
    for slot = 1, numSlots(bag) or 0 do
      local link = slotLink(bag, slot)
      local key = link and U.ItemKey(link)
      if key then
        out[key] = (out[key] or 0) + slotCount(bag, slot)
        Collect.RecordItem(key, link)
      end
    end
  end
  return out
end

--- Saves what you carry (and, with bank = true, what's in the bank).
function Collect.Inventory(bank)
  local realm = Db.Realm()
  local me = U.Me()
  local rec = realm.inv[me] or {}
  rec.t = time()
  rec.bags = Collect.Count(Collect.BagIds(false))
  if bank then
    rec.bank = Collect.Count(Collect.BagIds(true))
    rec.bankT = rec.t
  end
  realm.inv[me] = rec
  return rec
end

--- Your bag contents as a list for the Post tab: { key, name, link, count, quality, stacks = { { bag, slot, count } } }.
function Collect.BagItems()
  local byKey, list = {}, {}
  for _, bag in ipairs(Collect.BagIds(false)) do
    for slot = 1, numSlots(bag) or 0 do
      local link = slotLink(bag, slot)
      local key = link and U.ItemKey(link)
      if key then
        local entry = byKey[key]
        if not entry then
          local name, _, quality = GetItemInfo(link)
          entry = { key = key, link = link, name = name or key, quality = quality or 1, count = 0, stacks = {} }
          byKey[key] = entry
          list[#list + 1] = entry
        end
        local count = slotCount(bag, slot)
        entry.count = entry.count + count
        entry.stacks[#entry.stacks + 1] = { bag = bag, slot = slot, count = count }
      end
    end
  end
  table.sort(list, function(a, b)
    return a.name < b.name
  end)
  return list
end

-- ---- recipes ----

local TRADE_SKILL = {
  line = function()
    return GetTradeSkillLine and GetTradeSkillLine()
  end,
  num = function()
    return GetNumTradeSkills and GetNumTradeSkills() or 0
  end,
  info = function(i)
    local name, kind, _, expanded = GetTradeSkillInfo(i)
    return name, kind, expanded
  end,
  itemLink = function(i)
    return GetTradeSkillItemLink and GetTradeSkillItemLink(i)
  end,
  made = function(i)
    if GetTradeSkillNumMade then
      local low, high = GetTradeSkillNumMade(i)
      if low then
        return (low + (high or low)) / 2
      end
    end
    return 1
  end,
  numReagents = function(i)
    return GetTradeSkillNumReagents and GetTradeSkillNumReagents(i) or 0
  end,
  reagent = function(i, j)
    local name, _, count = GetTradeSkillReagentInfo(i, j)
    return name, count, GetTradeSkillReagentItemLink and GetTradeSkillReagentItemLink(i, j)
  end,
  expand = function(i)
    if ExpandTradeSkillSubClass then
      ExpandTradeSkillSubClass(i)
    end
  end,
  collapse = function(i)
    if CollapseTradeSkillSubClass then
      CollapseTradeSkillSubClass(i)
    end
  end,
}

local CRAFT = {
  line = function()
    return GetCraftDisplaySkillLine and GetCraftDisplaySkillLine() or (GetCraftName and GetCraftName())
  end,
  num = function()
    return GetNumCrafts and GetNumCrafts() or 0
  end,
  info = function(i)
    local name, _, kind, _, expanded = GetCraftInfo(i)
    return name, kind, expanded
  end,
  itemLink = function(i)
    return GetCraftItemLink and GetCraftItemLink(i)
  end,
  made = function()
    return 1
  end,
  numReagents = function(i)
    return GetCraftNumReagents and GetCraftNumReagents(i) or 0
  end,
  reagent = function(i, j)
    local name, _, count = GetCraftReagentInfo(i, j)
    return name, count, GetCraftReagentItemLink and GetCraftReagentItemLink(i, j)
  end,
  expand = function(i)
    if ExpandCraftSkillLine then
      ExpandCraftSkillLine(i)
    end
  end,
  collapse = function(i)
    if CollapseCraftSkillLine then
      CollapseCraftSkillLine(i)
    end
  end,
}

--- Notes every recipe in the open profession window: what it makes, how many, and its reagents.
--- Collapsed headers are opened for the reading and closed again. Recipes that make no item
--- (enchants) are skipped. Returns how many were saved.
local function readRecipes(api)
  local profession = api.line()
  if not profession or profession == "" or profession == "UNKNOWN" then
    return 0
  end
  local collapsed = {}
  for i = api.num(), 1, -1 do
    local name, kind, expanded = api.info(i)
    if kind == "header" and not expanded then
      collapsed[name] = true
      api.expand(i)
    end
  end
  local d = UncboxAHDB or Db.Init()
  local book = d.recipes[profession]
  if not book then
    book = {}
    d.recipes[profession] = book
  end
  local saved = 0
  for i = 1, api.num() do
    local name, kind = api.info(i)
    if name and kind ~= "header" then
      local key = U.ItemKey(api.itemLink(i))
      if key then
        local flat = {}
        for j = 1, api.numReagents(i) do
          local _, count, link = api.reagent(i, j)
          local rkey = link and U.ItemKey(link)
          if rkey and count then
            flat[#flat + 1] = rkey
            flat[#flat + 1] = count
            Collect.RecordItem(rkey, link)
          end
        end
        if #flat > 0 then
          book[key] = { n = name, m = api.made(i), r = flat }
          saved = saved + 1
        end
      end
    end
  end
  for i = api.num(), 1, -1 do
    local name, kind = api.info(i)
    if kind == "header" and collapsed[name] then
      api.collapse(i)
    end
  end
  return saved
end

function Collect.TradeSkill()
  return readRecipes(TRADE_SKILL)
end

function Collect.Craft()
  return readRecipes(CRAFT)
end

-- ---- vendors ----

--- Notes the price of every item this vendor always has in stock (limited stock is skipped).
function Collect.Merchant()
  if not GetMerchantNumItems then
    return 0
  end
  local d = UncboxAHDB or Db.Init()
  local saved = 0
  for i = 1, GetMerchantNumItems() do
    local name, _, price, quantity, available, _, extended = GetMerchantItemInfo(i)
    if name and available == -1 and not extended and price and price > 0 then
      local key = U.ItemKey(GetMerchantItemLink and GetMerchantItemLink(i))
      if key then
        d.vendorBuy[key] = math.floor(price / math.max(1, quantity or 1))
        saved = saved + 1
      end
    end
  end
  return saved
end
