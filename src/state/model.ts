import type { BackgroundId } from '../backgrounds';

// Everything the dashboard remembers. Saved to data/state.json by the local server and shared
// live between every open window, so a phone or second monitor can drive the streamed one.
// Each game preset keeps its own layout and data; Twitch and camera settings are shared.

export const PRESET_IDS = ['pokemon', 'smite2', 'wow', 'mcd2', 'steam', 'terminal', 'desk'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

/**
 * A preset of your own: a saved copy of a built-in one, or one imported from a file. The built-in
 * it is based on ("base") decides its theme, panel wording and game-specific behavior; the name and
 * the data are its own.
 */
export type CustomId = `custom-${string}`;
export interface CustomPreset {
  id: CustomId;
  name: string;
  base: PresetId;
  data: PresetData;
  /** The gallery preset it was installed from (its id in gallery/index.json), so the gallery can say "Installed". */
  galleryId?: string;
}

export function isCustomId(id: string): id is CustomId {
  return id.startsWith('custom-');
}

/**
 * What a board item is: the kind of a panel there is only one of in a preset ('game', 'chat'),
 * or the id of a widget you added ('wdg-…'). The kinds themselves are defined in
 * src/widgets/registry.ts, so a new widget never has to be listed here.
 */
export type BoardId = string;

/** A widget you can have any number of (a clock, the weather, an app window…) gets its own id. */
export type WidgetId = `wdg-${string}`;

export function isWidgetId(id: string): id is WidgetId {
  return id.startsWith('wdg-');
}

/**
 * One widget on a preset's board, of a kind with more than one allowed. Its `kind` is a key of
 * the widget library (src/widgets/registry.ts), which also says what its settings hold; they are
 * saved as they are and cleaned against the kind's defaults when loaded.
 */
export interface Widget<S = Record<string, unknown>> {
  id: WidgetId;
  kind: string;
  /** Shown as the panel's title; '' uses the kind's name. */
  title: string;
  settings: S;
}

/** Position on the board grid, in cells. */
export interface GridItem {
  i: BoardId;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 'native' is the game's own window placed in the panel, in the native shell (src/native.ts). */
export type VideoSource = 'none' | 'device' | 'window' | 'chroma' | 'native';
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
  /** Play here: the game window to put back in the panel when it (or Uncbox) starts again. */
  nativeGame: { process: string; title: string; exact?: boolean } | null;
}

export interface CameraSettings {
  /** Off until first switched on, so the page never grabs a webcam OBS may already be using. */
  enabled: boolean;
  deviceId: string | null;
  mirrored: boolean;
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

export type QuestState = 'open' | 'complete' | 'failed';

/** A quest from the WoW addon. The objective text carries its own progress ("Kobolds slain: 4/10"). */
export interface Quest {
  title: string;
  level: number;
  state: QuestState;
  objectives: { text: string; done: boolean }[];
}

/**
 * A box on the game picture that Uncbox reads as text, live (Windows' own OCR): an emerald count,
 * a level, a timer. Position and size are percent of the uncropped game picture.
 */
export interface HudRegion {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Read as a number (digits only, "1,234" → "1234") or as text. */
  numeric: boolean;
  /** The last reading, and when it changed. */
  value: string;
  at: number;
}

/** What a screen trigger does when its phrase shows up. */
export type TriggerAction =
  /** Adds 1 to one of the preset's counters (deaths, defeats). */
  | { kind: 'counter'; counterId: string }
  /** Marks the party member named in the text as down; the phrase has a {name} placeholder. */
  | { kind: 'slotDown' }
  /** Ticks the next milestone that isn't done. */
  | { kind: 'milestone' };

export const TRIGGER_ACTIONS: TriggerAction['kind'][] = ['counter', 'slotDown', 'milestone'];

/**
 * "When this shows up on the game's screen, do something": a box on the game picture (percent of
 * the uncropped picture, like a Stats box), a phrase to look for in what Windows' OCR reads there,
 * and an action. See src/hud/triggers.ts.
 */
export interface ScreenTrigger {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  phrase: string;
  /** The phrase is a regular expression, not plain words. */
  regex: boolean;
  action: TriggerAction;
  enabled: boolean;
  /** Seconds the phrase must be gone before it can fire again, so one death screen counts once. */
  cooldownSec: number;
  /** When it last fired; 0 if never. */
  at: number;
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
  /** The WoW quest log, filled in by the addon (integrations/wow). */
  quests: Quest[];
  /** When the WoW addon last sent something new; 0 if it never has. */
  wowLinkAt: number;
  /** The widgets on the board (src/widgets); the panels there is only one of keep their data in the fields here. */
  widgets: Widget[];
  /** The Stats panel's screen reader boxes (src/hud). */
  hud: HudRegion[];
  /** Phrases to watch for on the game's screen (src/hud/triggers.ts). */
  triggers: ScreenTrigger[];
}

export interface PinnedChannel {
  id: string;
  name: string;
  guildId: string;
  guildName: string;
}

/** Instant replay: the last 60 seconds of the game, saved with a key press (see src/clips). */
export interface ClipSettings {
  enabled: boolean;
  /** The clip key, as a KeyboardEvent.code ("Equal" is =). */
  key: string;
  /** Upload each new clip to Google Drive as soon as it is saved (server/driveupload.mjs). */
  driveAuto: boolean;
  /** Clips put on Drive can be viewed by anyone with the link. */
  driveShare: boolean;
}

/** Streaming from Uncbox itself instead of OBS (src/stream). Not secret: the stream key stays on the server. */
export interface StreamSettings {
  /** Which program streams: OBS as always, or Uncbox's own capture. */
  with: 'obs' | 'uncbox';
  /** The screen to capture, counting from 0. */
  screen: number;
  fps: 30 | 60;
  /** The picture's height in pixels; 0 is the screen's own. */
  height: 0 | 720 | 1080;
  /** Video bitrate in kilobits per second. */
  kbps: number;
  /** Stream the sound Windows plays. */
  desktop: boolean;
  /** A microphone's device id, 'default' for the Windows default, or null for none. */
  mic: string | null;
  /** Gains from 0 to 2; 1 is as it comes. */
  desktopVolume: number;
  micVolume: number;
}

/**
 * "When this, do that" (src/automations). A game is a built-in preset's game ("smite2"), or 'any'
 * for whatever Steam is running.
 */
export type AutomationGame = PresetId | 'any';

export type AutomationWhen =
  | { kind: 'gameStarts' | 'gameStops'; game: AutomationGame }
  | { kind: 'streamStarts' | 'streamStops' | 'recordStarts' }
  /** At a clock time ("21:30", this PC's time) on these days (0 is Sunday); no days means every day. */
  | { kind: 'time'; at: string; days: number[] }
  | { kind: 'focusStarts' | 'breakStarts' };

export type AutomationThen =
  | { kind: 'preset'; preset: PresetId | CustomId }
  | { kind: 'stream'; on: boolean }
  | { kind: 'scene'; scene: string }
  | { kind: 'record'; on: boolean }
  | { kind: 'focus' }
  | { kind: 'note'; text: string };

export interface Automation {
  id: string;
  enabled: boolean;
  /** An optional label of your own; the sentence is built from the rule itself. */
  name: string;
  when: AutomationWhen;
  then: AutomationThen[];
  /** When it last ran (ms since 1970), so a time rule runs once a minute even across reloads. 0 if never. */
  lastFired: number;
}

export interface AppState {
  version: 2;
  /** The preset on the board: a built-in one, or one of `custom`. */
  preset: PresetId | CustomId;
  twitch: { channel: string; hideBots: boolean };
  clips: ClipSettings;
  stream: StreamSettings;
  /** Voice channels pinned to the Discord panel for one-click joining. Shared by every preset. */
  discord: { pinned: PinnedChannel[] };
  camera: CameraSettings;
  presets: Record<PresetId, PresetData>;
  /** Presets of your own, after the built-in ones in the sidebar. */
  custom: CustomPreset[];
  /** Shared by every preset, and not part of a preset's export. */
  automations: Automation[];
}

export const GRID_COLS = 24;
export const GRID_ROWS = 24;
export const MAX_SLOTS = 12;
export const MAX_MILESTONES = 24;
export const MAX_HISTORY = 30;
export const MAX_QUESTS = 50;
export const MAX_HUD = 12;
export const MAX_TRIGGERS = 12;
export const MAX_PHRASE = 120;
export const MAX_COOLDOWN = 600;
export const MAX_CUSTOM = 50;
export const MAX_PRESET_NAME = 60;
export const MAX_AUTOMATIONS = 30;
export const MAX_AUTOMATION_STEPS = 6;
export const MAX_NOTE = 140;

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function emptySlot(): SlotItem {
  return { id: uid(), name: '', detail: '', image: '', down: false };
}

export function milestone(name = ''): Milestone {
  return { id: uid(), name, done: false };
}

export function emptyTrigger(): ScreenTrigger {
  return {
    id: uid(),
    label: '',
    x: 25,
    y: 40,
    w: 50,
    h: 20,
    phrase: '',
    regex: false,
    action: { kind: 'counter', counterId: '' },
    enabled: true,
    cooldownSec: 5,
    at: 0,
  };
}

export function counter(label: string, value = 0): Counter {
  return { id: uid(), label, value };
}

export function note(text: string): NoteItem {
  return { id: uid(), text, done: false };
}
