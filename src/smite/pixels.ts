// Pixel work for reading SMITE 2's screen: the two tricks that turn pictures OCR can't read into
// ones it can. Plain functions over RGBA bytes (what a canvas gives), so they run in a worker and
// can be tested without a browser.

export interface Picture {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

const gray = (d: Uint8ClampedArray, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/**
 * Keeps only the brightest pixels, as black on white. White text on a coloured bar ("482 (x9)" on
 * blue) is garbled by OCR as it is, but it is the brightest thing in the picture, so everything
 * dimmer than `cut` (0-255) goes white and the text stands alone.
 */
export function brightText(p: Picture, cut: number): Picture {
  const out = new Uint8ClampedArray(p.data.length);
  for (let i = 0; i < p.data.length; i += 4) {
    const v = gray(p.data, i) >= cut ? 0 : 255;
    out[i] = out[i + 1] = out[i + 2] = v;
    out[i + 3] = 255;
  }
  return { data: out, w: p.w, h: p.h };
}

/** The K/D/A strip's three numbers: where each one's columns are. See findKdaDigits. */
export interface Span {
  x0: number;
  x1: number;
}

/** The brightness a HUD digit has to reach to count as a mark (they are grey on a dark strip). */
export const KDA_CUT = 110;

/**
 * The strip beside your portrait is an icon, a number, an icon, a number, an icon and a number.
 * Given a band of the picture a little taller than the digits and wider than the strip, finds the
 * columns of the three numbers: the game's bright edges (the strip's frame, a bright sky behind it)
 * are ignored, the marks are grouped into runs, and the numbers are the three narrow runs spaced a
 * regular distance apart with an icon between each pair. `pitch` is that distance in pixels.
 * Null when the strip isn't found. `rows` are the rows that aren't the strip's frame.
 */
export function findKdaDigits(p: Picture, pitch: number): { spans: Span[]; rows: number[] } | null {
  const { data, w, h } = p;
  const mark = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mark[y * w + x] = gray(data, (y * w + x) * 4) >= KDA_CUT ? 1 : 0;
  // Bright background beside the strip, and the strip's frame, are not digits. Columns that are
  // marked all the way down are dropped first; then rows with a long unbroken line of marks (the
  // frame's top and bottom edges), then columns again over the rows that are left (its sides).
  const solid = (x: number, over: number[]) => over.length > 0 && over.reduce((n, y) => n + mark[y * w + x], 0) > 0.85 * over.length;
  const all = Array.from({ length: h }, (_, y) => y);
  const bare = Array.from({ length: w }, (_, x) => !solid(x, all));
  const longest = Math.max(16, 0.15 * w);
  const rows = all.filter((y) => {
    let run = 0;
    for (let x = 0; x < w; x++) {
      run = bare[x] && mark[y * w + x] ? run + 1 : 0;
      if (run >= longest) return false;
    }
    return true;
  });
  if (rows.length < 6) return null;
  const on = Array.from({ length: w }, (_, x) => bare[x] && !solid(x, rows) && rows.some((y) => mark[y * w + x]));
  // Runs of columns with marks; a gap of three empty columns ends one.
  const runs: Span[] = [];
  const gap = 3;
  for (let x = 0; x < w; x++) {
    if (!on[x]) continue;
    const last = runs[runs.length - 1];
    if (last && x - last.x1 <= gap) last.x1 = x;
    else runs.push({ x0: x, x1: x });
  }
  const width = (r: Span) => r.x1 - r.x0 + 1;
  const centre = (r: Span) => (r.x0 + r.x1) / 2;
  const slim = runs.filter((r) => width(r) >= 0.12 * pitch && width(r) <= 0.55 * pitch);
  // Each number has an icon (a wider run) just to its left, about 0.44 of the spacing away. The
  // icons are spaced like the numbers, so this is what tells the two sets apart.
  const hasIcon = (n: Span) =>
    runs.some((i) => i.x1 < n.x0 && width(i) >= 0.26 * pitch && Math.abs(centre(n) - centre(i) - 0.44 * pitch) <= 0.14 * pitch);
  let best: Span[] | null = null;
  for (const a of slim) {
    if (!hasIcon(a)) continue;
    for (const b of slim) {
      if (Math.abs(centre(b) - centre(a) - pitch) > 0.2 * pitch || !hasIcon(b)) continue;
      for (const c of slim) {
        if (Math.abs(centre(c) - centre(b) - pitch) > 0.2 * pitch || !hasIcon(c)) continue;
        if (!best || a.x0 < best[0].x0) best = [a, b, c];
      }
    }
  }
  return best ? { spans: best, rows } : null;
}

/**
 * One picture of the strip's three numbers for OCR: each cut out on its own (so the icons between
 * them can't be read as digits), brightest pixels black on white, enlarged 4 times, softened a
 * little (OCR reads these tiny digits better with soft edges than with hard blocks) and laid out
 * left to right with gaps. Null when the numbers can't be found.
 */
export function kdaPicture(p: Picture, pitch: number): Picture | null {
  const found = findKdaDigits(p, pitch);
  if (!found) return null;
  const { spans, rows } = found;
  const SCALE = 4;
  const PAD = 1;
  const MARGIN = 30;
  // Numbers closer than this get read as one word ("201"), which can't be split safely.
  const GAP = 80;
  const cells = spans.map((s) => ({ x0: Math.max(0, s.x0 - PAD), x1: Math.min(p.w - 1, s.x1 + PAD) }));
  const outW = MARGIN * 2 + GAP * (cells.length - 1) + cells.reduce((n, c) => n + (c.x1 - c.x0 + 1) * SCALE, 0);
  const outH = p.h * SCALE + MARGIN * 2;
  const ink = new Float32Array(outW * outH);
  let ox = MARGIN;
  for (const c of cells) {
    for (const y of rows) {
      for (let x = c.x0; x <= c.x1; x++) {
        if (gray(p.data, (y * p.w + x) * 4) < KDA_CUT) continue;
        for (let dy = 0; dy < SCALE; dy++) {
          for (let dx = 0; dx < SCALE; dx++) ink[(MARGIN + y * SCALE + dy) * outW + ox + (x - c.x0) * SCALE + dx] = 1;
        }
      }
    }
    ox += (c.x1 - c.x0 + 1) * SCALE + GAP;
  }
  // A 3 by 3 average, then white where there is no ink.
  const out = new Uint8ClampedArray(outW * outH * 4).fill(255);
  for (let y = 1; y < outH - 1; y++) {
    for (let x = 1; x < outW - 1; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += ink[(y + dy) * outW + x + dx];
      const v = Math.round(255 * (1 - sum / 9));
      const i = (y * outW + x) * 4;
      out[i] = out[i + 1] = out[i + 2] = v;
    }
  }
  return { data: out, w: outW, h: outH };
}
