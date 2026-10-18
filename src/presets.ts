import {
  type BoardId,
  type GridItem,
  isWindowId,
  type PanelId,
  type PresetData,
  type PresetId,
  counter,
  emptySlot,
  milestone,
  note,
} from './state/model';

export interface PresetDef {
  id: PresetId;
  name: string;
  /** One line under the name in the preset switcher. */
  blurb: string;
  titles: Record<PanelId, string>;
  /** Panels listed first in the sidebar; the rest are still available. */
  featured: PanelId[];
  slots: { variant: 'list' | 'tiles'; name: string; detail: string; showDown: boolean };
  layout: GridItem[];
  data: () => Omit<PresetData, 'layout'>;
}

const BASE_TITLES: Record<PanelId, string> = {
  game: 'Game',
  camera: 'Camera',
  chat: 'Chat',
  slots: 'Party',
  run: 'Run',
  progress: 'Progress',
  notes: 'Notes',
  match: 'Match',
  record: 'Session',
  character: 'Character',
  discord: 'Voice',
};

const timer = () => ({ startedAt: null, elapsedMs: 0 });

const baseData = (): Omit<PresetData, 'layout'> => ({
  game: {
    source: 'none',
    deviceId: null,
    fit: 'contain',
    pixelated: false,
    crop: { top: 0, right: 0, bottom: 0, left: 0 },
    chroma: '#00b140',
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
  windows: [],
});

// Layouts are on a 24 × 24 grid sized to fill the window. At 1920 × 1080 a 17 × 17 game
// window is almost exactly 16:9, and a 7 × 7 camera is 16:9 too.
export const PRESETS: Record<PresetId, PresetDef> = {
  pokemon: {
    id: 'pokemon',
    name: 'Pokémon',
    blurb: 'Party, badges, Nuzlocke',
    titles: { ...BASE_TITLES, slots: 'Party', run: 'Run' },
    featured: ['game', 'camera', 'slots', 'chat', 'discord', 'run', 'progress', 'notes'],
    slots: { variant: 'list', name: 'Empty', detail: 'Lv 5 · Adamant', showDown: true },
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
    blurb: 'KDA, record, build',
    titles: { ...BASE_TITLES, slots: 'Build', run: 'Session', notes: 'Game plan', record: 'Record' },
    featured: ['game', 'camera', 'chat', 'discord', 'match', 'record', 'slots', 'run', 'notes'],
    slots: { variant: 'tiles', name: 'Item', detail: '', showDown: false },
    layout: [
      { i: 'game', x: 0, y: 0, w: 17, h: 17 },
      { i: 'camera', x: 17, y: 0, w: 7, h: 7 },
      { i: 'chat', x: 17, y: 7, w: 7, h: 12 },
      { i: 'run', x: 17, y: 19, w: 7, h: 5 },
      { i: 'match', x: 0, y: 17, w: 5, h: 7 },
      { i: 'record', x: 5, y: 17, w: 4, h: 7 },
      { i: 'slots', x: 9, y: 17, w: 4, h: 7 },
      { i: 'discord', x: 13, y: 17, w: 4, h: 7 },
    ],
    data: () => {
      const d = baseData();
      d.run = { title: 'SMITE 2', subtitle: 'Ranked Conquest', timer: timer() };
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
    titles: { ...BASE_TITLES, run: '/played', notes: 'Quest log', progress: 'Progress' },
    featured: ['game', 'camera', 'character', 'chat', 'discord', 'progress', 'notes', 'run'],
    slots: { variant: 'list', name: 'Empty', detail: 'Class', showDown: true },
    layout: [
      { i: 'game', x: 0, y: 0, w: 17, h: 17 },
      { i: 'camera', x: 17, y: 0, w: 7, h: 7 },
      { i: 'character', x: 17, y: 7, w: 7, h: 8 },
      { i: 'chat', x: 17, y: 15, w: 7, h: 9 },
      { i: 'progress', x: 0, y: 17, w: 5, h: 7 },
      { i: 'notes', x: 5, y: 17, w: 4, h: 7 },
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
};

/** Default size for a panel added to a preset whose default layout does not include it. */
export const PANEL_SIZES: Record<PanelId, { w: number; h: number; minW: number; minH: number }> = {
  game: { w: 17, h: 17, minW: 6, minH: 6 },
  camera: { w: 7, h: 7, minW: 3, minH: 3 },
  chat: { w: 7, h: 9, minW: 4, minH: 4 },
  slots: { w: 7, h: 11, minW: 4, minH: 4 },
  run: { w: 5, h: 6, minW: 4, minH: 4 },
  progress: { w: 6, h: 7, minW: 4, minH: 4 },
  notes: { w: 6, h: 7, minW: 4, minH: 3 },
  match: { w: 5, h: 7, minW: 4, minH: 6 },
  record: { w: 5, h: 7, minW: 4, minH: 5 },
  character: { w: 7, h: 8, minW: 5, minH: 6 },
  discord: { w: 4, h: 7, minW: 3, minH: 3 },
};

const WINDOW_SIZE = { w: 7, h: 8, minW: 3, minH: 3 };

export function sizeOf(id: BoardId) {
  return isWindowId(id) ? WINDOW_SIZE : PANEL_SIZES[id];
}

export const WOW_RACES = ['Human', 'Dwarf', 'Night Elf', 'Gnome', 'Orc', 'Undead', 'Tauren', 'Troll', 'Skyborne'];

/** Official class colors, used to tint the character name. */
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
