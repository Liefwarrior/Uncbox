import { describe, expect, it } from 'vitest';
import centerFix from './fixtures/center.ocr.json';
import readsFix from './fixtures/reads.ocr.json';
import screensFix from './fixtures/screens.ocr.json';
import {
  type OcrLine,
  centerCrop,
  findDamageHeadings,
  hudKdaCrop,
  matchGod,
  parseCombatLog,
  parseCombatScreen,
  parseFps,
  parseHudGold,
  parseHudKda,
  parseHudTop,
  parseKillBanner,
  parseScoreboard,
  parseTopCards,
  toFrame,
  toInt,
} from './screen';

// The fixtures are real SMITE 2 screenshots read by Windows' OCR (see fixtures/). "screens" is each
// whole picture; "center" is what the reader actually sends for the Tab and T screens (the middle,
// shrunk to 1280 pixels); "reads" are the small crops (top bar, gold, K/D/A) and the T screen's rows.

type Whole = { w: number; h: number; lines: OcrLine[] };
const screens = screensFix as unknown as Record<string, Whole>;
const centers = centerFix as unknown as Record<string, { w: number; h: number; ox: number; oy: number; s: number; lines: OcrLine[] }>;
type Crop = { ox: number; oy: number; scale: number; lines: OcrLine[] };
const reads = readsFix as unknown as Record<string, Record<string, Crop>>;

const frame = (k: string) => toFrame(centers[k].lines, { ox: centers[k].ox, oy: centers[k].oy, scale: centers[k].s });
const inFrame = (c: Crop) => toFrame(c.lines, c);

const ALLIES = ['Anhur', 'Odin', 'Artemis'];
const ENEMIES = ['Ares', 'Ra', 'Kali'];
const gods = { allies: ALLIES, enemies: ENEMIES };

describe('numbers', () => {
  it('turns the letters game fonts get mistaken for back into digits, only inside numbers', () => {
    expect(toInt('1,247')).toBe(1247);
    expect(toInt('o')).toBe(0);
    expect(toInt('xl')).toBeNull();
    expect(toInt('l0O')).toBe(100);
    expect(toInt('Liefwarrior')).toBeNull();
  });

  it('matches a garbled god word to the draft', () => {
    expect(matchGod('SANHUR', ALLIES)).toBe('Anhur');
    expect(matchGod('ANNUR', ALLIES)).toBe('Anhur');
    expect(matchGod('KAI', ENEMIES)).toBe('Kali');
    expect(matchGod('RA', ENEMIES)).toBe('Ra');
    expect(matchGod('ODIN', ENEMIES)).toBeNull();
  });
});

describe('Tab screen', () => {
  const expected = (level: (number | null)[]) => ({
    order: [
      { god: 'Anhur', player: 'Liefwarrior', level: level[0], k: 0, d: 0, a: 0, gold: 1310 },
      { god: 'Odin', player: 'SlambOt', level: level[1], k: 0, d: 0, a: 0, gold: 1310 },
      { god: 'Artemis', player: expect.stringMatching(/BOT$/), level: level[2], k: 0, d: 0, a: 0, gold: 1310 },
    ],
    chaos: [
      { god: 'Ares', player: 'TrailbOt', level: level[3], k: 0, d: 0, a: 0, gold: 1310 },
      { god: 'Ra', player: 'Scoobybot', level: level[4], k: 0, d: 0, a: 0, gold: 1310 },
      { god: 'Kali', player: 'SnoozybOt', level: level[5], k: 0, d: 0, a: 0, gold: 1310 },
    ],
  });

  it('reads both teams from the whole picture, naming the god the OCR missed', () => {
    // Whole-picture OCR only caught the first level digit; "RA" it missed entirely.
    expect(parseScoreboard(screens.tab.lines, gods)).toEqual(expected([3, null, null, null, null, null]));
  });

  it('reads both teams from the picture the reader sends, filling in cells the OCR dropped from the totals', () => {
    const board = parseScoreboard(frame('tab'), gods)!;
    expect(board).toEqual(expected([3, 3, 3, null, 3, 1]));
    // The first row's K, D and A weren't read at all; the totals (0) less the others give 0.
    expect(board.order[0]).toMatchObject({ k: 0, d: 0, a: 0 });
  });

  it('title-cases god names as read when the draft is not known', () => {
    const board = parseScoreboard(screens.tab.lines)!;
    expect(board.order.map((r) => r.god)).toEqual(['Sanhur', 'Odin', 'Artemis']);
    expect(board.chaos.map((r) => r.god)).toEqual(['Ares', '', 'Kali']);
  });

  it('tells the teams apart even when the draft lists are swapped', () => {
    const board = parseScoreboard(screens.tab.lines, { allies: ENEMIES, enemies: ALLIES })!;
    expect(board.order.map((r) => r.god)).toEqual(['Anhur', 'Odin', 'Artemis']);
  });

  it('is null on every other screen', () => {
    for (const k of ['tscreen', 'tscreen2', 'hud', 'hud2', 'godselect']) expect(parseScoreboard(screens[k].lines, gods)).toBeNull();
    for (const k of ['tscreen', 'tscreen2', 'hud', 'hud2']) expect(parseScoreboard(frame(k), gods)).toBeNull();
  });
});

