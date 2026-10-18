import type { Crop } from '../state/model';

interface Props {
  crop: Crop;
  onChange: (edge: keyof Crop, value: number) => void;
  onReset: () => void;
  onClose: () => void;
}

export function CropEditor({ crop, onChange, onReset, onClose }: Props) {
  return (
    <div className="crop-editor no-drag">
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
