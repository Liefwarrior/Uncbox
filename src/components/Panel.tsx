import type { ReactNode } from 'react';
import type { BoardId } from '../state/model';
import { useBoard } from './Board';
import { Icon } from './Icon';

interface Props {
  id: BoardId;
  title: ReactNode;
  /** Plain-text name for tooltips when the title is an element. */
  label?: string;
  /** Edit controls; hidden in stream mode until the panel is hovered. */
  actions?: ReactNode;
  /** Content fills the panel edge to edge; the header floats over it while editing. */
  bleed?: boolean;
  className?: string;
  children: ReactNode;
}

export function Panel({ id, title, label, actions, bleed = false, className, children }: Props) {
  const { editing, hide } = useBoard();
  return (
    <section className={`panel panel--${id} ${bleed ? 'panel--bleed' : ''} ${className ?? ''}`}>
      <header className="panel__head drag-handle">
        {editing && (
          <span className="panel__grip" aria-hidden="true">
            <Icon name="grip" size={14} />
          </span>
        )}
        <h2>{title}</h2>
        <div className="panel__actions ctl">
          {actions}
          {editing && (
            <button className="icon-btn" title={`Hide ${label ?? (typeof title === 'string' ? title : 'panel')}`} onClick={() => hide(id)}>
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
      </header>
      <div className="panel__body">{children}</div>
    </section>
  );
}
