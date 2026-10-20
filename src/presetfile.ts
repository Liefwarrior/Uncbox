import { defaultPresetData, hydratePreset } from './state/hydrate';
import { PRESET_IDS, type PresetData, type PresetId } from './state/model';
import { cleanName } from './state/presets';
import { PRESETS } from './presets';

// A preset on its own, as a file you can hand to someone: a header that says what it is, then the
// same data Uncbox saves for a preset. Both directions go through forSharing(), so a file never
// carries your PC's devices or your progress, and one made by hand can't put them back.

export const PRESET_FILE_VERSION = 1;
export const PRESET_FILE_EXT = '.uncbox';
export const MAX_PRESET_FILE_BYTES = 5 * 1024 * 1024;

export interface PresetFile {
  uncbox: 'preset';
  version: typeof PRESET_FILE_VERSION;
  name: string;
  base: PresetId;
  exportedAt: string;
  data: PresetData;
}

export type PresetImport = { ok: true; name: string; base: PresetId; data: PresetData } | { ok: false; error: string };

/** For a file with a base this version doesn't know (one from a newer Uncbox): the plainest theme. */
const FALLBACK_BASE: PresetId = 'terminal';

/**
 * Only pictures that travel inside the file. A slot image that is a link to another site would
 * make whoever opens the preset fetch it, and would be gone from the file's point of view anyway.
 */
const sharedImage = (image: string) => (/^data:image\//i.test(image) ? image : '');

/**
 * A copy of a preset's data with what is personal or only meaningful on this PC taken out, and
 * progress put back to the start. What stays is the look and the setup: layout, background, titles,
 * slots, counters (labels), milestones, notes, widgets, app windows and the game panel's picture
 * settings.
 */
export function forSharing(data: PresetData, base: PresetId): PresetData {
  const d = structuredClone(data);
  const fresh = defaultPresetData(base);

  // Capture devices and game windows belong to this PC; leaving them out also means the panel
  // doesn't open someone's camera or attach to a program when the preset is loaded.
  d.game.deviceId = null;
  d.game.nativeGame = null;
  if (d.game.source === 'device' || d.game.source === 'native') d.game.source = 'none';

  d.run.timer = { startedAt: null, elapsedMs: 0 };
  d.slots = d.slots.map((s) => ({ ...s, image: sharedImage(s.image), down: false }));
  d.counters = d.counters.map((c) => ({ ...c, value: 0 }));
  d.milestones.items = d.milestones.items.map((m) => ({ ...m, done: false }));
  d.notes = d.notes.map((n) => ({ ...n, done: false }));

  // The match and the record are what happened on this PC, in the game and since.
  d.match = fresh.match;
  d.record = fresh.record;
  // Race, class and hardcore pick the character panel's look (class color); who and where is personal.
  d.character = { ...fresh.character, race: d.character.race, cls: d.character.cls, hardcore: d.character.hardcore, maxLevel: d.character.maxLevel };
  d.quests = [];
  d.wowLinkAt = 0;

  // Boxes stay where they were drawn; what they read is gone.
  d.hud = d.hud.map((r) => ({ ...r, value: '', at: 0 }));
  // Triggers are layout-ish and shared as they are; when one last fired is not.
  d.triggers = d.triggers.map((t) => ({ ...t, at: 0 }));
  // A weather place is likely home. The widget asks again.
  d.widgets = d.widgets.map((w) => (w.type === 'weather' ? { ...w, settings: { ...w.settings, place: '', lat: 0, lon: 0 } } : w));
  return d;
}

export function toPresetFile(name: string, base: PresetId, data: PresetData, exportedAt = new Date()): PresetFile {
  return {
    uncbox: 'preset',
    version: PRESET_FILE_VERSION,
    name: cleanName(name, PRESETS[base].name),
    base,
    exportedAt: exportedAt.toISOString(),
    data: forSharing(data, base),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (error: string): PresetImport => ({ ok: false, error });

/** Checks a parsed preset file and cleans it the way saved state is cleaned, so nothing odd gets in. */
export function fromPresetFile(json: unknown): PresetImport {
  if (!isObj(json) || json.uncbox !== 'preset') return fail('That doesn’t look like an Uncbox preset file.');
  if (typeof json.version !== 'number' || json.version < 1) return fail('That preset file is damaged.');
  if (json.version > PRESET_FILE_VERSION) return fail('That preset was made with a newer Uncbox. Update Uncbox to open it.');
  if (!isObj(json.data)) return fail('That preset file is empty.');
  const base = PRESET_IDS.includes(json.base as PresetId) ? (json.base as PresetId) : FALLBACK_BASE;
  return {
    ok: true,
    base,
    name: cleanName(json.name, PRESETS[base].name),
    data: forSharing(hydratePreset(base, json.data), base),
  };
}

/** The text of a preset file: size, then JSON, then fromPresetFile. */
export function parsePresetText(text: string): PresetImport {
  // Characters, not bytes, but the file size was checked first; this is for text from elsewhere.
  if (text.length > MAX_PRESET_FILE_BYTES) return fail('That file is too big to be a preset.');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail('That doesn’t look like an Uncbox preset file.');
  }
  return fromPresetFile(json);
}

/** "My WoW setup" → "My WoW setup.uncbox", without characters Windows won't take in a file name. */
export function presetFileName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/^[\s.]+|[\s.]+$/g, '');
  return `${safe || 'Uncbox preset'}${PRESET_FILE_EXT}`;
}
