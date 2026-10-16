import { type CSSProperties, useEffect, useState } from 'react';
import { CameraPanel } from './components/CameraPanel';
import { GamePanel } from './components/GamePanel';
import { NotesPanel } from './components/NotesPanel';
import { PartyPanel } from './components/PartyPanel';
import { ProgressPanel } from './components/ProgressPanel';
import { RunPanel } from './components/RunPanel';
import { Sidebar } from './components/Sidebar';
import { useAppState } from './state/useAppState';

function initialStreamMode() {
  const v = new URLSearchParams(window.location.search).get('stream');
  return v !== null && v !== '0' && v !== 'false';
}

export function App() {
  const { state, mutate, status } = useAppState();
  // Per-window, not saved: a phone can stay in edit mode while the captured window is in stream mode.
  const [streamMode, setStreamMode] = useState(initialStreamMode);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F8') {
        e.preventDefault();
        setStreamMode((m) => !m);
      } else if (e.key === 'Escape') {
        setStreamMode(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const { panels, sideLeft, sideWidth, bottomHeight } = state.layout;
  const hasSide = panels.camera || panels.party;
  const hasBottom = panels.run || panels.progress || panels.notes;
  const boardClass = ['board', hasSide && 'has-side', hasBottom && 'has-bottom', sideLeft && 'side-left']
    .filter(Boolean)
    .join(' ');
  const boardStyle = { '--side-w': `${sideWidth}px`, '--bottom-h': `${bottomHeight}px` } as CSSProperties;

  return (
    <div className={`app ${streamMode ? 'is-stream' : ''}`}>
      {!streamMode && (
        <Sidebar layout={state.layout} mutate={mutate} status={status} onStreamMode={() => setStreamMode(true)} />
      )}
      <main className={boardClass} style={boardStyle}>
        <GamePanel game={state.game} mutate={mutate} streamMode={streamMode} />
        {hasSide && (
          <div className="board__side">
            {panels.camera && <CameraPanel camera={state.camera} mutate={mutate} />}
            {panels.party && <PartyPanel party={state.party} mutate={mutate} />}
          </div>
        )}
        {hasBottom && (
          <div className="board__bottom">
            {panels.run && <RunPanel run={state.run} mutate={mutate} />}
            {panels.progress && (
              <ProgressPanel milestones={state.milestones} counters={state.counters} mutate={mutate} />
            )}
            {panels.notes && <NotesPanel notes={state.notes} mutate={mutate} />}
          </div>
        )}
      </main>
    </div>
  );
}
