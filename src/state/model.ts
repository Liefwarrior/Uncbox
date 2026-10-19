import type { BackgroundId } from '../backgrounds';

// Everything the dashboard remembers. Saved to data/state.json by the local server and shared
// live between every open window, so a phone or second monitor can drive the streamed one.
// Each game preset keeps its own layout and data; Twitch and camera settings are shared.

export const PRESET_IDS = ['pokemon', 'smite2', 'wow', 'terminal'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export const PANEL_IDS = [
  'game',
  'camera',
  'chat',
  'slots',
  'run',
  'progress',
  'notes',
  'match',
  'record',
  'character',
  'discord',
] as const;
export type PanelId = (typeof PANEL_IDS)[number];

/** App window panels can be added any number of times, so each gets its own id. */
export type WindowId = `win-${string}`;
export type BoardId = PanelId | WindowId;

export function isWindowId(id: string): id is WindowId {
  return id.startsWith('win-');
}

/** Position on the board grid, in cells. */
export interface GridItem {
  i: BoardId;
  x: number;
  y: number;
  w: number;
  h: number;
}

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

/** Another app's window (Discord, Spotify, a popped-out chat…) captured into a themed panel. */
export interface AppWindow {
  id: WindowId;
  title: string;
  fit: VideoFit;
  crop: Crop;
}

export interface SlotItem {
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

export interface Milestone {
  id: string;
  /** Optional; unnamed milestones render as numbered pips, named ones as chips. */
  name: string;
  done: boolean;
}

export interface NoteItem {
  id: string;
  text: string;
  done: boolean;
}

export const SMITE_ROLES = ['Solo', 'Jungle', 'Mid', 'Support', 'Carry'] as const;
export type SmiteRole = (typeof SMITE_ROLES)[number];

export interface MatchState {
  god: string;
  role: SmiteRole | '';
  mode: string;
  k: number;
  d: number;
  a: number;
}

export interface MatchResult {
  id: string;
  god: string;
  role: SmiteRole | '';
  k: number;
  d: number;
  a: number;
  win: boolean;
  at: number;
}

export interface RecordState {
  wins: number;
  losses: number;
  /** Newest first. */
  history: MatchResult[];
}

export interface CharacterState {
  name: string;
  race: string;
  cls: string;
  level: number;
  maxLevel: number;
  /** Progress through the current level, 0–100. */
  xp: number;
  zone: string;
  realm: string;
  guild: string;
  gold: string;
  hardcore: boolean;
}

export interface PresetData {
  layout: GridItem[];
  /** What fills the space behind the panels; see src/backgrounds.ts. */
  background: BackgroundId;
  game: GameSettings;
  run: {
    title: string;
    subtitle: string;
    /** Running when startedAt is set; total = elapsedMs + (now - startedAt). */
    timer: { startedAt: number | null; elapsedMs: number };
  };
  slots: SlotItem[];
  counters: Counter[];
  milestones: { label: string; items: Milestone[] };
  notes: NoteItem[];
  match: MatchState;
  record: RecordState;
  character: CharacterState;
  windows: AppWindow[];
}

export interface PinnedChannel {
  id: string;
  name: string;
  guildId: string;
  guildName: string;
}

export interface AppState {
  version: 2;
  preset: PresetId;
  twitch: { channel: string; hideBots: boolean };
  /** Voice channels pinned to the Discord panel for one-click joining. Shared by every preset. */
  discord: { pinned: PinnedChannel[] };
  camera: CameraSettings;
  presets: Record<PresetId, PresetData>;
}

export const GRID_COLS = 24;
export const GRID_ROWS = 24;
export const MAX_SLOTS = 12;
export const MAX_MILESTONES = 24;
export const MAX_HISTORY = 30;

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function emptySlot(): SlotItem {
  return { id: uid(), name: '', detail: '', image: '', down: false };
}

export function milestone(name = ''): Milestone {
  return { id: uid(), name, done: false };
}

export function counter(label: string, value = 0): Counter {
  return { id: uid(), label, value };
}

export function note(text: string): NoteItem {
  return { id: uid(), text, done: false };
}
