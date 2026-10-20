import { useEffect, useMemo, useRef, useState } from 'react';
import { callOut } from '../callout';
import { revealClip, saveClip, useClips, watchClip } from '../clips/replay';
import { Icon } from '../components/Icon';
import { openGallery } from '../gallery';
import { useCover } from '../native';
import { obsAction, useObs } from '../obs';
import type { AppState } from '../state/model';
import type { Mutate, MutatePreset } from '../state/useAppState';
import { showNotice } from '../undo';
import { requestWebOpen } from '../web';
import { primeAudio } from '../widgets/chime';
import { type DriveFile, openFile, searchDriveFiles } from '../widgets/drive';
import { DRIVE_FEATURE, hasGoogleScopes, useGoogle } from '../widgets/google';
import { launchTile, useTiles } from '../widgets/launcher';
import { arrange, buildCommands, DRIVE_MIN_QUERY, type PaletteActions, type PaletteContext, type Row } from './commands';
import { opensPalette } from './keys';
import { bump, loadRecent, saveRecent } from './recent';

const OPEN_EVENT = 'uncbox:palette';

/** Opens the palette from a button (the sidebar's hint). */
export function openPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

interface Props {
  state: AppState;
  mutate: Mutate;
  mutatePreset: MutatePreset;
  /** Stream mode shows the dashboard to viewers, so the palette stays shut. */
  streaming: boolean;
  onToggleStream: () => void;
}

/** Ctrl+K: a search box over everything Uncbox can do. */
export function Palette(props: Props) {
  const [open, setOpen] = useState(false);
  const { playing } = useClips();
  // Kept in a ref, so the key listener is added once.
  const blocked = useRef(false);
  blocked.current = props.streaming || Boolean(playing);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!opensPalette(e, e.target)) return;
      e.preventDefault();
      setOpen((was) => (was ? false : !blocked.current));
    };
    const onOpen = () => !blocked.current && setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);
  useEffect(() => {
    if (props.streaming) setOpen(false);
  }, [props.streaming]);

  // The game and the web widgets' pages are real windows in the app and would sit over the palette.
  useCover(open);
  return open ? <Dialog {...props} onClose={() => setOpen(false)} /> : null;
}

/** Live Drive results for what's typed, a moment after typing stops. Nothing is asked below three letters. */
function useDriveResults(query: string, enabled: boolean): DriveFile[] {
  const text = query.trim();
  const [found, setFound] = useState<{ text: string; files: DriveFile[] } | null>(null);
  useEffect(() => {
    if (!enabled || text.length < DRIVE_MIN_QUERY) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      searchDriveFiles(text, abort.signal)
        .then((files) => setFound({ text, files }))
        .catch(() => {});
    }, 300);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [text, enabled]);
  return found?.text === text ? found.files : [];
}

