import { isBackgroundId } from '../backgrounds';
import { DEFAULT_CLIP_KEY, isClipKey } from '../clips/keys';
import { defaultWidgetSettings } from '../widgets/catalog';
import { sizeOf } from '../panels/catalog';
import { PRESETS } from '../presets';
import { cleanName } from './presets';
import {
  type AppState,
  type AppWindow,
  type BoardId,
  type CustomPreset,
  type GridItem,
  GRID_COLS,
  isCustomId,
  MAX_CUSTOM,
  MAX_HISTORY,
  MAX_MILESTONES,
  MAX_HUD,
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
  isWidgetId,
  isWindowId,
  uid,
  type VideoFit,
  type VideoSource,
  type Widget,
  WIDGET_TYPES,
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
    custom: [],
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

function cleanLayout(saved: unknown, fallback: GridItem[], windows: AppWindow[], widgets: Widget[]): GridItem[] {
  if (!Array.isArray(saved)) return fallback;
  const seen = new Set<string>();
  const items: GridItem[] = [];
  for (const raw of objects(saved)) {
    const i = raw.i as BoardId;
    const known = isWindowId(i)
      ? windows.some((w) => w.id === i)
      : isWidgetId(i)
        ? widgets.some((w) => w.id === i)
        : PANEL_IDS.includes(i);
    if (!known || seen.has(i)) continue;
    seen.add(i);
    const { minW, minH } = sizeOf(i, widgets);
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
const VIDEO_SOURCES: VideoSource[] = ['none', 'device', 'window', 'chroma', 'native'];
const VIDEO_FITS: VideoFit[] = ['contain', 'cover', 'stretch'];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Cleans one preset's saved data against its built-in base. Also used for imported preset files. */
export function hydratePreset(id: PresetId, saved: unknown): PresetData {
  const base = defaultPresetData(id);
  const p = overlay(base, saved);
  const s = isObj(saved) ? saved : {};

  // Nullable fields have null defaults, so overlay() cannot type-check them.
  const game = isObj(s.game) ? s.game : {};
  p.game.deviceId = str(game.deviceId);
  const ng = isObj(game.nativeGame) ? game.nativeGame : null;
  p.game.nativeGame = ng && str(ng.process) ? { process: str(ng.process)!, title: str(ng.title) ?? '', ...(ng.exact === true ? { exact: true } : {}) } : null;
  // Words and colors the panels switch on or paint with; anything else (a hand-edited or shared
  // file) goes back to the default.
  if (!VIDEO_SOURCES.includes(p.game.source)) p.game.source = base.game.source;
  if (!VIDEO_FITS.includes(p.game.fit)) p.game.fit = base.game.fit;
  if (!HEX_COLOR.test(p.game.chroma)) p.game.chroma = base.game.chroma;
  const run = isObj(s.run) && isObj(s.run.timer) ? s.run.timer : {};
  p.run.timer.startedAt = typeof run.startedAt === 'number' ? run.startedAt : null;

  p.windows = objects(p.windows)
    .map((w) => overlay<AppWindow>({ id: `win-${uid()}`, title: 'App window', fit: 'contain', crop: { ...base.game.crop } }, w))
    .filter((w) => isWindowId(w.id));
  for (const w of p.windows) if (!VIDEO_FITS.includes(w.fit)) w.fit = 'contain';
  p.widgets = objects(p.widgets)
    .filter((w) => typeof w.id === 'string' && isWidgetId(w.id) && WIDGET_TYPES.includes(w.type as never))
    .map((w) => ({
      id: w.id as Widget['id'],
      type: w.type as Widget['type'],
      title: str(w.title) ?? '',
      settings: overlay(defaultWidgetSettings(), w.settings),
    }));
  p.hud = objects(p.hud)
    .map((r) => overlay({ id: uid(), label: '', x: 0, y: 0, w: 10, h: 5, numeric: true, value: '', at: 0 }, r))
    .slice(0, MAX_HUD);
  p.layout = cleanLayout(s.layout, base.layout, p.windows, p.widgets);
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

/** Presets of your own are held to the same rules as built-in ones, against their base. */
function hydrateCustom(saved: unknown): CustomPreset[] {
  const out: CustomPreset[] = [];
  const ids = new Set<string>();
  for (const raw of Array.isArray(saved) ? objects(saved) : []) {
    if (out.length >= MAX_CUSTOM) break;
    const { id, base } = raw;
    if (typeof id !== 'string' || !isCustomId(id) || ids.has(id)) continue;
    if (!PRESET_IDS.includes(base as PresetId)) continue;
    ids.add(id);
    out.push({ id, base: base as PresetId, name: cleanName(raw.name, PRESETS[base as PresetId].name), data: hydratePreset(base as PresetId, raw.data) });
  }
  return out;
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
  const custom = hydrateCustom(saved.custom);
  // A preset that no longer exists (deleted, or dropped above) leaves the first built-in showing.
  const shown = saved.preset;
  const preset =
    PRESET_IDS.includes(shown as PresetId) || custom.some((c) => c.id === shown) ? (shown as AppState['preset']) : base.preset;
  return {
    version: 2,
    preset,
    twitch: overlay(base.twitch, saved.twitch),
    clips,
    discord: {
      pinned: (isObj(saved.discord) && Array.isArray(saved.discord.pinned) ? objects(saved.discord.pinned) : [])
        .map((c) => overlay({ id: '', name: '', guildId: '', guildName: '' }, c))
        .filter((c) => /^\d+$/.test(c.id)),
    },
    camera: { ...overlay(base.camera, camera), deviceId: str(camera.deviceId) },
    presets: eachPreset((id) => hydratePreset(id, presets[id])),
    custom,
  };
}
