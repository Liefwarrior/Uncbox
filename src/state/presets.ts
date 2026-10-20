import { PRESETS, type PresetDef } from '../presets';
import {
  type AppState,
  type CustomId,
  type CustomPreset,
  isCustomId,
  MAX_CUSTOM,
  MAX_PRESET_NAME,
  type PresetData,
  PRESET_IDS,
  type PresetId,
  uid,
} from './model';

// Built-in and custom presets side by side. Everything that used to look up PRESETS[state.preset]
// goes through activePreset() instead, so a copy of the WoW preset is still "wow" wherever the
// game matters (its base), and still wears its own name.

export interface ActivePreset {
  id: PresetId | CustomId;
  /** The built-in preset it is, or is a copy of. Check this for anything game-specific. */
  base: PresetId;
  /** The base's definition, with a custom preset's own name. */
  def: PresetDef;
  data: PresetData;
}

/** What stands in when state.preset points at a custom preset that is gone. */
const FALLBACK: PresetId = PRESET_IDS[0];

export function activePreset(state: AppState): ActivePreset {
  if (isCustomId(state.preset)) {
    const custom = state.custom.find((c) => c.id === state.preset);
    if (custom) return { id: custom.id, base: custom.base, def: { ...PRESETS[custom.base], name: custom.name }, data: custom.data };
    return { id: FALLBACK, base: FALLBACK, def: PRESETS[FALLBACK], data: state.presets[FALLBACK] };
  }
  return { id: state.preset, base: state.preset, def: PRESETS[state.preset], data: state.presets[state.preset] };
}

/** A name that fits in the sidebar and a file name: one line, trimmed, not too long. */
export function cleanName(v: unknown, fallback = ''): string {
  const name = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_PRESET_NAME).trim() : '';
  return name || fallback;
}

/** Every name in use, built-in ones included, so a custom preset never looks like one of them. */
export function takenNames(state: Pick<AppState, 'custom'>): string[] {
  return [...PRESET_IDS.map((id) => PRESETS[id].name), ...state.custom.map((c) => c.name)];
}

/** "Name", or "Name 2", "Name 3"… when that is taken. */
export function uniqueName(name: string, taken: string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  const m = /^(.*\S)\s+(\d+)$/.exec(name);
  const stem = m ? m[1] : name;
  for (let n = m ? Number(m[2]) + 1 : 2; ; n++) {
    const suffix = ` ${n}`;
    const next = `${stem.slice(0, MAX_PRESET_NAME - suffix.length).trim()}${suffix}`;
    if (!used.has(next.toLowerCase())) return next;
  }
}

export function newCustomId(): CustomId {
  return `custom-${uid()}`;
}

/** Adds a preset of your own and switches to it. Does nothing at the limit; check `canAddCustom` first. */
export function addCustom(draft: AppState, id: CustomId, name: string, base: PresetId, data: PresetData) {
  if (!canAddCustom(draft)) return;
  draft.custom.push({ id, name: uniqueName(name, takenNames(draft)), base, data });
  draft.preset = id;
}

export const canAddCustom = (state: Pick<AppState, 'custom'>) => state.custom.length < MAX_CUSTOM;

/** A copy of the active preset, kept whole (it is your own PC), except that a running timer is paused. */
export function copyOfActive(state: AppState): { base: PresetId; data: PresetData } {
  const { base, data } = activePreset(state);
  const copy = structuredClone(data);
  const { startedAt } = copy.run.timer;
  if (startedAt !== null) copy.run.timer = { startedAt: null, elapsedMs: copy.run.timer.elapsedMs + Math.max(0, Date.now() - startedAt) };
  return { base, data: copy };
}

export function renameCustom(draft: AppState, id: CustomId, name: string) {
  const custom = draft.custom.find((c) => c.id === id);
  const clean = cleanName(name);
  if (!custom || !clean || clean === custom.name) return;
  custom.name = uniqueName(clean, takenNames({ custom: draft.custom.filter((c) => c.id !== id) }));
}

/** If it was showing, its built-in base takes over. */
export function removeCustom(draft: AppState, id: CustomId) {
  const custom = draft.custom.find((c) => c.id === id);
  if (!custom) return;
  draft.custom = draft.custom.filter((c) => c.id !== id);
  if (draft.preset === id) draft.preset = custom.base;
}

/** Puts a deleted preset back where it was (an Undo). */
export function restoreCustom(draft: AppState, custom: CustomPreset, index: number, show: boolean) {
  if (draft.custom.some((c) => c.id === custom.id) || !canAddCustom(draft)) return;
  draft.custom.splice(Math.min(index, draft.custom.length), 0, custom);
  if (show) draft.preset = custom.id;
}
