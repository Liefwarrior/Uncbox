import { markToolsChecked, readStatus, setStreamStatus } from './status';

// The page's calls to the server's streaming routes (server/stream.mjs). Each answer is the
// whole status, which is shared with everything that shows it. Every call resolves to '' when it
// worked, or to what to tell the person.

const unreachable = 'Couldn’t reach Uncbox. Is it still running?';

async function post(route: string, body: unknown = {}): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(`/api/stream${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const status = readStatus(data);
    if (res.ok && status) setStreamStatus(status);
    return { ok: res.ok, data };
  } catch {
    return { ok: false, data: { error: unreachable } };
  }
}

const problem = (data: Record<string, unknown>, fallback: string) => (typeof data.error === 'string' && data.error ? data.error : fallback);

export interface StartBody {
  audioPipe?: string;
  test: boolean;
  settings: { screen: number; fps: number; height: number; kbps: number };
}

export async function startStream(body: StartBody): Promise<string> {
  const { ok, data } = await post('/start', body);
  return ok ? '' : problem(data, 'Couldn’t start the stream.');
}

export async function stopStream(): Promise<string> {
  const { ok, data } = await post('/stop');
  return ok ? '' : problem(data, 'Couldn’t end the stream.');
}

/** Saves a pasted key; an empty one forgets it. */
export async function saveStreamKey(key: string): Promise<string> {
  const { ok, data } = await post('/key', { key });
  return ok ? '' : problem(data, 'Couldn’t save the key.');
}

/** Reads the key from the Twitch sign-in. */
export async function streamKeyFromTwitch(): Promise<string> {
  const { ok, data } = await post('/key/twitch');
  if (ok) return '';
  if (data.code === 'needs-signin') return 'Sign in to Twitch again so Uncbox can read your stream key.';
  if (data.code === 'not-signed-in') return 'Sign in to Twitch first, in a Twitch widget, then try again.';
  return problem(data, 'Couldn’t get the key from Twitch.');
}

/** Looks for FFmpeg and NVENC on this PC. `force` looks again even if it has already looked. */
export async function checkStreamTools(force = false): Promise<void> {
  const { ok } = await post('/check', { force });
  if (ok) markToolsChecked();
}
