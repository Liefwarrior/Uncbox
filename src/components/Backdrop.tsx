import { circuitBoard, graphPaper, hexagons, wiggle } from 'hero-patterns';
import { type CSSProperties, useEffect, useRef } from 'react';
import { backgroundKind, type BackgroundId } from '../backgrounds';
import type { Palette } from '../particles';
import type { PresetId } from '../state/model';

// Patterns are used as masks over a layer filled with the theme's accent, so their color comes
// from the theme tokens (and crossfades with them) instead of being baked into the SVG.
const PATTERNS: Partial<Record<BackgroundId, string>> = {
  circuit: circuitBoard('#000', 1),
  waves: wiggle('#000', 1),
  hexagons: hexagons('#000', 1),
  grid: graphPaper('#000', 1),
};

/** The preset's theme colors, read from a probe so a theme crossfade in progress doesn't matter. */
function paletteOf(preset: PresetId, root: Element): Palette {
  const probe = document.createElement('div');
  probe.className = `theme-${preset}`;
  probe.hidden = true;
  root.appendChild(probe);
  const css = getComputedStyle(probe);
  const read = (name: string) => css.getPropertyValue(name).trim();
  const colors = { accent: read('--accent'), accent2: read('--accent-2'), text: read('--text') };
  probe.remove();
  return colors;
}

export function Backdrop({ id, preset }: { id: BackgroundId; preset: PresetId }) {
  const host = useRef<HTMLDivElement>(null);
  const kind = backgroundKind(id);

  useEffect(() => {
    const el = host.current;
    if (kind !== 'particles' || !el) return;
    let stopped = false;
    let stop: (() => void) | undefined;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    void import('../particles')
      .then(({ startParticles }) => startParticles(el, id, paletteOf(preset, el.closest('.app') ?? document.body), still))
      .then((container) => {
        if (stopped) container?.destroy();
        else stop = () => container?.destroy();
      })
      .catch((err) => console.warn('Background animation failed to start:', err));
    return () => {
      stopped = true;
      stop?.();
    };
  }, [id, kind, preset]);

  if (kind === 'plain') return null;
  if (kind === 'pattern') {
    const mask = PATTERNS[id];
    return <div className={`backdrop backdrop--pattern backdrop--${id}`} style={{ maskImage: mask, WebkitMaskImage: mask } as CSSProperties} aria-hidden="true" />;
  }
  return <div ref={host} id="uncbox-backdrop" className="backdrop backdrop--particles" aria-hidden="true" />;
}
