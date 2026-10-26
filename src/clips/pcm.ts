// The small pure parts of putting sound on a clip, kept apart from the worker so they can be tested:
// lining a clip up with the app's sound by wall-clock time, and the PCM math. Sound is 48 kHz
// stereo, interleaved; times in ms are wall-clock (performance.timeOrigin + performance.now()),
// times in seconds are the capture's own clock, like mediabunny's.

/** Wall-clock milliseconds, the same in the page and in a worker. */
export const wallNow = () => performance.timeOrigin + performance.now();

/**
 * Turns the capture's frame times into wall-clock times. Each frame is seen a little after it was
 * taken, by a different amount each time (the capture is bursty); the least delay seen lately is
 * the closest to the truth, so the offset between the two clocks is kept as that minimum over the
 * last few seconds.
 */
export class ArrivalClock {
  // The smallest offset in each whole second, newest last.
  private buckets: { second: number; min: number }[] = [];

  constructor(private readonly keepSeconds = 10) {}

  /** A frame taken at `timestamp` (seconds, capture clock) was seen at `arrivalMs` (wall clock). */
  add(timestamp: number, arrivalMs: number) {
    const offset = arrivalMs - timestamp * 1000;
    const second = Math.floor(timestamp);
    const last = this.buckets[this.buckets.length - 1];
    if (last && last.second === second) last.min = Math.min(last.min, offset);
    else this.buckets.push({ second, min: offset });
    while (this.buckets.length > this.keepSeconds) this.buckets.shift();
  }

  /** The capture clock restarted: what was learned about the old one no longer applies. */
  reset() {
    this.buckets = [];
  }

  get ready() {
    return this.buckets.length > 0;
  }

  /** When (wall clock, ms) the frame with this capture time was taken. Needs ready. */
  wallMs(timestamp: number): number {
    const offset = Math.min(...this.buckets.map((b) => b.min));
    return timestamp * 1000 + offset;
  }
}

/**
 * The stretch of sound to ask the app for: it started `fromMs` ago and ended `toMs` ago, as of
 * `nowMs`. Both are whole milliseconds, with fromMs > toMs >= 0 (a clip that ended a moment in the
 * future, from a clock that ran ahead, is cut at now).
 */
export function clipWindow(startMs: number, endMs: number, nowMs: number): { fromMs: number; toMs: number } {
  const toMs = Math.max(0, Math.round(nowMs - endMs));
  const fromMs = Math.max(toMs + 1, Math.round(nowMs - startMs));
  return { fromMs, toMs };
}

/** How many frames a stretch of this many seconds is. */
export const framesFor = (seconds: number, rate: number) => Math.max(0, Math.round(seconds * rate));

/**
 * The frames [start, start + frames) of interleaved stereo `pcm`, as a copy. Where the sound is
 * shorter than that, the rest is silence, so every track is exactly as long as the video.
 */
export function sliceFrames(pcm: Int16Array, start: number, frames: number): Int16Array {
  const out = new Int16Array(frames * 2);
  const from = Math.max(0, start) * 2;
  const to = Math.min(pcm.length, (start + frames) * 2);
  if (to > from) out.set(pcm.subarray(from, to), from - start * 2);
  return out;
}

/** 16-bit samples as -1..1 floats. */
export function s16ToF32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}

/** The sum of the tracks, sample by sample, kept within -1..1. All the same length. */
export function mixTracks(tracks: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(tracks[0]?.length ?? 0);
  for (const track of tracks) for (let i = 0; i < out.length; i++) out[i] += track[i];
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i]));
  return out;
}

/** Cuts [0, total) into runs of at most `size`: [start, frames] pairs. */
export function chunks(total: number, size: number): [number, number][] {
  const out: [number, number][] = [];
  for (let at = 0; at < total; at += size) out.push([at, Math.min(size, total - at)]);
  return out;
}
