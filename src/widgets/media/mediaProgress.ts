// The "Now playing" progress bar's arithmetic. The server sends the position now and then; between
// those the page works the rest out from the clock.

export interface Timeline {
  /** Seconds into the track when the reading was taken. */
  position: number;
  /** Seconds; 0 when the app doesn't say (live streams). */
  duration: number;
  playing: boolean;
}

/**
 * Where the track is now: the reading plus the time since it was taken while playing, never past
 * the end. `elapsedMs` is how long ago the reading was taken.
 */
export function interpolatePosition(t: Timeline, elapsedMs: number): number {
  const moved = t.playing ? Math.max(0, elapsedMs) / 1000 : 0;
  const pos = Math.max(0, t.position + moved);
  return t.duration > 0 ? Math.min(pos, t.duration) : pos;
}

/** 0 to 1 along the bar; 0 when the length isn't known. */
export function progressFraction(position: number, duration: number): number {
  return duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
}

/** A click 0 to 1 along the bar → seconds into the track. */
export function seekPosition(fraction: number, duration: number): number {
  return Math.round(Math.min(1, Math.max(0, fraction)) * duration * 10) / 10;
}

/** 75 → "1:15", 3725 → "1:02:05". */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
