import { type ReactNode, useId } from 'react';
import type { BoardId } from '../state/model';
import { useBoard } from './Board';
import { Icon } from './Icon';
import { Menu, type MenuEntry } from './Menu';

interface Props {
  id: BoardId;
  title: ReactNode;
  /** Plain-text name for tooltips when the title is an element. */
  label?: string;
  /** Edit controls; hidden in stream mode until the panel is hovered. */
  actions?: ReactNode;
  /** Settings, each with a plain label, under a "⋯" button. */
  menu?: MenuEntry[];
  /** Content fills the panel edge to edge; the header floats over it while editing. */
  bleed?: boolean;
  /** Nothing to show yet (camera off, no channel…). Hidden in stream mode so viewers never see an empty box. */
  empty?: boolean;
  className?: string;
  children: ReactNode;
}

export function Panel({ id, title, label, actions, menu, bleed = false, empty = false, className, children }: Props) {
  const { editing, hide, nudge } = useBoard();
  const heading = useId();
  const name = label ?? (typeof title === 'string' ? title : undefined);
  return (
    <section aria-labelledby={heading} className={`panel panel--${id} ${bleed ? 'panel--bleed' : ''} ${empty ? 'is-empty' : ''} ${className ?? ''}`}>
      <header className="panel__head drag-handle">
        {editing && (
          <span
            className="panel__grip"
            role="button"
            tabIndex={0}
            aria-label={`Move or resize ${name ?? 'panel'}`}
            aria-description="Arrow keys move it one cell. Shift and the arrow keys make it wider, narrower, taller or shorter."
            onKeyDown={(e) => {
              if (e.ctrlKey || e.metaKey || e.altKey) return;
              if (nudge(id, e.key, e.shiftKey)) e.preventDefault();
            }}
          >
            <Icon name="grip" size={14} />
          </span>
        )}
        <h2 id={heading}>{title}</h2>
        <div className="panel__actions ctl">
          {actions}
          {menu && <Menu items={menu} label={`${name ?? 'Panel'} options`} />}
          {editing && (
            <button className="icon-btn" title={`Hide ${name ?? 'panel'}`} aria-label={`Hide ${name ?? 'panel'}`} onClick={() => hide(id, name)}>
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
      </header>
      <div className="panel__body">{children}</div>
    </section>
  );
}
