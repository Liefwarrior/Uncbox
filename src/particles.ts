import { type Container, type ISourceOptions, tsParticles } from '@tsparticles/engine';
import { loadSlim } from '@tsparticles/slim';
import type { BackgroundId } from './backgrounds';

// Loaded on demand (see Backdrop), so the animation library only downloads for people who pick an
// animated background. It draws once per screen refresh, up to 120 fps, so motion stays smooth on
// high-refresh monitors; the shapes are few and slow, so that costs the game almost nothing.

export interface Palette {
  accent: string;
  accent2: string;
  text: string;
}

const ready = loadSlim(tsParticles);

function optionsFor(id: BackgroundId, c: Palette, still: boolean): ISourceOptions {
  const base: ISourceOptions = {
    fullScreen: { enable: false },
    fpsLimit: 120,
    detectRetina: true,
    pauseOnBlur: false,
    pauseOnOutsideViewport: true,
  };
  const move = (speed: number, extra: object = {}) => ({ enable: !still, speed, outModes: { default: 'out' as const }, ...extra });
  switch (id) {
    case 'network':
      return {
        ...base,
        particles: {
          number: { value: 140 },
          paint: { fill: { enable: true, color: { value: c.accent } } },
          size: { value: { min: 1, max: 2.2 } },
          opacity: { value: 0.7 },
          links: { enable: true, distance: 200, color: c.accent, opacity: 0.32, width: 1 },
          move: move(0.4),
        },
      };
    case 'stars':
      return {
        ...base,
        particles: {
          number: { value: 220 },
          paint: { fill: { enable: true, color: { value: c.text } } },
          size: { value: { min: 0.5, max: 2 } },
          opacity: { value: { min: 0.15, max: 0.9 }, animation: { enable: !still, speed: 0.6, sync: false } },
          move: move(0.05, { random: true }),
        },
      };
    case 'bubbles':
      return {
        ...base,
        particles: {
          number: { value: 30 },
          paint: { fill: { enable: true, color: { value: c.accent } } },
          size: { value: { min: 4, max: 24 } },
          opacity: { value: { min: 0.05, max: 0.16 } },
          move: move(0.7, { direction: 'top' }),
        },
      };
    case 'shards':
      return {
        ...base,
        particles: {
          number: { value: 18 },
          shape: { type: 'triangle' },
          paint: { fill: { enable: false }, stroke: { width: 1.2, color: { value: [c.accent, c.accent2] } } },
          size: { value: { min: 16, max: 46 } },
          opacity: { value: { min: 0.15, max: 0.35 } },
          rotate: { value: { min: 0, max: 360 }, direction: 'random', animation: { enable: !still, speed: 2 } },
          move: move(0.25),
        },
      };
    default:
      return base;
  }
}

/** Starts an animated background inside `element`; returns the running container to destroy later. */
export async function startParticles(element: HTMLElement, id: BackgroundId, colors: Palette, still: boolean): Promise<Container | undefined> {
  await ready;
  return tsParticles.load({ id: element.id, element, options: optionsFor(id, colors, still) });
}
