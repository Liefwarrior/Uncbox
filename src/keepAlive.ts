// Some of the server's helpers (the music reader, the OBS connection, the Steam reader) only run
// while a widget on the page is using them, and stop about a minute and a half after the last ask.
// A widget that is showing asks again every so often to keep its helper running; it ignores the
// answer, since changes arrive as events.

/** How often a showing widget asks again. The server waits three times as long before it stops. */
export const KEEP_ALIVE_MS = 30_000;

/** Asks `url` every KEEP_ALIVE_MS until the returned function is called. */
export function keepAlive(url: string, everyMs = KEEP_ALIVE_MS): () => void {
  const id = setInterval(() => {
    fetch(url).catch(() => {});
  }, everyMs);
  return () => clearInterval(id);
}
