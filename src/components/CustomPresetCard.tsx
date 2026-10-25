import { useRef, useState } from 'react';
import { PRESETS } from '../presets';
import { downloadPreset } from '../presetio';
import { type CustomPreset, MAX_PRESET_NAME } from '../state/model';
import { removeCustom, renameCustom, restoreCustom } from '../state/presets';
import type { Mutate } from '../state/useAppState';
import { offerUndo } from '../undo';
import { Icon } from './Icon';
import { Menu } from './Menu';

interface Props {
  preset: CustomPreset;
  index: number;
  active: boolean;
  mutate: Mutate;
  /** After it is picked, so the list it sits in can shut. */
  onPick?: () => void;
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial);
  // Enter, Esc and losing focus all end the edit, and the first of them wins.
  const finished = useRef(false);
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    onDone(save ? value : null);
  };
  return (
    <input
      className="preset-rename"
      aria-label="Preset name"
      autoFocus
      maxLength={MAX_PRESET_NAME}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
    />
  );
}

/** A row for a preset of your own: the base's look, its own name, and a ⋯ menu to rename, export or delete it. */
export function CustomPresetCard({ preset, index, active, mutate, onPick }: Props) {
  const [renaming, setRenaming] = useState(false);

  const remove = () => {
    mutate((s) => removeCustom(s, preset.id));
    // Kept up through the switch to the base, which is what a delete of the showing preset does.
    offerUndo(`“${preset.name}” deleted`, () => mutate((s) => restoreCustom(s, preset, index, active)), true);
  };

  return (
    <div className="preset-slot">
      {renaming ? (
        <div className={`preset-card preset-card--${preset.base} is-custom ${active ? 'on' : ''}`}>
          <strong>
            <RenameInput
              initial={preset.name}
              onDone={(name) => {
                setRenaming(false);
                if (name !== null) mutate((s) => renameCustom(s, preset.id, name));
              }}
            />
          </strong>
          <span>Based on {PRESETS[preset.base].name}</span>
        </div>
      ) : (
        <button
          data-nav
          aria-current={active ? 'true' : undefined}
          className={`preset-card preset-card--${preset.base} is-custom ${active ? 'on' : ''}`}
          onClick={() => {
            mutate((s) => void (s.preset = preset.id));
            onPick?.();
          }}
        >
          <strong>{preset.name}</strong>
          <span>Based on {PRESETS[preset.base].name}</span>
          {active && (
            <span className="preset-card__check">
              <Icon name="check" size={14} />
            </span>
          )}
        </button>
      )}
      <div className="preset-slot__menu">
        <Menu
          label={`Options for ${preset.name}`}
          items={[
            { label: 'Rename', icon: 'pencil', onSelect: () => setRenaming(true) },
            { label: 'Export', icon: 'download', onSelect: () => downloadPreset(preset.name, preset.base, preset.data) },
            'divider',
            { label: 'Delete', icon: 'trash', confirm: 'Delete it?', onSelect: remove },
          ]}
        />
      </div>
    </div>
  );
}
