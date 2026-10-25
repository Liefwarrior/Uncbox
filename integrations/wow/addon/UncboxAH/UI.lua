-- The "Uncbox" tab on the auction house window. Plain Blizzard templates, no libraries:
--
--   Post       pick an item from your bags; Uncbox suggests a price from your posting rules. One click posts one stack.
--   Cancel     finds your undercut auctions; each click cancels the next.
--   Shopping   runs a shopping list or the deals search; each click buys one listing.
--
-- The game only lets posting, cancelling and buying happen on a click, which is why they work one at a time.

local ADDON, ns = ...
local U = ns.Util
local Db = ns.Db
local Rules = ns.Rules
local Scan = ns.Scan
local A = ns.Actions
local Collect = ns.Collect

local UI = {}
ns.UI = UI

local ROWS = 12
local ROW_H = 22

local function button(parent, text, w, h)
  local b = CreateFrame("Button", nil, parent, "UIPanelButtonTemplate")
  b:SetSize(w, h or 22)
  b:SetText(text)
  return b
end

local function label(parent, template, justify)
  local f = parent:CreateFontString(nil, "OVERLAY", template or "GameFontHighlightSmall")
  f:SetJustifyH(justify or "LEFT")
  return f
end

local function qualityColor(q)
  local c = ITEM_QUALITY_COLORS and ITEM_QUALITY_COLORS[q or 1]
  return c and c.hex or "|cffffffff"
end

