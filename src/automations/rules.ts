import { PRESETS, type PresetDef } from '../presets';
import {
  type AppState,
  type Automation,
  type AutomationGame,
  type AutomationThen,
  type AutomationWhen,
  type CustomId,
  isCustomId,
  MAX_AUTOMATION_STEPS,
  MAX_AUTOMATIONS,
  MAX_NOTE,
  MAX_PRESET_NAME,
  PRESET_IDS,
  type PresetId,
  uid,
} from '../state/model';

// The rules themselves: what they are made of, how they read as a sentence, which ones are worth
// suggesting, and how a saved list is brought back (src/state/hydrate.ts). The engine that decides
// when they fire is engine.ts.

// ---- games ----

/** Whether Uncbox can tell this preset's game is running: by its program, or by what Steam says. */
export const hasGameSignal = (def: PresetDef) => Boolean(def.detect || def.steamNames?.length);

/** The built-in presets a "game starts" rule can name. */
export const GAME_PRESETS: PresetId[] = PRESET_IDS.filter((id) => hasGameSignal(PRESETS[id]));

/** Whether the game Steam says is running is this preset's. */
export function steamMatches(def: PresetDef, steamName: string | null | undefined): boolean {
  if (!steamName || !def.steamNames) return false;
  const name = steamName.trim().toLowerCase();
  return def.steamNames.some((n) => n.trim().toLowerCase() === name);
}

// ---- sentences ----

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "21:30" → "9:30 PM". */
export function timeText(at: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(at);
  if (!m) return at;
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

/** [] and all seven days are "every day". */
export function daysText(days: number[]): string {
  const set = new Set(days);
  if (set.size === 0 || set.size === 7) return 'every day';
  const has = (list: number[]) => list.length === set.size && list.every((d) => set.has(d));
  if (has([1, 2, 3, 4, 5])) return 'on weekdays';
  if (has([0, 6])) return 'on weekends';
  return `on ${WEEKDAYS.filter((d) => set.has(d)).map((d) => DAY_NAMES[d]).join(', ')}`;
}

export function gameName(game: AutomationGame): string {
  return game === 'any' ? 'a Steam game' : PRESETS[game].name;
}

/** The name of a preset (built-in or your own), or '' if it is gone. */
export function presetName(custom: AppState['custom'], id: PresetId | CustomId): string {
  if (isCustomId(id)) return custom.find((c) => c.id === id)?.name ?? '';
  return PRESETS[id]?.name ?? '';
}

/** "SMITE 2 starts": the part of the sentence after "When". */
export function whenText(when: AutomationWhen): string {
  switch (when.kind) {
    case 'gameStarts':
      return `${gameName(when.game)} starts`;
    case 'gameStops':
      return `${gameName(when.game)} stops`;
    case 'streamStarts':
      return 'OBS starts streaming';
    case 'streamStops':
      return 'OBS stops streaming';
    case 'recordStarts':
      return 'OBS starts recording';
    case 'time':
      return `it’s ${timeText(when.at)} ${daysText(when.days)}`;
    case 'focusStarts':
      return 'a focus round starts';
    case 'breakStarts':
      return 'a break starts';
  }
}

/** "switch to the SMITE 2 preset": one step of what happens. */
export function thenText(then: AutomationThen, custom: AppState['custom']): string {
  switch (then.kind) {
    case 'preset':
      return `switch to the ${presetName(custom, then.preset) || 'missing'} preset`;
    case 'stream':
      return `turn stream mode ${then.on ? 'on' : 'off'}`;
    case 'scene':
      return `switch OBS to ${then.scene}`;
    case 'record':
      return then.on ? 'start recording' : 'stop recording';
    case 'focus':
      return 'start a focus round';
    case 'note':
      return `show “${then.text}”`;
  }
}

// ---- making rules ----

export function newAutomation(): Automation {
  return {
    id: uid(),
    enabled: true,
    name: '',
    when: { kind: 'gameStarts', game: 'any' },
    then: [{ kind: 'preset', preset: PRESET_IDS[0] }],
    lastFired: 0,
  };
}

export interface Suggestion {
  id: string;
  label: string;
  make: () => Automation[];
}

const rule = (when: AutomationWhen, then: AutomationThen[]): Automation => ({ id: uid(), enabled: true, name: '', when, then, lastFired: 0 });

/** One-click starting points, shown while there are no automations. */
export const SUGGESTIONS: Suggestion[] = [
  {
    id: 'game-preset',
    label: 'When a game starts, switch to its preset',
    make: () => GAME_PRESETS.map((id) => rule({ kind: 'gameStarts', game: id }, [{ kind: 'preset', preset: id }])),
  },
  {
    id: 'live-stream-mode',
    label: 'When OBS goes live, turn on stream mode',
    make: () => [rule({ kind: 'streamStarts' }, [{ kind: 'stream', on: true }])],
  },
];

export const canAddAutomation = (state: Pick<AppState, 'automations'>, count = 1) => state.automations.length + count <= MAX_AUTOMATIONS;

// ---- what a set of rules needs ----

export interface Needs {
  /** Some rule reads OBS's streaming or recording state. */
  obs: boolean;
  /** Some rule needs to know what Steam is running. */
  steam: boolean;
  /** Programs ("dungeons.exe", lower case) to look for. */
  exes: string[];
  /** Some rule depends on the clock. */
  time: boolean;
  /** Some rule depends on the focus timer. */
  focus: boolean;
  /** The preset games to work out. */
  games: PresetId[];
}

/** What only the switched-on rules need, so nothing is watched (or polled) for rules that are off. */
export function needsOf(rules: Automation[]): Needs {
  const needs: Needs = { obs: false, steam: false, exes: [], time: false, focus: false, games: [] };
  for (const r of rules) {
    if (!r.enabled) continue;
    const w = r.when;
    switch (w.kind) {
      case 'streamStarts':
      case 'streamStops':
      case 'recordStarts':
        needs.obs = true;
        break;
      case 'time':
        needs.time = true;
        break;
      case 'focusStarts':
      case 'breakStarts':
        needs.focus = true;
        break;
      case 'gameStarts':
      case 'gameStops': {
        if (w.game === 'any') {
          needs.steam = true;
          break;
        }
        const def = PRESETS[w.game];
        if (!needs.games.includes(w.game)) needs.games.push(w.game);
        if (def.steamNames?.length) needs.steam = true;
        if (def.detect && !needs.exes.includes(def.detect.toLowerCase())) needs.exes.push(def.detect.toLowerCase());
      }
    }
  }
  return needs;
}

// ---- loading ----

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseGame(v: unknown): AutomationGame | null {
  return v === 'any' || PRESET_IDS.includes(v as PresetId) ? (v as AutomationGame) : null;
}

function parseWhen(v: unknown): AutomationWhen | null {
  if (!isObj(v)) return null;
  switch (v.kind) {
    case 'gameStarts':
    case 'gameStops': {
      const game = parseGame(v.game);
      return game ? { kind: v.kind, game } : null;
    }
    case 'streamStarts':
    case 'streamStops':
    case 'recordStarts':
    case 'focusStarts':
    case 'breakStarts':
      return { kind: v.kind };
    case 'time': {
      if (typeof v.at !== 'string' || !TIME.test(v.at)) return null;
      const days = Array.isArray(v.days) ? v.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6) : [];
      const unique = [...new Set(days)].sort((a, b) => a - b);
      return { kind: 'time', at: v.at, days: unique.length === 7 ? [] : unique };
    }
    default:
      return null;
  }
}

