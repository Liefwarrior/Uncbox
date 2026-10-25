import type { PresetId } from '../state/model';
import { WIDGETS } from './registry';
import { CATEGORIES, type AnyWidgetDef, type Category } from './types';

// What the sidebar's "Get More Widgets" lists, as plain functions: which widgets match what was
// typed or picked, and how they are grouped. The sidebar only draws the result.

export interface LibrarySection {
  /** The heading; '' for a plain list. */
  title: string;
  defs: AnyWidgetDef[];
}

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Whether every word typed starts a word of the widget's name, hint, category or keywords. */
export function matchesQuery(def: AnyWidgetDef, query: string): boolean {
  const wanted = words(query);
  if (wanted.length === 0) return true;
  const have = words(`${def.name} ${def.hint} ${def.category} ${def.keywords ?? ''}`);
  return wanted.every((w) => have.some((h) => h.startsWith(w)));
}

/** The widgets a preset recommends, in library order. */
export const recommendedWidgets = (preset: PresetId): AnyWidgetDef[] => WIDGETS.filter((def) => def.presets?.includes(preset));

/**
 * The library for a search and a category chip. Typing searches everything (inside the chosen
 * category, if one is). With neither, the preset's recommended widgets come first, then every
 * other widget under its category.
 */
export function librarySections(opts: { query: string; category: Category | null; preset: PresetId; presetName: string }): LibrarySection[] {
  const { query, category, preset, presetName } = opts;
  const inCategory = (def: AnyWidgetDef) => !category || def.category === category;
  if (query.trim()) {
    const found = WIDGETS.filter((def) => inCategory(def) && matchesQuery(def, query));
    return found.length ? [{ title: '', defs: found }] : [];
  }
  if (category) return [{ title: category, defs: WIDGETS.filter(inCategory) }];

  const recommended = recommendedWidgets(preset);
  const sections: LibrarySection[] = recommended.length ? [{ title: `Recommended for ${presetName}`, defs: recommended }] : [];
  for (const name of CATEGORIES) {
    const defs = WIDGETS.filter((def) => def.category === name && !recommended.includes(def));
    if (defs.length) sections.push({ title: name, defs });
  }
  return sections;
}
