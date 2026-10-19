-- Shows your character and quest log on your Uncbox dashboard. Addons can't write files or talk
-- to the network while you play, so this draws them as a thin strip of colored blocks in the
-- top-left corner of the screen. Uncbox reads the strip from its capture of the game window and
-- crops it out, so viewers never see it. /uncbox hides or shows the strip.

local C = UncboxCodec
local band = bit.band

local FIELD, RECORD = "\31", "\30"
local TICK = 0.125 -- 8 pages a second: a character page every other tick, quest pages between

-- Plain text only: no control characters (they separate fields) and no |c color codes.
local function clean(s)
  if s == nil then
    return ""
  end
  s = tostring(s):gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", "")
  return (s:gsub("%c", ""))
end

local function maxLevel()
  if GetMaxLevelForPlayerExpansion then
    return GetMaxLevelForPlayerExpansion()
  elseif GetMaxPlayerLevel then
    return GetMaxPlayerLevel()
  end
  return 60
end

-- Version, name, realm, guild, race, class token, level, max level, xp, xp to level, copper, zone.
local function characterText()
  local race = UnitRace("player")
  local _, classToken = UnitClass("player")
  local guild = GetGuildInfo("player")
  return table.concat({
    "1",
    clean(UnitName("player")),
    clean(GetRealmName()),
    clean(guild),
    clean(race),
    clean(classToken),
    UnitLevel("player") or 1,
    maxLevel() or 60,
    UnitXP("player") or 0,
    UnitXPMax("player") or 0,
    GetMoney() or 0,
    clean(GetZoneText()),
  }, FIELD)
end

-- One record per quest: title, level, state (0 open, 1 complete, 2 failed), then for each
-- objective "1" or "0" (done) and its text.
local function questsText()
  local out = {}
  local Q = C_QuestLog
  if Q and Q.GetInfo and Q.GetNumQuestLogEntries and Q.GetQuestObjectives then
    for i = 1, Q.GetNumQuestLogEntries() do
      local info = Q.GetInfo(i)
      if info and not info.isHeader and not info.isHidden then
        local id = info.questID
        local state = 0
        if Q.IsFailed and Q.IsFailed(id) then
          state = 2
        elseif Q.IsComplete and Q.IsComplete(id) then
          state = 1
        end
        local rec = { clean(info.title), info.level or 0, state }
        for _, o in ipairs(Q.GetQuestObjectives(id) or {}) do
          rec[#rec + 1] = o.finished and "1" or "0"
          rec[#rec + 1] = clean(o.text)
        end
        out[#out + 1] = table.concat(rec, FIELD)
      end
    end
  else
    for i = 1, (GetNumQuestLogEntries()) do
      local title, level, _, isHeader, _, isComplete = GetQuestLogTitle(i)
      if title and not isHeader then
        local state = 0
        if isComplete == -1 then
          state = 2
        elseif isComplete == 1 or isComplete == true then
          state = 1
        end
        local rec = { clean(title), level or 0, state }
        for j = 1, GetNumQuestLeaderBoards(i) do
          local text, _, finished = GetQuestLogLeaderBoard(j, i)
          rec[#rec + 1] = finished and "1" or "0"
          rec[#rec + 1] = clean(text)
        end
        out[#out + 1] = table.concat(rec, FIELD)
      end
    end
  end
  return table.concat(out, RECORD)
end

-- Each channel resends its pages in turn; seq changes only when its text does.
local channels = {
  { kind = C.KIND_CHARACTER, read = characterText, every = 1, pages = {}, next = 1 },
  { kind = C.KIND_QUESTS, read = questsText, every = 2, pages = {}, next = 1 },
}

local function refresh(ch)
  local ok, text = pcall(ch.read)
  if not ok or text == ch.text then
    return
  end
  ch.text = text
  -- Random start, so a /reload never reuses the seq of what Uncbox last saw.
  ch.seq = ch.seq and (ch.seq + 1) % 256 or math.random(0, 255)
  ch.pages = C.paginate(ch.kind, ch.seq, text)
  ch.next = 1
end

local strip, cells, shown = nil, {}, {}

local function fitToPixels()
  -- With the parent's scale ignored, 768 / screen height makes one unit one physical pixel.
  local _, height = GetPhysicalScreenSize()
  if height and height > 0 then
    strip:SetScale(768 / height)
  end
end

local function buildStrip()
  -- On WorldFrame, not UIParent, so it stays up when Alt+Z hides the interface.
  strip = CreateFrame("Frame", "UncboxStrip", WorldFrame)
  strip:SetFrameStrata("TOOLTIP")
  if strip.SetIgnoreParentScale then
    strip:SetIgnoreParentScale(true)
  end
  strip:SetPoint("TOPLEFT", WorldFrame, "TOPLEFT", 0, 0)
  strip:SetSize(C.COLS * C.BLOCK, C.ROWS * C.BLOCK)
  fitToPixels()
  for i = 1, C.COLS * C.ROWS do
    local t = strip:CreateTexture(nil, "OVERLAY")
    local col, row = (i - 1) % C.COLS, math.floor((i - 1) / C.COLS)
    t:SetSize(C.BLOCK, C.BLOCK)
    t:SetPoint("TOPLEFT", strip, "TOPLEFT", col * C.BLOCK, -row * C.BLOCK)
    if t.SetSnapToPixelGrid then
      t:SetSnapToPixelGrid(false)
      t:SetTexelSnappingBias(0)
    end
    t:SetColorTexture(0, 0, 0, 1)
    cells[i], shown[i] = t, 0
  end
end

local function draw(bytes)
  local blocks = C.toBlocks(bytes)
  for i = 1, #blocks do
    local v = blocks[i]
    if shown[i] ~= v then
      shown[i] = v
      cells[i]:SetColorTexture(band(v, 4) > 0 and 1 or 0, band(v, 2) > 0 and 1 or 0, band(v, 1) > 0 and 1 or 0, 1)
    end
  end
end

local ticks = 0
local function tick()
  ticks = ticks + 1
  -- Odd ticks show the character, even ones the quest log (or the character if it has none).
  local ch = channels[ticks % 2 == 1 and 1 or 2]
  if #ch.pages == 0 then
    ch = channels[1]
  end
  if #ch.pages == 0 then
    return
  end
  if ch.next > #ch.pages then
    ch.next = 1
  end
  draw(ch.pages[ch.next])
  ch.next = ch.next + 1
end

local events = CreateFrame("Frame")
events:RegisterEvent("PLAYER_LOGIN")
events:RegisterEvent("DISPLAY_SIZE_CHANGED")
events:RegisterEvent("UI_SCALE_CHANGED")
events:SetScript("OnEvent", function(_, event)
  if event ~= "PLAYER_LOGIN" then
    if strip then
      fitToPixels()
    end
    return
  end
  UncboxDB = UncboxDB or {}
  buildStrip()
  strip:SetShown(not UncboxDB.hidden)
  for _, ch in ipairs(channels) do
    refresh(ch)
    C_Timer.NewTicker(ch.every, function()
      refresh(ch)
    end)
  end
  C_Timer.NewTicker(TICK, tick)
end)

SLASH_UNCBOX1 = "/uncbox"
SlashCmdList.UNCBOX = function()
  if not strip then
    return
  end
  UncboxDB.hidden = strip:IsShown()
  strip:SetShown(not UncboxDB.hidden)
  print(UncboxDB.hidden and "Uncbox: strip hidden. Your dashboard stops updating until you type /uncbox again."
    or "Uncbox: strip shown.")
end
