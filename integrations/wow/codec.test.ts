import { describe, expect, it } from 'vitest';
import { Assembler, COLS, fromBlocks, KIND_QUESTS, locate, paginate, readBlocks, toBlocks } from './codec';
import { formatMoney, parseCharacter, parseParty, parseQuests, partySlots } from './parse';

const utf8 = (s: string) => new TextEncoder().encode(s);
const quests = Array.from({ length: 12 }, (_, i) => `Quest ${i} — Ténèbres\x1f12\x1f0\x1f0\x1fKobolds slain: 4/10`).join('\x1e');

/** Draws blocks the way the addon does, with ±20 noise, over a gray background. */
function render(blocks: number[], at: { x: number; y: number; block: number }) {
  const width = 1100;
  const height = 140;
  const data = new Uint8ClampedArray(width * height * 4).fill(90);
  const noise = () => Math.round(Math.random() * 40 - 20);
  blocks.forEach((v, i) => {
    const bx = at.x + (i % COLS) * at.block;
    const by = at.y + Math.floor(i / COLS) * at.block;
    for (let y = by; y < by + at.block; y++) {
      for (let x = bx; x < bx + at.block; x++) {
        const o = (y * width + x) * 4;
        data[o] = (v & 4 ? 255 : 0) + noise();
        data[o + 1] = (v & 2 ? 255 : 0) + noise();
        data[o + 2] = (v & 1 ? 255 : 0) + noise();
      }
    }
  });
  return { data, width, height };
}

describe('codec', () => {
  it('round-trips a multi-page text', () => {
    const pages = paginate(KIND_QUESTS, 7, utf8(quests));
    expect(pages.length).toBeGreaterThan(1);
    const asm = new Assembler();
    const out = pages.map((p) => asm.push(fromBlocks(toBlocks(p))!));
    expect(out.at(-1)).toEqual({ kind: KIND_QUESTS, text: quests });
    expect(asm.push(fromBlocks(toBlocks(pages[0]))!)).toBeNull();
  });

  it('finds and reads the strip in a noisy frame under a title bar', () => {
    const page = paginate(1, 1, utf8('1\x1fLief'))[0];
    const img = render(toBlocks(page), { x: 8, y: 31, block: 3 });
    const spot = locate(img);
    expect(spot).toEqual({ x: 8, y: 31, block: 3 });
    expect(fromBlocks(readBlocks(img, spot!))?.payload).toEqual(utf8('1\x1fLief'));
  });

  it('rejects a damaged page', () => {
    const blocks = toBlocks(paginate(1, 1, utf8('hello'))[0]);
    blocks[20] ^= 1;
    expect(fromBlocks(blocks)).toBeNull();
  });
});

describe('parse', () => {
  it('reads the character and quest log', () => {
    const c = parseCharacter(['1', 'Lief', 'Doomhowl', 'Bumta Buds', 'Night Elf', 'DRUID', '23', '60', '3000', '12000', '874012', 'Darkshore'].join('\x1f'));
    expect(c).toMatchObject({ name: 'Lief', cls: 'Druid', level: 23, xp: 25, gold: '87g 40s', zone: 'Darkshore' });
    expect(formatMoney(4012)).toBe('40s 12c');
    expect(parseQuests('')).toEqual([]);
    expect(parseQuests('Bounty\x1f20\x1f1\x1f1\x1fHead: 1/1')).toEqual([
      { title: 'Bounty', level: 20, state: 'complete', objectives: [{ text: 'Head: 1/1', done: true }] },
    ]);
  });

  it('reads the party and keeps people in their slots', () => {
    const text = ['LiefDRUID2301', 'BumtaWARRIOR2211', 'GhostMAGE2100'].join('');
    const party = parseParty(text);
    expect(party[1]).toEqual({ name: 'Bumta', cls: 'Warrior', level: 22, dead: true, online: true });
    const first = partySlots(party, []);
    expect(first).toHaveLength(5);
    expect(first[2]).toMatchObject({ name: 'Ghost', detail: 'Level 21 Mage · Offline', down: false });
    expect(first[1].down).toBe(true);
    // Same group again: nothing changes, so nothing is saved.
    expect(partySlots(party, first)).toEqual(first);
    // Bumta leaves: Ghost keeps the slot (and picture) they had.
    first[2].image = 'data:ghost';
    const after = partySlots([party[0], party[2]], first);
    expect(after[1]).toMatchObject({ id: first[2].id, name: 'Ghost', image: 'data:ghost' });
    expect(after.slice(2).every((s) => !s.name)).toBe(true);
  });
});
