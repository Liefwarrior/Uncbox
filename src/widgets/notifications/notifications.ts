import { useEffect, useRef, useState } from 'react';

// Windows notifications, from the Uncbox server (server/widgets.mjs).

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
