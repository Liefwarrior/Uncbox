import { useEffect, useMemo, useRef, useState } from 'react';
import { allTags, filterGallery, type GalleryEntry, GALLERY_README_URL, onOpenGallery, previewUrl, useGallery } from '../gallery';
import { useCover } from '../native';
import { downloadPreset, installGalleryPreset } from '../presetio';
import { PRESETS } from '../presets';
import type { AppState } from '../state/model';
import { activePreset, installedFrom } from '../state/presets';
import type { Mutate } from '../state/useAppState';
import { Icon } from './Icon';

interface Props {
  state: AppState;
  mutate: Mutate;
  /** Stream mode shows the dashboard to viewers, so the gallery stays shut. */
  streaming: boolean;
}

/** The preset gallery: an overlay of Uncbox's own, opened from the sidebar or the command palette. */
export function Gallery(props: Props) {
  const [open, setOpen] = useState(false);
  const streaming = useRef(props.streaming);
  streaming.current = props.streaming;
  useEffect(() => onOpenGallery(() => !streaming.current && setOpen(true)), []);
  useEffect(() => {
    if (props.streaming) setOpen(false);
  }, [props.streaming]);
  // The game and the web widgets' pages are real windows in the app and would sit over the gallery.
  useCover(open);
  return open ? <Dialog {...props} onClose={() => setOpen(false)} /> : null;
}

function Dialog({ state, mutate, onClose }: Props & { onClose: () => void }) {
  const { index, error, reload } = useGallery();
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);

  // Put focus back where it was when the gallery goes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    search.current?.focus();
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  // Handled ahead of the page's own keys, so Esc doesn't also leave stream mode.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      close.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const entries = index?.presets ?? [];
  const tags = useMemo(() => allTags(entries), [entries]);
  const shown = useMemo(() => filterGallery(entries, query, tag, (b) => PRESETS[b].name), [entries, query, tag]);
  const { base, def, data } = activePreset(state);

  const install = async (entry: GalleryEntry) => {
    if (busy) return;
    setBusy(entry.id);
    const ok = await installGalleryPreset(entry, state, mutate);
    setBusy(null);
    if (ok) onClose();
  };
  const show = (entry: GalleryEntry) => {
    const have = installedFrom(state.custom, entry);
    if (!have) return;
    mutate((s) => void (s.preset = have.id));
    onClose();
  };

  return (
    <div className="gallery" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gallery__box" role="dialog" aria-label="Preset gallery" aria-modal="true">
        <header className="gallery__head">
          <h2>Preset gallery</h2>
          <p className="muted">Presets other people made. Installing adds a copy to your list; your own presets are never touched.</p>
          <button className="icon-btn gallery__close" onClick={onClose} aria-label="Close the gallery">
            <Icon name="x" size={16} />
          </button>
        </header>

        <div className="gallery__filters">
          <label className="gallery__search">
            <Icon name="search" size={16} />
            <input
              ref={search}
              aria-label="Search presets"
              placeholder="Search presets"
              spellCheck={false}
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {tags.length > 0 && (
            <div className="gallery__tags" role="group" aria-label="Filter by tag">
              <button className={`gallery__chip ${tag === null ? 'on' : ''}`} aria-pressed={tag === null} onClick={() => setTag(null)}>
                All
              </button>
              {tags.map((t) => (
                <button key={t} className={`gallery__chip ${tag === t ? 'on' : ''}`} aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}>
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="gallery__body">
          {error && (
            <div className="gallery__message" role="status">
              <p>{error}</p>
              <button className="btn btn--small" onClick={reload}>
                <Icon name="refresh" size={14} /> Try again
              </button>
            </div>
          )}
          {!error && !index && <p className="gallery__message muted">Loading the gallery…</p>}
          {index?.stale && <p className="gallery__note muted">Can’t reach the gallery right now. Showing the list from your last visit.</p>}
          {index && entries.length === 0 && <p className="gallery__message muted">There are no presets in the gallery yet.</p>}
          {index && entries.length > 0 && shown.length === 0 && <p className="gallery__message muted">Nothing matches that. Try other words or clear the tag.</p>}
          <ul className="gallery__grid">
            {shown.map((entry) => {
              const have = installedFrom(state.custom, entry);
              return (
                <li key={entry.id} className={`gallery-card gallery-card--${entry.base}`}>
                  <div className="gallery-card__preview" aria-hidden={!entry.preview}>
                    {entry.preview ? <img src={previewUrl(entry.id)} alt={`Preview of ${entry.name}`} loading="lazy" /> : <span>{entry.name.slice(0, 1)}</span>}
                  </div>
                  <div className="gallery-card__text">
                    <strong>{entry.name}</strong>
                    <span className="muted">by {entry.author}</span>
                    {entry.description && <p>{entry.description}</p>}
                    <div className="gallery-card__meta">
                      <span className="gallery-card__base">{PRESETS[entry.base].name}</span>
                      {entry.tags.map((t) => (
                        <button key={t} className="gallery-card__tag" onClick={() => setTag(t)} title={`Show only “${t}”`}>
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                  {have ? (
                    <div className="gallery-card__actions">
                      <span className="gallery-card__done">
                        <Icon name="check" size={14} /> Installed
                      </span>
                      <button className="btn btn--small" onClick={() => show(entry)}>
                        Show it
                      </button>
                    </div>
                  ) : (
                    <div className="gallery-card__actions">
                      <button className="btn btn--accent btn--small" disabled={busy !== null} onClick={() => void install(entry)}>
                        <Icon name="download" size={14} /> {busy === entry.id ? 'Installing…' : 'Install'}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        <footer className="gallery__foot">
          <div>
            <strong>Share yours</strong>
            <span className="muted"> Export a preset to get its file, then send it in as described in the guide.</span>
          </div>
          <div className="gallery__foot-actions">
            <button className="btn btn--small" onClick={() => downloadPreset(def.name, base, data)}>
              <Icon name="download" size={14} /> Export this preset
            </button>
            <a className="btn btn--small" href={GALLERY_README_URL} target="_blank" rel="noreferrer">
              <Icon name="external" size={14} /> How to share
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
}
