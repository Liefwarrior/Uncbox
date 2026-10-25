// SMITE 2 read off the game picture. Windows' OCR (server/ocr.mjs) turns screenshots into lines of
// words with positions; everything here turns those into numbers and names. There is nothing
// about the page in this file (no canvas, no React), so it can be tested on real screenshots.
//
// OCR on game fonts is good but never perfect, so the parsers are built to forgive: a missing cell
// is worked out from the team's totals, a god read as "SANHUR" is matched against the gods from
// the draft, and a picture that isn't the screen we want gives null instead of nonsense.

/** One word as the OCR returns it: [text, x, y, width, height], in the picture's pixels. */
export type OcrWord = [string, number, number, number, number];
export interface OcrLine {
  text: string;
  words: OcrWord[];
}

/** Where a cut-out sits in the full game picture: its top left corner, and how much it was shrunk or enlarged. */
export interface CropInfo {
  ox: number;
  oy: number;
  scale: number;
}

/** Moves lines read from a cut-out back into the full picture's pixels, so every parser can work in one space. */
export function toFrame(lines: OcrLine[], c: CropInfo): OcrLine[] {
  return lines.map((l) => ({
    text: l.text,
    words: l.words.map(([t, x, y, w, h]) => [t, x / c.scale + c.ox, y / c.scale + c.oy, w / c.scale, h / c.scale] as OcrWord),
  }));
}

// --- Words and numbers ---------------------------------------------------------------------

interface Piece {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

function pieces(lines: OcrLine[]): Piece[] {
  return lines.flatMap((l) =>
    l.words.map(([t, x, y, w, h]) => ({ t, x, y, w, h, cx: x + w / 2, cy: y + h / 2 })),
  );
}

/**
 * A whole number from OCR text, or null when it isn't one. Game fonts make OCR read 0 as o and 1 as
 * l or I, so those are turned back here, and only here: inside a token that is otherwise digits,
 * never in a name.
 */
export function toInt(text: string): number | null {
  const t = text.replace(/,/g, '');
  if (!/^[0-9oOlI|]+$/.test(t)) return null;
  return Number(t.replace(/[oO]/g, '0').replace(/[lI|]/g, '1'));
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};

/** Lowercase letters only, so "Ah Muzen Cab", "AH MUZEN CAB" and "SAhMuzenCab" compare alike. */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

/** Words on one line of text: pieces close together in height, joined left to right. */
interface TextLine {
  text: string;
  x: number;
  y: number;
  h: number;
  cy: number;
}

function textLines(ps: Piece[]): TextLine[] {
  const sorted = [...ps].sort((a, b) => a.cy - b.cy);
  const groups: Piece[][] = [];
  for (const p of sorted) {
    const g = groups.find((g) => Math.abs(g[0].cy - p.cy) <= 0.6 * Math.max(g[0].h, p.h));
    if (g) g.push(p);
    else groups.push([p]);
  }
  return groups
    .map((g) => {
      g.sort((a, b) => a.x - b.x);
      let text = g[0].t;
      for (let i = 1; i < g.length; i++) {
        const gap = g[i].x - (g[i - 1].x + g[i - 1].w);
        text += (gap > 0.45 * g[i].h ? ' ' : '') + g[i].t;
      }
      const h = Math.max(...g.map((p) => p.h));
      return { text, x: g[0].x, y: Math.min(...g.map((p) => p.y)), h, cy: g.reduce((s, p) => s + p.cy, 0) / g.length };
    })
    .sort((a, b) => a.cy - b.cy);
}

// --- The Tab screen ------------------------------------------------------------------------

export interface Row {
  /** The god's proper name (matched against the draft when it's known), or '' if unreadable. */
  god: string;
  player: string;
  level: number | null;
  k: number | null;
  d: number | null;
  a: number | null;
  gold: number | null;
}

export interface Scoreboard {
  order: Row[];
  chaos: Row[];
}

/** The gods of the match, from the log: the player's team and the other one. */
export interface GodHints {
  allies: string[];
  enemies: string[];
}

interface Header {
  cy: number;
  h: number;
  cols: { k: number; d: number; a: number; gold: number };
  pitch: number;
}

/** The K / D / A header rows (one per team). A header only has to find two of the three letters. */
function findHeaders(ps: Piece[]): Header[] {
  const letters = ps.filter((p) => /^[KDA]$/.test(p.t));
  const used = new Set<Piece>();
  const headers: Header[] = [];
  for (const d of letters.filter((p) => p.t === 'D')) {
    const a = letters.find((p) => p.t === 'A' && p.x > d.x && Math.abs(p.cy - d.cy) < d.h && p.x - d.x < 8 * d.h);
    if (!a) continue;
    const pitch = a.cx - d.cx;
    const k = letters.find((p) => p.t === 'K' && Math.abs(p.cy - d.cy) < d.h && Math.abs(d.cx - pitch - p.cx) < pitch * 0.4);
    if (k) used.add(k);
    const gold = ps.find((p) => /^[GC]o?[l1I]d$/i.test(p.t) && Math.abs(p.cy - d.cy) < d.h);
    headers.push({
      cy: d.cy,
      h: d.h,
      cols: { k: k ? k.cx : d.cx - pitch, d: d.cx, a: a.cx, gold: gold ? gold.cx : a.cx + pitch * 1.5 },
      pitch,
    });
  }
  return headers.sort((a, b) => a.cy - b.cy);
}

const looksLikeGod = (s: string) => /^[A-Z][A-Z .'-]*$/.test(s.replace(/[^A-Za-z .'-]/g, '')) && s.replace(/[^A-Za-z]/g, '').length >= 2;

