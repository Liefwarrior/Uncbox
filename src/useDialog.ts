import { type RefObject, useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'video[controls]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** What Tab can reach inside an element, in order, skipping anything hidden. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[hidden], [inert]') && el.getAttribute('aria-hidden') !== 'true');
}

interface Options {
  /** What gets focus when the dialog opens; the first thing Tab can reach if left out. */
  initial?: () => HTMLElement | null | undefined;
  /** Esc closes it. Handled ahead of the page's own keys, so Esc doesn't also leave stream mode. */
  onEscape?: () => void;
}

/**
 * For a dialog: focus moves in when it opens, Tab and Shift+Tab stay inside it, and focus goes
 * back to whatever opened it when it goes.
 */
export function useDialog(box: RefObject<HTMLElement | null>, { initial, onEscape }: Options = {}) {
  const escape = useRef(onEscape);
  escape.current = onEscape;
  const first = useRef(initial);
  first.current = initial;

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const root = box.current;
    (first.current?.() ?? (root && focusableIn(root)[0]) ?? root)?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape' && escape.current) {
        e.preventDefault();
        e.stopPropagation();
        escape.current();
      }
    };
    const onTab = (e: KeyboardEvent) => {
      const el = box.current;
      if (e.key !== 'Tab' || e.defaultPrevented || !el) return;
      const items = focusableIn(el);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === -1 || at === items.length - 1 ? 0 : at + 1;
      // Only steps in when focus would leave; otherwise the browser's own order is right.
      if ((e.shiftKey && at <= 0) || (!e.shiftKey && (at === -1 || at === items.length - 1))) {
        e.preventDefault();
        items[next].focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keydown', onTab);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keydown', onTab);
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [box]);
}
