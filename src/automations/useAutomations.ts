import { useEffect, useMemo, useRef, useState } from 'react';
import { obsAction, useObs } from '../obs';
import { useSteam } from '../steam';
import { type AppState, type Automation, isCustomId, PRESET_IDS } from '../state/model';
import type { Mutate } from '../state/useAppState';
import { offerUndo, showNotice } from '../undo';
import {
  admit,
  firedRules,
  focusSignal,
  gameSignals,
  newGuard,
  recordRun,
  type Runner,
  runRule,
  type Signals,
  startFocusRound,
} from './engine';
import { needsOf, presetName } from './rules';

// Runs the automations: gathers what the rules watch from the parts of Uncbox that already know it
// (the games, Steam, OBS, the focus timer, the clock), asks the engine what fires, and does the
// steps with the same functions the buttons use. It watches nothing that no switched-on rule needs.

const RUNNING_EVERY_MS = 5000;

/** Which of these programs are running, asked of the server like the run timer does. null until it answers. */
function useRunning(exes: string[]): string[] | null {
  const [running, setRunning] = useState<string[] | null>(null);
  const key = exes.join(',');
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const check = async () => {
      const r = await fetch(`/api/running?names=${encodeURIComponent(key)}`).catch(() => null);
      if (!r?.ok || !alive) return;
      const now = ((await r.json()) as { running: string[] }).running;
      if (alive) setRunning((was) => (was && was.join(',') === now.join(',') ? was : now));
    };
    void check();
    const t = setInterval(() => void check(), RUNNING_EVERY_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [key]);
  return key ? running : null;
}

interface Options {
  state: AppState;
  mutate: Mutate;
  /** Whether stream mode is on in this window, and a way to switch it. */
  isStreaming: () => boolean;
  setStream: (on: boolean) => void;
}

export function useAutomations({ state, mutate, isStreaming, setStream }: Options) {
  const needs = useMemo(() => needsOf(state.automations), [state.automations]);
  const obs = useObs(needs.obs);
  const steam = useSteam(needs.steam);
  const exes = useRunning(needs.exes);

  // Everything the steps read at the moment they run, without restarting the timer below.
  const latest = useRef({ state, mutate, isStreaming, setStream, obs, steam, exes });
  latest.current = { state, mutate, isStreaming, setStream, obs, steam, exes };
  const memory = useRef({ prev: null as Signals | null, guard: newGuard() });

  const step = useRef(() => {});
  step.current = () => {
    const L = latest.current;
    const enabled = L.state.automations.filter((r) => r.enabled);
    const m = memory.current;
    if (!enabled.length) {
      // Switched back on later, the first look is a fresh start.
      m.prev = null;
      return;
    }
    const now = Date.now();
    const wanted = needsOf(enabled);
    const next: Signals = {
      now,
      games: gameSignals(wanted.games, L.exes, L.steam ? (L.steam.playing?.name ?? null) : undefined),
      steam: wanted.steam && L.steam ? Boolean(L.steam.playing) : null,
      obs: wanted.obs && L.obs?.connected ? { streaming: L.obs.stream.active, recording: L.obs.record.active } : null,
      focus: wanted.focus ? focusSignal(L.state, now) : null,
    };
    const fired = firedRules(enabled, m.prev, next);
    m.prev = next;
    for (const rule of fired) {
      const chain = admit(m.guard, rule, now);
      if (!chain) continue;
      recordRun(m.guard, rule, now, chain);
      void fire(rule, now);
    }
  };

  async function fire(rule: Automation, now: number) {
    const L = latest.current;
    // Saved first, so a reload (or a second window) a moment later doesn't run a time rule again.
    L.mutate((s) => {
      const r = s.automations.find((x) => x.id === rule.id);
      if (r) r.lastFired = now;
    });
    const result = await runRule(rule, runnerFor());
    const message = `Automation: ${result.message}`;
    if (result.undo) offerUndo(message, result.undo, true);
    else showNotice(message);
  }

  /** The steps, done with the functions the rest of the page uses. */
  function runnerFor(): Runner {
    const L = () => latest.current;
    const problemMessage = async (action: Parameters<typeof obsAction>[0], done: string, failed: string) => {
      const problem = await obsAction(action);
      return { message: problem ? `${failed} (${problem.replace(/\.$/, '')})` : done };
    };
    return {
      preset: (id) => {
        const { state: s, mutate: change } = L();
        const name = presetName(s.custom, id);
        if (!name) return { message: 'couldn’t find that preset' };
        if (s.preset === id) return { message: `already on ${name}` };
        const before = s.preset;
        change((d) => void (d.preset = id));
        return {
          message: `switched to ${name}`,
          // Back to where it was, unless that preset was deleted meanwhile.
          undo: () =>
            L().mutate((d) => {
              if ((PRESET_IDS as readonly string[]).includes(before) || (isCustomId(before) && d.custom.some((c) => c.id === before))) d.preset = before;
            }),
        };
      },
      stream: (on) => {
        const { isStreaming: current, setStream: set } = L();
        if (current() === on) return { message: `stream mode was already ${on ? 'on' : 'off'}` };
        set(on);
        return { message: `turned stream mode ${on ? 'on' : 'off'}`, undo: () => set(!on) };
      },
      scene: (scene) =>
        problemMessage({ type: 'SetCurrentProgramScene', sceneName: scene }, `switched OBS to ${scene}`, `couldn’t switch OBS to ${scene}`),
      record: (on) =>
        problemMessage({ type: on ? 'StartRecord' : 'StopRecord' }, on ? 'started recording' : 'stopped recording', on ? 'couldn’t start recording' : 'couldn’t stop recording'),
      focus: () => {
        const { state: s, mutate: change } = L();
        const now = Date.now();
        // Asked of a copy first: a state update can run more than once, and the answer is needed now.
        const outcome = startFocusRound(structuredClone(s), now);
        if (outcome === 'none') return { message: 'there’s no focus timer to start (add one from Add a widget)' };
        if (outcome === 'started') change((d) => void startFocusRound(d, now));
        return { message: outcome === 'started' ? 'started a focus round' : 'a focus round is already running' };
      },
      note: (text) => ({ message: text }),
    };
  }

  // Look again whenever anything this hook was given changes...
  useEffect(() => step.current());
  // ...and every second for the clock and the focus timer, which change by themselves.
  const ticking = needs.time || needs.focus;
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => step.current(), 1000);
    return () => clearInterval(t);
  }, [ticking]);
}
