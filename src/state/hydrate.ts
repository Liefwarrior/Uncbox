import { isBackgroundId } from '../backgrounds';
import { DEFAULT_CLIP_KEY, isClipKey } from '../clips/keys';
import { sizeOf } from '../panels/catalog';
import { PRESETS } from '../presets';
import {
  type AppState,
  type AppWindow,
  type BoardId,
  type GridItem,
  GRID_COLS,
  MAX_HISTORY,
  MAX_MILESTONES,
  MAX_QUESTS,
  MAX_SLOTS,
  PANEL_IDS,
  type PanelId,
  PRESET_IDS,
  type PresetData,
  type PresetId,
  type QuestState,
  SMITE_ROLES,
  emptySlot,
  isWindowId,
  uid,
} from './model';

export function defaultPresetData(id: PresetId): PresetData {
  const def = PRESETS[id];
  return { layout: def.layout.map((item) => ({ ...item })), ...def.data() };
}

function eachPreset(make: (id: PresetId) => PresetData): Record<PresetId, PresetData> {
  return Object.fromEntries(PRESET_IDS.map((id) => [id, make(id)])) as Record<PresetId, PresetData>;
}

export function defaultState(): AppState {
  return {
    version: 2,
    preset: 'pokemon',
    twitch: { channel: '', hideBots: true },
    clips: { enabled: true, key: DEFAULT_CLIP_KEY },
    discord: { pinned: [] },
    camera: { enabled: false, deviceId: null, mirrored: true },
    presets: eachPreset(defaultPresetData),
  };
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Lay saved data over the defaults so fields added in newer versions still get a value.
 * Arrays are taken whole from the saved side; type mismatches fall back to the default.
 */
function overlay<T>(base: T, saved: unknown): T {
  if (saved === undefined || saved === null) return base;
  if (isObj(base)) {
    if (!isObj(saved)) return base;
    const out: Obj = { ...base };
    for (const key of Object.keys(base)) out[key] = overlay((base as Obj)[key], saved[key]);
    return out as T;
  }
  if (Array.isArray(base)) return (Array.isArray(saved) ? saved : base) as T;
  return (typeof saved === typeof base ? saved : base) as T;
}

const objects = (v: unknown[]) => v.filter(isObj);
const str = (v: unknown) => (typeof v === 'string' ? v : null);
const int = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback);

function cleanLayout(saved: unknown, fallback: GridItem[], windows: AppWindow[]): GridItem[] {
  if (!Array.isArray(saved)) return fallback;
  const seen = new Set<string>();
  const items: GridItem[] = [];
  for (const raw of objects(saved)) {
    const i = raw.i as BoardId;
    const known = isWindowId(i) ? windows.some((w) => w.id === i) : PANEL_IDS.includes(i);
    if (!known || seen.has(i)) continue;
    seen.add(i);
    const { minW, minH } = sizeOf(i);
    const w = Math.min(GRID_COLS, Math.max(minW, int(raw.w, minW)));
    items.push({
      i,
      w,
      h: Math.max(minH, int(raw.h, minH)),
      x: Math.min(GRID_COLS - w, Math.max(0, int(raw.x))),
      y: Math.max(0, int(raw.y)),
    });
  }
  return items;
}

const QUEST_STATES: QuestState[] = ['open', 'complete', 'failed'];

