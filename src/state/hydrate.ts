import { hydrateAutomations } from '../automations/rules';
import { isBackgroundId } from '../backgrounds';
import { DEFAULT_CLIP_KEY, isClipKey } from '../clips/keys';
import { fitToBoard, isValid } from '../layout';
import { PRESETS, type PresetDef } from '../presets';
import { boardDef, newWidget, settingsFor, sizeOf, widgetDef } from '../widgets/registry';
import { isSingle } from '../widgets/types';
import { cleanName } from './presets';
import { isObj, overlay } from './overlay';
import {
  type AppState,
  type CustomPreset,
  type GridItem,
  GRID_COLS,
  GRID_ROWS,
  isCustomId,
  MAX_CUSTOM,
  MAX_HISTORY,
  MAX_MILESTONES,
  MAX_HUD,
  MAX_TRIGGERS,
  MAX_PHRASE,
  MAX_COOLDOWN,
  emptyTrigger,
  TRIGGER_ACTIONS,
  type ScreenTrigger,
  MAX_QUESTS,
  MAX_SLOTS,
  PRESET_IDS,
  type PresetData,
  type PresetId,
  type QuestState,
  SMITE_ROLES,
  emptySlot,
  isWidgetId,
  uid,
  type VideoFit,
  type VideoSource,
  type Widget,
} from './model';

/** The widgets a preset starts with, each with its kind's defaults and the preset's own settings laid over them. */
function seedWidgets(def: PresetDef): Widget[] {
  return (def.widgets ?? []).map((s) => newWidget(s.kind, { id: s.id, title: s.title, settings: s.settings }));
}

export function defaultPresetData(id: PresetId): PresetData {
  const def = PRESETS[id];
  return { layout: def.layout.map((item) => ({ ...item })), widgets: seedWidgets(def), ...def.data() };
}

/**
 * "Reset layout": the preset's own panels and widgets come back where they started; widgets you
 * added go. The preset's own widgets keep the settings you gave them (a Web widget's home page,
 * the Launcher's tiles), and everything else (notes, counters, game settings) stays.
 */
export function resetLayout(d: PresetData, base: PresetId) {
  const fresh = defaultPresetData(base);
  const mine = new Map(d.widgets.map((w) => [w.id, w]));
  d.layout = fresh.layout;
  d.widgets = fresh.widgets.map((w) => {
    const have = mine.get(w.id);
    return have && have.kind === w.kind ? have : w;
  });
}

function eachPreset(make: (id: PresetId) => PresetData): Record<PresetId, PresetData> {
  return Object.fromEntries(PRESET_IDS.map((id) => [id, make(id)])) as Record<PresetId, PresetData>;
}

export function defaultState(): AppState {
  return {
    version: 2,
    preset: 'pokemon',
    twitch: { channel: '', hideBots: true },
    clips: { enabled: true, key: DEFAULT_CLIP_KEY, driveAuto: false, driveShare: false },
    discord: { pinned: [] },
    camera: { enabled: false, deviceId: null, mirrored: true },
    presets: eachPreset(defaultPresetData),
    custom: [],
    automations: [],
  };
}

type Obj = Record<string, unknown>;

const objects = (v: unknown[]) => v.filter(isObj);
const str = (v: unknown) => (typeof v === 'string' ? v : null);
const int = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback);

/**
 * The widgets of a saved preset. A widget is read by its kind, which the library must know and
 * allow more than one of; anything else (a kind from a newer Uncbox, a hand-edited file) is dropped,
 * and so is a repeated id. Its settings are the kind's defaults with the saved ones laid over them,
 * which is also how files from before each kind kept its own settings are read: those had a
 * `type` instead of a `kind`, and one struct of everyone's settings, from which each kind takes its own.
 *
 * App windows used to be a list of their own ("win-..." ids); they are widgets of the kind `window`
 * now. `renamed` maps their old ids to the new ones, for the layout.
 */
function cleanWidgets(saved: unknown, windows: unknown, renamed: Map<string, string>): Widget[] {
  const widgets: Widget[] = [];
  const taken = new Set<string>();
  const add = (id: string, kind: string, title: unknown, settings: unknown) => {
    const def = widgetDef(kind);
    if (!def || isSingle(def) || !isWidgetId(id) || taken.has(id)) return false;
    taken.add(id);
    widgets.push({ id, kind, title: str(title) ?? '', settings: settingsFor(def, settings) });
    return true;
  };
  for (const w of objects(Array.isArray(saved) ? saved : [])) {
    const kind = str(w.kind) ?? str(w.type);
    if (typeof w.id === 'string' && kind) add(w.id, kind, w.title, w.settings);
  }
  for (const win of objects(Array.isArray(windows) ? windows : [])) {
    if (typeof win.id !== 'string' || !win.id.startsWith('win-')) continue;
    let id = `wdg-${win.id.slice(4)}`;
    if (taken.has(id)) id = `wdg-${uid()}`;
    // Windows were called "App window" unless renamed, which is what an untitled window is called now.
    const title = win.title === 'App window' ? '' : win.title;
    if (add(id, 'window', title, { fit: win.fit, crop: win.crop })) renamed.set(win.id, id);
  }
  return widgets;
}

