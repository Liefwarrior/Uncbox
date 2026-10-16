import type { ReactNode } from 'react';

interface Props {
  title: string;
  /** Edit controls; hidden in stream mode until the panel is hovered. */
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function Panel({ title, actions, className, children }: Props) {
  return (
    <section className={`panel ${className ?? ''}`}>
      <header className="panel__head">
        <h2>{title}</h2>
        {actions && <div className="panel__actions ctl">{actions}</div>}
      </header>
      <div className="panel__body">{children}</div>
    </section>
  );
}
