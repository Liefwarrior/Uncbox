import { type CSSProperties, useEffect } from 'react';
import { Icon } from '../../components/Icon';
import type { BodyProps, SettingsProps } from '../types';
import { showNotice } from '../../undo';
import { playChime, primeAudio } from './chime';
import {
  configOf,
  type FocusSettings,
  type FocusState,
  isRunning,
  pause,
  PHASE_NAMES,
  phaseMs,
  remaining,
  reset,
  roundDots,
  patchOf,
  settle,
  skip,
  start,
  stateOf,
} from './focus';
import { useNow } from '../shared/useNow';

/** "24:07", or "1:05:00" for an hour or more. Rounds up, so a fresh 25 minute timer reads 25:00. */
function clock(ms: number) {
  const total = Math.ceil(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  return `${h ? `${h}:${pad(m)}` : m}:${pad(total % 60)}`;
}

const RING = 2 * Math.PI * 44;

/** How long ago a phase may have ended and still get a chime (a page opened much later stays quiet). */
const FRESH_MS = 60_000;

/** The timer, shown big. It runs from the saved end time, so a reload or a sleeping tab loses nothing. */
export function FocusBody({ settings: s, set, editing }: BodyProps<FocusSettings>) {
  const now = useNow(1000);
  const cfg = configOf(s);
  const { state, ended, endedAt } = settle(stateOf(s), now, cfg);

  // Display-only pages (stream mode) show the settled time but never write it back or make a sound.
  const last = ended.at(-1);
  useEffect(() => {
    if (!editing || !last) return;
    set(patchOf(state));
    if (Date.now() - endedAt > FRESH_MS) return;
    if (s.focusSound) playChime();
    showNotice(last === 'work' ? 'Focus round done. Time for a break.' : 'Break over. Back to it.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, endedAt]);

  const left = remaining(state, now, cfg);
  const total = phaseMs(state.phase, cfg);
  const running = isRunning(state);
  const dots = roundDots(state, cfg);
  const act = (next: FocusState) => set(patchOf(next));

  return (
    <div className={`widget-focus ${state.phase === 'work' ? '' : 'is-break'} ${running ? 'is-running' : ''}`}>
      <div className="widget-focus__ring">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <circle className="widget-focus__track" cx="50" cy="50" r="44" />
          <circle
            className="widget-focus__arc"
            cx="50"
            cy="50"
            r="44"
            style={{ strokeDasharray: RING, strokeDashoffset: RING * (1 - Math.min(1, Math.max(0, 1 - left / total))) } as CSSProperties}
          />
        </svg>
        <div className="widget-focus__text">
          <strong>{clock(left)}</strong>
          <span>{PHASE_NAMES[state.phase]}</span>
          <ol className="widget-focus__dots" aria-label={`Round ${Math.min(state.round, dots.total)} of ${dots.total}`}>
            {Array.from({ length: dots.total }, (_, i) => (
              <li key={i} className={i < dots.done ? 'is-done' : i === dots.current ? 'is-current' : ''} />
            ))}
          </ol>
        </div>
      </div>
      {editing && (
        <div className="widget-focus__buttons no-drag">
          <button
            className="btn btn--small btn--accent"
            onClick={() => {
              if (running) return act(pause(state, Date.now()));
              primeAudio();
              act(start(state, Date.now(), cfg));
            }}
          >
            <Icon name={running ? 'pause' : 'play'} size={14} /> {running ? 'Pause' : state.left ? 'Resume' : 'Start'}
          </button>
          <button className="btn btn--small" title="Skip to the next part" onClick={() => act(skip(state, Date.now(), cfg))}>
            <Icon name="skipForward" size={14} /> Skip
          </button>
          <button className="btn btn--small" title="Back to round 1" onClick={() => act(reset())}>
            <Icon name="reset" size={14} /> Reset
          </button>
        </div>
      )}
    </div>
  );
}

/** A number field that keeps whole numbers between 1 and `max`. */
function Minutes({ label, value, max, onChange }: { label: string; value: number; max: number; onChange: (n: number) => void }) {
  return (
    <label>
      {label}
      <input
        type="number"
        min={1}
        max={max}
        value={value}
        onChange={(e) => {
          const n = Math.round(Number(e.target.value));
          if (Number.isFinite(n) && n >= 1) onChange(Math.min(max, n));
        }}
      />
    </label>
  );
}

export function FocusSettingsForm({ settings: s, set }: SettingsProps<FocusSettings>) {
  return (
    <>
      <div className="widget-settings__grid">
        <Minutes label="Focus (min)" value={s.focusWork} max={600} onChange={(n) => set({ focusWork: n })} />
        <Minutes label="Short break (min)" value={s.focusShort} max={600} onChange={(n) => set({ focusShort: n })} />
        <Minutes label="Long break (min)" value={s.focusLong} max={600} onChange={(n) => set({ focusLong: n })} />
        <Minutes label="Rounds before a long break" value={s.focusRounds} max={12} onChange={(n) => set({ focusRounds: n })} />
      </div>
      <label className="inline">
        <input type="checkbox" checked={s.focusAuto} onChange={(e) => set({ focusAuto: e.target.checked })} /> Start the next part by itself
      </label>
      <label className="inline">
        <input type="checkbox" checked={s.focusSound} onChange={(e) => set({ focusSound: e.target.checked })} /> Play a chime when a part ends
      </label>
    </>
  );
}
