import { useState } from 'react';
import { useWindowStream } from '../media';
import type { AppWindow } from '../state/model';
import type { MutatePreset } from '../state/useAppState';
import { useBoard } from './Board';
import { CropEditor } from './CropEditor';
import { CroppedVideo } from './CroppedVideo';
import { Icon } from './Icon';
import { Panel } from './Panel';

/**
 * Shows another app's window (Discord, Spotify, a popped-out chat…) inside a themed panel.
 * View only: the browser can show a window but cannot forward clicks or typing to it.
 */
export function WindowPanel({ win, mutatePreset }: { win: AppWindow; mutatePreset: MutatePreset }) {
  const { editing, fitWidthToAspect } = useBoard();
  const { stream, error, pick } = useWindowStream(true);
  const [aspect, setAspect] = useState(0);
  const [cropOpen, setCropOpen] = useState(false);

  const set = (recipe: (w: AppWindow) => void) =>
    mutatePreset((d) => {
      const w = d.windows.find((x) => x.id === win.id);
      if (w) recipe(w);
    });

  return (
    <Panel
      id={win.id}
      className="panel--window"
      label={win.title}
      empty={!stream}
      title={
        editing ? (
          <input
            className="ghost-input panel__title-input"
            value={win.title}
            placeholder="Window name"
            onChange={(e) => set((w) => void (w.title = e.target.value))}
          />
        ) : (
          win.title
        )
      }
      menu={[
        // The window picker needs this click's user activation, so it opens straight from the menu.
        { label: stream ? 'Choose another window' : 'Choose window', icon: 'monitor', onSelect: () => void pick() },
        stream && 'divider',
        stream && {
          label: 'Fill the panel',
          checked: win.fit === 'cover',
          onSelect: () => set((w) => void (w.fit = w.fit === 'cover' ? 'contain' : 'cover')),
        },
        stream && { label: 'Crop edges', icon: 'crop', onSelect: () => setCropOpen(true) },
        stream && {
          label: 'Fit panel to window',
          icon: 'fit',
          disabled: !aspect,
          onSelect: () => fitWidthToAspect(win.id, aspect),
        },
      ]}
    >
      {stream ? (
        <CroppedVideo stream={stream} fit={win.fit} crop={win.crop} onAspect={setAspect} />
      ) : (
        <div className="window-empty ctl">
          <button className="btn btn--accent" onClick={() => void pick()}>
            <Icon name="monitor" /> Choose window
          </button>
          <p className="muted">Any open window, such as Discord or Spotify.</p>
          {error && <p className="error">{error}</p>}
        </div>
      )}
      {cropOpen && editing && stream && (
        <CropEditor
          crop={win.crop}
          onChange={(edge, value) => set((w) => void (w.crop[edge] = value))}
          onReset={() => set((w) => void (w.crop = { top: 0, right: 0, bottom: 0, left: 0 }))}
          onClose={() => setCropOpen(false)}
        />
      )}
    </Panel>
  );
}
