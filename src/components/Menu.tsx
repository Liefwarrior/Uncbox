import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCover } from '../native';
import { Icon, type IconName } from './Icon';

export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect: () => void;
  /** Shows a check box; the item toggles something on or off. */
  checked?: boolean;
  /** One choice of several (a dropdown): the chosen one shows a tick. */
  selected?: boolean;
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
export function Menu({
  items,
  label = 'Options',
  trigger,
  align = 'right',
  className = '',
}: {
  items: MenuEntry[];
  label?: string;
  /** What the button shows instead of "⋯": a dropdown shows its current choice. */
  trigger?: ReactNode;
  /** Which edge of the button the list lines up with. */
  align?: 'left' | 'right';
  className?: string;
}) {
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
    const side = align === 'left' ? { left: b.left } : { right: window.innerWidth - b.right };
    // Open downward unless that runs off the bottom of the window.
    setPos(b.bottom + 6 + h > window.innerHeight ? { ...side, bottom: window.innerHeight - b.top + 6 } : { ...side, top: b.bottom + 6 });
  }, [open, align]);

  /** Shuts the menu; keyboard users get focus back on the button they opened it from. */
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus({ preventScroll: true });
  };
  const menuItems = () => [...(list.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [])];

  // The first item takes focus when the menu opens, so arrow keys work straight away.
  useEffect(() => {
    // A dropdown opens on the choice that is made; other menus on their first item.
    if (open) (menuItems().find((i) => i.getAttribute('role') === 'menuitemradio' && i.getAttribute('aria-checked') === 'true') ?? menuItems()[0])?.focus({ preventScroll: true });
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
        className={`${trigger ? 'dropdown__btn' : 'icon-btn'} ${open ? 'on' : ''} ${className}`}
        title={label}
        aria-label={trigger ? undefined : label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger ?? <Icon name="more" size={16} />}
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
                  role={e.selected !== undefined ? 'menuitemradio' : e.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                  aria-checked={e.selected ?? e.checked}
                  tabIndex={-1}
                  className={`menu__item ${e.confirm ? 'is-danger' : ''} ${armed === i ? 'is-armed' : ''}`}
                  disabled={e.disabled}
                  onClick={() => {
                    if (e.confirm && armed !== i) return setArmed(i);
                    e.onSelect();
                    if (e.checked === undefined) close(true);
                  }}
                >
                  {e.selected !== undefined ? (
                    <span className="menu__icon menu__tick">{e.selected && <Icon name="check" size={14} />}</span>
                  ) : e.checked !== undefined ? (
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
