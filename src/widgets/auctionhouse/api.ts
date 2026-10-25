import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { listen } from '../../events';
import type { FormulaResult } from './ah';
import type { AhTab } from './settings';

// Talking to the auction house routes (server/wowah.mjs): reading with a hook that fetches again
// when the server says new data arrived, and plain functions for the writes.

export const API = '/api/wow/ah';

/** How often to ask again while the page is showing; the `wowah` event does the rest. */
export const POLL_MS = 60_000;

export interface Where {
  realm: string;
  faction: string;
}

/** What the tabs share: which realm they read, whether gold is hidden, and how to move around. */
export interface AhContextValue {
  /** Counts up with each `wowah` event; reads fetch again when it changes. */
  tick: number;
  where: Where | null;
  hideGold: boolean;
  goTab: (tab: AhTab) => void;
  /** Opens an item's detail in the Search tab. */
  openItem: (item: string) => void;
}

export const AhContext = createContext<AhContextValue>({ tick: 0, where: null, hideGold: false, goTab: () => {}, openItem: () => {} });
export const useAhContext = () => useContext(AhContext);

/** `path` with the realm and faction added to its query, when one was picked. */
export function withWhere(path: string, where: Where | null): string {
  if (!where) return path;
  return `${path}${path.includes('?') ? '&' : '?'}realm=${encodeURIComponent(where.realm)}&faction=${encodeURIComponent(where.faction)}`;
}

/** A query string from the values that are set. */
export function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Re-renders each time the server ingests new auction house data. */
export function useWowahTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => listen('wowah', () => setTick((n) => n + 1)), []);
  return tick;
}

const messageOf = async (r: Response): Promise<string> => {
  const body = await r.json().catch(() => null);
  return body && typeof body.error === 'string' ? body.error : `The server said ${r.status}.`;
};

/** A write (or any request) to the auction house routes; throws the server's own message when it says no. */
export async function ahRequest<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, where: Where | null = null): Promise<T> {
  const r = await fetch(`${API}${withWhere(path, where)}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await messageOf(r));
  return (await r.json().catch(() => ({}))) as T;
}

/** What a price formula comes to for an item. Errors come back in the result, not thrown. */
export async function testFormula(formula: string, item: string | null, where: Where | null): Promise<FormulaResult> {
  try {
    const r = await fetch(`${API}${withWhere('/formula/test', where)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formula, ...(item ? { item } : {}) }),
    });
    const body = await r.json().catch(() => null);
    if (body && typeof body.ok === 'boolean') return body as FormulaResult;
    return { ok: false, error: body && typeof body.error === 'string' ? body.error : `The server said ${r.status}.` };
  } catch {
    return { ok: false, error: 'Couldn’t reach Uncbox.' };
  }
}

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * The JSON at an auction house route, read again when new data arrives, every minute while the
 * page is visible, and when it becomes visible again. `path` is relative to /api/wow/ah and gets
 * the chosen realm unless `scoped` is false. null reads nothing. The last answer stays on screen
 * while the next one loads.
 */
export function useAh<T>(path: string | null, { scoped = true }: { scoped?: boolean } = {}): Loaded<T> {
  const { tick, where } = useAhContext();
  const url = path === null ? null : `${API}${scoped ? withWhere(path, where) : path}`;
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: url !== null });
  const latest = useRef(0);

  const load = useCallback(() => {
    if (!url) return;
    const mine = ++latest.current;
    setState((s) => (s.loading ? s : { ...s, loading: true }));
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(await messageOf(r));
        return (await r.json()) as T;
      })
      .then((data) => {
        if (mine === latest.current) setState({ data, error: null, loading: false });
      })
      .catch((err) => {
        if (mine === latest.current) setState((s) => ({ data: s.data, error: err instanceof Error ? err.message : String(err), loading: false }));
      });
  }, [url]);

  useEffect(() => {
    if (!url) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    load();
  }, [load, url, tick]);

  useEffect(() => {
    if (!url) return;
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const timer = setInterval(() => visible() && load(), POLL_MS);
    const onVisible = () => visible() && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      // An answer still on its way belongs to a view that is gone.
      latest.current++;
    };
  }, [load, url]);

  return { ...state, reload: load };
}

/** Opens an item's Wowhead page in the browser, through the same local route the setup links use. */
export function openWowhead(item: string): void {
  const m = /^i:(\d+)/.exec(item);
  if (!m) return;
  void fetch('/api/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 'wowhead-item', item: Number(m[1]) }),
  }).catch(() => {});
}
