import { useRef } from 'react';
import { panelTitle, PRESETS } from '../presets';
import { downloadPreset, importPresetFile } from '../presetio';
import { type AppState, MAX_CUSTOM, PANEL_IDS, type PanelId, PRESET_IDS, uid, WIDGET_TYPES, type WidgetType, type WindowId } from '../state/model';
import { activePreset, addCustom, canAddCustom, copyOfActive, newCustomId, takenNames, uniqueName } from '../state/presets';
import { showNotice } from '../undo';
import { newWidget, WIDGET_INFO } from '../widgets/catalog';
import { resetLayout as resetPresetLayout } from '../state/hydrate';
import type { Mutate, MutatePreset, SyncStatus } from '../state/useAppState';
import { useArmed } from '../useArmed';
import { callOut } from '../callout';
import { placePanel } from '../layout';
import { send, shell } from '../native';
import { PANEL_INFO } from '../panels/catalog';
import { BackgroundPicker } from './BackgroundPicker';
import { ClipsSection } from './Clips';
import { CustomPresetCard } from './CustomPresetCard';
import { Icon } from './Icon';
import { SetupList } from './SetupList';
import { StartWithWindows } from './StartWithWindows';
import { UpdateNotice } from './UpdateNotice';

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
  const { base, def, data } = activePreset(state);
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
  const addWidget = (type: WidgetType) => {
    const w = newWidget(type);
    mutatePreset((d) => {
      d.widgets.push(w);
      d.layout.push(placePanel(d.layout, w.id, d.widgets));
    });
    callOut(w.id);
  };
  const resetLayout = () =>
    trigger(() => mutatePreset((d) => resetPresetLayout(d, base)));
  const picker = useRef<HTMLInputElement>(null);
  const importFile = (file: File | undefined) => {
    if (file) void importPresetFile(file, state, mutate);
  };
  const saveCopy = () => {
    if (!canAddCustom(state)) return showNotice(`You already have ${MAX_CUSTOM} presets of your own. Delete one to make room.`);
    const copy = copyOfActive(state);
    const id = newCustomId();
    const name = uniqueName(def.name, takenNames(state));
    mutate((s) => addCustom(s, id, name, copy.base, copy.data));
    showNotice(`Saved a copy as “${name}”. You’re editing the copy now.`);
  };
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

          <UpdateNotice />

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
            {state.custom.map((c, index) => (
              <CustomPresetCard key={c.id} preset={c} index={index} active={state.preset === c.id} mutate={mutate} />
            ))}
          </div>
          <button className="side-link side-link--quiet" onClick={() => picker.current?.click()}>
            <Icon name="upload" /> Import a preset
          </button>
          <input
            ref={picker}
            type="file"
            accept=".uncbox,.json"
            hidden
            onChange={(e) => {
              importFile(e.target.files?.[0]);
              // So choosing the same file again still counts.
              e.target.value = '';
            }}
          />

          <SetupList state={state} mutatePreset={mutatePreset} />

          <button className="stream-btn" onClick={onStreamMode}>
            <Icon name="cast" /> Stream mode
          </button>
          <p className="hint">Full screen, edit controls hidden. Esc to come back.</p>
          {shell && (
            <button className="side-link side-link--quiet" onClick={() => send({ type: 'minimize' })}>
              <Icon name="minus" /> Minimize to the tray
            </button>
          )}
          <StartWithWindows />

          <ClipsSection settings={state.clips} mutate={mutate} />

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
          <details className="more widget-library">
            <summary>
              <Icon name="plus" /> Add a widget
            </summary>
            <ul className="widget-library__list">
              {WIDGET_TYPES.map((type) => (
                <li key={type}>
                  <button className="widget-library__item" onClick={() => addWidget(type)}>
                    <Icon name={WIDGET_INFO[type].icon} />
                    <span className="toggles__text">
                      {WIDGET_INFO[type].name}
                      <small>{WIDGET_INFO[type].hint}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </details>
          <button className={`side-link side-link--quiet ${armed ? 'is-armed' : ''}`} onClick={resetLayout}>
            <Icon name="layout" /> {armed ? 'Reset layout?' : 'Reset layout'}
          </button>
          <button className="side-link side-link--quiet" onClick={saveCopy}>
            <Icon name="copy" /> Save as a new preset
          </button>
          <button className="side-link side-link--quiet" onClick={() => downloadPreset(def.name, base, data)}>
            <Icon name="download" /> Export this preset
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
