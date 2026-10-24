import { describe, expect, it } from 'vitest';
import { Assembler, COLS, fromBlocks, KIND_GUILD, KIND_GUILD_EVENTS, KIND_RAID, KIND_RAID_EVENTS, locate, paginate, readBlocks, toBlocks } from './codec';
import type { GuildMember } from './messages.mjs';
import { parseGuildEvents, parseRaidEvents, parseRosterMessage, RosterTracker } from './parse';

const utf8 = (s: string) => new TextEncoder().encode(s);
const F = '\x1f';
const R = '\x1e';

/** Draws blocks the way the addon does, with noise, over a gray background. */
function render(blocks: number[], at: { x: number; y: number; block: number }, width = 1100, height = 140) {
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

describe('guild and raid kinds on the strip', () => {
  it('round-trip, each as its own text', () => {
    const asm = new Assembler();
    const big = Array.from({ length: 40 }, (_, i) => `Member${i}${F}2${F}60${F}MAGE${F}Zoë`).join(R);
    const cases: [number, string][] = [
      [KIND_GUILD, big],
      [KIND_GUILD_EVENTS, `on${F}1760000000${F}Lief${F}${F}`],
      [KIND_RAID, `D${F}9`],
      [KIND_RAID_EVENTS, `C${F}1760000000${F}Lief`],
    ];
    for (const [kind, text] of cases) {
      const out = paginate(kind, 3, utf8(text)).map((p) => asm.push(fromBlocks(toBlocks(p))!));
      expect(out.at(-1)).toEqual({ kind, text });
    }
  });

  it('keep apart when pages of different kinds interleave', () => {
    const asm = new Assembler();
    const a = paginate(KIND_GUILD, 1, utf8('x'.repeat(400)));
    const b = paginate(KIND_RAID_EVENTS, 1, utf8('hello'));
    expect(asm.push(fromBlocks(toBlocks(a[0]))!)).toBeNull();
    expect(asm.push(fromBlocks(toBlocks(b[0]))!)).toEqual({ kind: KIND_RAID_EVENTS, text: 'hello' });
    expect(a.slice(1).map((p) => asm.push(fromBlocks(toBlocks(p))!)).at(-1)).toMatchObject({ kind: KIND_GUILD });
  });

  it('are found in the top-right corner, and only when asked', () => {
    const page = paginate(KIND_GUILD, 1, utf8('hello'))[0];
    const img = render(toBlocks(page), { x: 1100 - 512 - 6, y: 12, block: 2 });
    expect(locate(img)).toBeNull();
    const spot = locate(img, Infinity);
    expect(spot!.block).toBe(2);
    expect(Math.abs(spot!.x - (1100 - 512 - 6))).toBeLessThanOrEqual(1);
    expect(Math.abs(spot!.y - 12)).toBeLessThanOrEqual(1);
    expect(fromBlocks(readBlocks(img, spot!))?.payload).toEqual(utf8('hello'));
  });
});

describe('reading the messages', () => {
  const member = (name: string, extra = '') => ['M', name, '1', '60', 'MAGE', 'Orgrimmar', '1', '0', '', extra].join(F);

  it('reads guild info, full pieces and deltas', () => {
    expect(parseRosterMessage(KIND_GUILD, ['I', 'Night Watch', 'hi', 'GM', 'Raider'].join(F))).toEqual({ type: 'info', name: 'Night Watch', motd: 'hi', ranks: ['GM', 'Raider'] });
    const full = parseRosterMessage(KIND_GUILD, [['R', '7', '1', '2'].join(F), member('Lief')].join(R));
    expect(full).toMatchObject({ type: 'full', sync: 7, index: 1, count: 2, members: [{ name: 'Lief', rankIndex: 1, level: 60, class: 'MAGE', online: true, status: 0, hoursOffline: null }] });
    const delta = parseRosterMessage(KIND_GUILD, [['D', '7'].join(F), member('Lief'), ['X', 'Bumta'].join(F)].join(R));
    expect(delta).toMatchObject({ type: 'delta', sync: 7, removed: ['Bumta'] });
    expect(parseRosterMessage(KIND_GUILD, 'garbage')).toBeNull();
    // Info only means something for the guild.
    expect(parseRosterMessage(KIND_RAID, ['I', 'x'].join(F))).toBeNull();
  });

  it('puts a roster together from pieces, applies deltas to the right sync, and ignores the rest', () => {
    const t = new RosterTracker<GuildMember>();
    const piece = (sync: number, index: number, count: number, names: string[]) => parseRosterMessage(KIND_GUILD, [['R', sync, index, count].join(F), ...names.map((n) => member(n))].join(R));
    // A change before any roster is ignored.
    expect(t.apply(parseRosterMessage(KIND_GUILD, [['D', '1'].join(F), member('Ghost')].join(R)))).toBeNull();
    expect(t.apply(piece(1, 2, 2, ['B']))).toBeNull();
    expect(t.apply(piece(1, 1, 2, ['A']))).toMatchObject({ full: true, members: [{ name: 'A' }, { name: 'B' }], removed: [] });
    expect(t.apply(parseRosterMessage(KIND_GUILD, [['D', '1'].join(F), member('C'), ['X', 'A'].join(F)].join(R)))).toMatchObject({ full: false, removed: ['A'] });
    expect([...t.members.keys()]).toEqual(['B', 'C']);
    // A delta for another sync is no use.
    expect(t.apply(parseRosterMessage(KIND_GUILD, [['D', '2'].join(F), member('Z')].join(R)))).toBeNull();
    // A new full sync replaces everything and says who went.
    expect(t.apply(piece(2, 1, 1, ['C', 'D']))).toMatchObject({ full: true, removed: ['B'] });
  });

  it('reads guild events and each kind of raid news', () => {
    expect(parseGuildEvents(`promote${F}100${F}Bumta${F}Officer${F}Lief${R}level${F}101${F}Pip${F}60`)).toEqual([
      { type: 'promote', t: 100, name: 'Bumta', a: 'Officer', b: 'Lief' },
      { type: 'level', t: 101, name: 'Pip', a: '60', b: '' },
    ]);
    const news = [
      ['Z', '100', 'Molten Core', '409', '', '40', 'master', 'Lief'],
      ['A', '110', '100', 'boss', 'Lucifron', 'Lief,Bumta'],
      ['E', '105', '100', '663', 'Lucifron', '9', '40', '1', '109'],
      ['E', '105', '100', '663', 'Lucifron', '9', '40', '', ''],
      ['L', '112', '100', 'Bumta', '16922', 'Leggings', '4', '1', 'Lucifron'],
      ['C', '120', 'Lief'],
      ['F', '120', 'Lief', 'Lief', 'Bumta', ''],
      ['?', 'unknown'],
    ].map((r) => r.join(F)).join(R);
    expect(parseRaidEvents(news)).toEqual([
      { tag: 'raid', id: 100, zone: 'Molten Core', instanceId: 409, endT: null, size: 40, lootMethod: 'master', masterLooter: 'Lief' },
      { tag: 'attendance', t: 110, raid: 100, kind: 'boss', boss: 'Lucifron', names: ['Lief', 'Bumta'] },
      { tag: 'encounter', t: 105, raid: 100, id: 663, name: 'Lucifron', difficulty: 9, size: 40, success: true, endT: 109 },
      { tag: 'encounter', t: 105, raid: 100, id: 663, name: 'Lucifron', difficulty: 9, size: 40, success: null, endT: null },
      { tag: 'loot', t: 112, raid: 100, who: 'Bumta', itemId: 16922, name: 'Leggings', quality: 4, count: 1, boss: 'Lucifron' },
      { tag: 'readycheck', t: 120, initiator: 'Lief' },
      { tag: 'readycheck_done', t: 120, initiator: 'Lief', ready: ['Lief'], notReady: ['Bumta'], afk: [] },
    ]);
  });
});
