-- Price lines on item tooltips, from UncboxAHData (the file Uncbox writes):
--
--   Uncbox Market Value   what it usually sells for
--   Uncbox Min Buyout     the cheapest right now (as of the last scan)
--   Uncbox Your Avg Sale  what you sold it for, and Sale Rate how often it sells
--   Uncbox Vendor         what a vendor pays
--
-- Over a stack in your bags each line also shows the price for the whole stack.

local ADDON, ns = ...
local U = ns.Util
local Db = ns.Db
local Rules = ns.Rules

local Tooltip = {}
ns.Tooltip = Tooltip

local GOLD = { 1, 0.82, 0 }
local GREY = { 0.7, 0.7, 0.75 }

--- The lines for an item as a list of { left, right, rightColor }. count > 1 adds the stack's price.
function Tooltip.Lines(key, count, realmKey)
  local item = Rules.Item(key, realmKey)
  if not item then
    return {}
  end
  count = count or 1
  local lines = {}
  local function money(label, copper)
    if not copper or copper <= 0 then
      return
    end
    local text = U.Money(copper)
    if count > 1 then
      text = text .. "  (x" .. count .. ": " .. U.Money(copper * count) .. ")"
    end
    lines[#lines + 1] = { label, text }
  end
  money("Uncbox Market Value", item.market)
  money("Uncbox Min Buyout", item.minBuyout)
  if not item.market and not item.minBuyout then
    money("Uncbox Historical", item.historical)
  end
  money("Uncbox Your Avg Sale", item.avgSell)
  if item.saleRate then
    lines[#lines + 1] = { "Uncbox Sale Rate", math.floor(item.saleRate * 100 + 0.5) .. "%" }
  end
  money("Uncbox Vendor", item.vendor)
  return lines
end

--- How many of the item the tooltip's owner holds (a bag slot), or 1.
local function stackSize(tooltip)
  local owner = tooltip.GetOwner and tooltip:GetOwner()
  if not owner then
    return 1
  end
  local ok, count = pcall(function()
    local bag, slot = owner:GetParent():GetID(), owner:GetID()
    if C_Container and C_Container.GetContainerItemInfo then
      local info = C_Container.GetContainerItemInfo(bag, slot)
      return info and info.stackCount
    end
    local _, c = GetContainerItemInfo(bag, slot)
    return c
  end)
  if ok and type(count) == "number" and count > 0 then
    return count
  end
  return 1
end

local function decorate(tooltip)
  if not Db.Options().tooltip or tooltip.uahDone then
    return
  end
  local _, link = tooltip:GetItem()
  local key = link and U.ItemKey(link)
  if not key then
    return
  end
  local lines = Tooltip.Lines(key, stackSize(tooltip))
  if #lines == 0 then
    return
  end
  tooltip.uahDone = true
  for _, l in ipairs(lines) do
    tooltip:AddDoubleLine(l[1], l[2], GOLD[1], GOLD[2], GOLD[3], GREY[1], GREY[2], GREY[3])
  end
  tooltip:Show()
end

--- Hooks the game's item tooltips (once).
function Tooltip.Hook()
  if Tooltip.hooked then
    return
  end
  Tooltip.hooked = true
  -- Newer clients hand tooltips to a data processor; older ones fire OnTooltipSetItem.
  local processor = TooltipDataProcessor and TooltipDataProcessor.AddTooltipPostCall and Enum and Enum.TooltipDataType
  if processor then
    TooltipDataProcessor.AddTooltipPostCall(Enum.TooltipDataType.Item, function(tooltip)
      if tooltip == GameTooltip or tooltip == ItemRefTooltip then
        decorate(tooltip)
      end
    end)
  end
  for _, tooltip in ipairs({ GameTooltip, ItemRefTooltip }) do
    if tooltip and tooltip.HookScript then
      if not processor then
        tooltip:HookScript("OnTooltipSetItem", decorate)
      end
      tooltip:HookScript("OnTooltipCleared", function(t)
        t.uahDone = nil
      end)
    end
  end
end
