import type { PresetData, ScreenTrigger, SlotItem } from '../state/model';

// Screen triggers: "when this phrase shows up in that box on the game's screen, do something".
// Everything here is plain functions over text, so it is tested without a game or a browser. The
// reader loop that feeds it OCR text is in reader.ts.

// ---------- reading text the way OCR garbles it ----------

/** Letters that game fonts and OCR swap for digits and each other ("Y0U DlED" is "YOU DIED"). */
const LOOKALIKE: Record<string, string> = { '0': 'o', '1': 'i', l: 'i', '5': 's' };

/** Text with only letters and digits left, lower case, lookalikes folded, and where each one was. */
export interface Squashed {
  s: string;
  /** at[i] is where character i of `s` sits in the original text. */
  at: number[];
}

export function squash(text: string): Squashed {
  let s = '';
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    // "é" → "e": the first character after splitting off the accent.
    const c = text[i].normalize('NFD')[0].toLowerCase();
    if (!/[\p{L}\p{N}]/u.test(c)) continue;
    s += LOOKALIKE[c] ?? c;
    at.push(i);
  }
  return { s, at };
}

/** How many mistakes OCR may make reading `length` characters: one per six. */
export const budget = (length: number) => Math.floor(length / 6);

/** The fewest single-character changes to turn one string into the other. */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * The best place `needle` appears in `hay` with at most `maxErr` mistakes (Sellers' approximate
 * substring search), as the span [start, end) of `hay`. The fewest mistakes wins; Null if none.
 */
export function findApprox(hay: string, needle: string, maxErr: number): { start: number; end: number; dist: number } | null {
  const m = needle.length;
  if (!m) return null;
  let cost = Array.from({ length: m + 1 }, (_, i) => i);
  let from = new Array<number>(m + 1).fill(0);
  let best: { start: number; end: number; dist: number } | null = null;
  for (let j = 1; j <= hay.length; j++) {
    const nextCost = [0];
    const nextFrom = [j];
    for (let i = 1; i <= m; i++) {
      const diag = cost[i - 1] + (needle[i - 1] === hay[j - 1] ? 0 : 1);
      const skipHay = cost[i] + 1;
      const skipNeedle = nextCost[i - 1] + 1;
      if (diag <= skipHay && diag <= skipNeedle) {
        nextCost[i] = diag;
        nextFrom[i] = from[i - 1];
      } else if (skipHay <= skipNeedle) {
        nextCost[i] = skipHay;
        nextFrom[i] = from[i];
      } else {
        nextCost[i] = skipNeedle;
        nextFrom[i] = nextFrom[i - 1];
      }
    }
    cost = nextCost;
    from = nextFrom;
    if (cost[m] <= maxErr && (!best || cost[m] < best.dist)) best = { start: from[m], end: j, dist: cost[m] };
  }
  return best;
}

// ---------- matching a trigger's phrase ----------

/** What a phrase found: the text where `{name}` was, if the phrase has one. */
export interface PhraseMatch {
  name: string | null;
}

const NAME = '{name}';
/** A name longer than this is a whole sentence the phrase's other words sit in, not a name. */
const MAX_NAME = 40;

/** A problem with the phrase to tell the user about, or null if it is fine. */
export function phraseProblem(phrase: string, regex: boolean): string | null {
  if (!phrase.trim()) return 'Type the words to look for.';
  if (!regex) return null;
  try {
    new RegExp(phrase, 'i');
    return null;
  } catch {
    return 'That isn’t a valid pattern.';
  }
}

/**
 * Looks for the phrase in text read off the screen. Ignores case, spaces and punctuation, and
 * allows one mistake per six letters, so "YOUDIED", "you died." and "Y0U DlED" all find "YOU DIED".
 * A phrase with {name} ("{name} fainted!") also returns what was where the name goes. With
 * `regex`, the phrase is a pattern run on the text as read, and a group called `name` is the name.
 */
