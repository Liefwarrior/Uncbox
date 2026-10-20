import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCover } from '../native';
import { Icon, type IconName } from './Icon';

export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect: () => void;
  /** Shows a check box; the item toggles something on or off. */
  checked?: boolean;
  /** Destructive: the first click changes the label to this, the second runs it. */
  confirm?: string;
  disabled?: boolean;
}

/** Falsy entries are skipped, so items can be written inline as `cond && {...}`. */
export type MenuEntry = MenuItem | 'divider' | false | null | undefined;

/**
 * A "⋯" button with a list of plainly labeled actions. Drawn inside the themed app root (panels
 * clip their content, so it cannot live inside the panel) and placed against the button.
 */
export function Menu({ items, label = 'Options' }: { items: MenuEntry[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState<number | null>(null);
  const [pos, setPos] = useState<CSSProperties>({});
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // An open menu is drawn by the page, so a web widget's real view (in the app) must not cover it.
  useCover(open, true);
  const entries = items.filter((e): e is MenuItem | 'divider' => Boolean(e));

  useLayoutEffect(() => {
    if (!open || !button.current || !list.current) return;
    const b = button.current.getBoundingClientRect();
    const h = list.current.offsetHeight;
    const right = window.innerWidth - b.right;
    // Open downward unless that runs off the bottom of the window.
    setPos(b.bottom + 6 + h > window.innerHeight ? { right, bottom: window.innerHeight - b.top + 6 } : { right, top: b.bottom + 6 });
  }, [open]);

  /** Shuts the menu; keyboard users get focus back on the button they opened it from. */
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus({ preventScroll: true });
  };
  const menuItems = () => [...(list.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [])];

  // The first item takes focus when the menu opens, so arrow keys work straight away.
  useEffect(() => {
    if (open) menuItems()[0]?.focus({ preventScroll: true });
  }, [open]);

  const onListKey = (e: ReactKeyboardEvent) => {
    const items = menuItems();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      e.preventDefault();
      items[(i + items.length) % items.length]?.focus({ preventScroll: true });
    };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? -1 : at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(-1);
    else if (e.key === 'Tab') {
      e.preventDefault();
      close(true);
    }
  };

  useEffect(() => {
    if (!open) {
      setArmed(null);
      return;
    }
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close(true);
    };
    const onResize = () => setOpen(false);
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  if (entries.length === 0) return null;
  const root = document.querySelector('.app') ?? document.body;

  return (
    <>
      <button
        ref={button}
        className={`icon-btn ${open ? 'on' : ''}`}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="more" size={16} />
      </button>
      {open &&
        createPortal(
          <div ref={list} className="menu" role="menu" aria-label={label} style={pos} onKeyDown={onListKey}>
            {entries.map((e, i) =>
              e === 'divider' ? (
                <hr key={i} />
              ) : (
                <button
                  key={i}
                  role={e.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                  aria-checked={e.checked}
                  tabIndex={-1}
                  className={`menu__item ${e.confirm ? 'is-danger' : ''} ${armed === i ? 'is-armed' : ''}`}
                  disabled={e.disabled}
                  onClick={() => {
                    if (e.confirm && armed !== i) return setArmed(i);
                    e.onSelect();
                    if (e.checked === undefined) close(true);
                  }}
                >
                  {e.checked !== undefined ? (
                    <span className={`menu__check ${e.checked ? 'on' : ''}`}>{e.checked && <Icon name="check" size={12} />}</span>
                  ) : (
                    <span className="menu__icon">{e.icon && <Icon name={e.icon} size={15} />}</span>
                  )}
                  {armed === i ? e.confirm : e.label}
                </button>
              ),
            )}
          </div>,
          root,
        )}
    </>
  );
}
