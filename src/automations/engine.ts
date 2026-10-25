import { PRESETS } from '../presets';
import type { AppState, Automation, AutomationGame, AutomationThen, AutomationWhen, PresetId, Widget } from '../state/model';
import { activePreset } from '../state/presets';
import { configOf, type FocusSettings, isFocusWidget, isRunning, nextPhase, patchOf, settle, start, stateOf } from '../widgets/focus/focus';
import { steamMatches } from './rules';

// The rules engine, as plain functions. It is given what the last look at the world was (Signals)
// and what this one is, and says which rules fire. "Starts" and "stops" are edges: they fire once,
// on the change, never again while the thing stays true. src/automations/useAutomations.ts gathers
// the signals and does the actions.

/** Where the focus timer is: working, on a break, paused partway, or not running. */
export type FocusSignal = 'work' | 'break' | 'paused' | 'idle';

/** Everything the rules can watch. null (or a missing game) means "not known yet", which never counts as a change. */
export interface Signals {
  /** ms since 1970. */
  now: number;
  /** Whether each preset's game is running. */
  games: Partial<Record<PresetId, boolean>>;
  /** Whether Steam is running any game. */
  steam: boolean | null;
  /** OBS, or null while it is not connected. */
  obs: { streaming: boolean; recording: boolean } | null;
  focus: FocusSignal | null;
}

// ---- reading the world ----

/**
 * Whether each of these presets' games is running, from its program (`exes`, lower case, null until
 * the first answer) and from the game Steam says is running (undefined until it answers, null for none).
 * A game neither source can speak for is left out.
 */
export function gameSignals(watch: PresetId[], exes: string[] | null, steamName: string | null | undefined): Partial<Record<PresetId, boolean>> {
  const out: Partial<Record<PresetId, boolean>> = {};
  for (const id of watch) {
    const def = PRESETS[id];
    const answers: (boolean | undefined)[] = [];
    if (def.detect) answers.push(exes ? exes.includes(def.detect.toLowerCase()) : undefined);
    if (def.steamNames?.length) answers.push(steamName === undefined ? undefined : steamMatches(def, steamName));
    if (answers.includes(true)) out[id] = true;
    else if (answers.length > 0 && !answers.includes(undefined)) out[id] = false;
  }
  return out;
}

const eachPreset = (state: Pick<AppState, 'presets' | 'custom'>) => [...Object.values(state.presets), ...state.custom.map((c) => c.data)];

/** The focus timer's state at `now`; the first timer that is running wins, then the first paused one. */
export function focusSignal(state: Pick<AppState, 'presets' | 'custom'>, now: number): FocusSignal {
  let paused = false;
  for (const data of eachPreset(state)) {
    for (const w of data.widgets) {
      if (!isFocusWidget(w)) continue;
      const timer = settle(stateOf(w.settings), now, configOf(w.settings)).state;
      if (isRunning(timer)) return timer.phase === 'work' ? 'work' : 'break';
      if (timer.left > 0) paused = true;
    }
  }
  return paused ? 'paused' : 'idle';
}

/** The focus timer "Start a focus round" would use: one on the preset showing, else the first anywhere. */
function focusWidget(state: AppState): Widget<FocusSettings> | undefined {
  const here = activePreset(state).data.widgets.find(isFocusWidget);
  return here ?? eachPreset(state).flatMap((d) => d.widgets).find(isFocusWidget);
}

/**
 * Starts a work round: a running one is left alone, a paused one resumes, and after a break (or
 * before the first round) the next round begins. 'none' if there is no focus timer to start.
 */
export function startFocusRound(draft: AppState, now: number): 'started' | 'already' | 'none' {
  const widget = focusWidget(draft);
  if (!widget) return 'none';
  const s = widget.settings;
  const cfg = configOf(s);
  let timer = settle(stateOf(s), now, cfg).state;
  if (isRunning(timer) && timer.phase === 'work') {
    Object.assign(s, patchOf(timer));
    return 'already';
  }
  if (timer.phase !== 'work') {
    const next = nextPhase(timer.phase, timer.round, cfg);
    timer = { ...next, endsAt: 0, left: 0 };
  }
  Object.assign(s, patchOf(start(timer, now, cfg)));
  return 'started';
}

// ---- which rules fire ----

/** The minute a moment falls in, so two moments in the same minute compare equal. */
const minuteOf = (ms: number) => Math.floor(ms / 60_000);

/** A time rule is due during its minute on its days, once: `lastFired` (which is saved) says it already ran. */
export function timeDue(rule: Automation, now: number): boolean {
  const w = rule.when;
  if (w.kind !== 'time') return false;
  const d = new Date(now);
  if (`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` !== w.at) return false;
  if (w.days.length > 0 && !w.days.includes(d.getDay())) return false;
  return minuteOf(rule.lastFired) !== minuteOf(now);
}

/** up for false → true, down for true → false, and nothing when either side isn't known. */
function edge(prev: boolean | null | undefined, next: boolean | null | undefined): 'up' | 'down' | null {
  if (prev == null || next == null || prev === next) return null;
  return next ? 'up' : 'down';
}

const gameState = (s: Signals, game: AutomationGame) => (game === 'any' ? s.steam : s.games[game]);