export function matchPhrase(text: string, phrase: string, regex = false): PhraseMatch | null {
  if (!text.trim() || !phrase.trim()) return null;
  if (regex) {
    let found: RegExpMatchArray | null;
    try {
      found = text.match(new RegExp(phrase, 'i'));
    } catch {
      return null;
    }
    return found ? { name: found.groups?.name?.trim() || null } : null;
  }

  const hay = squash(text);
  const at = phrase.indexOf(NAME);
  if (at < 0) {
    const want = squash(phrase).s;
    return want && findApprox(hay.s, want, budget(want.length)) ? { name: null } : null;
  }

  // "{name} fainted!": find the words before and after the name, and take what lies between.
  const before = squash(phrase.slice(0, at)).s;
  const after = squash(phrase.slice(at + NAME.length)).s;
  let from = 0;
  if (before) {
    const b = findApprox(hay.s, before, budget(before.length));
    if (!b) return null;
    from = b.end;
  }
  let to = hay.s.length;
  if (after) {
    const a = findApprox(hay.s.slice(from), after, budget(after.length));
    if (!a) return null;
    to = from + a.start;
  }
  if (to <= from) return null;
  const name = text.slice(hay.at[from], hay.at[to - 1] + 1).trim();
  if (!name || name.length > MAX_NAME) return null;
  return { name };
}

/**
 * The party member a name read off the screen belongs to. Names are compared the same forgiving
 * way, so "Pidgeoto" finds PIDGEOTTO; the closest wins, so an exact "Pidgeot" is never taken for
 * the Pidgeotto beside it. Two different names equally close mean no match: better to mark nothing
 * than the wrong one.
 */
export function resolveSlot(name: string, slots: SlotItem[]): SlotItem | null {
  const want = squash(name).s;
  if (!want) return null;
  let best: SlotItem[] = [];
  let bestDist = Infinity;
  for (const slot of slots) {
    const have = squash(slot.name).s;
    if (!have) continue;
    const dist = editDistance(want, have);
    if (dist > budget(have.length)) continue;
    if (dist < bestDist) {
      best = [slot];
      bestDist = dist;
    } else if (dist === bestDist) best.push(slot);
  }
  if (!best.length) return null;
  const names = new Set(best.map((s) => squash(s.name).s));
  if (names.size > 1) return null;
  // Two slots with the same name (a duplicate): the one that is still up.
  return best.find((s) => !s.down) ?? best[0];
}

// ---------- firing once per sighting ----------

/** Where one trigger is: ready to fire, or waiting for its phrase to go away. */
export interface DebounceState {
  armed: boolean;
  /** When the phrase was last seen gone, while waiting; null while it is on screen. */
  absentSince: number | null;
  /** What it last fired for, so a different party member fainting right after still counts. */
  lastKey: string | null;
}

export const freshDebounce = (): DebounceState => ({ armed: true, absentSince: null, lastKey: null });

/**
 * One reading. `key` is null when the phrase isn't there, otherwise what it was found for ('' for
 * a plain phrase, the party member's id for a name). It fires when ready; after that it can't fire
 * again until the phrase has been gone for `cooldownSec` seconds, so a death screen that stays up
 * for ten seconds counts once. A different key fires at once.
 */
export function stepDebounce(state: DebounceState, key: string | null, now: number, cooldownSec: number): { state: DebounceState; fire: boolean } {
  if (key === null) {
    const absentSince = state.absentSince ?? now;
    const rearmed = !state.armed && now - absentSince >= cooldownSec * 1000;
    return {
      state: { armed: state.armed || rearmed, absentSince, lastKey: rearmed ? null : state.lastKey },
      fire: false,
    };
  }
  if (state.armed || key !== state.lastKey) return { state: { armed: false, absentSince: null, lastKey: key }, fire: true };
  return { state: { ...state, absentSince: null }, fire: false };
}

// ---------- doing something about it ----------

