import { useEffect, useRef, useState } from 'react';
import { listen } from '../events';
import type { WidgetSettings } from '../state/model';
import { interpolatePosition } from './mediaProgress';

// Live data for the widgets, from the Uncbox server (server/widgets.mjs) or, for the weather,
// straight from Open-Meteo (free, no account; only the chosen place's coordinates are sent).

function usePoll<T>(url: string | null, everyMs: number): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    const load = () =>
      fetch(url)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => alive && d && setData(d))
        .catch(() => {});
    load();
    const t = setInterval(load, everyMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [url, everyMs]);
  return data;
}

export interface SystemStats {
  cpu: number;
  memory: { used: number; total: number };
  gpu: { name: string; load: number; temp: number; used: number; total: number } | null;
}

export const useSystem = () => usePoll<SystemStats>('/api/system', 2000);

export interface Media {
  playing: boolean;
  app?: string;
  title?: string;
  artist?: string;
  album?: string;
  /** The cover's version (see mediaArtUrl), or '' when there isn't one. */
  art?: string;
  /** Seconds into the track when it was read, and how long ago that was when the page got it. */
  position?: number;
  age?: number;
  /** Seconds; 0 when unknown. */
  duration?: number;
  /** Which buttons the playing app allows. */
  controls?: { playPause: boolean; next: boolean; previous: boolean; seek: boolean };
}

/** A reading plus when this page got it, so the progress bar can carry on from there. */
export type MediaNow = Media & { receivedAt: number };

export const mediaArtUrl = (version: string) => `/api/media/art?v=${encodeURIComponent(version)}`;

export function useMedia(): MediaNow | null {
  const [media, setMedia] = useState<MediaNow | null>(null);
  useEffect(() => {
    let alive = true;
    const take = (m: Media) => alive && setMedia({ ...m, receivedAt: performance.now() });
    // The first ask starts the server's reader; after that, changes arrive as events.
    fetch('/api/media')
      .then((r) => r.json())
      .then(take)
      .catch(() => {});
    const stop = listen('media', (data) => take(JSON.parse(data)));
    return () => {
      alive = false;
      stop();
    };
  }, []);
  return media;
}

export interface PingStats {
  host: string;
  /** Milliseconds for the newest ping, or null when it was lost. */
  last: number | null;
  avg: number | null;
  jitter: number;
  /** Percent of the last 60 pings that were lost. */
  loss: number;
  history: (number | null)[];
}

export interface GameStats {
  name: string;
  fps: number;
  /** The 1% low frame rate over the last 60 seconds. */
  fpsLow: number | null;
  fpsHistory: number[];
  gpuMs: number | null;
  /** The game's own ping, or null when it has no server connection. */
  ping: number | null;
  pingHistory: (number | null)[];
}

interface NetstatsEvent {
  targets: Record<string, PingStats>;
  router: PingStats | null;
  game: GameStats | null;
}

export interface Netstats {
  ping: PingStats | null;
  router: PingStats | null;
  game: GameStats | null;
}

/**
 * Live ping and frame rate. Asking the server every few seconds is what keeps it measuring; it
 * stops by itself soon after the last widget goes away. The numbers arrive as "netstats" events.
 */
export function useNetstats(s: WidgetSettings): { stats: Netstats | null; error: string } {
  const [stats, setStats] = useState<Netstats | null>(null);
  const [error, setError] = useState('');
  const target = s.pingTarget.trim();
  const router = s.showRouter;

  useEffect(() => {
    let alive = true;
    let key = '';
    const apply = (e: NetstatsEvent) => setStats({ ping: e.targets[key] ?? null, router: e.router, game: e.game });
    const ask = async () => {
      try {
        const r = await fetch(`/api/netstats?target=${encodeURIComponent(target)}&router=${router ? 1 : 0}`);
        const d = await r.json();
        if (!alive) return;
        if (!r.ok) return setError(d.error || 'Ping is unavailable.');
        setError('');
        key = d.key;
        apply(d);
      } catch {
        // Server restarting; the next ask tries again.
      }
    };
    void ask();
    const t = setInterval(ask, 5000);
    const stop = listen('netstats', (data) => alive && key && apply(JSON.parse(data)));
    return () => {
      alive = false;
      clearInterval(t);
      stop();
    };
  }, [target, router]);
  return { stats, error };
}

export type MediaAction = 'toggle' | 'next' | 'previous' | 'seek';

