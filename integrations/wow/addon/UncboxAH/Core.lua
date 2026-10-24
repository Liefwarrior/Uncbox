-- Wires the addon to the game: events, the /uah command, and starting the pieces when they're needed.
-- Everything it records lands in UncboxAHDB, which WoW writes to disk on /reload and logout; Uncbox
-- reads that file. The prices Uncbox sends back are in UncboxAHData.lua (loaded with the addon).

local ADDON, ns = ...
local U = ns.Util
local Db = ns.Db

local Core = {}
ns.Core = Core

local frame = CreateFrame("Frame")
Core.frame = frame
local handlers = {}
local bankOpen = false
local dirtyBags = false

local function guarded(name, fn, ...)
  local ok, err = pcall(fn, ...)
  if not ok then
    U.Print("|cffff5555error|r in " .. name .. ": " .. tostring(err))
  end
end

function handlers.ADDON_LOADED(name)
  if name ~= ADDON then
    return
  end
  Db.Init()
end

function handlers.PLAYER_LOGIN()
  Db.RegisterChar()
  ns.Tooltip.Hook()
  ns.Acct.Hook()
  ns.Acct.SnapshotGold(true)
  ns.Collect.Inventory(false)
end

function handlers.PLAYER_ENTERING_WORLD()
  ns.Acct.SnapshotGold(false)
end

function handlers.PLAYER_LOGOUT()
  ns.Acct.SnapshotGold(true)
  ns.Collect.Inventory(bankOpen)
end

function handlers.AUCTION_HOUSE_SHOW()
  guarded("the auction tab", ns.UI.Build)
  if GetOwnerAuctionItems then
    GetOwnerAuctionItems()
  end
end

function handlers.AUCTION_HOUSE_CLOSED()
  if ns.Scan.state and ns.Scan.state.kind ~= "full" then
    ns.Scan.Cancel(nil)
  end
end

function handlers.AUCTION_ITEM_LIST_UPDATE()
  guarded("the scan", ns.Scan.OnListUpdate)
end

function handlers.AUCTION_OWNED_LIST_UPDATE()
  guarded("your auctions", ns.Scan.ReadOwned)
end

function handlers.MAIL_INBOX_UPDATE()
  guarded("the mail", ns.Acct.ReadInbox)
  ns.Acct.SnapshotGold(false)
end

function handlers.MAIL_SHOW()
  ns.Acct.SnapshotGold(false)
end

function handlers.BAG_UPDATE_DELAYED()
  dirtyBags = true
  U.After(5, function()
    if dirtyBags then
      dirtyBags = false
      guarded("the bags", ns.Collect.Inventory, bankOpen)
    end
  end)
end

function handlers.BANKFRAME_OPENED()
  bankOpen = true
  U.After(1, function()
    guarded("the bank", ns.Collect.Inventory, true)
  end)
end

function handlers.BANKFRAME_CLOSED()
  bankOpen = false
end

function handlers.TRADE_SKILL_SHOW()
  U.After(0.5, function()
    guarded("the profession", ns.Collect.TradeSkill)
  end)
end

function handlers.CRAFT_SHOW()
  U.After(0.5, function()
    guarded("the profession", ns.Collect.Craft)
  end)
end

function handlers.MERCHANT_SHOW()
  guarded("the vendor", ns.Collect.Merchant)
end

function handlers.GET_ITEM_INFO_RECEIVED()
  ns.Collect.RetryInfo()
end

--- The game's event handler (also how the tests send events).
function Core.OnEvent(event, ...)
  local h = handlers[event]
  if h then
    h(...)
  end
end

frame:SetScript("OnEvent", function(_, event, ...)
  Core.OnEvent(event, ...)
end)

for event in pairs(handlers) do
  frame:RegisterEvent(event)
end

-- ---- /uah ----

local HELP = {
  "/uah scan: run a full auction house scan (the game allows one every 15 minutes)",
  "/uah post: open the Post tab at the auction house",
  "/uah cancel: find your undercut auctions",
  "/uah shop [list number]: run a shopping list, or look for deals",
  "/uah status: how old your scan and prices are",
  "/uah tooltip: turn the price lines on tooltips off or on",
  "/uah layout auto|new|old: how searches are sent, if scans do nothing",
}

local function openTab(mode)
  if not (AuctionFrame and AuctionFrame:IsShown()) then
    U.Print("Open the auction house first.")
    return false
  end
  ns.UI.Build()
  if ns.UI.tab then
    AuctionFrameTab_OnClick(ns.UI.tab)
  end
  ns.UI.Show(mode)
  return true
end

function Core.Slash(msg)
  local cmd, rest = string.match(msg or "", "^%s*(%S*)%s*(.-)%s*$")
  cmd = string.lower(cmd or "")
  if cmd == "scan" then
    local ok, why = ns.Scan.StartFull()
    U.Print(ok and "Full scan started. Don't close the auction house." or why)
  elseif cmd == "post" then
    openTab("post")
  elseif cmd == "cancel" then
    if openTab("cancel") then
      ns.Actions.CancelScan()
    end
  elseif cmd == "shop" then
    if openTab("shop") then
      local n = tonumber(rest)
      local ok, why = ns.Actions.Shop(n or "deals")
      if not ok then
        U.Print(why)
      end
    end
  elseif cmd == "status" then
    U.Print(ns.UI.Status())
  elseif cmd == "tooltip" then
    local o = Db.Options()
    o.tooltip = not o.tooltip
    U.Print("Tooltip prices " .. (o.tooltip and "on." or "off."))
  elseif cmd == "layout" then
    if rest == "auto" or rest == "new" or rest == "old" then
      Db.Options().queryLayout = rest
      U.Print("Searches use the " .. rest .. " layout.")
    else
      U.Print("Searches use the " .. ns.Scan.Layout() .. " layout (" .. Db.Options().queryLayout .. ").")
    end
  else
    for _, line in ipairs(HELP) do
      U.Print(line)
    end
  end
end

SLASH_UNCBOXAH1 = "/uah"
SLASH_UNCBOXAH2 = "/uncboxah"
SlashCmdList = SlashCmdList or {}
SlashCmdList["UNCBOXAH"] = Core.Slash
