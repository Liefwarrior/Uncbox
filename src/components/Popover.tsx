import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCover } from '../native';
import { focusableIn } from '../useDialog';
import { Icon } from './Icon';

interface Props {
  /** What the list is ("Game"): names the button and the list for a screen reader. */
  label: string;
  /** In words, what is picked right now. The button is read as "label: current". */
  current: string;
  /** What the button shows; the chevron is added. */
  trigger: ReactNode;
  className?: string;
  /** The list. Mark what the arrow keys visit with `data-nav` and what is picked with `aria-current="true"`. */
  children: (close: () => void) => ReactNode;
}

/**
 * A button that opens a short list under it, for picking one thing out of several. Drawn inside the
 * themed app root (the sidebar scrolls and clips), as wide as the button. Arrows, Home and End move
 * through the `data-nav` items, Tab stays inside, Esc or a click outside shuts it, and focus goes
 * back to the button. The list is plain buttons, so a row can carry its own "⋯" menu beside it.
 */
export function Popover({ label, current, trigger, className = '', children }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  // An open list is drawn by the page, so a web widget's real view (in the app) must not cover it.
  useCover(open, true);

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const b = button.current.getBoundingClientRect();
    setPos({ left: b.left, width: b.width, top: b.bottom + 4, maxHeight: Math.max(180, window.innerHeight - b.bottom - 16) });
  }, [open]);

  /** Shuts the list; focus goes back on the button it was opened from. */
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus({ preventScroll: true });
  };
  const items = () => [...(panel.current?.querySelectorAll<HTMLElement>('[data-nav]:not(:disabled)') ?? [])];

  // The picked item takes focus (else the first), so Enter and the arrows work straight away.
  useEffect(() => {
    if (!open) return;
    const all = items();
    (all.find((el) => el.getAttribute('aria-current') === 'true') ?? all[0])?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      // A row's own menu is drawn outside the list but is part of it.
      if (button.current?.contains(t) || panel.current?.contains(t) || (t as Element).closest?.('.menu')) return;
      close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      const t = e.target;
      // A row's menu or rename box deals with its own Esc first.
      if (document.querySelector('.menu') || (t instanceof Element && t.closest('input'))) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    const onScroll = (e: Event) => {
      if (!panel.current?.contains(e.target as Node)) close(false);
    };
    const onResize = () => close(false);
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  // A row that goes away (a deleted preset) takes focus with it; arrows bring it back.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || (document.activeElement && document.activeElement !== document.body)) return;
      e.preventDefault();
      items()[0]?.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const onPanelKey = (e: ReactKeyboardEvent) => {
    if ((e.target as Element).closest('input')) return;
    const nav = items();
    const at = nav.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      e.preventDefault();
      nav[(i + nav.length) % nav.length]?.focus({ preventScroll: true });
    };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? -1 : at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(-1);
    else if (e.key === 'Tab' && panel.current) {
      // Stays inside: the last item wraps to the first.
      const all = focusableIn(panel.current);
      const i = all.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey ? i <= 0 : i === all.length - 1) {
        e.preventDefault();
        all[e.shiftKey ? all.length - 1 : 0]?.focus();
      }
    }
  };

  const root = document.querySelector('.app') ?? document.body;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`popover__trigger ${className} ${open ? 'is-open' : ''}`}
        aria-label={`${label}: ${current}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="popover__label">{trigger}</span>
        <span className="popover__chevron">
          <Icon name="chevronDown" size={16} />
        </span>
      </button>
      {open &&
        createPortal(
          <div ref={panel} id={id} className="popover__panel" role="group" aria-label={label} style={pos} onKeyDown={onPanelKey}>
            {children(close)}
          </div>,
          root,
        )}
    </>
  );
}
