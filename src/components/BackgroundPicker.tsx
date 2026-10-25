import { BACKGROUNDS, type BackgroundId, isBackgroundId } from '../backgrounds';
import type { MutatePreset } from '../state/useAppState';

/** The backdrop behind the board, as a plain list to pick from. */
export function BackgroundPicker({ value, mutatePreset }: { value: BackgroundId; mutatePreset: MutatePreset }) {
  return (
    <select
      className="select--block"
      aria-label="Background"
      value={value}
      onChange={(e) => {
        const id = e.target.value;
        if (isBackgroundId(id)) mutatePreset((d) => void (d.background = id));
      }}
    >
      {BACKGROUNDS.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
    </select>
  );
}
