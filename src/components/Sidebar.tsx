import { type RefObject, useEffect, useState, useRef } from 'react';
import { onAutomationEditor } from '../automations/editor';
import { downloadPreset, FULL_MESSAGE } from '../presetio';
import { type AppState } from '../state/model';
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
import { Icon } from './Icon';
import { PresetPicker } from './PresetPicker';
import { Section, openSection } from './Section';
import { SetupList } from './SetupList';
import { StartWithWindows } from './StartWithWindows';
import { UpdateNotice } from './UpdateNotice';
import { OnScreen, WidgetLibraryDialog } from './WidgetLibrary';

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

/** Whether the page is in stream mode (the app root carries `is-stream`), without the app having to say so. */
function useInStream(from: RefObject<HTMLElement | null>) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const app = from.current?.closest('.app');
    if (!app) return;
    const read = () => setOn(app.classList.contains('is-stream'));
    read();
    const watch = new MutationObserver(read);
    watch.observe(app, { attributes: true, attributeFilter: ['class'] });
    return () => watch.disconnect();
  }, [from]);
  return on;
}

export function Sidebar({ state, mutate, mutatePreset, status, onStreamMode }: Props) {
  const active = activePreset(state);
  const { base, def, data } = active;
  const { armed, trigger } = useArmed();
  const aside = useRef<HTMLElement>(null);
  const [library, setLibrary] = useState(false);
  const streaming = useInStream(aside);
  // Stream mode shows the dashboard to viewers, so the library stays shut.
  useEffect(() => {
    if (streaming) setLibrary(false);
  }, [streaming]);
  // "Add an automation" from the command palette needs the section showing.
  useEffect(() => onAutomationEditor(() => openSection('automations')), []);

  const resetLayout = () =>
    trigger(() => mutatePreset((d) => resetPresetLayout(d, base)));
  const saveCopy = () => {
    if (!canAddCustom(state)) return showNotice(FULL_MESSAGE, true);
    const copy = copyOfActive(state);
    const id = newCustomId();
    const name = uniqueName(def.name, takenNames(state));
    mutate((s) => addCustom(s, id, name, copy.base, copy.data));
    showNotice(`Saved a copy as “${name}”. You’re editing the copy now.`);
  };

  return (
    <aside className="sidebar" ref={aside}>
      <div className="sidebar__inner">
        <div className="sidebar__scroll">
          <div className="brand">
            <img src="/favicon.svg" alt="" width={22} height={22} />
            <span>Uncbox</span>
          </div>

          <UpdateNotice />

          <PresetPicker state={state} mutate={mutate} />

          <button className="stream-btn" onClick={onStreamMode}>
            <Icon name="cast" /> Stream mode
          </button>
          <p className="hint">Full screen, edit controls hidden. Esc to come back.</p>

          <SetupList state={state} mutatePreset={mutatePreset} />

          <h3>On screen</h3>
          <OnScreen active={active} mutatePreset={mutatePreset} />
          <button className="side-link" aria-haspopup="dialog" onClick={() => setLibrary(true)}>
            <Icon name="plus" /> Get More Widgets
          </button>
          {library && <WidgetLibraryDialog active={active} mutatePreset={mutatePreset} onClose={() => setLibrary(false)} />}

          <div className="folds">
            <Section id="clips" title="Clips">
              <ClipsSection settings={state.clips} mutate={mutate} />
            </Section>

            <Section id="automations" title="Automations">
              <AutomationsSection state={state} mutate={mutate} />
            </Section>

            {base === 'wow' && (
              <Section id="wow" title="WoW addon">
                <WowSection />
              </Section>
            )}

            {shell && (
              <Section id="app" title="App">
                <button className="side-link side-link--quiet" onClick={() => send({ type: 'minimize' })}>
                  <Icon name="minus" /> Minimize to the tray
                </button>
                <StartWithWindows />
              </Section>
            )}

            <Section id="layout" title="Layout">
              <button className={`side-link side-link--quiet ${armed ? 'is-armed' : ''}`} onClick={resetLayout}>
                <Icon name="layout" /> {armed ? 'Reset layout?' : 'Reset layout'}
              </button>
              <button className="side-link side-link--quiet" onClick={saveCopy}>
                <Icon name="copy" /> Save as a new preset
              </button>
              <button className="side-link side-link--quiet" onClick={() => downloadPreset(def.name, base, data)}>
                <Icon name="download" /> Export this preset
              </button>
              <label className="side-field">
                Background
                <BackgroundPicker value={data.background} mutatePreset={mutatePreset} />
              </label>
            </Section>
          </div>
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
