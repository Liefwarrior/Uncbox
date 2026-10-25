import { type ReactNode, useEffect, useId, useState } from 'react';
import { Icon } from './Icon';

// The sidebar's folding sections: a heading that is a button, a chevron, and a body that is shut
// until you open it. Whether each is open is remembered in localStorage (on this PC, in this
// browser); without storage they simply start shut.

const KEY = (id: string) => `uncbox.sidebar.${id}`;
const OPEN_EVENT = 'uncbox:open-section';

/** What was saved for a section: true (open), false (shut), or null if you never touched it. */
export function readOpen(id: string): boolean | null {
  try {
    const v = window.localStorage.getItem(KEY(id));
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

function saveOpen(id: string, open: boolean) {
  try {
    window.localStorage.setItem(KEY(id), open ? '1' : '0');
  } catch {
    // No storage (private window, blocked): the section works, it just won't be remembered.
  }
}

/** Opens a section from elsewhere (the command palette's "Add an automation" needs its editor showing). */
export function openSection(id: string) {
  saveOpen(id, true);
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }));
}

interface Props {
  /** Names the section for remembering open/closed. */
  id: string;
  title: string;
  /** A few words after the title ("3 of 4"). */
  meta?: string;
  /** Open when you have not chosen either way. */
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * A heading you can fold. The content stays on the page while shut (just hidden), so whatever
 * it keeps running (listening for a key, waiting on the game) carries on.
 */
export function Section({ id, title, meta, defaultOpen = false, children }: Props) {
  const body = useId();
  const [chosen, setChosen] = useState<boolean | null>(() => readOpen(id));
  const open = chosen ?? defaultOpen;

  useEffect(() => {
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<string>).detail === id) setChosen(true);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [id]);

  const toggle = () => {
    setChosen(!open);
    saveOpen(id, !open);
  };

  return (
    <section className={`fold ${open ? 'is-open' : ''}`}>
      <h3 className="fold__head">
        <button type="button" className="fold__btn" aria-expanded={open} aria-controls={body} onClick={toggle}>
          <span className="fold__title">{title}</span>
          {meta && <span className="fold__meta">{meta}</span>}
          <span className="fold__chevron">
            <Icon name="chevronDown" size={14} />
          </span>
        </button>
      </h3>
      <div id={body} className="fold__body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
