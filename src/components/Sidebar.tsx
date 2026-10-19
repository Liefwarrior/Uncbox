import { panelTitle, PRESETS } from '../presets';
import { type AppState, PANEL_IDS, type PanelId, PRESET_IDS, uid, type WindowId } from '../state/model';
import { defaultPresetData } from '../state/hydrate';
import type { Mutate, MutatePreset, SyncStatus } from '../state/useAppState';
import { useArmed } from '../useArmed';
import { placePanel } from '../layout';
import { PANEL_INFO } from '../panels/catalog';
import { BackgroundPicker } from './BackgroundPicker';
import { Icon } from './Icon';
import { SetupList } from './SetupList';

const STATUS_TEXT: Record<SyncStatus, string> = {
  loading: 'Loading…',
  synced: 'Saved',
  saving: 'Saving…',
  offline: 'Can’t reach Uncbox. Not saving.',
};

interface Props {
  state: AppState;
  mutate: Mutate;
  mutatePreset: MutatePreset;
  status: SyncStatus;
  onStreamMode: () => void;
}

export function Sidebar({ state, mutate, mutatePreset, status, onStreamMode }: Props) {
  const def = PRESETS[state.preset];
  const data = state.presets[state.preset];
  const shown = new Set(data.layout.map((item) => item.i));
  const more = PANEL_IDS.filter((id) => !def.featured.includes(id));
  const { armed, trigger } = useArmed();

  const toggle = (id: PanelId, on: boolean) =>
    mutatePreset((d) => {
      d.layout = on ? [...d.layout, placePanel(d.layout, id)] : d.layout.filter((item) => item.i !== id);
    });
  const addWindow = () =>
    mutatePreset((d) => {
      const id: WindowId = `win-${uid()}`;
      d.windows.push({ id, title: 'App window', fit: 'contain', crop: { top: 0, right: 0, bottom: 0, left: 0 } });
      d.layout.push(placePanel(d.layout, id));
    });
  const resetLayout = () =>
    trigger(() =>
      mutatePreset((d) => {
        d.layout = defaultPresetData(state.preset).layout;
        d.windows = [];
      }),
    );
  const row = (id: PanelId) => (
    <li key={id}>
      <label>
        <input type="checkbox" checked={shown.has(id)} onChange={(e) => toggle(id, e.target.checked)} />
        <span className="toggle" />
        <span className="toggles__text">
          {panelTitle(def, id)}
          <small>{PANEL_INFO[id].hint}</small>
        </span>
      </label>
    </li>
  );

  return (
    <aside className="sidebar">
      <div className="sidebar__inner">
        <div className="sidebar__scroll">
          <div className="brand">
            <img src="/favicon.svg" alt="" width={22} height={22} />
            <span>Uncbox</span>
          </div>

          <h3>Game</h3>
          <div className="presets">
            {PRESET_IDS.map((id) => (
              <button
                key={id}
                className={`preset-card preset-card--${id} ${state.preset === id ? 'on' : ''}`}
                onClick={() => mutate((s) => void (s.preset = id))}
              >
                <strong>{PRESETS[id].name}</strong>
                <span>{PRESETS[id].blurb}</span>
              </button>
            ))}
          </div>

          <SetupList state={state} mutatePreset={mutatePreset} />

          <button className="stream-btn" onClick={onStreamMode}>
            <Icon name="cast" /> Stream mode
          </button>
          <p className="hint">Full screen, edit controls hidden. Esc to come back.</p>

          <h3>On screen</h3>
          <ul className="toggles">{def.featured.map(row)}</ul>
          {more.length > 0 && (
            <details className="more">
              <summary>More panels</summary>
              <ul className="toggles">{more.map(row)}</ul>
            </details>
          )}
          <button className="side-link" onClick={addWindow}>
            <Icon name="plus" /> Add an app window
          </button>
          <button className={`side-link side-link--quiet ${armed ? 'is-armed' : ''}`} onClick={resetLayout}>
            <Icon name="layout" /> {armed ? 'Reset layout?' : 'Reset layout'}
          </button>

          <h3>Background</h3>
          <BackgroundPicker value={data.background} mutatePreset={mutatePreset} />
        </div>

        <footer className={`sync sync--${status}`}>
          <span className="sync__dot" />
          {STATUS_TEXT[status]}
        </footer>
      </div>
    </aside>
  );
}
