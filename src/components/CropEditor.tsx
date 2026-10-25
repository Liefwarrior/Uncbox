import { useRef } from 'react';
import type { Crop } from '../state/model';
import { useDialog } from '../useDialog';

interface Props {
  crop: Crop;
  onChange: (edge: keyof Crop, value: number) => void;
  onReset: () => void;
  onClose: () => void;
}

export function CropEditor({ crop, onChange, onReset, onClose }: Props) {
  // Focus moves to the first slider, Tab stays inside, Esc closes, and focus goes back to the opener.
  const box = useRef<HTMLDivElement>(null);
  useDialog(box, { onEscape: onClose });
  return (
    <div ref={box} className="crop-editor no-drag" role="dialog" aria-label="Crop the source">
      <p className="muted">Trim the edges of the source, e.g. a menu bar, a sidebar or black borders.</p>
      {(['top', 'bottom', 'left', 'right'] as const).map((edge) => (
        <label key={edge}>
          <span>{edge}</span>
          <input
            type="range"
            min={0}
            max={45}
            step={0.5}
            value={crop[edge]}
            onChange={(e) => onChange(edge, Number(e.target.value))}
          />
          <output>{crop[edge].toFixed(1)}%</output>
        </label>
      ))}
      <div className="row">
        <button className="btn" onClick={onReset}>
          Reset
        </button>
        <button className="btn btn--accent" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
