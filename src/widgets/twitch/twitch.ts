import { useEffect, useRef, useState } from 'react';
import { listen } from '../../events';
import { uid } from '../../state/model';

// The Twitch widget's side of server/twitch.mjs: whether you're signed in, the stream's latest
// numbers, and the calls that sign in and change the title or category. No token ever gets here.

export interface TwitchStatus {
  configured: boolean;
  signedIn: boolean;
  signingIn: boolean;
  login: string;
  displayName: string;
  error: string;
}

export interface TwitchStream {
  live: boolean;
  viewers: number;
  /** When the stream began (ms since 1970), or 0 offline. */
  startedAt: number;
  title: string;
  game: { id: string; name: string };
  thumbnail: string;
  /** null where Twitch wouldn't say (no subscriptions on a non-affiliate channel). */
  followers: number | null;
  subs: number | null;
  latestFollowers: string[];
  /** Viewer counts, one per read, for this stream so far. */
  samples: number[];
  updatedAt: number;
}

export interface Category {
  id: string;
  name: string;
  boxArt: string;
}

export const TITLE_MAX = 140;
/** How often a shown widget tells the server it's still there; the server polls Twitch while any do. */
const HEARTBEAT_MS = 30_000;

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/twitch/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Something went wrong talking to Twitch.');
  return json as T;
}

export const twitchApi = {
  status: () => call<TwitchStatus>('status'),
  setClientId: (clientId: string) => call<TwitchStatus>('client', { clientId }),
  signIn: () => call<{ userCode: string; verificationUri: string; expiresIn: number }>('signin', {}),
  signOut: () => call<TwitchStatus>('signout', {}),
  save: (change: { title?: string; gameId?: string }) => call<{ snapshot: TwitchStream }>('channel', change),
  categories: (q: string) => call<{ categories: Category[] }>(`categories?q=${encodeURIComponent(q)}`).then((r) => r.categories),
};

export function useTwitchStatus(): TwitchStatus | null {
  const [status, setStatus] = useState<TwitchStatus | null>(null);
  useEffect(() => {
    let alive = true;
    twitchApi
      .status()
      .then((s) => alive && setStatus(s))
      .catch(() => {});
    const stop = listen('twitch', (data) => setStatus(JSON.parse(data)));
    return () => {
      alive = false;
      stop();
    };
  }, []);
  return status;
}

/** The stream's latest numbers while `active`. Showing the widget is what makes the server read Twitch. */
export function useTwitchStream(active: boolean): TwitchStream | null {
  const [stream, setStream] = useState<TwitchStream | null>(null);
  const id = useRef('');
  id.current ||= `tw-${uid()}`;
  useEffect(() => {
    if (!active) {
      setStream(null);
      return;
    }
    const me = id.current;
    let alive = true;
    const watch = () =>
      call<{ snapshot: TwitchStream | null }>('watch', { id: me })
        .then((r) => alive && r.snapshot && setStream(r.snapshot))
        .catch(() => {});
    void watch();
    const beat = setInterval(() => void watch(), HEARTBEAT_MS);
    const stop = listen('twitchstream', (data) => setStream(JSON.parse(data)));
    return () => {
      alive = false;
      clearInterval(beat);
      stop();
      void call('unwatch', { id: me }).catch(() => {});
    };
  }, [active]);
  return stream;
}

/** 3725 s → "1:02:05"; under an hour, "2:05". */
export function uptime(startedAt: number, now: number): string {
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** A line's points ("x,y x,y …") for an SVG polyline of the samples, fitted to the box; '' if there's no line to draw yet. */
export function sparkPoints(samples: number[], width: number, height: number, pad = 2): string {
  if (samples.length < 2) return '';
  const lo = Math.min(...samples);
  const hi = Math.max(...samples);
  const span = hi - lo;
  return samples
    .map((v, i) => {
      const x = (i / (samples.length - 1)) * width;
      // A flat line sits in the middle rather than on the floor.
      const y = span === 0 ? height / 2 : pad + (1 - (v - lo) / span) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/** A count for the header: 1,234 (or a dash where Twitch didn't say). */
export const count = (n: number | null) => (n === null ? '–' : n.toLocaleString());
