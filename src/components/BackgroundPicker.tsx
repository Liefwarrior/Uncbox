import { circuitBoard, graphPaper, hexagons, wiggle } from 'hero-patterns';
import type { CSSProperties, ReactNode } from 'react';
import { BACKGROUNDS, type BackgroundId } from '../backgrounds';
import type { MutatePreset } from '../state/useAppState';

const tile = (fn: (fill?: string, opacity?: number) => string) => {
  const mask = fn('#000', 1);
  return <span className="bg-tile__pattern" style={{ maskImage: mask, WebkitMaskImage: mask } as CSSProperties} />;
};

// Small still drawings of the animated ones, in the theme's accent.
const PREVIEWS: Record<BackgroundId, ReactNode> = {
  plain: null,
  network: (
    <svg viewBox="0 0 60 36" aria-hidden="true">
      <path d="M8 26 22 10l16 12 14-14M22 10l-2 22 18-10" />
      {[[8, 26], [22, 10], [38, 22], [52, 8], [20, 32]].map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.8" />)}
    </svg>
  ),
  stars: (
    <svg viewBox="0 0 60 36" aria-hidden="true">
      {[[6, 8, 1], [18, 22, 0.7], [27, 6, 1.2], [36, 28, 0.8], [44, 14, 1], [54, 26, 0.7], [12, 31, 0.6], [50, 5, 0.6]].map(([x, y, r]) => (
        <circle key={`${x}${y}`} className="fill-text" cx={x} cy={y} r={r} />
      ))}
    </svg>
  ),
  bubbles: (
    <svg viewBox="0 0 60 36" aria-hidden="true">
      {[[12, 24, 7], [30, 12, 4], [44, 25, 9], [52, 8, 3]].map(([x, y, r]) => <circle key={`${x}${y}`} className="soft" cx={x} cy={y} r={r} />)}
    </svg>
  ),
  shards: (
    <svg viewBox="0 0 60 36" aria-hidden="true">
      <path className="line" d="M6 28 16 10l10 18zM32 6l14 4-10 11zM40 32l8-12 8 12z" />
    </svg>
  ),
  circuit: tile(circuitBoard),
  waves: tile(wiggle),
  hexagons: tile(hexagons),
  grid: tile(graphPaper),
};

export function BackgroundPicker({ value, mutatePreset }: { value: BackgroundId; mutatePreset: MutatePreset }) {
  return (
    <div className="bg-grid" role="radiogroup" aria-label="Background">
      {BACKGROUNDS.map((b) => (
        <button
          key={b.id}
          role="radio"
          aria-checked={value === b.id}
          className={`bg-tile ${value === b.id ? 'on' : ''}`}
          onClick={() => mutatePreset((d) => void (d.background = b.id))}
        >
          <span className="bg-tile__preview">{PREVIEWS[b.id]}</span>
          <span className="bg-tile__name">{b.name}</span>
        </button>
      ))}
    </div>
  );
}
