import { PANEL_INFO } from './panels/catalog';
import { defaultWidgetSettings } from './widgets/catalog';
import {
  type GridItem,
  type PanelId,
  type PresetData,
  type PresetId,
  counter,
  emptySlot,
  milestone,
  note,
  type Widget,
} from './state/model';

export interface PresetDef {
  id: PresetId;
  name: string;
  /** One line under the name in the preset switcher. */
  blurb: string;
  /** Panel titles that differ from the defaults in panels/catalog.ts. */
  titles: Partial<Record<PanelId, string>>;
  /** Panels listed first in the sidebar; the rest are still available. */
  featured: PanelId[];
  /** Names the Stats panel suggests for its screen-reading boxes. */
  hud?: string[];
  /** The game's program ("Dungeons.exe"): the run timer starts when it does and pauses when it closes. */
  detect?: string;
  slots: {
    variant: 'list' | 'tiles';
    name: string;
    detail: string;
    showDown: boolean;
    /** What a downed slot is called: "Fainted" unless set. */
    down?: string;
    /** A color for a slot's name and initial, e.g. from the WoW class in its detail. */
    tint?: (detail: string) => string | undefined;
  };
  layout: GridItem[];
  data: () => Omit<PresetData, 'layout'>;
}

const timer = () => ({ startedAt: null, elapsedMs: 0 });

const baseData = (): Omit<PresetData, 'layout'> => ({
  background: 'plain',
  game: {
    source: 'none',
    deviceId: null,
    fit: 'contain',
    pixelated: false,
    crop: { top: 0, right: 0, bottom: 0, left: 0 },
    chroma: '#00b140',
    nativeGame: null,
  },
  run: { title: '', subtitle: '', timer: timer() },
  slots: Array.from({ length: 6 }, emptySlot),
  counters: [],
  milestones: { label: 'Milestones', items: Array.from({ length: 8 }, () => milestone()) },
  notes: [],
  match: { god: '', role: '', mode: '', k: 0, d: 0, a: 0 },
  record: { wins: 0, losses: 0, history: [] },
  character: {
    name: '',
    race: '',
    cls: '',
    level: 1,
    maxLevel: 60,
    xp: 0,
    zone: '',
    realm: '',
    guild: '',
    gold: '',
    hardcore: false,
  },
  quests: [],
  wowLinkAt: 0,
  windows: [],
  widgets: [],
  hud: [],
});

