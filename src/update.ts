import { useEffect, useState } from 'react';

// Whether a newer Uncbox is out (server/update.mjs asks GitHub at most once a day).

export interface UpdateInfo {
  version: string;
  /** The release page, opened in the browser. Nothing is downloaded by itself. */
  url: string;
}

/** The newer release, or null when up to date, offline or unknown: the page never complains. */
export function useUpdate(): UpdateInfo | null {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/update')
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (alive && body?.update?.version && body.update.url) setUpdate(body.update);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return update;
}
