// What the Ping & FPS widget shows, as plain functions: the colour a ping gets, and the line for
// a sparkline. The numbers themselves come from the server (server/netstats.mjs).

export type Tone = 'good' | 'warn' | 'bad';

/** Green under 60 ms, amber under 120, red above (and for a lost ping). */
export function pingTone(ms: number | null): Tone {
  if (ms === null) return 'bad';
  if (ms < 60) return 'good';
  if (ms < 120) return 'warn';
  return 'bad';
}

/** Frame rates: green from 60, amber from 30, red below. */
export function fpsTone(fps: number): Tone {
  if (fps >= 60) return 'good';
  if (fps >= 30) return 'warn';
  return 'bad';
}

export const SPARK_W = 120;
export const SPARK_H = 32;
const SLOTS = 60;

/**
 * A sparkline for up to 60 readings (null is a missing one): the line as SVG path data, with a gap
 * where readings are missing, and the x positions of those gaps. The newest reading sits at the
 * right edge, so a new history fills in from the right.
 */
export function sparkline(values: (number | null)[], { floorMax = 1 } = {}): { path: string; gaps: number[] } {
  const shown = values.slice(-SLOTS);
  const real = shown.filter((v): v is number => v !== null);
  // The scale starts at 0 and never zooms in tighter than floorMax, so a calm line stays low.
  const max = Math.max(floorMax, ...real);
  const step = SPARK_W / (SLOTS - 1);
  const offset = (SLOTS - shown.length) * step;
  const pad = 2;
  const round = (n: number) => Math.round(n * 10) / 10;
  let path = '';
  let pen = false;
  const gaps: number[] = [];
  shown.forEach((v, i) => {
    const x = round(offset + i * step);
    if (v === null) {
      pen = false;
      gaps.push(x);
      return;
    }
    const y = round(SPARK_H - pad - (v / max) * (SPARK_H - pad * 2));
    path += `${pen ? 'L' : 'M'}${x} ${y}`;
    pen = true;
  });
  return { path, gaps };
}
