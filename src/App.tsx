import { useEffect, useState } from 'react';
import { Board } from './components/Board';
import { CameraPanel } from './components/CameraPanel';
import { CharacterPanel } from './components/CharacterPanel';
import { DiscordPanel } from './components/DiscordPanel';
import { ChatPanel } from './components/ChatPanel';
import { GamePanel } from './components/GamePanel';
import { MatchPanel } from './components/MatchPanel';
import { NotesPanel } from './components/NotesPanel';
import { ProgressPanel } from './components/ProgressPanel';
import { RecordPanel } from './components/RecordPanel';
import { RunPanel } from './components/RunPanel';
import { Sidebar } from './components/Sidebar';
import { SlotsPanel } from './components/SlotsPanel';
import { WindowPanel } from './components/WindowPanel';
import { PRESETS } from './presets';
import { type BoardId, isWindowId } from './state/model';
import { useAppState } from './state/useAppState';

function initialStreamMode() {
  const v = new URLSearchParams(window.location.search).get('stream');
  return v !== null && v !== '0' && v !== 'false';
}

export function App() {
  const { state, mutate, mutatePreset, status } = useAppState();
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

  const def = PRESETS[state.preset];
  const data = state.presets[state.preset];
  const t = def.titles;

  const renderPanel = (id: BoardId) => {
    if (isWindowId(id)) {
      const win = data.windows.find((w) => w.id === id);
      return win ? <WindowPanel win={win} mutatePreset={mutatePreset} /> : null;
    }
    switch (id) {
      case 'game':
        return <GamePanel game={data.game} mutatePreset={mutatePreset} />;
      case 'camera':
        return <CameraPanel camera={state.camera} title={t.camera} mutate={mutate} />;
      case 'chat':
        return <ChatPanel twitch={state.twitch} title={t.chat} mutate={mutate} />;
      case 'slots':
        return <SlotsPanel slots={data.slots} title={t.slots} def={def.slots} mutatePreset={mutatePreset} />;
      case 'run':
        return <RunPanel run={data.run} title={t.run} mutatePreset={mutatePreset} />;
      case 'progress':
        return (
          <ProgressPanel
            milestones={data.milestones}
            counters={data.counters}
            title={t.progress}
            mutatePreset={mutatePreset}
          />
        );
      case 'notes':
        return <NotesPanel notes={data.notes} title={t.notes} mutatePreset={mutatePreset} />;
      case 'match':
        return <MatchPanel match={data.match} title={t.match} mutatePreset={mutatePreset} />;
      case 'record':
        return <RecordPanel record={data.record} match={data.match} title={t.record} mutatePreset={mutatePreset} />;
      case 'discord':
        return <DiscordPanel pinned={state.discord.pinned} title={t.discord} mutate={mutate} />;
      case 'character':
        return <CharacterPanel character={data.character} title={t.character} mutatePreset={mutatePreset} />;
    }
  };

  return (
    <div className={`app theme-${state.preset} ${streamMode ? 'is-stream' : 'is-editing'}`}>
      <Sidebar
        state={state}
        mutate={mutate}
        mutatePreset={mutatePreset}
        status={status}
        onStreamMode={() => setStreamMode(true)}
      />
      <main className="stage">
        <Board
          key={state.preset}
          layout={data.layout}
          editing={!streamMode}
          mutatePreset={mutatePreset}
          renderPanel={renderPanel}
        />
      </main>
    </div>
  );
}
