-- Messages for the strip that aren't "the latest state of something" (guild events, a roster in
-- pieces, raid events). They wait here in order and go out one at a time, each shown for a few
-- rounds like the character and quest log are, so a captured frame that misses a page is covered.
--
-- Two lines: the queue (small live news, goes first) and bulk (the pieces of a full roster sync,
-- let out a few at a time so a 50-person guild is spread over several bursts, not one long one).

local C = UncboxCodec

local REPEATS = 3 -- each message is shown this many times over
local QUEUE_MAX = 80 -- the oldest news is dropped past this
local BULK_BURST = 4 -- pieces of a full sync released at once
local BULK_GAP = 3 -- seconds between bursts

local O = { queue = {}, bulkLine = {}, enabled = true, bulkAt = 0 }
local seqs = {}

local function now()
  return GetTime and GetTime() or 0
end

-- Turned off while the strip is hidden, so nothing piles up that nobody can read.
function O.setEnabled(on)
  O.enabled = on
  if not on then
    O.queue, O.bulkLine = {}, {}
  end
end

-- Live news: goes out before any bulk.
function O.push(kind, text)
  if not O.enabled then
    return
  end
  O.queue[#O.queue + 1] = { kind = kind, text = text }
  while #O.queue > QUEUE_MAX do
    table.remove(O.queue, 1)
  end
end

-- A list of texts for one kind, let out a burst at a time. A new bulk replaces an old one.
function O.bulk(kind, texts)
  if not O.enabled then
    return
  end
  local keep = {}
  for _, m in ipairs(O.bulkLine) do
    if m.kind ~= kind then
      keep[#keep + 1] = m
    end
  end
  for _, text in ipairs(texts) do
    keep[#keep + 1] = { kind = kind, text = text }
  end
  O.bulkLine = keep
end

-- Whether pieces of a full sync of this kind are still waiting to go out.
function O.bulkPending(kind)
  for _, m in ipairs(O.bulkLine) do
    if m.kind == kind then
      return true
    end
  end
  return false
end

local function nextSeq(kind)
  seqs[kind] = seqs[kind] and (seqs[kind] + 1) % 256 or math.random(0, 255)
  return seqs[kind]
end

-- The strip's turn-taking loop treats this like the character and quest log channels.
O.channel = { kind = 0, pages = {}, next = 1, rounds = 0 }

-- Loads the next message once the last one has been shown enough times.
function O.channel.refill(ch)
  if ch.rounds > 0 then
    return
  end
  if #O.queue == 0 and #O.bulkLine > 0 and now() >= O.bulkAt then
    for _ = 1, math.min(BULK_BURST, #O.bulkLine) do
      O.queue[#O.queue + 1] = table.remove(O.bulkLine, 1)
    end
    O.bulkAt = now() + BULK_GAP
  end
  local m = table.remove(O.queue, 1)
  if m then
    ch.pages = C.paginate(m.kind, nextSeq(m.kind), m.text)
    ch.next = 1
    ch.rounds = REPEATS
  end
end

-- Forgets everything waiting (a /reload never needs this; it's for the tests and /uncbox off).
function O.clear()
  O.queue, O.bulkLine = {}, {}
  O.channel.pages, O.channel.rounds = {}, 0
end

UncboxOutbox = O
