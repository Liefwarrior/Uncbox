import { type RefObject, useLayoutEffect, useState } from 'react';

/**
 * How wide an element is right now, kept up to date as the panel is resized. 0 until it has been
 * measured (and where there is no ResizeObserver), so "narrow" tests should ask for more than 0.
 */
export function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver((entries) => setWidth(Math.round(entries[entries.length - 1].contentRect.width)));
    watch.observe(el);
    return () => watch.disconnect();
  }, [ref]);
  return width;
}
