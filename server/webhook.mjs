// The Discord webhook that "Send to Discord" posts clips to. The URL is a secret (anyone holding
// it can post to the channel), so it lives only in data/clips-discord.json on this PC: it is not
// part of the shared state, and the page is only ever told whether one is set and its last four
// characters, never the whole thing.

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Discord turns away files over 10 MB on normal servers. The page aims for 9.5 MB to stay clear. */
export const DISCORD_MAX_BYTES = 10_000_000;

// Exactly what Discord hands out ("Copy Webhook URL"): https, discord.com or discordapp.com, the
// numeric id and the token. No extra host labels, ports, queries or paths, so a pasted URL can't
// point the server at anywhere else.
const WEBHOOK = /^https:\/\/(discord|discordapp)\.com\/api(?:\/v\d{1,2})?\/webhooks\/(\d{17,20})\/([A-Za-z0-9_-]{16,128})$/;

/** The cleaned-up webhook ({ url, hint }), or null when it isn't a Discord webhook URL. */
export function parseWebhook(input) {
  if (typeof input !== 'string') return null;
  const url = input.trim();
  const m = WEBHOOK.exec(url);
  if (!m) return null;
  return { url, hint: `…${m[3].slice(-4)}` };
}

/** Discord's answer in plain words. `retryAfter` is in seconds, from a 429. */
export function discordProblem(status, message = '', retryAfter = 0) {
  if (status === 401 || status === 403 || status === 404) {
    return 'Discord doesn’t accept that webhook any more. It may have been deleted. Add a new one in Clips.';
  }
  if (status === 413) return 'Discord says the clip is too big. Try a shorter trim.';
  if (status === 429) {
    const wait = Math.max(1, Math.ceil(retryAfter));
    return `Discord asks you to slow down. Try again in ${wait} second${wait === 1 ? '' : 's'}.`;
  }
  if (status >= 500) return 'Discord is having trouble right now. Try again in a minute.';
  const said = String(message).trim().slice(0, 200);
  return said ? `Discord said no: ${said}` : `Discord said no (${status}).`;
}

/**
 * Posts one MP4 to the webhook as an attachment and says how it went: { ok: true } or
 * { ok: false, status, error }. `fetchImpl` is only swapped out by the tests.
 */
export async function sendToWebhook(url, bytes, filename, fetchImpl = fetch) {
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ content: 'Clip from Uncbox' }));
  form.append('files[0]', new Blob([bytes], { type: 'video/mp4' }), filename);
  let res;
  try {
    // No redirects: the URL carries the token, so it only ever goes to the host it was typed for.
    res = await fetchImpl(url, { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(90_000) });
  } catch (err) {
    // The error itself is not passed on: some include the URL, and with it the token.
    const timedOut = err?.name === 'TimeoutError';
    return {
      ok: false,
      status: 502,
      error: timedOut ? 'Discord took too long to answer. Try again.' : 'Couldn’t reach Discord. Check your internet connection.',
    };
  }
  if (res.ok) return { ok: true };
  const body = await res.json().catch(() => ({}));
  return { ok: false, status: res.status, error: discordProblem(res.status, body.message, body.retry_after) };
}

/** Where the webhook is kept: one small JSON file in the data folder. */
export function createWebhookStore(dataDir) {
  const file = path.join(dataDir, 'clips-discord.json');
  return {
    /** The saved webhook URL, or '' when there isn't one (or the file was edited into something else). */
    async get() {
      try {
        const saved = JSON.parse(await readFile(file, 'utf8'));
        return parseWebhook(saved?.url)?.url ?? '';
      } catch {
        return '';
      }
    },
    async set(url) {
      await mkdir(dataDir, { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify({ url }), { mode: 0o600 });
      await rename(tmp, file);
    },
    async clear() {
      await unlink(file).catch((err) => {
        if (err.code !== 'ENOENT') throw err;
      });
    },
  };
}