function parseThen(v: unknown): AutomationThen | null {
  if (!isObj(v)) return null;
  switch (v.kind) {
    case 'preset': {
      const id = v.preset;
      if (typeof id !== 'string') return null;
      return PRESET_IDS.includes(id as PresetId) || (isCustomId(id) && id.length > 'custom-'.length) ? { kind: 'preset', preset: id as PresetId | CustomId } : null;
    }
    case 'stream':
      return typeof v.on === 'boolean' ? { kind: 'stream', on: v.on } : null;
    case 'record':
      return typeof v.on === 'boolean' ? { kind: 'record', on: v.on } : null;
    case 'scene': {
      const scene = typeof v.scene === 'string' ? v.scene.trim().slice(0, 200) : '';
      return scene ? { kind: 'scene', scene } : null;
    }
    case 'focus':
      return { kind: 'focus' };
    case 'note': {
      const text = typeof v.text === 'string' ? v.text.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE) : '';
      return text ? { kind: 'note', text } : null;
    }
    default:
      return null;
  }
}

/** Brings a saved list back: whatever is unusable is dropped, so one bad rule never costs the others. */
export function hydrateAutomations(saved: unknown): Automation[] {
  if (!Array.isArray(saved)) return [];
  const out: Automation[] = [];
  const seen = new Set<string>();
  for (const item of saved) {
    if (out.length >= MAX_AUTOMATIONS) break;
    if (!isObj(item)) continue;
    const when = parseWhen(item.when);
    const then = (Array.isArray(item.then) ? item.then : [])
      .map(parseThen)
      .filter((t): t is AutomationThen => t !== null)
      .slice(0, MAX_AUTOMATION_STEPS);
    if (!when || !then.length) continue;
    let id = typeof item.id === 'string' && item.id ? item.id : uid();
    if (seen.has(id)) id = uid();
    seen.add(id);
    out.push({
      id,
      enabled: item.enabled !== false,
      name: typeof item.name === 'string' ? item.name.replace(/\s+/g, ' ').trim().slice(0, MAX_PRESET_NAME) : '',
      when,
      then,
      lastFired: typeof item.lastFired === 'number' && Number.isFinite(item.lastFired) && item.lastFired > 0 ? Math.round(item.lastFired) : 0,
    });
  }
  return out;
}
