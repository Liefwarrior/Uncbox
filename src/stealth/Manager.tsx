import { useEffect, useState } from 'react';
import { ClipPlayer, ClipToast } from '../components/Clips';
import { Gallery } from '../components/Gallery';
import { Icon } from '../components/Icon';
import { Sidebar } from '../components/Sidebar';
import { UndoToast } from '../components/UndoToast';
import { deviceBox, send, useCovered } from '../native';
import { Palette } from '../palette/Palette';
import { PrivacyProvider } from '../privacy';
import { PRESETS } from '../presets';
import { PRESET_IDS, type AppState } from '../state/model';
import { activePreset } from '../state/presets';
import { useAppState, type Mutate } from '../state/useAppState';
import { endStream, goLive, StreamRunner, useStreamController } from '../stream/live';
import { streamLine } from '../stream/format';
import { isStreaming, useStream } from '../stream/status';
import { useArmed } from '../useArmed';
import { useNow } from '../widgets/shared/useNow';
import { relay, setStealth, useStealth } from './stealth';

// Stealth mode's manager page (?view=manager), in the Uncbox app's manager window: the OBS-style
// way to run Uncbox while the game is played full screen. A live preview of exactly what viewers see
// (drawn by Windows over the box below, see StealthForm.cs), the stream's controls, your presets as
// one-click scenes, and the whole sidebar. It shows no board of its own: the dashboard, running
// behind the game, is the board, and everything here reaches it through the shared state.

/** Anything modal over the page (the widget library, the palette, the gallery, a clip): the preview hides under it. */
const MODAL = '[role="dialog"], [aria-modal="true"], dialog[open]';

/**
 * The box the app draws the preview in. Its place is sent in device pixels whenever it changes (the
 * window resized, the sidebar opened), and taken away while something modal covers the page, since
 * Windows draws the preview on top of everything in it.
 */
function Preview() {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const covered = useCovered();
  useEffect(() => {
    if (!box) return;
    let last = '';
    let frame = 0;
    const report = () => {
      const hidden = covered || document.querySelector(MODAL) !== null;
      const rect = deviceBox(box);
      const key = hidden ? 'hidden' : JSON.stringify(rect);
      if (key !== last) {
        last = key;
        send(hidden || rect.w < 2 || rect.h < 2 ? { type: 'previewrect' } : { type: 'previewrect', ...rect });
      }
      frame = requestAnimationFrame(report);
    };
    report();
    return () => {
      cancelAnimationFrame(frame);
      send({ type: 'previewrect' });
    };
  }, [box, covered]);
  return (
    <div className="manager__preview" ref={setBox} role="img" aria-label="Live preview: what viewers see">
      <p className="manager__preview-wait">The preview shows here.</p>
    </div>
  );
}

