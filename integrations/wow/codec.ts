// The strip of colored blocks the Uncbox addon draws in the game's top-left corner. Encoding is an
// exact mirror of addon/Uncbox/Codec.lua (see the comment there for the page layout); decoding
// finds the strip in a captured video frame and turns it back into bytes.
//
// Block colors: 4 is red, 2 is green, 1 is blue, so 7 is white and 0 is black.

export const BLOCK = 3;
export const COLS = 160;
export const ROWS = 4;
export const SYNC = [7, 0, 4, 2, 1, 0, 7, 0];
export const MAGIC = 0x55;
export const KIND_CHARACTER = 1;
export const KIND_QUESTS = 2;
export const PAGE_BYTES = Math.floor(((COLS * ROWS - SYNC.length) * 3) / 8);
export const PAYLOAD = PAGE_BYTES - 8;

/** CRC-16/CCITT-FALSE. */
export function crc16(bytes: ArrayLike<number>): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function paginate(kind: number, seq: number, text: Uint8Array): number[][] {
  const count = Math.min(255, Math.max(1, Math.ceil(text.length / PAYLOAD)));
  const pages: number[][] = [];
  for (let i = 0; i < count; i++) {
    const chunk = text.subarray(i * PAYLOAD, (i + 1) * PAYLOAD);
    const bytes = [MAGIC, kind, seq % 256, i, count, chunk.length, ...chunk];
    const crc = crc16(bytes);
    pages.push([...bytes, crc >> 8, crc & 0xff]);
  }
  return pages;
}

export function toBlocks(bytes: number[]): number[] {
  const out = [...SYNC];
  let acc = 0;
  let nbits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    nbits += 8;
    while (nbits >= 3) {
      nbits -= 3;
      out.push((acc >> nbits) & 7);
    }
    acc &= (1 << nbits) - 1;
  }
  if (nbits > 0) out.push((acc << (3 - nbits)) & 7);
  while (out.length < COLS * ROWS) out.push(0);
  return out;
}

export interface Page {
  kind: number;
  seq: number;
  index: number;
  count: number;
  payload: Uint8Array;
}

/** A page from block colors, or null if the sync pattern or checksum is wrong. */
export function fromBlocks(blocks: number[]): Page | null {
  if (SYNC.some((v, i) => blocks[i] !== v)) return null;
  const bytes = new Uint8Array(PAGE_BYTES);
  let acc = 0;
  let nbits = 0;
  let n = 0;
  for (let i = SYNC.length; i < blocks.length && n < PAGE_BYTES; i++) {
    acc = ((acc << 3) | blocks[i]) & 0x7ff;
    nbits += 3;
    if (nbits >= 8) {
      nbits -= 8;
      bytes[n++] = (acc >> nbits) & 0xff;
    }
  }
  const length = bytes[5];
  if (bytes[0] !== MAGIC || length > PAYLOAD || bytes[3] >= bytes[4]) return null;
  const crc = crc16(bytes.subarray(0, 6 + length));
  if (bytes[6 + length] !== crc >> 8 || bytes[7 + length] !== (crc & 0xff)) return null;
  return { kind: bytes[1], seq: bytes[2], index: bytes[3], count: bytes[4], payload: bytes.slice(6, 6 + length) };
}

/** Where the strip sits in an image: its top-left corner and block size, in image pixels. */
export interface StripSpot {
  x: number;
  y: number;
  block: number;
}

/** An RGBA image, like canvas ImageData. */
export interface Rgba {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

function colorAt(img: Rgba, x: number, y: number, strict: boolean): number {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= img.width || py >= img.height) return -1;
  const o = (py * img.width + px) * 4;
  let v = 0;
  for (let c = 0; c < 3; c++) {
    const level = img.data[o + c];
    // The sync pattern must be clear-cut, so ordinary game pictures don't pass for it.
    if (strict && level > 64 && level < 191) return -1;
    v = (v << 1) | (level > 127 ? 1 : 0);
  }
  return v;
}

const center = (spot: StripSpot, col: number, row: number) =>
  [spot.x + (col + 0.5) * spot.block, spot.y + (row + 0.5) * spot.block] as const;

function syncAt(img: Rgba, spot: StripSpot): boolean {
  return SYNC.every((v, i) => colorAt(img, ...center(spot, i, 0), true) === v);
}

/** Block sizes tried, most likely first: the addon draws 3 px blocks, but captures can be scaled. */
const SIZES = [3, 2, 4, 1.5];

/**
 * Finds the sync pattern near the top-left corner. Window captures can include the title bar
 * and border, so it searches 0–100 px down and 0–60 px across.
 */
export function locate(img: Rgba): StripSpot | null {
  for (const block of SIZES) {
    for (let y = 0; y <= 100; y++) {
      for (let x = 0; x <= 60; x++) {
        if (!syncAt(img, { x, y, block })) continue;
        // Several offsets match the same blocks; take the middle one so samples land mid-block.
        let x2 = x;
        while (syncAt(img, { x: x2 + 1, y, block })) x2++;
        let y2 = y;
        while (syncAt(img, { x, y: y2 + 1, block })) y2++;
        return { x: (x + x2) / 2, y: (y + y2) / 2, block };
      }
    }
  }
  return null;
}

export function readBlocks(img: Rgba, spot: StripSpot): number[] {
  const out: number[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) out.push(Math.max(0, colorAt(img, ...center(spot, col, row), false)));
  }
  return out;
}

/** Puts multi-page texts back together. push() returns a text once all its pages have arrived. */
export class Assembler {
  private parts = new Map<number, { seq: number; pages: (Uint8Array | undefined)[] }>();
  private last = new Map<number, number>();

  push(page: Page): { kind: number; text: string } | null {
    let part = this.parts.get(page.kind);
    if (!part || part.seq !== page.seq || part.pages.length !== page.count) {
      part = { seq: page.seq, pages: new Array(page.count) };
      this.parts.set(page.kind, part);
    }
    part.pages[page.index] = page.payload;
    if (this.last.get(page.kind) === page.seq) return null;
    for (let i = 0; i < page.count; i++) if (!part.pages[i]) return null;
    this.last.set(page.kind, page.seq);
    const total = part.pages.reduce((n, p) => n + p!.length, 0);
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const p of part.pages) {
      bytes.set(p!, at);
      at += p!.length;
    }
    return { kind: page.kind, text: new TextDecoder().decode(bytes) };
  }
}