/** What a firing changes, ready to apply to the preset and to take back. */
export interface Fire {
  /** What the toast says. */
  message: string;
  apply: (d: PresetData) => void;
  undo: (d: PresetData) => void;
}

/** Why a trigger that saw its phrase still does nothing, in plain words; null when it does something. */
export function whyNot(data: PresetData, t: ScreenTrigger, name: string | null): string | null {
  const a = t.action;
  if (a.kind === 'counter') return data.counters.some((c) => c.id === a.counterId) ? null : 'Pick a counter for it to add to.';
  if (a.kind === 'milestone') return data.milestones.items.some((m) => !m.done) ? null : 'Every milestone is already ticked.';
  if (!name) return 'The phrase needs {name} where the name goes.';
  const slot = resolveSlot(name, data.slots);
  if (!slot) return `Read the name “${name}”, but nobody in the party is called that.`;
  if (slot.down) return `${slot.name} is already down.`;
  return null;
}

/** What firing this trigger would do right now, or null if it would do nothing (see whyNot). */
export function planFire(data: PresetData, t: ScreenTrigger, name: string | null): Fire | null {
  if (whyNot(data, t, name)) return null;
  const a = t.action;
  if (a.kind === 'counter') {
    const c = data.counters.find((x) => x.id === a.counterId)!;
    const bump = (by: number) => (d: PresetData) => {
      const x = d.counters.find((k) => k.id === c.id);
      if (x) x.value += by;
    };
    return { message: `${c.label || 'Counter'} +1`, apply: bump(1), undo: bump(-1) };
  }
  if (a.kind === 'milestone') {
    const m = data.milestones.items.find((x) => !x.done)!;
    const set = (done: boolean) => (d: PresetData) => {
      const x = d.milestones.items.find((k) => k.id === m.id);
      if (x) x.done = done;
    };
    return { message: `${m.name || 'Milestone'} ticked`, apply: set(true), undo: set(false) };
  }
  const slot = resolveSlot(name!, data.slots)!;
  const set = (down: boolean) => (d: PresetData) => {
    const x = d.slots.find((k) => k.id === slot.id);
    if (x) x.down = down;
  };
  return { message: `${slot.name} marked down`, apply: set(true), undo: set(false) };
}

/** The key a reading is debounced on: '' for a plain phrase, the party member for a name. Null when it didn't match. */
export function readingKey(data: PresetData, t: ScreenTrigger, text: string): { key: string | null; name: string | null } {
  const found = matchPhrase(text, t.phrase, t.regex);
  if (!found) return { key: null, name: null };
  if (t.action.kind !== 'slotDown') return { key: '', name: found.name };
  const slot = found.name ? resolveSlot(found.name, data.slots) : null;
  // A name nobody in the party has is treated as not there, so it can't hold back a later one.
  return { key: slot ? slot.id : null, name: found.name };
}

const shown = (text: string) => (text.length > 60 ? `${text.slice(0, 60)}…` : text);

/** The "Test" button's answer: what was read, and what the trigger would have done about it. */
export function describeTest(data: PresetData, t: ScreenTrigger, text: string): string {
  const seen = text.trim();
  if (!seen) return 'Saw no text in that box.';
  const problem = phraseProblem(t.phrase, t.regex);
  if (problem) return `Saw “${shown(seen)}”. ${problem}`;
  const found = matchPhrase(seen, t.phrase, t.regex);
  if (!found) return `Saw “${shown(seen)}”, which isn’t “${shown(t.phrase)}”.`;
  const why = whyNot(data, t, found.name);
  if (why) return `Saw “${shown(seen)}”: a match. ${why}`;
  return `Saw “${shown(seen)}”: a match. It would: ${planFire(data, t, found.name)!.message}.`;
}

/** "just now", "5 min ago", "2 h ago": when a trigger last fired, or "never". */
export function firedText(at: number, now: number): string {
  if (!at) return 'never';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
