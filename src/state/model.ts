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
  'quests',
  'steam',
  'hud',
  'teams',
  'scoreboard',
  'damage',
] as const;
export type PanelId = (typeof PANEL_IDS)[number];

/** App window panels can be added any number of times, so each gets its own id. */
export type WindowId = `win-${string}`;
/** So can widgets (a clock, the weather…); see src/widgets. */
export type WidgetId = `wdg-${string}`;
export type BoardId = PanelId | WindowId | WidgetId;

export function isWindowId(id: string): id is WindowId {
  return id.startsWith('win-');
}

export function isWidgetId(id: string): id is WidgetId {
  return id.startsWith('wdg-');
}

export const WIDGET_TYPES = ['clock', 'weather', 'media', 'notifications', 'system', 'network', 'countdown', 'text', 'obs', 'focus', 'launcher', 'web', 'drive', 'twitch', 'calendar', 'gmail'] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

/** Every widget type's settings in one shape; each type reads only its own. */
export interface WidgetSettings {
  /** Clock: an IANA time zone ("Europe/London"), or '' for this PC's. */
  timeZone: string;
  hour12: boolean;
  seconds: boolean;
  /** Weather: the place as found, and where it is. */
  place: string;
  lat: number;
  lon: number;
  celsius: boolean;
  /** Notifications: only these apps (comma-separated, as listed), or '' for all. */
  apps: string;
  /** Notifications: show the message itself, not just who it's from. Off by default: it's on stream. */
  showBody: boolean;
  /** Countdown: when it ends (ms since 1970), or 0 if not set. */
  target: number;
  /** Text: what it says. Countdown: what's coming. */
  text: string;
  /** Ping & FPS: the host (or host:port) to ping, or '' for the default. */
  pingTarget: string;
  /** Ping & FPS: also show the ping to this PC's router. */
  showRouter: boolean;
  /** Focus timer: minutes of work, short break and long break; work rounds before a long break. */
  focusWork: number;
  focusShort: number;
  focusLong: number;
  focusRounds: number;
  /** Focus timer: start the next phase by itself, and chime when one ends. */
  focusAuto: boolean;
  focusSound: boolean;
  /** Focus timer: where it is (see widgets/focus.ts). It's saved, so a reload carries on. */
  focusPhase: 'work' | 'short' | 'long';
  focusRound: number;
  focusEndsAt: number;
  focusLeft: number;
  /** Launcher: the ids of the saved tiles it shows, in order. The tiles themselves live on this PC (server/launcher.mjs). */
  launcherTiles: string[];
  /** Web: the page it is on now (saved, so it comes back after a reload), and the one it starts on. */
  url: string;
  homeUrl: string;
  /** Web: what an address that isn't a web address is searched with (an id from src/web.ts). */
  searchEngine: string;
  /** Web: leave the back / address / reload bar out, for a clean view on stream. */
  hideToolbar: boolean;
  /** Web: page zoom in percent, 50 to 200. */
  zoom: number;
  /** Drive: which list is showing (recent, starred, shared or search). */
  driveView: string;
  /** Calendar: how many days ahead to show (1, 3 or 7), and whether all-day events are left out. */
  calendarDays: number;
  calendarHideAllDay: boolean;
  /** Gmail: only unread messages, and the label to watch (a Gmail label id; INBOX by default). */
  gmailOnlyUnread: boolean;
  gmailLabel: string;
  /** Calendar and Gmail: show the details in stream mode too. Off by default: they're private. */
  showOnStream: boolean;
}

export interface Widget {
  id: WidgetId;
  type: WidgetType;
  /** Shown as the panel's title; '' uses the type's name. */
  title: string;
  settings: WidgetSettings;
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
  windows: AppWindow[];
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

export interface AppState {
  version: 2;
  /** The preset on the board: a built-in one, or one of `custom`. */
  preset: PresetId | CustomId;
  twitch: { channel: string; hideBots: boolean };
  clips: ClipSettings;
  /** Voice channels pinned to the Discord panel for one-click joining. Shared by every preset. */
  discord: { pinned: PinnedChannel[] };
  camera: CameraSettings;
  presets: Record<PresetId, PresetData>;
  /** Presets of your own, after the built-in ones in the sidebar. */
  custom: CustomPreset[];
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
