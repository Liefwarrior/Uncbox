// When a stream drops (the connection to Twitch broke, FFmpeg stopped), the page starts it again:
// a few seconds later, then a little longer each time, and gives up after five tries in a row.

/** How long to wait before each try, in order. Five tries, then give up. */
export const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000] as const;

/** A stream that stayed up this long counts as working again, so the next drop starts the tries over. */
export const STEADY_MS = 60_000;

/** The wait before the next try, given how many tries in a row have been made (0 before the first); null means give up. */
export function retryDelayMs(triesSoFar: number): number | null {
  return RETRY_DELAYS_MS[triesSoFar] ?? null;
}

/** The tries counted in a row after a drop, given how long the stream had been live before it. */
export function triesAfterDrop(triesSoFar: number, liveMs: number): number {
  return liveMs >= STEADY_MS ? 0 : triesSoFar;
}