/** The preset's own widgets that a layout uses and the saved widgets lack, so a layout is never left with holes. */
function withSeeds(layout: { i: string }[], widgets: Widget[], seeds: Widget[]): Widget[] {
  const out = [...widgets];
  for (const item of layout) {
    if (!isWidgetId(item.i) || out.some((w) => w.id === item.i)) continue;
    const seed = seeds.find((w) => w.id === item.i);
    if (seed) out.push(seed);
  }
  return out;
}

/**
 * The layout of a saved preset: only things this version can draw (single panels by kind,
 * widgets that exist), none twice, each at least its smallest size and on the board. `renamed`
 * is where old app window ids went. Null if nothing usable is left of a layout that had things in it.
 */
function cleanLayout(saved: unknown, widgets: Widget[], renamed: Map<string, string>): GridItem[] | null {
  if (!Array.isArray(saved)) return null;
  const seen = new Set<string>();
  const items: GridItem[] = [];
  for (const raw of objects(saved)) {
    const i = typeof raw.i === 'string' ? (renamed.get(raw.i) ?? raw.i) : '';
    if (!boardDef(i, widgets) || seen.has(i)) continue;
    seen.add(i);
    const { minW, minH } = sizeOf(i, widgets);
    const w = Math.min(GRID_COLS, Math.max(minW, int(raw.w, minW)));
    items.push({
      i,
      w,
      h: Math.min(GRID_ROWS, Math.max(minH, int(raw.h, minH))),
      x: Math.min(GRID_COLS - w, Math.max(0, int(raw.x))),
      y: Math.max(0, int(raw.y)),
    });
  }
  // Everything dropped: better the preset's own board than an empty one. (A board you emptied yourself stays empty.)
  if (saved.length > 0 && items.length === 0) return null;
  return items;
}

const pct = (n: number) => Math.min(100, Math.max(0, n));

/** A trigger from a hand-edited or shared file: its box stays on the picture and its action is a known one. */
function cleanTrigger(t: ScreenTrigger): ScreenTrigger {
  t.x = pct(t.x);
  t.y = pct(t.y);
  t.w = Math.min(100 - t.x, pct(t.w));
  t.h = Math.min(100 - t.y, pct(t.h));
  t.phrase = t.phrase.slice(0, MAX_PHRASE);
  t.cooldownSec = Math.min(MAX_COOLDOWN, Math.max(1, Math.round(t.cooldownSec) || 5));
  const kind = t.action.kind;
  if (!TRIGGER_ACTIONS.includes(kind)) t.action = { kind: 'counter', counterId: '' };
  else if (t.action.kind === 'counter') t.action = { kind: 'counter', counterId: String(t.action.counterId ?? '') };
  else t.action = { kind } as ScreenTrigger['action'];
  return t;
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

  // The board: widgets first (old app windows become widgets), then a layout made of things that exist.
  const renamed = new Map<string, string>();
  // The preset's own widgets that the saved layout mentions come back if the save lost them.
  const kept = cleanWidgets(s.widgets, s.windows, renamed);
  const mentioned = (Array.isArray(s.layout) ? objects(s.layout) : []).flatMap((item) => (typeof item.i === 'string' ? [{ i: renamed.get(item.i) ?? item.i }] : []));
  const widgets = withSeeds(mentioned, kept, base.widgets);
  let layout = cleanLayout(s.layout, widgets, renamed);
  // A layout with panels on top of each other or off the board is squeezed back on; if it can't be, the preset's own is used.
  if (layout && !isValid(layout, widgets)) layout = fitToBoard(layout, undefined, widgets);
  p.layout = layout ?? base.layout;
  // The preset's own board has widgets of its own, which a save without them (or one that lost them) gets back.
  // A widget that is not on the board is nowhere to be seen, so it goes rather than pile up.
  p.widgets = withSeeds(p.layout, widgets, base.widgets).filter((w) => p.layout.some((item) => item.i === w.id));
  p.hud = objects(p.hud)
    .map((r) => overlay({ id: uid(), label: '', x: 0, y: 0, w: 10, h: 5, numeric: true, value: '', at: 0 }, r))
    .slice(0, MAX_HUD);
  p.triggers = objects(Array.isArray(s.triggers) ? s.triggers : [])
    .map((t) => cleanTrigger(overlay(emptyTrigger(), t)))
    .slice(0, MAX_TRIGGERS);
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
    const preset: CustomPreset = { id, base: base as PresetId, name: cleanName(raw.name, PRESETS[base as PresetId].name), data: hydratePreset(base as PresetId, raw.data) };
    if (typeof raw.galleryId === 'string' && /^[a-z0-9-]{1,48}$/.test(raw.galleryId)) preset.galleryId = raw.galleryId;
    out.push(preset);
  }
  return out;
}

/** Version 1 had a single Pokémon-style board; it becomes the Pokémon preset. */
function migrateV1(v1: Obj): AppState {
  const state = defaultState();
  const milestones = isObj(v1.milestones) ? v1.milestones : {};
  const done = Array.isArray(milestones.done) ? milestones.done : [];
  const shown = isObj(v1.layout) && isObj(v1.layout.panels) ? v1.layout.panels : {};
  const renamed: Record<string, string> = { party: 'slots' };
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
    automations: hydrateAutomations(saved.automations),
  };
}
