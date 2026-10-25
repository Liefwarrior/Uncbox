import { useEffect, useState } from 'react';

/** The JSON at `url`, asked for again every `everyMs`; null until the first answer (or with no url). */
export function usePoll<T>(url: string | null, everyMs: number): T | null {
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
