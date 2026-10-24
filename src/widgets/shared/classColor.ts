import { contrast, parseColor, type Rgb } from '../../contrast';
import { WOW_CLASSES } from '../../presets';

// Class colors for the WoW guild widgets. The official colors are used, except that one too dark
// to read on the panels (the Shaman's blue) is lightened until it reads at 4.5:1 on the lightest
// panel of every theme. The themes are all dark, so this only ever lightens.

/** About the lightest thing text sits on in any theme (an inset: --panel-2 of the Steam theme). */
const LIGHTEST_UNDER: Rgb = [42, 52, 66];
const READABLE = 4.5;

/** A color made lighter, a little at a time, until it reads on the panels; unchanged if it already does. */
export function readableOnDark(hex: string, under: Rgb = LIGHTEST_UNDER): string {
  const parsed = parseColor(hex);
  if (!parsed) return hex;
  const base = parsed.rgb;
  for (let mix = 0; mix <= 1.0001; mix += 0.05) {
    const rgb = base.map((c) => Math.round(c + (255 - c) * mix)) as Rgb;
    if (contrast(rgb, under) >= READABLE) return `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  }
  return '#ffffff';
}

/** "DRUID", "druid" and "Druid" are all "Druid"; anything that isn't a class WoW Forever has is ''. */
export function classKey(cls: string | null | undefined): string {
  const text = String(cls ?? '').trim().toLowerCase();
  return Object.keys(WOW_CLASSES).find((c) => c.toLowerCase() === text) ?? '';
}

const READABLE_CLASSES = Object.fromEntries(Object.entries(WOW_CLASSES).map(([k, v]) => [k, readableOnDark(v)]));

/** The color to draw a class name or dot in, in every theme. The text color for a class that isn't known. */
export function classColor(cls: string | null | undefined): string {
  return READABLE_CLASSES[classKey(cls)] ?? 'var(--text)';
}

/** The class's name for people: "Druid". Empty when unknown. */
export const classLabel = (cls: string | null | undefined): string => classKey(cls);

/** The classes in the order the game lists them. */
export const CLASS_NAMES = Object.keys(WOW_CLASSES);
