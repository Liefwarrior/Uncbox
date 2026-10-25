// The numbers behind vertical shorts and Discord copies, kept apart from the encoding so they can
// be tested: where the 9:16 frame sits, how big and how bitrate-heavy a Discord copy can be, and
// what "Last 30 s" means. transcode.ts turns these into an actual video.

/** What a vertical short is saved as. */
export const VERTICAL = { width: 1080, height: 1920, bitrate: 12_000_000, frameRate: 60 } as const;

/** Discord turns away files over 10 MB on normal servers; aim lower, since encoders overshoot a little. */
export const DISCORD_MAX_BYTES = 10_000_000;
const DISCORD_TARGET_BYTES = 9_500_000;
/** Room for the MP4's own bookkeeping, which counts toward the size but is not video. */
const OVERHEAD = 0.96;
const MIN_BITRATE = 250_000;
const MAX_BITRATE = 8_000_000;
/** Below this a Discord copy looks soft; the editor says so, to nudge toward a shorter trim. */
const SOFT_BITRATE = 1_500_000;
/** Discord copies are 720p-class and 30 fps: a clip this size at 1080p60 would be mush. */
const DISCORD_LONG_SIDE = 1280;
const DISCORD_SHORT_SIDE = 720;
export const DISCORD_FRAME_RATE = 30;

export interface Crop {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Video encoders want even sizes. */
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** How wide the 9:16 frame is, as a fraction of a source frame `w` wide and `h` tall. */
export function frameShare(w: number, h: number): number {
  return Math.min(1, even((h * 9) / 16) / w);
}

/**
 * The 9:16 region of a `w` x `h` frame, full height. `position` runs from 0 (against the left
 * edge) to 1 (against the right); 0.5 is centred. 1920 x 1080 gives the 608 x 1080 the short is cut from.
 */
export function verticalCrop(w: number, h: number, position: number): Crop {
  const width = Math.min(w, even((h * 9) / 16));
  const free = w - width;
  const p = Math.min(1, Math.max(0, Number.isFinite(position) ? position : 0.5));
  return { left: Math.min(free, Math.round((p * free) / 2) * 2), top: 0, width, height: h };
}

/** The size of a Discord copy: 720p-class, same orientation, and never bigger than the source. */
export function discordSize(w: number, h: number): { width: number; height: number } {
  const scale = Math.min(1, DISCORD_LONG_SIDE / Math.max(w, h), DISCORD_SHORT_SIDE / Math.min(w, h));
  return { width: even(w * scale), height: even(h * scale) };
}

/** The video bitrate (bits per second) that lets `seconds` of video fit under Discord's limit. */
export function discordBitrate(seconds: number): number {
  const bits = (DISCORD_TARGET_BYTES * OVERHEAD * 8) / Math.max(1, seconds);
  return Math.round(Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, bits)));
}

/** True when a Discord copy of this bitrate will look noticeably soft. */
export const isSoft = (bitrate: number) => bitrate < SOFT_BITRATE;

export interface Trim {
  start: number;
  end: number;
}

/** "Whole clip" (null) or the last `seconds` of a clip `duration` long, in seconds. */
export function lastSeconds(duration: number, seconds: number | null): Trim {
  if (seconds === null || seconds >= duration) return { start: 0, end: duration };
  return { start: duration - seconds, end: duration };
}

/** Keeps a trim inside the clip and at least `gap` seconds long, whichever handle was moved. */
export function clampTrim(trim: Trim, duration: number, moved: 'start' | 'end', gap = 0.5): Trim {
  const g = Math.min(gap, duration);
  if (moved === 'start') {
    const start = Math.min(Math.max(0, trim.start), duration - g);
    return { start, end: Math.max(trim.end, start + g) };
  }
  const end = Math.min(duration, Math.max(trim.end, g));
  return { start: Math.min(Math.max(0, trim.start), end - g), end };
}