describe('T screen', () => {
  it('finds the damage totals and the time window', () => {
    const log = parseCombatLog(screens.tscreen.lines)!;
    expect(log.dealt.total).toBe(1247);
    expect(log.taken.total).toBe(0);
    expect(log.window).toBe(20);
    expect(parseCombatLog(screens.hud.lines)).toBeNull();
    expect(parseCombatLog(screens.tab.lines)).toBeNull();
  });

  it('reads the ability rows from the plain and bright passes together', () => {
    const r = reads.tscreen;
    const log = parseCombatScreen(screens.tscreen.lines, inFrame(r.dealtPlain), inFrame(r.dealtBright))!;
    expect(log.dealt.total).toBe(1247);
    expect(log.dealt.rows.map((x) => [x.amount, x.hits])).toEqual([
      [482, 9],
      [453, 1],
      [210, 2],
      [102, 2],
    ]);
    expect(log.dealt.rows.map((x) => x.ability)).toEqual([expect.stringMatching(/^Tremors$/), expect.stringMatching(/^Tectonic Sh/), 'Seismic Crush', 'Cabrakan Basic Attack']);
    expect(log.taken).toEqual({ total: 0, rows: [] });
  });

  it('reads a match in progress: dealt, taken and the bars behind them', () => {
    const r = reads.tscreen2;
    const log = parseCombatScreen(frame('tscreen2'), [...inFrame(r.dealtPlain), ...inFrame(r.takenPlain)], [...inFrame(r.dealtBright), ...inFrame(r.takenBright)])!;
    expect(log).toEqual({
      dealt: {
        total: 1029,
        rows: [
          { amount: 534, hits: 4, ability: 'Anhur Basic Attack' },
          { amount: 388, hits: 5, ability: 'Anhur Basic Attack' },
          { amount: 107, hits: 1, ability: 'Anhur Basic Attack' },
        ],
      },
      taken: {
        total: 265,
        rows: [
          { amount: 136, hits: 1, ability: 'Bolt' },
          { amount: 129, hits: 3, ability: 'Ra Basic Attack' },
        ],
      },
      window: 20,
    });
  });

  it('still gets the numbers from the plain pass alone', () => {
    const r = reads.tscreen2;
    const log = parseCombatScreen(frame('tscreen2'), [...inFrame(r.dealtPlain), ...inFrame(r.takenPlain)], [])!;
    expect(log.dealt.rows.map((x) => [x.amount, x.hits])).toEqual([
      [534, 4],
      [388, 5],
      [107, 1],
    ]);
    expect(log.taken.rows.map((x) => [x.amount, x.hits])).toEqual([
      [136, 1],
      [129, 3],
    ]);
  });

  it('says where the headings are, for cutting the rows out', () => {
    const h = findDamageHeadings(frame('tscreen2'))!;
    expect(h.dealt!.total).toBe(1029);
    expect(h.taken!.total).toBe(265);
    expect(h.taken!.x).toBeGreaterThan(h.dealt!.x + 500);
    expect(findDamageHeadings(frame('tab'))).toBeNull();
  });

  it('reads the top cards: your side left, theirs right', () => {
    const cards = parseTopCards(screens.tscreen2.lines)!;
    expect(cards.kills).toEqual({ ally: { player: 'Liefwarrior', god: 'Anhur' }, enemy: { player: 'TrailbOt', god: 'Ares' } });
    expect(cards.damage.ally).toEqual({ player: 'ChompBOT', god: 'Artemis' });
    expect(cards.damage.enemy).toEqual({ player: 'SnoozybOt', god: 'Kali' });
    expect(cards.mitigated.ally).toEqual({ player: 'SlambOt', god: 'Odin' });
    expect(cards.gold.enemy!.player).toBe('Scoobybot');
    // From the shrunk picture one god name is lost, the players are not.
    expect(parseTopCards(frame('tscreen2'))!.kills.ally).toEqual({ player: 'Liefwarrior', god: 'Anhur' });
    expect(parseTopCards(screens.tab.lines)).toBeNull();
  });
});