--- A column of clickable rows. fill(row, data) writes a row's text.
local function rowList(parent, x, y, w, count, onClick)
  local list = { rows = {}, offset = 0, data = {} }
  for i = 1, count do
    local r = CreateFrame("Button", nil, parent)
    r:SetSize(w, ROW_H)
    r:SetPoint("TOPLEFT", parent, "TOPLEFT", x, y - (i - 1) * ROW_H)
    r.text = label(r, "GameFontHighlight")
    r.text:SetPoint("LEFT", r, "LEFT", 4, 0)
    r.text:SetPoint("RIGHT", r, "RIGHT", -4, 0)
    r.hl = r:CreateTexture(nil, "HIGHLIGHT")
    r.hl:SetAllPoints()
    r.hl:SetColorTexture(1, 1, 1, 0.12)
    r:SetScript("OnClick", function(self)
      if self.item and onClick then
        onClick(self.item, self)
      end
    end)
    list.rows[i] = r
  end
  function list.Set(data, fill)
    list.data = data
    list.fill = fill or list.fill
    if list.offset > math.max(0, #data - count) then
      list.offset = math.max(0, #data - count)
    end
    for i, r in ipairs(list.rows) do
      local d = data[i + list.offset]
      r.item = d
      if d then
        list.fill(r, d)
        r:Show()
      else
        r.text:SetText("")
        r:Hide()
      end
    end
  end
  function list.Scroll(by)
    list.offset = math.max(0, math.min(math.max(0, #list.data - count), list.offset + by))
    list.Set(list.data)
  end
  return list
end

-- ---- the Post tab ----

local function buildPost(panel)
  local f = CreateFrame("Frame", nil, panel)
  f:SetAllPoints()
  local st = { sel = nil, hours = 24 }

  local list
  list = rowList(f, 6, -34, 250, ROWS, function(entry)
    UI.SelectItem(entry)
  end)
  f.list = list
  local up = button(f, "Up", 60)
  up:SetPoint("TOPLEFT", f, "TOPLEFT", 6, -34 - ROWS * ROW_H - 4)
  up:SetScript("OnClick", function()
    list.Scroll(-ROWS + 2)
  end)
  local down = button(f, "Down", 60)
  down:SetPoint("LEFT", up, "RIGHT", 4, 0)
  down:SetScript("OnClick", function()
    list.Scroll(ROWS - 2)
  end)
  local refresh = button(f, "Refresh bags", 100)
  refresh:SetPoint("LEFT", down, "RIGHT", 4, 0)
  refresh:SetScript("OnClick", function()
    UI.RefreshBags()
  end)
  f.hint = label(f, "GameFontNormal")
  f.hint:SetPoint("TOPLEFT", f, "TOPLEFT", 6, -10)
  f.hint:SetText("Your bags")

  local x = 280
  f.name = label(f, "GameFontNormalLarge")
  f.name:SetPoint("TOPLEFT", f, "TOPLEFT", x, -10)
  f.info = label(f, "GameFontHighlight")
  f.info:SetPoint("TOPLEFT", f, "TOPLEFT", x, -40)
  f.info:SetWidth(480)
  f.info:SetHeight(100)
  f.info:SetJustifyV("TOP")

  local function field(text, row, width, initial)
    local l = label(f, "GameFontNormal")
    l:SetPoint("TOPLEFT", f, "TOPLEFT", x, -150 - (row - 1) * 30)
    l:SetText(text)
    local e = CreateFrame("EditBox", nil, f, "InputBoxTemplate")
    e:SetSize(width, 20)
    e:SetPoint("TOPLEFT", f, "TOPLEFT", x + 130, -146 - (row - 1) * 30)
    e:SetAutoFocus(false)
    e:SetText(initial or "")
    e:SetScript("OnEscapePressed", e.ClearFocus)
    e:SetScript("OnEnterPressed", e.ClearFocus)
    return e
  end
  f.price = field("Price each", 1, 140)
  f.size = field("Stack size", 2, 50, "1")
  f.stacks = field("Stacks to post", 3, 50, "1")
  local dur = button(f, "24 hours", 90)
  dur:SetPoint("TOPLEFT", f, "TOPLEFT", x + 130, -146 - 3 * 30)
  local durLabel = label(f, "GameFontNormal")
  durLabel:SetPoint("TOPLEFT", f, "TOPLEFT", x, -150 - 3 * 30)
  durLabel:SetText("Duration")
  dur:SetScript("OnClick", function()
    st.hours = st.hours == 12 and 24 or st.hours == 24 and 48 or 12
    dur:SetText(st.hours .. " hours")
  end)
  f.dur = dur

  local check = button(f, "Check prices", 110)
  check:SetPoint("TOPLEFT", f, "TOPLEFT", x, -146 - 4 * 30 - 6)
  check:SetScript("OnClick", function()
    UI.CheckSelected()
  end)
  local post = button(f, "Post", 110, 26)
  post:SetPoint("LEFT", check, "RIGHT", 10, 0)
  post:SetScript("OnClick", function()
    UI.PostSelected()
  end)
  f.post = post
  f.result = label(f, "GameFontHighlight")
  f.result:SetPoint("TOPLEFT", check, "BOTTOMLEFT", 0, -10)
  f.result:SetWidth(480)
  f.state = st
  return f
end

function UI.RefreshBags()
  local f = UI.post
  local items = {}
  for _, e in ipairs(Collect.BagItems()) do
    local item = Rules.Item(e.key)
    if item then
      items[#items + 1] = e
    end
  end
  f.items = items
  f.list.Set(items, function(row, e)
    local item = Rules.Item(e.key)
    row.text:SetText(qualityColor(e.quality) .. e.name .. "|r  x" .. e.count .. "   " .. U.Money(item and (item.market or item.minBuyout) or 0))
  end)
  f.hint:SetText(#items == 0 and "Nothing in your bags has a price yet. Run a scan." or "Your bags")
end

function UI.SelectItem(entry)
  local f = UI.post
  f.state.sel = entry
  f.name:SetText(qualityColor(entry.quality) .. entry.name .. "|r  x" .. entry.count)
  local plan = A.PostPlan(entry.key, entry.count)
  f.state.plan = plan
  if not plan then
    f.info:SetText("Uncbox has no prices for this item.")
    return
  end
  f.price:SetText(plan.price and U.Money(plan.price) or "")
  f.size:SetText(tostring(plan.stackSize))
  f.stacks:SetText(tostring(math.max(1, plan.stacks)))
  f.state.hours = plan.duration
  f.dur:SetText(plan.duration .. " hours")
  UI.ShowPlan(plan)
end

local WHY = {
  undercut = "undercutting the lowest seller",
  match = "matching your own lowest auction",
  ["no competition"] = "nobody else is selling it, so the normal price",
  ["below min"] = "undercutting would go below your minimum, so the normal price",
  capped = "capped at your maximum price",
  ["no price"] = "no price",
}

function UI.ShowPlan(plan)
  local f = UI.post
  local lines = {}
  lines[#lines + 1] = "Market value: " .. (plan.market and U.Money(plan.market, true) or "unknown")
  lines[#lines + 1] = "Lowest other seller: " .. (plan.lowest and U.Money(plan.lowest, true) or "none seen")
  if plan.seen then
    lines[#lines + 1] = "Seen " .. U.Age(time() - plan.seen) .. " ago. Check prices to look again."
  end
  lines[#lines + 1] = "Suggested: " .. (plan.price and U.Money(plan.price, true) or "-") .. " (" .. (WHY[plan.why] or plan.why or "") .. ")"
  lines[#lines + 1] = plan.fromGroup and "Using your group's posting rules." or "No group for this item: using a standard rule."
  f.info:SetText(table.concat(lines, "\n"))
end

function UI.CheckSelected()
  local f = UI.post
  local sel = f.state.sel
  if not sel then
    return
  end
  local ok = A.CheckCompetition(sel.key, sel.name, function()
    local plan = A.PostPlan(sel.key, sel.count)
    f.state.plan = plan
    if plan then
      f.price:SetText(plan.price and U.Money(plan.price) or "")
      UI.ShowPlan(plan)
    end
  end)
  f.result:SetText(ok and "Looking up prices..." or "Wait for the other scan to finish.")
end

function UI.PostSelected()
  local f = UI.post
  local sel = f.state.sel
  if not sel then
    return
  end
  local price = U.ParseMoney(f.price:GetText())
  local size = tonumber(f.size:GetText()) or 1
  local stacks = tonumber(f.stacks:GetText()) or 1
  if stacks < 1 then
    f.result:SetText("Nothing left to post.")
    return
  end
  local ok, info = A.PostOne(sel.key, price, size, f.state.hours)
  if ok then
    f.stacks:SetText(tostring(stacks - 1))
    f.result:SetText("Posted " .. info .. " at " .. U.Money(price, true) .. " each.")
    U.After(0.5, function()
      UI.RefreshBags()
    end)
  else
    f.result:SetText(info)
  end
end

-- ---- the Cancel tab ----

local function buildCancel(panel)
  local f = CreateFrame("Frame", nil, panel)
  f:SetAllPoints()
  local scanBtn = button(f, "Scan my auctions", 140, 24)
  scanBtn:SetPoint("TOPLEFT", f, "TOPLEFT", 6, -8)
  scanBtn:SetScript("OnClick", function()
    f.summary:SetText("Looking at your auctions...")
    local ok = A.CancelScan(function(list)
      f.summary:SetText(#list == 0 and "None of your auctions are undercut." or (#list .. " of your auctions are undercut."))
    end)
    if not ok then
      f.summary:SetText("Wait for the other scan to finish.")
    end
  end)
  local cancel = button(f, "Cancel next", 140, 24)
  cancel:SetPoint("LEFT", scanBtn, "RIGHT", 10, 0)
  cancel:SetScript("OnClick", function()
    local ok, info = A.CancelNext()
    if not ok then
      f.summary:SetText(info)
    end
  end)
  f.summary = label(f, "GameFontHighlight")
  f.summary:SetPoint("LEFT", cancel, "RIGHT", 12, 0)
  f.list = rowList(f, 6, -44, 780, ROWS + 2)
  f.list.Set({}, function(row, c)
    row.text:SetText(qualityColor(1) .. c.name .. "|r  x" .. c.count .. "   yours " .. U.Money(c.price) .. "   lowest " .. U.Money(c.lowest) .. "   repost at " .. U.Money(c.newPrice or 0))
  end)
  U.On("cancellist", function(list)
    f.list.Set(list)
  end)
  return f
end

-- ---- the Shopping tab ----

local function buildShopping(panel)
  local f = CreateFrame("Frame", nil, panel)
  f:SetAllPoints()
  f.buttons = {}
  f.summary = label(f, "GameFontHighlight")
  f.summary:SetPoint("TOPLEFT", f, "TOPLEFT", 6, -40)
  f.summary:SetText("Pick a shopping list, or look for deals. Click a result to buy it.")
  f.list = rowList(f, 6, -62, 780, ROWS, function(result)
    if result.listing.seller and Db.IsMine(result.listing.seller) then
      return
    end
    local what, why = A.Buy(result)
    if what == "searching" then
      f.summary:SetText("Checking the listing is still there. Click it again to buy.")
    elseif what == "bought" then
      f.summary:SetText("Bought " .. result.name .. ".")
    elseif not what then
      f.summary:SetText(why)
    end
  end)
  f.list.Set({}, function(row, r)
    local mark = r.ready and "|cff55ff55ready|r  " or r.gone and "|cffff5555gone|r  " or ""
    row.text:SetText(mark .. qualityColor(1) .. r.name .. "|r  x" .. (r.listing.count or 1) .. "   " .. U.Money(r.price) .. " each" .. (r.percent and ("   " .. math.floor(r.percent * 100 + 0.5) .. "% of market") or ""))
  end)
  U.On("results", function(results)
    f.list.Set(results)
  end)
  return f
end

function UI.RefreshLists()
  local f = UI.shop
  for _, b in ipairs(f.buttons) do
    b:Hide()
  end
  local lists = A.Lists()
  local x = 6
  local function place(i, text, which)
    local b = f.buttons[i]
    if not b then
      b = button(f, text, 120, 24)
      f.buttons[i] = b
    end
    b:SetText(text)
    b:ClearAllPoints()
    b:SetPoint("TOPLEFT", f, "TOPLEFT", x, -8)
    b:SetScript("OnClick", function()
      local ok, why = A.Shop(which, function(results)
        f.summary:SetText(#results == 0 and "Nothing worth buying right now." or (#results .. " listings worth buying."))
      end)
      f.summary:SetText(ok and "Searching..." or why)
    end)
    b:Show()
    x = x + 126
  end
  local i = 0
  for n, l in ipairs(lists) do
    if n <= 5 then
      i = i + 1
      place(i, l.name, n)
    end
  end
  place(i + 1, "Deals", "deals")
end

-- ---- the window ----

local MODES = { "post", "cancel", "shop" }

function UI.Show(mode)
  for _, m in ipairs(MODES) do
    if UI[m] then
      UI[m]:SetShown(m == mode)
    end
  end
  UI.mode = mode
  if mode == "post" then
    UI.RefreshBags()
  elseif mode == "shop" then
    UI.RefreshLists()
  end
end

--- The line along the bottom: how old the scan and the prices are, whether a scan is running.
function UI.Status()
  local realm = Db.Realm()
  local last = Db.LastFullScan(realm)
  local now = time()
  local text = "Last full scan: " .. (last and (U.Age(now - last) .. " ago") or "never")
  local age = Rules.DataAge(now)
  text = text .. "   |   Prices from Uncbox: " .. (age and (U.Age(age) .. " old") or "none yet (open Uncbox, then /reload)")
  local st = Scan.state
  if st then
    local p = Scan.Progress()
    text = text .. "   |   " .. (st.kind == "full" and "Full scan" or "Searching") .. (p and (" " .. math.floor(p * 100) .. "%") or "...")
  else
    local can, left = Scan.CanFull()
    text = text .. "   |   " .. (can and "full scan ready" or ("next full scan in " .. U.Age(left)))
  end
  return text
end

function UI.Build()
  if UI.panel or not AuctionFrame then
    return
  end
  local panel = CreateFrame("Frame", "UncboxAHPanel", AuctionFrame)
  panel:SetPoint("TOPLEFT", AuctionFrame, "TOPLEFT", 12, -68)
  panel:SetPoint("BOTTOMRIGHT", AuctionFrame, "BOTTOMRIGHT", -10, 36)
  panel:SetFrameLevel(AuctionFrame:GetFrameLevel() + 5)
  local bg = panel:CreateTexture(nil, "BACKGROUND")
  bg:SetAllPoints()
  bg:SetColorTexture(0.04, 0.045, 0.06, 0.97)
  panel:Hide()
  UI.panel = panel

  local body = CreateFrame("Frame", nil, panel)
  body:SetPoint("TOPLEFT", panel, "TOPLEFT", 0, -28)
  body:SetPoint("BOTTOMRIGHT", panel, "BOTTOMRIGHT", 0, 30)

  local x = 6
  for _, m in ipairs({ { "post", "Post" }, { "cancel", "Cancel" }, { "shop", "Shopping" } }) do
    local b = button(panel, m[2], 100, 22)
    b:SetPoint("TOPLEFT", panel, "TOPLEFT", x, -4)
    b:SetScript("OnClick", function()
      UI.Show(m[1])
    end)
    x = x + 104
  end

  UI.post = buildPost(body)
  UI.cancel = buildCancel(body)
  UI.shop = buildShopping(body)

  panel.status = label(panel, "GameFontHighlightSmall")
  panel.status:SetPoint("BOTTOMLEFT", panel, "BOTTOMLEFT", 8, 8)
  local full = button(panel, "Full scan", 100, 22)
  full:SetPoint("BOTTOMRIGHT", panel, "BOTTOMRIGHT", -6, 4)
  full:SetScript("OnClick", function()
    local ok, why = Scan.StartFull()
    if not ok then
      U.Print(why)
    end
  end)
  panel.status:SetPoint("RIGHT", full, "LEFT", -8, 0)

  local elapsed = 0
  panel:SetScript("OnUpdate", function(_, dt)
    elapsed = elapsed + dt
    if elapsed >= 0.5 then
      elapsed = 0
      panel.status:SetText(UI.Status())
    end
  end)
  U.On("scan", function()
    panel.status:SetText(UI.Status())
  end)

  -- The tab itself, after the game's own.
  local n = (AuctionFrame.numTabs or 3) + 1
  local tab = CreateFrame("Button", "AuctionFrameTab" .. n, AuctionFrame, "AuctionTabTemplate")
  tab:SetID(n)
  tab:SetText("Uncbox")
  tab:SetPoint("LEFT", _G["AuctionFrameTab" .. (n - 1)], "RIGHT", -8, 0)
  PanelTemplates_SetNumTabs(AuctionFrame, n)
  PanelTemplates_EnableTab(AuctionFrame, n)
  UI.tab = tab
  hooksecurefunc("AuctionFrameTab_OnClick", function(self)
    local id = self and self.GetID and self:GetID() or AuctionFrame.selectedTab
    if id == n then
      panel:Show()
      UI.Show(UI.mode or "post")
    else
      panel:Hide()
    end
  end)
  UI.Show("post")
  panel:Hide()
end