/** Go live, Test, End, and how the stream is going, OBS's controls dock in one row. */
function LiveDeck({ state }: { state: AppState }) {
  const status = useStream();
  const ctl = useStreamController();
  const now = useNow();
  const go = useArmed();
  const end = useArmed();
  const settings = state.stream;
  const busy = ctl.phase !== 'idle' || isStreaming(status) || status.state === 'stopping';
  const live = status.state === 'live';
  const uncbox = settings.with === 'uncbox';
  const stats = status.stats;

  return (
    <div className="manager__deck">
      <div className={`manager__status ${live ? 'is-live' : ''}`} aria-live="polite">
        <span className="manager__dot" aria-hidden="true" />
        <span>{busy ? streamLine(status, ctl, now) : uncbox ? 'Not live' : 'OBS streams (Streaming, below, to stream from Uncbox)'}</span>
        {live && stats && (
          <span className="manager__stats">
            {Math.round(stats.fps)} fps · {stats.dropped} dropped
          </span>
        )}
      </div>
      {(ctl.error || (!busy && status.state === 'error' && status.error)) && <p className="error manager__error">{ctl.error || status.error}</p>}
      <div className="manager__buttons">
        {uncbox && !busy && (
          <>
            <button className={`btn btn--accent ${go.armed ? 'is-armed' : ''}`} onClick={() => go.trigger(() => void goLive(settings, false))}>
              <Icon name="radio" size={15} /> {go.armed ? 'Go live?' : 'Go live'}
            </button>
            <button className="btn" onClick={() => void goLive(settings, true)}>
              Test stream
            </button>
          </>
        )}
        {uncbox && busy && (
          <button className={`btn ${end.armed ? 'is-armed' : ''}`} onClick={() => end.trigger(() => void endStream())}>
            <Icon name="x" size={15} /> {end.armed ? 'End stream?' : 'End stream'}
          </button>
        )}
        <button className="btn" onClick={() => relay({ type: 'clipsave' })} title="Saves the last minute of your game, like the clip key">
          <Icon name="film" size={15} /> Save clip
        </button>
        <span className="spacer" />
        <button className="btn" onClick={() => send({ type: 'play' })} title="Back into the game (Ctrl+Shift+F12)">
          <Icon name="gamepad" size={15} /> Play
        </button>
        <button className="btn" onClick={() => send({ type: 'minimize' })} title="Out of the way; the stream goes on">
          <Icon name="minus" size={15} /> Minimize
        </button>
      </div>
    </div>
  );
}

/** Your presets as OBS-style scenes: one click and viewers see that one. */
function Scenes({ state, mutate }: { state: AppState; mutate: Mutate }) {
  const showing = state.preset;
  const all = [...PRESET_IDS.map((id) => ({ id: id as string, name: PRESETS[id].name })), ...state.custom.map((c) => ({ id: c.id, name: c.name }))];
  return (
    <nav className="manager__scenes" aria-label="Scenes">
      <span className="manager__label">Scenes</span>
      {all.map((p) => (
        <button
          key={p.id}
          className={`chip manager__scene ${p.id === showing ? 'on' : ''}`}
          aria-pressed={p.id === showing}
          onClick={() => mutate((s) => void (s.preset = p.id as AppState['preset']))}
        >
          {p.name}
        </button>
      ))}
    </nav>
  );
}

/** The whole manager page. */
export function ManagerApp() {
  const { state, mutate, mutatePreset, status } = useAppState();
  const stealth = useStealth();
  if (status === 'loading') return null;
  const { base, def } = activePreset(state);
  return (
    <PrivacyProvider streamMode={false}>
      <StreamRunner settings={state.stream} />
      <div className={`app theme-${base} is-editing is-manager`}>
        <Sidebar state={state} mutate={mutate} mutatePreset={mutatePreset} status={status} onStreamMode={() => setStealth(false)} view="manager" />
        <main className="manager">
          <header className="manager__bar">
            <span className="manager__mode">
              <Icon name="eyeOff" size={15} /> {stealth ? 'Stealth mode' : 'Stealth mode is off'}
            </span>
            <span className="manager__label">What viewers see · {def.name}</span>
            <span className="spacer" />
            <button className="btn btn--small" onClick={() => setStealth(false)}>
              <Icon name="layout" size={14} /> Full dashboard
            </button>
          </header>
          <Preview />
          <LiveDeck state={state} />
          <Scenes state={state} mutate={mutate} />
          <p className="hint manager__hint">
            Play as you normally would: viewers see your Uncbox dashboard with the game in it. This window never shows on stream. Ctrl+Shift+F12 swaps between it and the game.
          </p>
          <UndoToast />
          <ClipToast driveAuto={state.clips.driveAuto} />
          <ClipPlayer settings={state.clips} data={activePreset(state).data} mutatePreset={mutatePreset} />
          <Gallery state={state} mutate={mutate} streaming={false} />
          <Palette state={state} mutate={mutate} mutatePreset={mutatePreset} streaming={false} onToggleStream={() => setStealth(false)} />
        </main>
      </div>
    </PrivacyProvider>
  );
}
