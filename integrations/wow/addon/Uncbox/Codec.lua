-- Turns text into the strip of colored blocks Uncbox reads. Kept free of WoW API calls so it can
-- be tested outside the game; integrations/wow/codec.ts is its exact mirror.
--
-- Each block is one of 8 colors (red, green and blue each fully on or off), so it carries 3 bits
-- and survives any brightness or gamma setting. A page is a grid of COLS x ROWS blocks: a fixed
-- sync pattern Uncbox looks for, then these bytes, 3 bits per block, most significant bit first:
--
--   0x55, kind, seq, index, count, length, payload (length bytes), crc16 high, crc16 low
--
-- kind 1 is the character, kind 2 the quest log. seq changes whenever the text does, and a long
-- text is split over several pages (index of count) that Uncbox puts back together.

local band, bor, bxor, lshift, rshift = bit.band, bit.bor, bit.bxor, bit.lshift, bit.rshift

local C = {
  BLOCK = 3,
  COLS = 160,
  ROWS = 4,
  SYNC = { 7, 0, 4, 2, 1, 0, 7, 0 },
  MAGIC = 0x55,
  KIND_CHARACTER = 1,
  KIND_QUESTS = 2,
}
-- 640 blocks minus the sync pattern, at 3 bits each, less the 8 bytes of header and checksum.
C.PAGE_BYTES = math.floor((C.COLS * C.ROWS - #C.SYNC) * 3 / 8)
C.PAYLOAD = C.PAGE_BYTES - 8

-- CRC-16/CCITT-FALSE over a list of byte values.
function C.crc16(bytes)
  local crc = 0xFFFF
  for i = 1, #bytes do
    crc = bxor(crc, lshift(bytes[i], 8))
    for _ = 1, 8 do
      if band(crc, 0x8000) ~= 0 then
        crc = band(bxor(lshift(crc, 1), 0x1021), 0xFFFF)
      else
        crc = band(lshift(crc, 1), 0xFFFF)
      end
    end
  end
  return crc
end

-- Splits text into pages of bytes, header and checksum included.
function C.paginate(kind, seq, text)
  local count = math.max(1, math.ceil(#text / C.PAYLOAD))
  if count > 255 then
    count = 255
  end
  local pages = {}
  for i = 0, count - 1 do
    local chunk = text:sub(i * C.PAYLOAD + 1, (i + 1) * C.PAYLOAD)
    local bytes = { C.MAGIC, kind, seq % 256, i, count, #chunk }
    for j = 1, #chunk do
      bytes[#bytes + 1] = chunk:byte(j)
    end
    local crc = C.crc16(bytes)
    bytes[#bytes + 1] = rshift(crc, 8)
    bytes[#bytes + 1] = band(crc, 0xFF)
    pages[#pages + 1] = bytes
  end
  return pages
end

-- One page of bytes as block colors 0-7, sync pattern first, padded with black.
function C.toBlocks(bytes)
  local out = {}
  for i = 1, #C.SYNC do
    out[i] = C.SYNC[i]
  end
  local acc, nbits = 0, 0
  for i = 1, #bytes do
    acc = bor(lshift(acc, 8), bytes[i])
    nbits = nbits + 8
    while nbits >= 3 do
      nbits = nbits - 3
      out[#out + 1] = band(rshift(acc, nbits), 7)
    end
    acc = band(acc, lshift(1, nbits) - 1)
  end
  if nbits > 0 then
    out[#out + 1] = band(lshift(acc, 3 - nbits), 7)
  end
  for i = #out + 1, C.COLS * C.ROWS do
    out[i] = 0
  end
  return out
end

UncboxCodec = C
