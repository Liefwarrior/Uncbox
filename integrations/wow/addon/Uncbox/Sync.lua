-- Sends a list of people (a guild or a raid) over the strip without ever sending all of it at once
-- twice. The first time (and every so often after) it's a full sync: the list cut into messages
-- that each fit one page, handed to the Outbox's bulk line. After that only what changed goes out.
--
-- Messages are records split by \30, fields by \31, and each record starts with a tag:
--   R sync index count     first record of a full sync piece (index of count, 1-based)
--   D sync                 first record of a delta
--   M field ...            a person, fields as the list gives them
--   X name                 a person who is gone (deltas only)
-- A delta only applies to the full sync with the same number: Uncbox ignores it otherwise.

local U = UncboxUtil
local O = UncboxOutbox

local S = {}
S.__index = S

local PIECE = 160 -- bytes of a message, so it fits one page with room to spare

function S.new(kind)
  return setmetatable({ kind = kind, sync = math.random(0, 255), known = nil }, S)
end

-- Cuts records into messages of about PIECE bytes under a header.
local function pack(records, header)
  local out, cur, size = {}, {}, #header
  for _, rec in ipairs(records) do
    if #cur > 0 and size + #rec + 1 > PIECE then
      out[#out + 1] = cur
      cur, size = {}, #header
    end
    cur[#cur + 1] = rec
    size = size + #rec + 1
  end
  if #cur > 0 or #out == 0 then
    out[#out + 1] = cur
  end
  return out
end

local function text(header, records)
  local parts = { header }
  for _, rec in ipairs(records) do
    parts[#parts + 1] = rec
  end
  return table.concat(parts, U.RECORD)
end

-- Forget what was sent, so the next update is a full sync.
function S:reset()
  self.known = nil
end

-- list: array of { key = name, rec = fields as text }. force sends everything again.
function S:update(list, force)
  -- A full sync is still going out; changes wait, and go out as a delta after it.
  if O.bulkPending(self.kind) then
    return
  end
  local cur = {}
  for _, p in ipairs(list) do
    cur[p.key] = p.rec
  end
  if force or not self.known then
    -- Nobody to send, and nobody sent before: there's nothing for Uncbox to learn.
    if #list == 0 and (not self.known or next(self.known) == nil) then
      self.known = {}
      return
    end
    self.sync = (self.sync + 1) % 256
    local records = {}
    for _, p in ipairs(list) do
      records[#records + 1] = "M" .. U.FIELD .. p.rec
    end
    local pieces = pack(records, "R" .. U.FIELD .. "255" .. U.FIELD .. "99" .. U.FIELD .. "99")
    local texts = {}
    for i, piece in ipairs(pieces) do
      local head = table.concat({ "R", self.sync, i, #pieces }, U.FIELD)
      texts[#texts + 1] = text(head, piece)
    end
    O.bulk(self.kind, texts)
    self.known = cur
    return
  end
  local records = {}
  for _, p in ipairs(list) do
    if self.known[p.key] ~= p.rec then
      records[#records + 1] = "M" .. U.FIELD .. p.rec
    end
  end
  local gone = {}
  for key in pairs(self.known) do
    if cur[key] == nil then
      gone[#gone + 1] = key
    end
  end
  table.sort(gone)
  for _, key in ipairs(gone) do
    records[#records + 1] = "X" .. U.FIELD .. key
  end
  self.known = cur
  if #records == 0 then
    return
  end
  local head = "D" .. U.FIELD .. self.sync
  for _, piece in ipairs(pack(records, head)) do
    O.push(self.kind, text(head, piece))
  end
end

S.pack = pack
S.PIECE = PIECE

UncboxSync = S
