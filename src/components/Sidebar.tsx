import { type AppState, PANEL_LABELS, type PanelId } from '../state/model';
import type { Mutate, SyncStatus } from '../state/useAppState';
import { Icon } from './Icon';

const STATUS_TEXT: Record<SyncStatus, string> = {
  loading: 'Loading…',
  synced: 'Saved',
  saving: 'Saving…',
  offline: 'Server offline, changes not saved',
};

interface Props {
  layout: AppState['layout'];
  mutate: Mutate;
  status: SyncStatus;
  onStreamMode: () => void;
}

export function Sidebar({ layout, mutate, status, onStreamMode }: Props) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <img src="/favicon.svg" alt="" width={20} height={20} />
        <span>PokéStream</span>
      </div>

      <button className="stream-btn" onClick={onStreamMode}>
        <Icon name="cast" /> Stream mode
      </button>
      <p className="hint">Hides this sidebar and the edit controls. F8 or Esc to come back.</p>

      <h3>Panels</h3>
      <ul className="toggles">
        {(Object.keys(PANEL_LABELS) as PanelId[]).map((id) => (
          <li key={id}>
            <label>
              <input
                type="checkbox"
                checked={layout.panels[id]}
                onChange={(e) => mutate((s) => void (s.layout.panels[id] = e.target.checked))}
              />
              <span className="toggle" />
              {PANEL_LABELS[id]}
            </label>
          </li>
        ))}
      </ul>

      <h3>Layout</h3>
      <button className="side-link" onClick={() => mutate((s) => void (s.layout.sideLeft = !s.layout.sideLeft))}>
        <Icon name="swap" /> Side column on the {layout.sideLeft ? 'left' : 'right'}
      </button>
      <label className="slider">
        <span>Side width</span>
        <input
          type="range"
          min={220}
          max={560}
          step={10}
          value={layout.sideWidth}
          onChange={(e) => mutate((s) => void (s.layout.sideWidth = Number(e.target.value)))}
        />
      </label>
      <label className="slider">
        <span>Bottom height</span>
        <input
          type="range"
          min={140}
          max={420}
          step={10}
          value={layout.bottomHeight}
          onChange={(e) => mutate((s) => void (s.layout.bottomHeight = Number(e.target.value)))}
        />
      </label>

      <footer className={`sync sync--${status}`}>
        <span className="sync__dot" />
        {STATUS_TEXT[status]}
      </footer>
    </aside>
  );
}
