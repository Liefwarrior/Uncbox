import { useCallback, useEffect, useRef, useState } from 'react';
import { Backdrop } from './components/Backdrop';
import { Board } from './components/Board';
import { ClipPlayer, ClipToast } from './components/Clips';
import { Gallery } from './components/Gallery';
import { Sidebar } from './components/Sidebar';
import { Palette } from './palette/Palette';
import { UndoToast } from './components/UndoToast';
import { useAutomations } from './automations/useAutomations';
import { useClipKeyInPage } from './clips/replay';
import { useGameDetect, useGameStream, useScreenTriggers } from './hud/reader';
import { useSmiteSync } from './smite';
import { useSmiteScreen } from './smite/reader';
import { renderPanel } from './panels';
import { usePresetDrop } from './presetio';
import type { BoardId } from './state/model';
import { activePreset } from './state/presets';
import { useAppState } from './state/useAppState';
import { dismissUndoOnSwitch } from './undo';

function initialStreamMode() {
  const v = new URLSearchParams(window.location.search).get('stream');
  return v !== null && v !== '0' && v !== 'false';
}

export function App() {
  const { state, mutate, mutatePreset, status } = useAppState();
  // Per-window, not saved: a phone can stay in edit mode while the captured window is in stream mode.
  const [streamMode, setStreamMode] = useState(initialStreamMode);
  const streaming = useRef(streamMode);
  streaming.current = streamMode;

  // Stream mode also goes full screen, which hides the browser's tabs and address bar. Browsers
  // only allow that from a click or key press, so it is requested here rather than in an effect.
  const enterStream = useCallback(() => {
    setStreamMode(true);
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  }, []);
  const exitStream = useCallback(() => {
    setStreamMode(false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }, []);

  // F8, and the command palette's "Toggle stream mode".
  const toggleStream = useCallback(() => (streaming.current ? exitStream() : enterStream()), [enterStream, exitStream]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F8') {
        e.preventDefault();
        toggleStream();
      } else if (e.key === 'Escape') {
        exitStream();
      }
    };
    // The browser takes Esc itself to leave full screen, so the page never sees that key press.
    const onFullscreen = () => {
      if (!document.fullscreenElement) setStreamMode(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFullscreen);
    };
  }, [toggleStream, exitStream]);

  useClipKeyInPage(state.clips);
  useAutomations({
    state,
    mutate,
    isStreaming: useCallback(() => streaming.current, []),
    setStream: useCallback((on: boolean) => (on ? enterStream() : exitStream()), [enterStream, exitStream]),
  });

  // The page itself never scrolls: everything fits the window. If something focused off screen
  // nudges it anyway, put it straight back, or the whole layout stays shifted.
  useEffect(() => {
    const back = () => {
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    };
    back();
    window.addEventListener('scroll', back);
    return () => window.removeEventListener('scroll', back);
  }, []);
  // Game-specific behavior follows the base, so a copy of the SMITE 2 preset still reads SMITE.
  const { base, def, data } = activePreset(state);
  useGameDetect(def.detect, mutatePreset);
  useScreenTriggers(useGameStream(), data, mutatePreset);
  useSmiteSync(base === 'smite2', mutatePreset);
  useSmiteScreen(base === 'smite2', mutatePreset);
  usePresetDrop(state, mutate);

  useEffect(dismissUndoOnSwitch, [state.preset]);

  const render = (id: BoardId) => renderPanel(id, { state, data, def, mutate, mutatePreset });

  // Draw nothing until the saved state arrives (a few ms locally). Otherwise every reload shows the
  // default preset's theme first and crossfades to the real one, which is visible on stream.
  if (status === 'loading') return null;

  return (
    <div className={`app theme-${base} ${streamMode ? 'is-stream' : 'is-editing'}`}>
      <Sidebar
        state={state}
        mutate={mutate}
        mutatePreset={mutatePreset}
        status={status}
        onStreamMode={enterStream}
      />
      <main className="stage">
        <Backdrop id={data.background} preset={base} />
        <Board
          key={state.preset}
          layout={data.layout}
          widgets={data.widgets}
          editing={!streamMode}
          mutatePreset={mutatePreset}
          renderPanel={render}
        />
        <UndoToast />
        <ClipToast driveAuto={state.clips.driveAuto} />
        <ClipPlayer settings={state.clips} data={data} mutatePreset={mutatePreset} />
        <Gallery state={state} mutate={mutate} streaming={streamMode} />
        <Palette state={state} mutate={mutate} mutatePreset={mutatePreset} streaming={streamMode} onToggleStream={toggleStream} />
      </main>
    </div>
  );
}
