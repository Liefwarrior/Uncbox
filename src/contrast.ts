/** WCAG 2.x contrast math and a reader for the theme tokens in styles.css (used by tests). */

export type Rgb = [number, number, number];

/** Parses #rgb, #rrggbb, rgb() and rgba(); returns the color and its alpha. */
export function parseColor(value: string): { rgb: Rgb; alpha: number } | null {
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return { rgb: [...m[1]].map((c) => parseInt(c + c, 16)) as Rgb, alpha: 1 };
  m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) return { rgb: [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as Rgb, alpha: 1 };
  m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/.exec(v);
  if (m) return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: m[4] === undefined ? 1 : Number(m[4]) };
  return null;
}

/** Lays a translucent color over an opaque one. */
export function over(top: { rgb: Rgb; alpha: number }, under: Rgb): Rgb {
  return top.rgb.map((c, i) => Math.round(c * top.alpha + under[i] * (1 - top.alpha))) as Rgb;
}

export function luminance([r, g, b]: Rgb): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Reads each `.theme-x { --token: value; }` block of a stylesheet into a token map. */
export function readThemes(css: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  const block = /^\.theme-([a-z0-9]+)\s*\{([^}]*)\}/gm;
  for (let m = block.exec(css); m; m = block.exec(css)) {
    const tokens: Record<string, string> = {};
    for (const d of m[2].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) tokens[d[1]] = d[2].trim();
    out[m[1]] = tokens;
  }
  return out;
}