function triggered(when: AutomationWhen, prev: Signals, next: Signals): boolean {
  switch (when.kind) {
    case 'gameStarts':
      return edge(gameState(prev, when.game), gameState(next, when.game)) === 'up';
    case 'gameStops':
      return edge(gameState(prev, when.game), gameState(next, when.game)) === 'down';
    case 'streamStarts':
      return edge(prev.obs?.streaming, next.obs?.streaming) === 'up';
    case 'streamStops':
      return edge(prev.obs?.streaming, next.obs?.streaming) === 'down';
    case 'recordStarts':
      return edge(prev.obs?.recording, next.obs?.recording) === 'up';
    // Resuming a paused round isn't starting one.
    case 'focusStarts':
      return next.focus === 'work' && (prev.focus === 'idle' || prev.focus === 'break');
    case 'breakStarts':
      return next.focus === 'break' && (prev.focus === 'idle' || prev.focus === 'work');
    case 'time':
      return false;
  }
}

/**
 * The switched-on rules that fire now. `prev` is the last look (null on the first), so nothing
 * that was already true when Uncbox opened fires. Time rules don't need it: they fire in their minute.
 */
export function firedRules(rules: Automation[], prev: Signals | null, next: Signals): Automation[] {
  return rules.filter((r) => r.enabled && (r.when.kind === 'time' ? timeDue(r, next.now) : prev !== null && triggered(r.when, prev, next)));
}

// ---- keeping them in check ----

/** A rule can't fire again this soon after it last did. */
export const COOLDOWN_MS = 10_000;
/** How long a rule's doing counts as the cause of a change it makes (recording started, a round begun). */
export const CAUSE_MS = 5_000;
/** The most rules that can follow one another from one firing. */
export const MAX_CHAIN = 3;

type WhenKind = AutomationWhen['kind'];

export interface Guard {
  lastRun: Record<string, number>;
  /** What rules recently made happen, and the rules in the chain that made it happen. */
  caused: Partial<Record<WhenKind, { until: number; chain: string[] }>>;
}

export const newGuard = (): Guard => ({ lastRun: {}, caused: {} });

/** The things a step can make happen that another rule is waiting for. */
export function causes(then: AutomationThen): WhenKind[] {
  if (then.kind === 'record' && then.on) return ['recordStarts'];
  if (then.kind === 'focus') return ['focusStarts'];
  return [];
}

/**
 * Whether the rule may fire now, and if so the chain of rules that led to it (its own id last).
 * Not within the cooldown of its last run; not when it is itself part of the chain that made its
 * trigger happen (that would be a loop); and chains stop at MAX_CHAIN.
 */
export function admit(guard: Guard, rule: Automation, now: number): string[] | null {
  const last = guard.lastRun[rule.id];
  if (last !== undefined && now - last < COOLDOWN_MS) return null;
  const cause = guard.caused[rule.when.kind];
  const before = cause && cause.until > now ? cause.chain : [];
  if (before.includes(rule.id) || before.length >= MAX_CHAIN) return null;
  return [...before, rule.id];
}

/** Notes that the rule fired, and what its steps will make happen. */
export function recordRun(guard: Guard, rule: Automation, now: number, chain: string[]) {
  guard.lastRun[rule.id] = now;
  for (const step of rule.then) {
    for (const kind of causes(step)) guard.caused[kind] = { until: now + CAUSE_MS, chain };
  }
}

// ---- doing them ----

export interface StepResult {
  /** What happened, in a few plain words ("switched to SMITE 2"). */
  message: string;
  undo?: () => void;
}

/** What each kind of step does. The page provides these (useAutomations.ts); tests provide fakes. */
export interface Runner {
  preset: (preset: Extract<AutomationThen, { kind: 'preset' }>['preset']) => StepResult | Promise<StepResult>;
  stream: (on: boolean) => StepResult | Promise<StepResult>;
  scene: (scene: string) => StepResult | Promise<StepResult>;
  record: (on: boolean) => StepResult | Promise<StepResult>;
  focus: () => StepResult | Promise<StepResult>;
  note: (text: string) => StepResult | Promise<StepResult>;
}

function runStep(step: AutomationThen, run: Runner): StepResult | Promise<StepResult> {
  switch (step.kind) {
    case 'preset':
      return run.preset(step.preset);
    case 'stream':
      return run.stream(step.on);
    case 'scene':
      return run.scene(step.scene);
    case 'record':
      return run.record(step.on);
    case 'focus':
      return run.focus();
    case 'note':
      return run.note(step.text);
  }
}

/**
 * Runs the steps one after another, in order. A step that fails doesn't stop the rest. The result
 * is one message for the whole firing, and one undo that takes back what can be taken back, last first.
 */
export async function runRule(rule: Automation, run: Runner): Promise<StepResult> {
  const messages: string[] = [];
  const undos: (() => void)[] = [];
  for (const step of rule.then) {
    try {
      const result = await runStep(step, run);
      messages.push(result.message);
      if (result.undo) undos.push(result.undo);
    } catch {
      messages.push('something went wrong');
    }
  }
  return {
    message: messages.join(', '),
    undo: undos.length ? () => [...undos].reverse().forEach((u) => u()) : undefined,
  };
}