function hydratePreset(id: PresetId, saved: unknown): PresetData {
  const base = defaultPresetData(id);
  const p = overlay(base, saved);
  const s = isObj(saved) ? saved : {};

  // Nullable fields have null defaults, so overlay() cannot type-check them.
  const game = isObj(s.game) ? s.game : {};
  p.game.deviceId = str(game.deviceId);
  const run = isObj(s.run) && isObj(s.run.timer) ? s.run.timer : {};
  p.run.timer.startedAt = typeof run.startedAt === 'number' ? run.startedAt : null;

  p.windows = objects(p.windows)
    .map((w) => overlay<AppWindow>({ id: `win-${uid()}`, title: 'App window', fit: 'contain', crop: { ...base.game.crop } }, w))
    .filter((w) => isWindowId(w.id));
  p.layout = cleanLayout(s.layout, base.layout, p.windows);
  p.slots = objects(p.slots).map((m) => overlay(emptySlot(), m)).slice(0, MAX_SLOTS);
  p.counters = objects(p.counters).map((c) => overlay({ id: uid(), label: 'Counter', value: 0 }, c));
  p.notes = objects(p.notes).map((n) => overlay({ id: uid(), text: '', done: false }, n));
  p.milestones.items = objects(p.milestones.items)
    .map((m) => overlay({ id: uid(), name: '', done: false }, m))
    .slice(0, MAX_MILESTONES);
  if (!SMITE_ROLES.includes(p.match.role as never)) p.match.role = '';
  if (!isBackgroundId(p.background)) p.background = base.background;
  p.record.history = objects(p.record.history)
    .map((r) => overlay({ id: uid(), god: '', role: '' as const, k: 0, d: 0, a: 0, win: false, at: 0 }, r))
    .slice(0, MAX_HISTORY);
  p.quests = objects(p.quests)
    .map((q) => ({
      ...overlay({ title: '', level: 0, state: 'open' as QuestState }, q),
      objectives: (Array.isArray(q.objectives) ? objects(q.objectives) : []).map((o) => overlay({ text: '', done: false }, o)),
    }))
    .filter((q) => q.title && QUEST_STATES.includes(q.state))
    .slice(0, MAX_QUESTS);
  return p;
}

/** Version 1 had a single Pokémon-style board; it becomes the Pokémon preset. */
function migrateV1(v1: Obj): AppState {
  const state = defaultState();
  const milestones = isObj(v1.milestones) ? v1.milestones : {};
  const done = Array.isArray(milestones.done) ? milestones.done : [];
  const shown = isObj(v1.layout) && isObj(v1.layout.panels) ? v1.layout.panels : {};
  const renamed: Record<string, PanelId> = { party: 'slots' };
  const hidden = new Set<string>(
    Object.entries(shown)
      .filter(([, on]) => on === false)
      .map(([k]) => renamed[k] ?? k),
  );
  state.presets.pokemon = hydratePreset('pokemon', {
    game: v1.game,
    run: v1.run,
    slots: v1.party,
    counters: v1.counters,
    notes: v1.notes,
    milestones: {
      label: milestones.label,
      items: done.map((d) => ({ id: uid(), name: '', done: Boolean(d) })),
    },
    layout: PRESETS.pokemon.layout.filter((item) => !hidden.has(item.i)),
  });
  state.camera = overlay(state.camera, v1.camera);
  state.camera.deviceId = isObj(v1.camera) ? str(v1.camera.deviceId) : null;
  return state;
}

export function hydrate(saved: unknown): AppState {
  if (!isObj(saved)) return defaultState();
  if (saved.version !== 2) return migrateV1(saved);
  const base = defaultState();
  const presets = isObj(saved.presets) ? saved.presets : {};
  const camera = isObj(saved.camera) ? saved.camera : {};
  const clips = overlay(base.clips, saved.clips);
  if (!isClipKey(clips.key)) clips.key = DEFAULT_CLIP_KEY;
  return {
    version: 2,
    preset: PRESET_IDS.includes(saved.preset as PresetId) ? (saved.preset as PresetId) : base.preset,
    twitch: overlay(base.twitch, saved.twitch),
    clips,
    discord: {
      pinned: (isObj(saved.discord) && Array.isArray(saved.discord.pinned) ? objects(saved.discord.pinned) : [])
        .map((c) => overlay({ id: '', name: '', guildId: '', guildName: '' }, c))
        .filter((c) => /^\d+$/.test(c.id)),
    },
    camera: { ...overlay(base.camera, camera), deviceId: str(camera.deviceId) },
    presets: eachPreset((id) => hydratePreset(id, presets[id])),
  };
}
