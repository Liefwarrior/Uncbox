import { useState } from 'react';
import { useWindowStream } from '../../media';
import { settingsSetter, WidgetFrame } from '../frame';
import type { WidgetProps } from '../types';
import type { WindowSettings } from './settings';
import { useBoard } from '../../components/boardContext';
import { CropEditor } from '../../components/CropEditor';
import { CroppedVideo } from '../../components/CroppedVideo';
import { Icon } from '../../components/Icon';

/**
 * Shows another app's window (Discord, Spotify, a popped-out chat…) inside a themed panel.
 * View only: the browser can show a window but cannot forward clicks or typing to it.
 */
export function WindowPanel({ widget, name, mutatePreset }: WidgetProps<WindowSettings>) {
  const { editing, fitWidthToAspect } = useBoard();
  const win = widget.settings;
  const { stream, error, pick } = useWindowStream(true);
  const [aspect, setAspect] = useState(0);
  const [cropOpen, setCropOpen] = useState(false);

  const set = settingsSetter(widget, mutatePreset);

  return (
    <WidgetFrame
      widget={widget}
      name={name}
      mutatePreset={mutatePreset}
      empty={!stream}
      menu={[
        // The window picker needs this click's user activation, so it opens straight from the menu.
        { label: stream ? 'Choose another window' : 'Choose window', icon: 'monitor', onSelect: () => void pick() },
        stream && 'divider',
        stream && {
          label: 'Fill the panel',
          checked: win.fit === 'cover',
          onSelect: () => set({ fit: win.fit === 'cover' ? 'contain' : 'cover' }),
        },
        stream && { label: 'Crop edges', icon: 'crop', onSelect: () => setCropOpen(true) },
        stream && {
          label: 'Fit panel to window',
          icon: 'fit',
          disabled: !aspect,
          onSelect: () => fitWidthToAspect(widget.id, aspect),
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
          onChange={(edge, value) => set({ crop: { ...win.crop, [edge]: value } })}
          onReset={() => set({ crop: { top: 0, right: 0, bottom: 0, left: 0 } })}
          onClose={() => setCropOpen(false)}
        />
      )}
    </WidgetFrame>
  );
}