/** The draft's god an OCR'd word stands for, or null. Names glue icons on ("SANHUR"), so a god inside the word counts. */
export function matchGod(word: string, candidates: string[]): string | null {
  const w = squash(word);
  if (!w) return null;
  let best: { god: string; score: number } | null = null;
  for (const god of candidates) {
    const g = squash(god);
    if (!g) continue;
    let score = -1;
    if (w === g) score = 0;
    else if (g.length >= 3 && w.includes(g)) score = 0.5;
    else if (g.length <= 3 && w.length <= g.length + 1 && distance(w, g) <= 1) score = 1;
    else if (g.length > 3 && distance(w, g) <= 2) score = distance(w, g);
    if (score >= 0 && (!best || score < best.score)) best = { god, score };
  }
  return best ? best.god : null;
}

const titleCase = (s: string) => s.toLowerCase().replace(/(^|[ '-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());

interface DraftRow {
  y: number;
  godText: string;
  player: string;
  level: number | null;
  cells: { k: number | null; d: number | null; a: number | null; gold: number | null };
  named: boolean;
}

/**
 * Everyone's god, name, level, K/D/A and gold from the Tab screen, or null if it isn't showing.
 * `gods` (from the game's log) fixes god names the OCR garbled; without it names are title-cased
 * as read. Team totals are used to fill in a number the OCR dropped when it's the only one missing.
 */
export function parseScoreboard(lines: OcrLine[], gods?: GodHints): Scoreboard | null {
  const ps = pieces(lines);
  const headers = findHeaders(ps);
  if (!headers.length) return null;
  const labels = ps.filter((p) => /^(ORDER|CHAOS)$/.test(p.t));
  // Not the god pick screen, which also names the teams but has no table of numbers.
  if (!labels.length && headers.length < 2) return null;

  const out: Record<'order' | 'chaos', Row[]> = { order: [], chaos: [] };
  const drafts: { team: 'order' | 'chaos'; rows: DraftRow[] }[] = [];

  headers.forEach((hd, i) => {
    const label = labels
      .filter((l) => Math.abs(l.cy - hd.cy) < 3 * hd.h)
      .sort((a, b) => Math.abs(a.cy - hd.cy) - Math.abs(b.cy - hd.cy))[0];
    const team: 'order' | 'chaos' = label ? (label.t === 'ORDER' ? 'order' : 'chaos') : i === 0 ? 'order' : 'chaos';
    const top = hd.cy + hd.h;
    const bottom = headers[i + 1] ? headers[i + 1].cy - headers[i + 1].h : Infinity;
    const section = ps.filter((p) => p.cy > top && p.cy < bottom);

    // Numbers sit in columns under the K, D, A and Gold headers; rows are where they line up.
    const tol = { k: 0.45 * hd.pitch, d: 0.45 * hd.pitch, a: 0.45 * hd.pitch, gold: 0.9 * hd.pitch };
    const cells: { col: 'k' | 'd' | 'a' | 'gold'; v: number; cy: number; h: number }[] = [];
    for (const p of section) {
      const v = toInt(p.t);
      if (v === null) continue;
      const col = (['k', 'd', 'a', 'gold'] as const).find((c) => Math.abs(p.cx - hd.cols[c]) <= tol[c]);
      if (col) cells.push({ col, v, cy: p.cy, h: p.h });
    }
    const cellH = median(cells.map((c) => c.h)) || hd.h;
    const bands: { cy: number; cells: typeof cells }[] = [];
    for (const c of [...cells].sort((a, b) => a.cy - b.cy)) {
      const b = bands.find((b) => Math.abs(b.cy - c.cy) < 0.8 * cellH);
      if (b) {
        b.cells.push(c);
        b.cy = b.cells.reduce((s, x) => s + x.cy, 0) / b.cells.length;
      } else bands.push({ cy: c.cy, cells: [c] });
    }
    const gaps = bands.slice(1).map((b, j) => b.cy - bands[j].cy).filter((g) => g > 2 * cellH);
    const pitchY = median(gaps) || 4.6 * cellH;

    // Names: everything to the left of the K column, two lines a player (god, then name).
    const kEdge = hd.cols.k - 0.6 * hd.pitch;
    // Nothing counts below the totals row: the HUD's own labels ("PUSH") are down there.
    const limit = bands.length ? bands[bands.length - 1].cy + 0.5 * pitchY : Infinity;
    const words = section.filter((p) => p.x + p.w < kEdge && p.cy < limit && /[A-Za-z]{2}/.test(p.t));
    const nameX = words.length ? median(words.map((p) => p.x)) : hd.cols.k;
    const levels = section.filter((p) => p.x + p.w < nameX - 2 && toInt(p.t) !== null && p.t.length <= 2);

    const rows: DraftRow[] = bands.map((b) => ({
      y: b.cy,
      godText: '',
      player: '',
      level: null,
      cells: {
        k: b.cells.find((c) => c.col === 'k')?.v ?? null,
        d: b.cells.find((c) => c.col === 'd')?.v ?? null,
        a: b.cells.find((c) => c.col === 'a')?.v ?? null,
        gold: b.cells.find((c) => c.col === 'gold')?.v ?? null,
      },
      named: false,
    }));

    // A name's two lines belong to the row whose numbers are level with them.
    const nameLines = textLines(words.filter((p) => p.x >= nameX - 0.5 * hd.pitch));
    const placed = new Map<DraftRow, TextLine[]>();
    const loose: TextLine[] = [];
    for (const l of nameLines) {
      const row = rows.filter((r) => Math.abs(r.y - l.cy) < 0.5 * pitchY).sort((a, b) => Math.abs(a.y - l.cy) - Math.abs(b.y - l.cy))[0];
      if (row) placed.set(row, [...(placed.get(row) ?? []), l]);
      else loose.push(l);
    }
    // Lines with no numbers beside them (all dropped by the OCR) still make a row.
    for (let j = 0; j < loose.length; ) {
      const group = [loose[j]];
      while (loose[j + group.length] && loose[j + group.length].cy - group[group.length - 1].cy < 0.5 * pitchY) group.push(loose[j + group.length]);
      j += group.length;
      const row: DraftRow = {
        y: group.reduce((s, l) => s + l.cy, 0) / group.length,
        godText: '',
        player: '',
        level: null,
        cells: { k: null, d: null, a: null, gold: null },
        named: false,
      };
      rows.push(row);
      placed.set(row, group);
    }
    rows.sort((a, b) => a.y - b.y);

    for (const row of rows) {
      const ls = placed.get(row);
      if (ls?.length) {
        row.named = true;
        let god: TextLine | undefined;
        let player: TextLine | undefined;
        if (ls.length >= 2) {
          player = ls.reduce((best, l) => (l.h >= best.h ? l : best));
          god = ls.find((l) => l.cy < player!.cy && looksLikeGod(l.text));
        } else if (looksLikeGod(ls[0].text) && ls[0].cy < row.y - 0.25 * cellH) god = ls[0];
        else player = ls[0];
        row.godText = god?.text ?? '';
        row.player = player?.text ?? '';
      }
      const lv = levels
        .filter((p) => Math.abs(p.cy - row.y) < 0.5 * pitchY)
        .sort((a, b) => Math.abs(a.cy - row.y) - Math.abs(b.cy - row.y))[0];
      const n = lv ? toInt(lv.t) : null;
      row.level = n !== null && n >= 1 && n <= 20 ? n : null;
    }
    drafts.push({ team, rows });
  });

  // Totals (a row of numbers with no name) fill in a single missing cell: it's the total less the rest.
  for (const d of drafts) {
    const named = d.rows.filter((r) => r.named);
    const totals = d.rows.filter((r) => !r.named && r.y > Math.max(...named.map((r) => r.y), -Infinity)).pop();
    if (totals) {
      for (const col of ['k', 'd', 'a', 'gold'] as const) {
        const total = totals.cells[col];
        const missing = named.filter((r) => r.cells[col] === null);
        if (total !== null && missing.length === 1) {
          const rest = named.reduce((s, r) => s + (r.cells[col] ?? 0), 0);
          if (total >= rest) missing[0].cells[col] = total - rest;
        }
      }
    }
    d.rows = named;
  }

  // Which list of gods is which team's? The one the read names match best.
  const lists = gods ? [gods.allies, gods.enemies] : [];
  const score = (rows: DraftRow[], list: string[]) => rows.filter((r) => r.godText && matchGod(r.godText, list)).length;
  const assigned = new Map<DraftRow[], string[]>();
  if (gods && drafts.length) {
    if (drafts.length === 1) {
      const [only] = drafts;
      assigned.set(only.rows, score(only.rows, lists[0]) >= score(only.rows, lists[1]) ? lists[0] : lists[1]);
    } else {
      const [x, y] = drafts;
      const straight = score(x.rows, lists[0]) + score(y.rows, lists[1]);
      const crossed = score(x.rows, lists[1]) + score(y.rows, lists[0]);
      assigned.set(x.rows, straight >= crossed ? lists[0] : lists[1]);
      assigned.set(y.rows, straight >= crossed ? lists[1] : lists[0]);
    }
  }

  for (const d of drafts) {
    const list = assigned.get(d.rows) ?? [];
    const fixed = d.rows.map((r) => (r.godText ? matchGod(r.godText, list) : null));
    // One god nobody has been matched to, and one row with no god: they belong together.
    const left = list.filter((g) => !fixed.includes(g));
    const blanks = fixed.map((g, i) => (g === null && !d.rows[i].godText ? i : -1)).filter((i) => i >= 0);
    if (left.length === 1 && blanks.length === 1) fixed[blanks[0]] = left[0];
    d.rows.forEach((r, i) => {
      out[d.team].push({
        god: fixed[i] ?? (r.godText ? titleCase(r.godText.replace(/^[^A-Za-z]+/, '')) : ''),
        player: r.player,
        level: r.level,
        ...r.cells,
      });
    });
  }
  return out.order.length || out.chaos.length ? out : null;
}

// --- The T screen (combat log) -------------------------------------------------------------

export interface DamageRow {
  amount: number;
  hits: number;
  ability: string;
}

export interface DamageSide {
  total: number | null;
  rows: DamageRow[];
}

export interface CombatLog {
  dealt: DamageSide;
  taken: DamageSide;
  /** The "last N seconds" the lists cover (the screen says "Top 10 | 20s"). */
  window: number | null;
}

/** A "1,247 Damage dealt" heading: where it is, and the total in front of it. */
export interface DamageHeading {
  x: number;
  y: number;
  h: number;
  total: number | null;
}

function findHeading(ps: Piece[], word: RegExp): DamageHeading | null {
  const w = ps.find((p) => /^Dama(g|q)e$/i.test(p.t) && ps.some((n) => word.test(n.t) && Math.abs(n.cy - p.cy) < p.h && n.x > p.x && n.x - p.x < 6 * p.h));
  if (!w) return null;
  // The total is the number just in front: "1,247" is usually one word but can come split at the comma.
  const before = ps.filter((p) => p.x + p.w <= w.x + 2 && Math.abs(p.cy - w.cy) < w.h && toInt(p.t) !== null).sort((a, b) => b.x - a.x);
  const chain: Piece[] = [];
  for (const p of before) {
    const next = chain.length ? chain[chain.length - 1].x : w.x;
    if (next - (p.x + p.w) < 0.7 * w.h) chain.push(p);
    else break;
  }
  chain.reverse();
  return { x: chain.length ? chain[0].x : w.x, y: w.y, h: w.h, total: chain.length ? toInt(chain.map((p) => p.t).join('')) : null };
}

/** Where the damage headings are on the T screen, from the whole-picture read (it also tells which screen is up). */
export function findDamageHeadings(lines: OcrLine[]): { dealt: DamageHeading | null; taken: DamageHeading | null } | null {
  const ps = pieces(lines);
  const dealt = findHeading(ps, /^dea[l1I]t$/i);
  const taken = findHeading(ps, /^take[nr]$/i);
  return dealt || taken ? { dealt, taken } : null;
}

const NUM = '[0-9oOlI,]';
/** "534 (x4) Anhur …": the damage, the number of hits, and where the words start. "(xl)" is x1. */
const AMOUNT = new RegExp(`^(${NUM}+?)\\s*\\(\\s*[xX]\\s*([0-9oOlI]+)\\s*\\)?`);

interface RowRead {
  cy: number;
  h: number;
  amount: number | null;
  hits: number | null;
  /** Where the "(x4)" ends, so names are read from there on. */
  numbersEnd: number;
  name: string;
}

/** The rows of one side (everything below the heading and inside its half), one RowRead per line of text. */
export function readRows(ps: Piece[], heading: DamageHeading, width: number): RowRead[] {
  const inSide = ps.filter((p) => p.cy > heading.y + 2.2 * heading.h && p.x > heading.x - 0.2 * heading.h && p.x < heading.x + width);
  return textLines(inSide).map((line) => {
    const words = inSide.filter((p) => Math.abs(p.cy - line.cy) <= 0.6 * Math.max(p.h, line.h)).sort((a, b) => a.x - b.x);
    let amount: number | null = null;
    let hits: number | null = null;
    let numbersEnd = -Infinity;
    // Words are glued together in unpredictable ways ("388(x5", "(xl)"), so try the line as text.
    for (let n = 1; n <= Math.min(words.length, 4); n++) {
      const text = words.slice(0, n).map((w) => w.t).join(' ');
      const m = AMOUNT.exec(text.replace(/\s+/g, ' '));
      if (m && /\d|[oO]/.test(m[1])) {
        amount = toInt(m[1]);
        hits = toInt(m[2]);
        numbersEnd = words[n - 1].x + words[n - 1].w;
        break;
      }
    }
    if (amount === null && words.length) {
      // A glued or dropped "(x4)": the damage alone, if the first word is a number.
      const first = toInt(words[0].t);
      if (first !== null && words[0].t.length >= 2) {
        amount = first;
        numbersEnd = words[0].x + words[0].w;
      }
    }
    // The name is what follows the numbers, less any scraps of "(x4)" the OCR left behind.
    const after = words.filter((w) => w.x >= numbersEnd - 1 && !(amount !== null && toInt(w.t) !== null && w.x < numbersEnd + 2));
    while (after.length && /^[()xX|0-9oOlI]{1,5}$/.test(after[0].t)) after.shift();
    const name = after.map((w) => w.t).join(' ');
    return { cy: line.cy, h: line.h, amount, hits, numbersEnd, name };
  });
}

/**
 * Damage dealt and taken from the T screen, or null if it isn't showing. `plain` is the normal
 * read; `bright` is a read of the same pictures with only the brightest pixels kept, which gets
 * the numbers on the coloured bars right where the plain read garbles them. Numbers come from
 * the bright read, names from the plain one, matched by how far down the row is.
 */
export function parseCombatLog(plain: OcrLine[], bright?: OcrLine[]): CombatLog | null {
  const heads = findDamageHeadings(plain);
  if (!heads) return null;
  const { dealt, taken } = heads;
  const pp = pieces(plain);
  const bp = bright ? pieces(bright) : [];
  const anchor = (dealt ?? taken)!;
  const width = dealt && taken ? Math.abs(taken.x - dealt.x) * 0.98 : 34 * anchor.h;

  const sideOf = (heading: DamageHeading | null): DamageSide => {
    if (!heading) return { total: null, rows: [] };
    const a = readRows(pp, heading, width);
    const b = bright ? readRows(bp, heading, width) : [];
    const rows: DamageRow[] = [];
    const lineH = median([...a, ...b].map((r) => r.h)) || heading.h;
    // Each row of the bright read, plus any row only the plain read could see.
    const used = new Set<RowRead>();
    for (const r of b) {
      const mate = a.filter((x) => !used.has(x) && Math.abs(x.cy - r.cy) < 1.2 * lineH).sort((x, y) => Math.abs(x.cy - r.cy) - Math.abs(y.cy - r.cy))[0];
      if (mate) used.add(mate);
      const amount = r.amount ?? mate?.amount ?? null;
      const hits = r.hits ?? mate?.hits ?? null;
      if (amount === null || hits === null) continue;
      // The plain read's name is usually cleaner; the bright read's is better when the plain one
      // was cut off ("Tremor" for "Tremors") or lost a letter ("Ba ic"): the same name, only
      // longer. A bright read that is longer because it's noisy differs by more than that.
      let ability = mate ? mate.name : r.name;
      if (!ability) ability = r.name;
      else {
        const a = squash(ability);
        const b = squash(r.name);
        if (a.length >= 3 && b.length > a.length && (b.startsWith(a) || distance(a, b) <= 2)) ability = r.name;
      }
      rows.push({ amount, hits, ability });
    }
    for (const x of a) {
      if (used.has(x) || x.amount === null || x.hits === null) continue;
      if (b.some((r) => Math.abs(r.cy - x.cy) < 1.2 * lineH)) continue;
      rows.push({ amount: x.amount, hits: x.hits, ability: x.name });
    }
    return { total: heading.total, rows };
  };

  const win = pp.find(
    (p) => /^\d+s$/i.test(p.t.replace(/O/g, '0')) && anchor.y - anchor.h < p.y && p.y < anchor.y + 3 * anchor.h && p.x > anchor.x && p.x < anchor.x + width,
  );
  return { dealt: sideOf(dealt), taken: sideOf(taken), window: win ? toInt(win.t.slice(0, -1)) : null };
}

/**
 * The combat log from everything one look at the T screen reads: the whole-picture read (headings
 * and totals, but garbled rows) and, for each side, the plain and bright reads of just the rows.
 * Everything is in the full picture's pixels. The garbled rows of the first read are dropped so
 * they can't be counted twice.
 */
export function parseCombatScreen(center: OcrLine[], rowsPlain: OcrLine[], rowsBright: OcrLine[]): CombatLog | null {
  const heads = findDamageHeadings(center);
  if (!heads) return null;
  const rowsTop = Math.min(...[heads.dealt, heads.taken].filter((x): x is DamageHeading => x !== null).map((x) => x.y + 2.2 * x.h));
  const header = center.filter((l) => l.words.every((w) => w[2] < rowsTop));
  return parseCombatLog([...header, ...rowsPlain], rowsBright);
}

/** The top cards above the combat log ("TOP KILLS": your team's best, and theirs). */
export interface TopCard {
  ally: { player: string; god: string } | null;
  enemy: { player: string; god: string } | null;
}
export type TopCards = Record<'damage' | 'gold' | 'kills' | 'mitigated', TopCard>;

export function parseTopCards(lines: OcrLine[]): TopCards | null {
  const ps = pieces(lines);
  const out = {} as TopCards;
  let found = 0;
  for (const key of ['damage', 'gold', 'kills', 'mitigated'] as const) {
    const word = ps.find((p) => p.t.toUpperCase() === key.toUpperCase() && ps.some((t) => /^TOP$/i.test(t.t) && Math.abs(t.cy - p.cy) < p.h && t.x < p.x && p.x - t.x < 5 * p.h));
    if (!word) {
      out[key] = { ally: null, enemy: null };
      continue;
    }
    const topWord = ps.filter((t) => /^TOP$/i.test(t.t) && Math.abs(t.cy - word.cy) < word.h && t.x < word.x).sort((a, b) => b.x - a.x)[0];
    const centre = (topWord.x + word.x + word.w) / 2;
    // The card sits below its heading: your side's player and god to the left of the middle, theirs to the right.
    const inCard = ps.filter((p) => p.cy > word.y + 2 * word.h && p.cy < word.y + 11 * word.h && Math.abs(p.cx - centre) < 22 * word.h && !/^\.+$/.test(p.t) && /[A-Za-z0-9]/.test(p.t));
    const side = (left: boolean) => {
      const ls = textLines(inCard.filter((p) => (left ? p.cx < centre : p.cx >= centre)));
      return ls.length ? { player: ls[0].text, god: ls[1]?.text ?? '' } : null;
    };
    out[key] = { ally: side(true), enemy: side(false) };
    found++;
  }
  return found ? out : null;
}

// --- The HUD -------------------------------------------------------------------------------

export interface HudTop {
  /** "7:39" as shown, and in seconds. */
  time: string;
  seconds: number;
  orderKills: number | null;
  chaosKills: number | null;
  orderGold: number | null;
  chaosGold: number | null;
}

/** The match timer and both teams' kills from the top bar. Kills are the numbers beside the timer. */
export function parseHudTop(lines: OcrLine[]): HudTop | null {
  const ps = pieces(lines);
  const timer = ps.find((p) => /^[0-9oOlI]{1,3}:[0-9oOlI]{2}$/.test(p.t));
  if (!timer) return null;
  const [m, s] = timer.t.split(':').map((x) => toInt(x) ?? 0);
  const row = ps.filter((p) => p !== timer && Math.abs(p.cy - timer.cy) < timer.h);
  const numeric = row.map((p) => ({ p, v: toInt(p.t) })).filter((n): n is { p: Piece; v: number } => n.v !== null);
  const left = numeric.filter((n) => n.p.x + n.p.w <= timer.x + 2).sort((a, b) => b.p.x - a.p.x);
  const right = numeric.filter((n) => n.p.x >= timer.x + timer.w - 2).sort((a, b) => a.p.x - b.p.x);
  // Kills are small numbers right next to the clock; gold is the long number beyond them.
  const kills = (side: typeof left) => (side[0] && side[0].v < 1000 && side[0].p.t.length <= 3 ? side[0].v : null);
  const gold = (side: typeof left) => side.find((n) => n.p.t.replace(/,/g, '').length >= 4)?.v ?? null;
  return { time: `${m}:${String(s).padStart(2, '0')}`, seconds: m * 60 + s, orderKills: kills(left), chaosKills: kills(right), orderGold: gold(left), chaosGold: gold(right) };
}

/** Your gold, bottom left. The coin reads as a 0 (sometimes glued on), so take the last number and drop leading zeros. */
export function parseHudGold(lines: OcrLine[]): number | null {
  const nums = pieces(lines).filter((p) => toInt(p.t) !== null).sort((a, b) => a.x - b.x);
  const last = nums[nums.length - 1];
  if (!last) return null;
  return Number(String(toInt(last.t)).replace(/^0+(?=\d)/, '')) || 0;
}

export interface Kda {
  k: number;
  d: number;
  a: number;
}

/** K/D/A from the picture of the three number cells laid side by side: exactly three whole numbers or nothing. */
export function parseHudKda(lines: OcrLine[]): Kda | null {
  const nums = pieces(lines).sort((a, b) => a.x - b.x);
  if (nums.length !== 3) return null;
  const v = nums.map((p) => toInt(p.t));
  if (v.some((n) => n === null || n > 99)) return null;
  return { k: v[0]!, d: v[1]!, a: v[2]! };
}

/** The frames-per-second counter in the corner ("FPS:117"), or null. */
export function parseFps(lines: OcrLine[]): number | null {
  const text = lines.map((l) => l.text).join(' ');
  const m = /FPS\s*:?\s*([0-9oOlI]{1,3})/i.exec(text);
  return m ? toInt(m[1]) : null;
}

// --- Kill banner ---------------------------------------------------------------------------

export interface KillBanner {
  killer: string;
  victim: string;
}

/**
 * "Liefwarrior ⚔ Kali" across the upper middle of the screen for a few seconds after a kill: the
 * killer's name left of the middle, the victim's right. `known` (gods and player names seen so
 * far) lets a banner be accepted when only one side could be read.
 */
export function parseKillBanner(lines: OcrLine[], size: { w: number; h: number }, known: string[] = []): KillBanner | null {
  const mid = size.w / 2;
  const names = pieces(lines).filter(
    (p) => p.cy > 0.15 * size.h && p.cy < 0.42 * size.h && p.h >= 0.011 * size.h && /^[A-Za-z0-9_-]{3,}$/.test(p.t) && Math.abs(p.cx - mid) > 0.025 * size.w && Math.abs(p.cx - mid) < 0.22 * size.w,
  );
  const known2 = new Set(known.map(squash));
  const pick = (left: boolean) => {
    const side = names.filter((p) => (left ? p.cx < mid : p.cx > mid));
    // The name nearest the swords.
    return side.sort((a, b) => Math.abs(a.cx - mid) - Math.abs(b.cx - mid))[0] ?? null;
  };
  const l = pick(true);
  const r = pick(false);
  if (l && r && Math.abs(l.cy - r.cy) < 0.6 * Math.max(l.h, r.h)) return { killer: l.t, victim: r.t };
  const one = l ?? r;
  if (one && known2.has(squash(one.t)) && !(l && r)) return l ? { killer: l.t, victim: '' } : { killer: '', victim: one.t };
  return null;
}

// --- Geometry: what to cut out of the game picture ---------------------------------------------

/** A rectangle in the full picture's pixels. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The longest side of the picture used to find out which screen is up (the Tab text is big enough). */
export const SCREEN_MAX_SIDE = 1280;

/** The middle of the picture, where the Tab and T screens are, and how much it's shrunk to stay under SCREEN_MAX_SIDE. */
export function centerCrop(w: number, h: number): { box: Box; scale: number } {
  const box = { x: Math.round(w * 0.1), y: Math.round(h * 0.08), w: Math.round(w * 0.8), h: Math.round(h * 0.87) };
  return { box, scale: Math.min(1, SCREEN_MAX_SIDE / Math.max(box.w, box.h)) };
}

/** The top bar: team gold, kills and the timer. */
export const hudTopCrop = (w: number, h: number): Box => ({ x: Math.round(w * 0.35), y: 0, w: Math.round(w * 0.3), h: Math.round(h * 0.06) });
/** The corner with the FPS counter. */
export const fpsCrop = (w: number, h: number): Box => ({ x: 0, y: 0, w: Math.round(w * 0.09), h: Math.round(h * 0.06) });
/** Your gold, bottom left (a margin above and below, because windowed games have a title bar). */
export const hudGoldCrop = (w: number, h: number): Box => ({ x: Math.round(w * 0.02), y: Math.round(h * 0.955), w: Math.round(w * 0.065), h: Math.round(h * 0.0325) });
/** How far apart the K, D and A numbers are in the K/D/A strip, as a fraction of the picture's height. */
export const KDA_PITCH = 0.0275;

/**
 * The K/D/A strip next to your portrait. It is placed from the middle of the picture and scales
 * with its height, like the rest of the HUD; the band is a little taller than the digits.
 */
export const hudKdaCrop = (w: number, h: number): Box => ({
  x: Math.round(w / 2 - 0.34 * h),
  y: Math.round(0.845 * h),
  w: Math.round(0.14 * h),
  h: Math.round(0.024 * h),
});

/**
 * Where the ability rows of the combat log are, from a damage heading: one box a side. The rows
 * start under the heading's bar and each is about 0.034 of the picture's height tall; there can be ten.
 */
export function combatRowsCrop(heading: DamageHeading, h: number): Box {
  return { x: Math.round(heading.x + 0.055 * h), y: Math.round(heading.y + 0.07 * h), w: Math.round(0.4 * h), h: Math.round(0.36 * h) };
}
