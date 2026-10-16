// Everything the dashboard remembers. Saved to data/state.json by the local server and shared
// live between every open window, so a phone or second monitor can drive the streamed one.

export type PanelId = 'camera' | 'party' | 'run' | 'progress' | 'notes';

export const PANEL_LABELS: Record<PanelId, string> = {
  camera: 'Camera',
  party: 'Party',
  run: 'Run',
  progress: 'Progress',
  notes: 'Notes',
};

export type VideoSource = 'none' | 'device' | 'window' | 'chroma';
export type VideoFit = 'contain' | 'cover' | 'stretch';

export interface Crop {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface GameSettings {
  source: VideoSource;
  deviceId: string | null;
  fit: VideoFit;
  /** Nearest-neighbour scaling, so GB/GBA/DS pixel art stays crisp when blown up. */
  pixelated: boolean;
  /** Percent of the source trimmed from each edge, e.g. an emulator's menu bar. */
  crop: Crop;
  /** Solid color for the "chroma slot" source; key it out in OBS and put your capture under it. */
  chroma: string;
}

export interface CameraSettings {
  /** Off until first switched on, so the page never grabs a webcam OBS may already be using. */
  enabled: boolean;
  deviceId: string | null;
  mirrored: boolean;
}

export interface PartyMember {
  id: string;
  name: string;
  detail: string;
  /** Small data: URL (downscaled upload) or a plain image URL dragged in from another tab. */
  image: string;
  down: boolean;
}

export interface Counter {
  id: string;
  label: string;
  value: number;
}

export interface NoteItem {
  id: string;
  text: string;
  done: boolean;
}

export interface AppState {
  version: 1;
  run: {
    title: string;
    subtitle: string;
    /** Running when startedAt is set; total = elapsedMs + (now - startedAt). */
    timer: { startedAt: number | null; elapsedMs: number };
  };
  party: PartyMember[];
  counters: Counter[];
  milestones: { label: string; done: boolean[] };
  notes: NoteItem[];
  game: GameSettings;
  camera: CameraSettings;
  layout: {
    panels: Record<PanelId, boolean>;
    /** Put the side column (camera + party) on the left instead of the right. */
    sideLeft: boolean;
    sideWidth: number;
    bottomHeight: number;
  };
}

export const MAX_PARTY = 12;
export const MAX_MILESTONES = 24;

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function emptyMember(): PartyMember {
  return { id: uid(), name: '', detail: '', image: '', down: false };
}

export function defaultState(): AppState {
  return {
    version: 1,
    run: {
      title: 'Pokémon',
      subtitle: 'Any% casual run',
      timer: { startedAt: null, elapsedMs: 0 },
    },
    party: Array.from({ length: 6 }, emptyMember),
    counters: [
      { id: uid(), label: 'Deaths', value: 0 },
      { id: uid(), label: 'Resets', value: 0 },
    ],
    milestones: { label: 'Badges', done: Array(8).fill(false) },
    notes: [{ id: uid(), text: 'Every bit of text is editable, just click it', done: false }],
    game: {
      source: 'none',
      deviceId: null,
      fit: 'contain',
      pixelated: true,
      crop: { top: 0, right: 0, bottom: 0, left: 0 },
      chroma: '#00b140',
    },
    camera: { enabled: false, deviceId: null, mirrored: true },
    layout: {
      panels: { camera: true, party: true, run: true, progress: true, notes: true },
      sideLeft: false,
      sideWidth: 330,
      bottomHeight: 220,
    },
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Lay saved data over the defaults so fields added in newer versions still get a value.
 * Arrays are taken whole from the saved side; type mismatches fall back to the default.
 */
function overlay<T>(base: T, saved: unknown): T {
  if (saved === undefined || saved === null) return base;
  if (isPlainObject(base)) {
    if (!isPlainObject(saved)) return base;
    const out: Record<string, unknown> = { ...base };
    for (const key of Object.keys(base)) out[key] = overlay((base as Record<string, unknown>)[key], saved[key]);
    return out as T;
  }
  if (Array.isArray(base)) return (Array.isArray(saved) ? saved : base) as T;
  return (typeof saved === typeof base ? saved : base) as T;
}

export function hydrate(saved: unknown): AppState {
  const base = defaultState();
  const state = overlay(base, saved);
  // Nullable fields have null defaults, so overlay() can't type-check them; do it here.
  const s = isPlainObject(saved) ? saved : {};
  const game = isPlainObject(s.game) ? s.game : {};
  const camera = isPlainObject(s.camera) ? s.camera : {};
  state.game.deviceId = typeof game.deviceId === 'string' ? game.deviceId : null;
  state.camera.deviceId = typeof camera.deviceId === 'string' ? camera.deviceId : null;
  const timer = isPlainObject(s.run) && isPlainObject(s.run.timer) ? s.run.timer : {};
  state.run.timer.startedAt = typeof timer.startedAt === 'number' ? timer.startedAt : null;
  state.party = state.party.filter(isPlainObject).map((m) => overlay(emptyMember(), m)).slice(0, MAX_PARTY);
  state.counters = state.counters
    .filter(isPlainObject)
    .map((c) => overlay({ id: uid(), label: 'Counter', value: 0 }, c));
  state.notes = state.notes.filter(isPlainObject).map((n) => overlay({ id: uid(), text: '', done: false }, n));
  state.milestones.done = state.milestones.done.map(Boolean).slice(0, MAX_MILESTONES);
  return state;
}
