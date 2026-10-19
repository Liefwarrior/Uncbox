import { useCallback, useEffect, useRef, useState } from 'react';
import { Backdrop } from './components/Backdrop';
import { Board } from './components/Board';
import { ClipPlayer, ClipToast } from './components/Clips';
import { Sidebar } from './components/Sidebar';
import { UndoToast } from './components/UndoToast';
import { useClipKeyInPage } from './clips/replay';
import { renderPanel } from './panels';
import { PRESETS } from './presets';
import type { BoardId } from './state/model';
import { useAppState } from './state/useAppState';
import { dismissUndo } from './undo';

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F8') {
        e.preventDefault();
        if (streaming.current) exitStream();
        else enterStream();
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
  }, [enterStream, exitStream]);

  useClipKeyInPage(state.clips);

  // An undo restores into the active preset, so it must not outlive a switch to another one.
  useEffect(dismissUndo, [state.preset]);

  const def = PRESETS[state.preset];
  const data = state.presets[state.preset];
  const render = (id: BoardId) => renderPanel(id, { state, data, def, mutate, mutatePreset });

  // Draw nothing until the saved state arrives (a few ms locally). Otherwise every reload shows the
  // default preset's theme first and crossfades to the real one, which is visible on stream.
  if (status === 'loading') return null;

  return (
    <div className={`app theme-${state.preset} ${streamMode ? 'is-stream' : 'is-editing'}`}>
      <Sidebar
        state={state}
        mutate={mutate}
        mutatePreset={mutatePreset}
        status={status}
        onStreamMode={enterStream}
      />
      <main className="stage">
        <Backdrop id={data.background} preset={state.preset} />
        <Board
          key={state.preset}
          layout={data.layout}
          widgets={data.widgets}
          editing={!streamMode}
          mutatePreset={mutatePreset}
          renderPanel={render}
        />
        <UndoToast />
        <ClipToast />
        <ClipPlayer />
      </main>
    </div>
  );
}
