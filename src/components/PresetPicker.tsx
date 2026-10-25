import { useRef } from 'react';
import { openGallery } from '../gallery';
import { importPresetFile } from '../presetio';
import { PRESETS } from '../presets';
import { type AppState, PRESET_IDS } from '../state/model';
import type { Mutate } from '../state/useAppState';
import { CustomPresetCard } from './CustomPresetCard';
import { Dropdown } from './Dropdown';
import { Icon } from './Icon';

/** The name and blurb of the preset on the board, and the built-in game whose look it wears. */
function shown(state: AppState) {
  const custom = state.custom.find((c) => c.id === state.preset);
  if (custom) return { base: custom.base, name: custom.name, blurb: `Based on ${PRESETS[custom.base].name}` };
  const id = PRESET_IDS.find((p) => p === state.preset) ?? PRESET_IDS[0];
  return { base: id, name: PRESETS[id].name, blurb: PRESETS[id].blurb };
}

/**
 * "Game": one button showing the preset you are on (in its own font and color), which opens the
 * list of all of them. Presets of your own keep their ⋯ menu; importing and browsing sit at the
 * bottom of the list.
 */
export function PresetPicker({ state, mutate }: { state: AppState; mutate: Mutate }) {
  const file = useRef<HTMLInputElement>(null);
  const now = shown(state);

  return (
    <>
      <Dropdown
        label="Game"
        current={now.name}
        className={`preset-pick preset-card--${now.base}`}
        trigger={
          <span className="preset-face">
            <strong>{now.name}</strong>
            <span>{now.blurb}</span>
          </span>
        }
      >
        {(close) => (
          <>
            <div className="preset-list">
              {PRESET_IDS.map((id) => (
                <button
                  key={id}
                  data-nav
                  aria-current={state.preset === id ? 'true' : undefined}
                  className={`preset-card preset-card--${id} ${state.preset === id ? 'on' : ''}`}
                  onClick={() => {
                    mutate((s) => void (s.preset = id));
                    close();
                  }}
                >
                  <strong>{PRESETS[id].name}</strong>
                  <span>{PRESETS[id].blurb}</span>
                  {state.preset === id && (
                    <span className="preset-card__check">
                      <Icon name="check" size={14} />
                    </span>
                  )}
                </button>
              ))}
              {state.custom.map((c, index) => (
                <CustomPresetCard key={c.id} preset={c} index={index} active={state.preset === c.id} mutate={mutate} onPick={close} />
              ))}
            </div>
            <div className="preset-foot">
              <button
                data-nav
                className="side-link side-link--quiet"
                onClick={() => {
                  // Opens the file chooser from this click; the list shuts around it.
                  file.current?.click();
                  close();
                }}
              >
                <Icon name="upload" /> Import a preset
              </button>
              <button
                data-nav
                className="side-link side-link--quiet"
                onClick={() => {
                  close();
                  openGallery();
                }}
              >
                <Icon name="globe" /> Browse presets
              </button>
            </div>
          </>
        )}
      </Dropdown>
      <input
        ref={file}
        type="file"
        accept=".uncbox,.json"
        aria-label="Preset file"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importPresetFile(f, state, mutate);
          // So choosing the same file again still counts.
          e.target.value = '';
        }}
      />
    </>
  );
}
