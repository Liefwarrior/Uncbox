import { useEffect, useState } from 'react';

/** Re-renders every second (or minute), lined up with the clock. */
export function useNow(everyMs = 1000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now());
      t = setTimeout(tick, everyMs - (Date.now() % everyMs) + 5);
    };
    t = setTimeout(tick, everyMs - (Date.now() % everyMs) + 5);
    return () => clearTimeout(t);
  }, [everyMs]);
  return now;
}
