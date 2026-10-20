import type { ReactNode } from 'react';
import { CameraPanel } from '../components/CameraPanel';
import { CharacterPanel } from '../components/CharacterPanel';
import { ChatPanel } from '../components/ChatPanel';
import { DiscordPanel } from '../components/DiscordPanel';
import { GamePanel } from '../components/GamePanel';
import { MatchPanel } from '../components/MatchPanel';
import { NotesPanel } from '../components/NotesPanel';
import { ProgressPanel } from '../components/ProgressPanel';
import { QuestsPanel } from '../components/QuestsPanel';
import { RecordPanel } from '../components/RecordPanel';
import { RunPanel } from '../components/RunPanel';
import { HudPanel } from '../components/HudPanel';
import { SlotsPanel } from '../components/SlotsPanel';
import { SteamPanel } from '../components/SteamPanel';
import { DamagePanel } from '../components/DamagePanel';
import { ScoreboardPanel } from '../components/ScoreboardPanel';
import { TeamsPanel } from '../components/TeamsPanel';
import { WindowPanel } from '../components/WindowPanel';
import { panelTitle, type PresetDef } from '../presets';
import { type AppState, type BoardId, isWidgetId, isWindowId, type PanelId, type PresetData } from '../state/model';
import { WidgetPanel } from '../widgets/WidgetPanel';
import type { Mutate, MutatePreset } from '../state/useAppState';

export interface PanelContext {
  state: AppState;
  data: PresetData;
  def: PresetDef;
  title: string;
  mutate: Mutate;
  mutatePreset: MutatePreset;
}

const RENDER: Record<PanelId, (c: PanelContext) => ReactNode> = {
  game: (c) => (
    <GamePanel
      game={c.data.game}
      preset={c.def.id}
      wow={c.def.id === 'wow' ? c.data : null}
      clips={c.state.clips}
      mutatePreset={c.mutatePreset}
    />
  ),
  camera: (c) => <CameraPanel camera={c.state.camera} title={c.title} mutate={c.mutate} />,
  chat: (c) => <ChatPanel twitch={c.state.twitch} title={c.title} mutate={c.mutate} />,
  slots: (c) => <SlotsPanel slots={c.data.slots} title={c.title} def={c.def.slots} mutatePreset={c.mutatePreset} />,
  run: (c) => <RunPanel run={c.data.run} title={c.title} mutatePreset={c.mutatePreset} />,
  progress: (c) => (
    <ProgressPanel milestones={c.data.milestones} counters={c.data.counters} title={c.title} mutatePreset={c.mutatePreset} />
  ),
  notes: (c) => <NotesPanel notes={c.data.notes} title={c.title} mutatePreset={c.mutatePreset} />,
  match: (c) => <MatchPanel match={c.data.match} title={c.title} mutatePreset={c.mutatePreset} />,
  record: (c) => <RecordPanel record={c.data.record} match={c.data.match} title={c.title} mutatePreset={c.mutatePreset} />,
  character: (c) => <CharacterPanel character={c.data.character} title={c.title} mutatePreset={c.mutatePreset} />,
  discord: (c) => <DiscordPanel pinned={c.state.discord.pinned} title={c.title} mutate={c.mutate} />,
  quests: (c) => <QuestsPanel quests={c.data.quests} linked={c.data.wowLinkAt > 0} title={c.title} />,
  steam: (c) => <SteamPanel title={c.title} />,
  teams: (c) => <TeamsPanel title={c.title} />,
  scoreboard: (c) => <ScoreboardPanel title={c.title} />,
  damage: (c) => <DamagePanel title={c.title} />,
  hud: (c) => <HudPanel hud={c.data.hud} title={c.title} suggestions={c.def.hud ?? []} mutatePreset={c.mutatePreset} />,
};

export function renderPanel(id: BoardId, c: Omit<PanelContext, 'title'>): ReactNode {
  if (isWindowId(id)) {
    const win = c.data.windows.find((w) => w.id === id);
    return win ? <WindowPanel win={win} mutatePreset={c.mutatePreset} /> : null;
  }
  if (isWidgetId(id)) {
    const widget = c.data.widgets.find((w) => w.id === id);
    return widget ? <WidgetPanel widget={widget} mutatePreset={c.mutatePreset} /> : null;
  }
  return RENDER[id]({ ...c, title: panelTitle(c.def, id) });
}