/** Presses a button on the music playing on this PC. The next reading shows the result. */
export function sendMediaControl(action: MediaAction, position?: number): void {
  fetch('/api/media/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, position }),
  }).catch(() => {});
}

/** Where the track is now, redrawn a few times a second while it plays. */
export function useMediaPosition(m: MediaNow): number {
  const at = () =>
    interpolatePosition({ position: m.position ?? 0, duration: m.duration ?? 0, playing: m.playing }, (m.age ?? 0) + performance.now() - m.receivedAt);
  const [position, setPosition] = useState(at);
  useEffect(() => {
    setPosition(at);
    if (!m.playing) return;
    const t = setInterval(() => setPosition(at), 250);
    return () => clearInterval(t);
    // at() reads m, which these cover.
  }, [m.position, m.age, m.duration, m.playing, m.receivedAt]);
  return position;
}

export interface Toast {
  id: number;
  app: string;
  title: string;
  body: string;
  at: number;
}

const KEEP = 4;
/** Notifications older than this when the widget appears are left out, so it starts clean. */
const FRESH_MS = 5 * 60_000;

export function useNotifications(apps: string): { toasts: Toast[]; error: string } {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [error, setError] = useState('');
  const after = useRef(0);
  const since = useRef(Date.now() - FRESH_MS);
  const wanted = apps
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  const key = wanted.join(',');

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/notifications?after=${after.current}`);
        const d = await r.json();
        if (!alive) return;
        if (!r.ok) return setError(d.error || 'Notifications are unavailable.');
        setError('');
        const fresh = (d.notifications as Toast[]).filter((t) => t.at >= since.current);
        if (d.notifications.length) after.current = Math.max(after.current, ...d.notifications.map((t: Toast) => t.id));
        const mine = fresh.filter((t) => !wanted.length || wanted.some((w) => t.app.toLowerCase().includes(w)));
        if (mine.length) setToasts((old) => [...mine.sort((a, b) => b.id - a.id), ...old].slice(0, KEEP));
      } catch {
        // Server restarting; the next poll tries again.
      }
    };
    void load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // wanted is read through key.
  }, [key]);
  return { toasts, error };
}

// ---- weather ----

export interface Place {
  name: string;
  lat: number;
  lon: number;
}

/** "Austin" → the best match, as "Austin, Texas, United States". */
export async function findPlace(query: string): Promise<Place | null> {
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(query)}`);
  const d = await r.json();
  const p = d.results?.[0];
  if (!p) return null;
  return { name: [p.name, p.admin1, p.country].filter(Boolean).join(', '), lat: p.latitude, lon: p.longitude };
}

export interface Weather {
  temp: number;
  high: number;
  low: number;
  code: number;
  day: boolean;
}

export function useWeather(s: WidgetSettings): Weather | null {
  const url =
    s.lat || s.lon
      ? `https://api.open-meteo.com/v1/forecast?latitude=${s.lat}&longitude=${s.lon}&current=temperature_2m,weather_code,is_day` +
        `&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto&temperature_unit=${s.celsius ? 'celsius' : 'fahrenheit'}`
      : null;
  const d = usePoll<{
    current: { temperature_2m: number; weather_code: number; is_day: number };
    daily: { temperature_2m_max: number[]; temperature_2m_min: number[] };
  }>(url, 15 * 60_000);
  if (!d?.current) return null;
  return {
    temp: Math.round(d.current.temperature_2m),
    high: Math.round(d.daily.temperature_2m_max[0]),
    low: Math.round(d.daily.temperature_2m_min[0]),
    code: d.current.weather_code,
    day: d.current.is_day === 1,
  };
}

/** WMO weather codes, as Open-Meteo reports them, in words and a symbol. */
export function describeWeather(code: number, day: boolean): [string, string] {
  if (code === 0) return ['Clear', day ? '☀️' : '🌙'];
  if (code <= 2) return ['Partly cloudy', day ? '⛅' : '☁️'];
  if (code === 3) return ['Cloudy', '☁️'];
  if (code <= 48) return ['Fog', '🌫️'];
  if (code <= 57) return ['Drizzle', '🌦️'];
  if (code <= 67) return ['Rain', '🌧️'];
  if (code <= 77) return ['Snow', '❄️'];
  if (code <= 82) return ['Showers', '🌧️'];
  if (code <= 86) return ['Snow showers', '🌨️'];
  return ['Thunderstorms', '⛈️'];
}
