import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  const entries = items.filter((e): e is MenuItem | 'divider' => Boolean(e));

  useLayoutEffect(() => {
    if (!open || !button.current || !list.current) return;
    const b = button.current.getBoundingClientRect();
    const h = list.current.offsetHeight;
    const right = window.innerWidth - b.right;
    // Open downward unless that runs off the bottom of the window.
    setPos(b.bottom + 6 + h > window.innerHeight ? { right, bottom: window.innerHeight - b.top + 6 } : { right, top: b.bottom + 6 });
  }, [open]);

  useEffect(() => {
    if (!open) {
      setArmed(null);
      return;
    }
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onResize = () => setOpen(false);
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
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
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="more" size={16} />
      </button>
      {open &&
        createPortal(
          <div ref={list} className="menu" role="menu" style={pos}>
            {entries.map((e, i) =>
              e === 'divider' ? (
                <hr key={i} />
              ) : (
                <button
                  key={i}
                  role={e.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                  aria-checked={e.checked}
                  className={`menu__item ${e.confirm ? 'is-danger' : ''} ${armed === i ? 'is-armed' : ''}`}
                  disabled={e.disabled}
                  onClick={() => {
                    if (e.confirm && armed !== i) return setArmed(i);
                    e.onSelect();
                    if (e.checked === undefined) setOpen(false);
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
