import { useRef } from 'react';
import { PRESETS } from '../presets';
import { openGallery } from '../gallery';
import { downloadPreset, FULL_MESSAGE, importPresetFile } from '../presetio';
import { type AppState, PRESET_IDS } from '../state/model';
import { activePreset, addCustom, canAddCustom, copyOfActive, newCustomId, takenNames, uniqueName } from '../state/presets';
import { showNotice } from '../undo';
import { resetLayout as resetPresetLayout } from '../state/hydrate';
import type { Mutate, MutatePreset, SyncStatus } from '../state/useAppState';
import { useArmed } from '../useArmed';
import { send, shell } from '../native';
import { PaletteHint } from '../palette/Palette';
import { AutomationsSection } from './Automations';
import { BackgroundPicker } from './BackgroundPicker';
import { ClipsSection } from './Clips';
import { WowSection } from './WowSection';
import { CustomPresetCard } from './CustomPresetCard';
import { Icon } from './Icon';
import { SetupList } from './SetupList';
import { StartWithWindows } from './StartWithWindows';
import { UpdateNotice } from './UpdateNotice';
import { OnScreen, WidgetLibrary } from './WidgetLibrary';

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
  const active = activePreset(state);
  const { base, def, data } = active;
  const { armed, trigger } = useArmed();

  const resetLayout = () =>
    trigger(() => mutatePreset((d) => resetPresetLayout(d, base)));
  const picker = useRef<HTMLInputElement>(null);
  const importFile = (file: File | undefined) => {
    if (file) void importPresetFile(file, state, mutate);
  };
  const saveCopy = () => {
    if (!canAddCustom(state)) return showNotice(FULL_MESSAGE, true);
    const copy = copyOfActive(state);
    const id = newCustomId();
    const name = uniqueName(def.name, takenNames(state));
    mutate((s) => addCustom(s, id, name, copy.base, copy.data));
    showNotice(`Saved a copy as “${name}”. You’re editing the copy now.`);
  };

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
          <button className="side-link side-link--quiet" onClick={openGallery}>
            <Icon name="globe" /> Browse presets
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

          {base === 'wow' && <WowSection />}

          <AutomationsSection state={state} mutate={mutate} />

          <h3>On screen</h3>
          <OnScreen active={active} mutatePreset={mutatePreset} />

          <h3>Get More Widgets</h3>
          <WidgetLibrary active={active} mutatePreset={mutatePreset} />

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

        <PaletteHint />
        <footer className={`sync sync--${status}`}>
          <span className="sync__dot" />
          {STATUS_TEXT[status]}
        </footer>
      </div>
    </aside>
  );
}