// Layouts are on a 24 × 24 grid sized to fill the window. At 1920 × 1080 a 17 × 17 game
// window is almost exactly 16:9, and a 7 × 7 camera is 16:9 too.
export const PRESETS: Record<PresetId, PresetDef> = {
  pokemon: {
    id: 'pokemon',
    name: 'Pokémon',
    blurb: 'Party, badges, Nuzlocke',
    titles: {},
    featured: ['game', 'camera', 'slots', 'chat', 'discord', 'run', 'progress', 'notes'],
    slots: { variant: 'list', name: 'Pokémon', detail: 'Level, nature', showDown: true },
    layout: [
      { i: 'game', x: 0, y: 0, w: 17, h: 17 },
      { i: 'camera', x: 17, y: 0, w: 7, h: 7 },
      { i: 'slots', x: 17, y: 7, w: 7, h: 11 },
      { i: 'chat', x: 17, y: 18, w: 7, h: 6 },
      { i: 'run', x: 0, y: 17, w: 4, h: 7 },
      { i: 'progress', x: 4, y: 17, w: 5, h: 7 },
      { i: 'notes', x: 9, y: 17, w: 4, h: 7 },
      { i: 'discord', x: 13, y: 17, w: 4, h: 7 },
    ],
    data: () => {
      const d = baseData();
      d.game.pixelated = true;
      d.run = { title: 'Pokémon', subtitle: 'Nuzlocke', timer: timer() };
      d.counters = [counter('Deaths'), counter('Resets')];
      d.milestones = { label: 'Badges', items: Array.from({ length: 8 }, () => milestone()) };
      d.notes = [note('One catch per route'), note('Fainted means dead')];
      return d;
    },
  },

  smite2: {
    id: 'smite2',
    name: 'SMITE 2',
    blurb: 'Live god, build and teams; record',
    titles: { slots: 'Build', run: 'Session', notes: 'Game plan', record: 'Record' },
    featured: ['game', 'camera', 'chat', 'discord', 'match', 'teams', 'scoreboard', 'damage', 'record', 'slots', 'run', 'notes'],
    slots: { variant: 'tiles', name: 'Item', detail: '', showDown: false },
    layout: [
      { i: 'game', x: 0, y: 0, w: 17, h: 17 },
      { i: 'camera', x: 17, y: 0, w: 7, h: 7 },
      { i: 'teams', x: 17, y: 7, w: 7, h: 6 },
      { i: 'chat', x: 17, y: 13, w: 7, h: 11 },
      { i: 'match', x: 0, y: 17, w: 5, h: 7 },
      { i: 'record', x: 5, y: 17, w: 4, h: 7 },
      { i: 'slots', x: 9, y: 17, w: 4, h: 7 },
      { i: 'discord', x: 13, y: 17, w: 4, h: 7 },
    ],
    data: () => {
      const d = baseData();
      // The match panel already names the mode, so the session line starts blank.
      d.run = { title: 'SMITE 2', subtitle: '', timer: timer() };
      d.match = { god: '', role: 'Mid', mode: 'Ranked Conquest', k: 0, d: 0, a: 0 };
      d.notes = [note('Ward the enemy jungle entrance'), note('Anti-heal by second item if they have sustain')];
      d.milestones = { label: 'Daily goals', items: Array.from({ length: 3 }, () => milestone()) };
      return d;
    },
  },

  wow: {
    id: 'wow',
    name: 'WoW Forever',
    blurb: 'Leveling, raids',
    titles: { run: '/played' },
    featured: ['game', 'camera', 'character', 'quests', 'slots', 'chat', 'discord', 'progress', 'run'],
    // The addon fills these in with your group; they can still be typed in by hand.
    slots: { variant: 'list', name: 'Name', detail: 'Level and class', showDown: true, down: 'Dead', tint: wowClassColor },
    layout: [
      { i: 'game', x: 0, y: 0, w: 17, h: 17 },
      { i: 'camera', x: 17, y: 0, w: 7, h: 7 },
      { i: 'character', x: 17, y: 7, w: 7, h: 8 },
      { i: 'chat', x: 17, y: 15, w: 7, h: 9 },
      { i: 'progress', x: 0, y: 17, w: 5, h: 7 },
      { i: 'quests', x: 5, y: 17, w: 4, h: 7 },
      { i: 'discord', x: 9, y: 17, w: 4, h: 7 },
      { i: 'run', x: 13, y: 17, w: 4, h: 7 },
    ],
    data: () => {
      const d = baseData();
      d.run = { title: 'WoW Forever', subtitle: 'Road to 60', timer: timer() };
      d.counters = [counter('Deaths'), counter('Quests')];
      // The raids at launch, per Blizzard's roadmap: Onyxia's Lair, plus two unlocking Dec 9.
      d.milestones = {
        label: 'Raids',
        items: [milestone("Onyxia's Lair"), milestone('Barrow Deeps'), milestone('Hyjal Summit')],
      };
      d.notes = [note('Grab flight paths as you pass through towns'), note('Train new ranks every even level')];
      d.slots = Array.from({ length: 5 }, emptySlot);
      d.character = {
        name: '',
        race: 'Human',
        cls: 'Warrior',
        level: 1,
        maxLevel: 60,
        xp: 0,
        zone: 'Elwynn Forest',
        realm: '',
        guild: '',
        gold: '0g',
        hardcore: false,
      };
      return d;
    },
  },

  mcd2: {
    id: 'mcd2',
    name: 'Minecraft Dungeons II',
    blurb: 'Live stats, party, missions',
    titles: { slots: 'Party', run: 'Session', progress: 'Missions', hud: 'Stats' },
    featured: ['game', 'camera', 'hud', 'chat', 'slots', 'progress', 'discord', 'run'],
    slots: { variant: 'list', name: 'Player', detail: 'Build', showDown: true, down: 'Down' },
    hud: ['Emeralds', 'Level', 'Arrows', 'Gold', 'Souls', 'Health'],
    detect: 'Dungeons.exe',
    layout: [
      { i: 'game', x: 0, y: 0, w: 17, h: 17 },
      { i: 'camera', x: 17, y: 0, w: 7, h: 7 },
      { i: 'hud', x: 17, y: 7, w: 7, h: 8 },
      { i: 'chat', x: 17, y: 15, w: 7, h: 9 },
      { i: 'progress', x: 0, y: 17, w: 5, h: 7 },
      { i: 'slots', x: 5, y: 17, w: 4, h: 7 },
      { i: 'discord', x: 9, y: 17, w: 4, h: 7 },
      { i: 'run', x: 13, y: 17, w: 4, h: 7 },
    ],
    data: () => {
      const d = baseData();
      d.background = 'grid';
      d.run = { title: 'Minecraft Dungeons II', subtitle: 'Session', timer: timer() };
      d.counters = [counter('Deaths'), counter('Bosses')];
      d.milestones = { label: 'Missions', items: Array.from({ length: 8 }, () => milestone()) };
      d.slots = Array.from({ length: 4 }, emptySlot);
      return d;
    },
  },

  steam: {
    id: 'steam',
    name: 'Steam Big Picture',
    blurb: 'Any Steam game, live from Steam',
    titles: { run: 'Session' },
    featured: ['game', 'camera', 'steam', 'chat', 'discord', 'run'],
    slots: { variant: 'list', name: 'Name', detail: 'Note', showDown: false },
    layout: [
      { i: 'game', x: 0, y: 0, w: 17, h: 17 },
      { i: 'camera', x: 17, y: 0, w: 7, h: 7 },
      { i: 'steam', x: 17, y: 7, w: 7, h: 10 },
      { i: 'chat', x: 17, y: 17, w: 7, h: 7 },
      { i: 'run', x: 0, y: 17, w: 4, h: 7 },
      { i: 'discord', x: 4, y: 17, w: 4, h: 7 },
      { i: 'wdg-steamclock', x: 8, y: 17, w: 4, h: 7 },
      { i: 'wdg-steamsystem', x: 12, y: 17, w: 5, h: 7 },
    ],
    data: () => {
      const d = baseData();
      d.background = 'network';
      d.run = { title: 'Steam', subtitle: 'Session', timer: timer() };
      d.widgets = [
        { id: 'wdg-steamclock', type: 'clock', title: '', settings: defaultWidgetSettings() },
        { id: 'wdg-steamsystem', type: 'system', title: '', settings: defaultWidgetSettings() },
      ];
      return d;
    },
  },

  terminal: {
    id: 'terminal',
    name: 'Terminal',
    blurb: 'PowerShell look, any game',
    titles: { slots: 'Loadout', run: 'Session', progress: 'Goals', notes: 'Todo' },
    featured: ['game', 'camera', 'chat', 'discord', 'run', 'progress', 'notes', 'slots'],
    slots: { variant: 'list', name: 'Item', detail: 'Note', showDown: false },
    layout: [
      { i: 'game', x: 0, y: 0, w: 17, h: 17 },
      { i: 'camera', x: 17, y: 0, w: 7, h: 7 },
      { i: 'chat', x: 17, y: 7, w: 7, h: 17 },
      { i: 'run', x: 0, y: 17, w: 4, h: 7 },
      { i: 'progress', x: 4, y: 17, w: 5, h: 7 },
      { i: 'notes', x: 9, y: 17, w: 4, h: 7 },
      { i: 'discord', x: 13, y: 17, w: 4, h: 7 },
    ],
    data: () => {
      const d = baseData();
      d.run = { title: 'Session', subtitle: '', timer: timer() };
      d.counters = [counter('Deaths')];
      d.milestones = { label: 'Goals', items: Array.from({ length: 5 }, () => milestone()) };
      d.notes = [note('Check audio levels'), note('Say hi to chat')];
      return d;
    },
  },

  // Work, browse and plan between games. There is no game panel (add one from the sidebar if you
  // want it), and the widgets come with the preset, like the Steam preset's clock and system.
  desk: {
    id: 'desk',
    name: 'Desk',
    blurb: 'Work, browse and plan between games',
    titles: {},
    featured: ['notes', 'progress', 'run', 'camera', 'game', 'chat', 'discord'],
    slots: { variant: 'list', name: 'Name', detail: 'Note', showDown: false },
    layout: [
      { i: 'wdg-deskweb', x: 0, y: 0, w: 13, h: 16 },
      // Drive spans the whole row under the browser for now.
      { i: 'wdg-deskdrive', x: 0, y: 16, w: 8, h: 8 },
      { i: 'wdg-deskcalendar', x: 8, y: 16, w: 5, h: 8 },
      { i: 'wdg-deskclock', x: 13, y: 0, w: 6, h: 4 },
      { i: 'wdg-deskweather', x: 13, y: 4, w: 6, h: 4 },
      { i: 'wdg-desklauncher', x: 13, y: 8, w: 6, h: 7 },
      { i: 'notes', x: 13, y: 15, w: 6, h: 9 },
      { i: 'wdg-deskfocus', x: 19, y: 0, w: 5, h: 7 },
      { i: 'wdg-deskmedia', x: 19, y: 7, w: 5, h: 4 },
      { i: 'wdg-desknotifications', x: 19, y: 11, w: 5, h: 13 },
    ],
    data: () => {
      const d = baseData();
      d.run = { title: 'Desk', subtitle: '', timer: timer() };
      d.notes = [note('Plan the evening'), note('Reply to messages')];
      const widget = (id: Widget['id'], type: Widget['type'], settings: Partial<Widget['settings']> = {}): Widget => ({
        id,
        type,
        title: '',
        settings: { ...defaultWidgetSettings(), ...settings },
      });
      d.widgets = [
        // Wikipedia allows being framed (Google does not), so the Web widget opens with a page.
        widget('wdg-deskweb', 'web', { homeUrl: 'https://en.wikipedia.org/wiki/Main_Page' }),
        widget('wdg-deskdrive', 'drive'),
        widget('wdg-deskcalendar', 'calendar'),
        widget('wdg-deskclock', 'clock'),
        widget('wdg-deskweather', 'weather'),
        widget('wdg-desklauncher', 'launcher'),
        widget('wdg-deskfocus', 'focus'),
        widget('wdg-deskmedia', 'media'),
        widget('wdg-desknotifications', 'notifications'),
      ];
      return d;
    },
  },
};

export function panelTitle(def: PresetDef, id: PanelId): string {
  return def.titles[id] ?? PANEL_INFO[id].title;
}

export const WOW_RACES = ['Human', 'Dwarf', 'Night Elf', 'Gnome', 'Orc', 'Undead', 'Tauren', 'Troll', 'Skyborne'];

/** The class color for text that names a class ("Level 23 Druid"), if it does. */
export function wowClassColor(text: string): string | undefined {
  const cls = Object.keys(WOW_CLASSES).find((c) => new RegExp(`\\b${c}\\b`, 'i').test(text));
  return cls && WOW_CLASSES[cls];
}

/** Official class colors, used to tint the character name and party. */
export const WOW_CLASSES: Record<string, string> = {
  Druid: '#FF7C0A',
  Hunter: '#AAD372',
  Mage: '#3FC7EB',
  Paladin: '#F48CBA',
  Priest: '#FFFFFF',
  Rogue: '#FFF468',
  Shaman: '#0070DD',
  Warlock: '#8788EE',
  Warrior: '#C69B6D',
};