function Dialog({ state, mutate, mutatePreset, onToggleStream, onClose }: Props & { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [recent] = useState(loadRecent);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const clips = useClips();
  const tiles = useTiles();
  const { status } = useGoogle();
  // Drive's own access, not every Google widget's: a Calendar not yet allowed shouldn't hide Drive.
  const signedIn = Boolean(status?.signedIn && hasGoogleScopes(status, DRIVE_FEATURE.scopes));
  const results = useDriveResults(query, signedIn);
  // Reading OBS is what makes the server connect to it, so only where a widget already does.
  const usesObs = [...Object.values(state.presets), ...state.custom.map((c) => c.data)].some((d) => d.widgets.some((w) => w.type === 'obs'));
  const obs = useObs(usesObs);

  const actions: PaletteActions = useMemo(
    () => ({
      saveClip: () => void saveClip(),
      watchClip,
      revealClips: () => revealClip(),
      launchTile: (tile) => void launchTile(tile.id).catch((err) => showNotice(err instanceof Error ? err.message : `Couldn’t open ${tile.name}.`)),
      openDriveFile: (file) => openFile(file, 'cloud'),
      obs: (action) => void obsAction(action).then((problem) => problem && showNotice(problem)),
      openWeb: requestWebOpen,
      primeAudio,
      callOut,
      toggleStream: onToggleStream,
      browsePresets: openGallery,
    }),
    [onToggleStream],
  );

  const ctx: PaletteContext = {
    state,
    mutate,
    mutatePreset,
    query,
    clips,
    tiles,
    drive: { signedIn, results },
    obs,
    actions,
    now: Date.now(),
  };
  const sections = arrange(buildCommands(ctx), query, recent);
  const rows = sections.flatMap((s) => s.rows);
  const at = Math.min(active, rows.length - 1);

  // Put focus back where it was when the palette goes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [at, query]);

  const run = (row: Row | undefined) => {
    if (!row) return;
    const { command } = row;
    onClose();
    if (command.live === undefined) saveRecent(bump(recent, command.id));
    command.run();
  };

  /** The first row of the next heading (or the previous one), wrapping around. */
  const jumpGroup = (by: 1 | -1) => {
    if (rows.length === 0) return;
    const firsts: number[] = [];
    let n = 0;
    for (const s of sections) {
      firsts.push(n);
      n += s.rows.length;
    }
    const current = firsts.filter((i) => i <= at).length - 1;
    // Going back from the middle of a heading goes to its own first row.
    const target = by === -1 && firsts[current] < at ? current : (current + by + firsts.length) % firsts.length;
    setActive(firsts[target]);
  };

  // Everything is handled here, ahead of the page's own keys: Esc must not also leave stream
  // mode, and arrows must not scroll the board.
  const key = useRef<(e: KeyboardEvent) => void>(undefined);
  key.current = (e) => {
    if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    const swallow = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === 'Escape') {
      swallow();
      onClose();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      swallow();
      if (rows.length > 0) setActive((at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
    } else if (e.key === 'Tab') {
      swallow();
      jumpGroup(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Enter') {
      swallow();
      run(rows[at]);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => key.current?.(e);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  let index = -1;
  return (
    <div className="palette" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette__box" role="dialog" aria-label="Command palette" aria-modal="true">
        <div className="palette__search">
          <Icon name="search" size={16} />
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={rows.length > 0 ? `palette-row-${at}` : undefined}
            aria-label="Search commands"
            placeholder="Type a command, a web address, or something to search for"
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette__list" id="palette-list" role="listbox" ref={list}>
          {rows.length === 0 && <p className="palette__empty muted">Nothing matches “{query.trim()}”.</p>}
          {sections.map((section) => (
            <div key={section.group} role="group" aria-label={section.group}>
              <h4 className="palette__heading">{section.group}</h4>
              {section.rows.map((row) => {
                const i = ++index;
                return (
                  <PaletteRow
                    key={row.command.id}
                    id={`palette-row-${i}`}
                    row={row}
                    selected={i === at}
                    onHover={() => setActive(i)}
                    onRun={() => run(row)}
                  />
                );
              })}
            </div>
          ))}
        </div>
        <footer className="palette__foot muted">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>Enter</kbd> run
          </span>
          <span>
            <kbd>Tab</kbd> next heading
          </span>
        </footer>
      </div>
    </div>
  );
}

function PaletteRow({ id, row, selected, onHover, onRun }: { id: string; row: Row; selected: boolean; onHover: () => void; onRun: () => void }) {
  const { command } = row;
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      className={`palette__row ${selected ? 'is-active' : ''}`}
      // Keeps the typing focus in the search box.
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={() => !selected && onHover()}
      onClick={onRun}
    >
      <span className="palette__icon">{command.icon && <Icon name={command.icon} size={16} />}</span>
      <span className="palette__title">
        <Highlighted text={command.title} positions={row.positions} />
      </span>
      {command.detail && <span className="palette__detail muted">{command.detail}</span>}
      {command.shortcut && <kbd>{command.shortcut}</kbd>}
    </div>
  );
}

/** The title with the letters the search matched in bold. */
function Highlighted({ text, positions }: { text: string; positions: number[] }) {
  if (positions.length === 0) return <>{text}</>;
  const hit = new Set(positions);
  const parts: { text: string; hit: boolean }[] = [];
  [...text].forEach((ch, i) => {
    const last = parts[parts.length - 1];
    if (last && last.hit === hit.has(i)) last.text += ch;
    else parts.push({ text: ch, hit: hit.has(i) });
  });
  return (
    <>
      {parts.map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : p.text))}
    </>
  );
}

/** The small "Ctrl K" button in the sidebar. */
export function PaletteHint() {
  return (
    <button className="palette-hint" onClick={openPalette} title="Search everything Uncbox can do">
      <Icon name="search" size={14} /> Search commands <kbd>Ctrl K</kbd>
    </button>
  );
}
