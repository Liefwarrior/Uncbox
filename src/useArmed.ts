import { useCallback, useEffect, useState } from 'react';

/**
 * Two-click confirmation for destructive buttons: the first click arms it (show "Reset?"),
 * a second click within a few seconds runs the action. Replaces window.confirm.
 */
export function useArmed(ms = 3000) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), ms);
    return () => clearTimeout(t);
  }, [armed, ms]);
  const trigger = useCallback(
    (action: () => void) => {
      if (armed) {
        setArmed(false);
        action();
      } else setArmed(true);
    },
    [armed],
  );
  return { armed, trigger };
}