describe('HUD', () => {
  it('reads the match clock, team kills and team gold from the top bar', () => {
    expect(parseHudTop(inFrame(reads.hud2.top))).toEqual({ time: '7:39', seconds: 459, orderKills: 3, chaosKills: 0, orderGold: 21266, chaosGold: 20061 });
    expect(parseHudTop(inFrame(reads.hud.top))).toMatchObject({ time: '2:00', seconds: 120, orderGold: 100000 });
    expect(parseHudTop(screens.tab.lines.slice(0, 1))).toBeNull();
  });

  it('reads your gold with the coin icon dropped', () => {
    expect(parseHudGold(inFrame(reads.hud.gold))).toBe(94600);
    // The coin came glued on as a leading 0.
    expect(parseHudGold(inFrame(reads.hud2.gold))).toBe(2376);
  });

  it('reads K/D/A only when it finds exactly three whole numbers', () => {
    expect(parseHudKda(reads.hud.kda.lines)).toEqual({ k: 0, d: 0, a: 0 });
    expect(parseHudKda(reads.hud2.kda.lines)).toEqual({ k: 2, d: 0, a: 1 });
    expect(parseHudKda([])).toBeNull();
    expect(parseHudKda([{ text: '2 o', words: [['2', 0, 0, 5, 9], ['o', 20, 0, 5, 9]] }])).toBeNull();
  });

  it('reads the frame rate', () => {
    expect(parseFps(inFrame(reads.hud.fps))).toBe(201);
    expect(parseFps(inFrame(reads.hud2.fps))).toBe(117);
    expect(parseFps([])).toBeNull();
  });
});

describe('kill banner', () => {
  const size = { w: 1914, h: 1106 };
  it('reads the names either side of the swords', () => {
    const lines: OcrLine[] = [
      { text: 'Liefwarrior', words: [['Liefwarrior', 733, 300, 100, 20]] },
      { text: 'Kali', words: [['Kali', 1080, 302, 32, 16]] },
    ];
    expect(parseKillBanner(lines, size)).toEqual({ killer: 'Liefwarrior', victim: 'Kali' });
  });

  it('takes the one name the OCR could see when it is one the match has shown', () => {
    // On the real screenshot the blue side's white-on-light-blue name is not picked up.
    expect(parseKillBanner(frame('hud2'), size)).toBeNull();
    expect(parseKillBanner(frame('hud2'), size, ['Kali', 'Ares'])).toEqual({ killer: '', victim: 'Kali' });
  });

  it('is quiet when there is no banner', () => {
    expect(parseKillBanner(screens.hud.lines, { w: 1914, h: 1072 }, ['Kali'])).toBeNull();
  });
});

describe('where to cut', () => {
  it('shrinks the middle of the picture to at most 1280 pixels on its longest side', () => {
    const c = centerCrop(1914, 1106);
    expect(c.box.w * c.scale).toBeLessThanOrEqual(1280.5);
    expect(c.box).toMatchObject({ x: 191, y: 88 });
    expect(centerCrop(1000, 700).scale).toBe(1);
  });

  it('puts the K/D/A strip left of centre, scaled by height', () => {
    const b = hudKdaCrop(1914, 1072);
    expect(b.x).toBeLessThan(957 - 300);
    expect(b.x + b.w).toBeGreaterThan(957 - 245);
    expect(b.x + b.w).toBeLessThan(957);
  });
});
