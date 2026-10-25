import { useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { callOut } from '../callout';
import { addWidgetTo, type Removed, removeFromBoard, restoreToBoard, setPanelShown } from '../layout';
import { useCover } from '../native';
import type { BoardId, PresetData } from '../state/model';
import type { ActivePreset } from '../state/presets';
import type { MutatePreset } from '../state/useAppState';
import { offerUndo } from '../undo';
import { useDialog } from '../useDialog';
import { type LibrarySection, librarySections, matchesQuery } from '../widgets/library';
import { boardDef, boardTitle, newWidget, panelTitle, WIDGETS } from '../widgets/registry';
import { CATEGORIES, type AnyWidgetDef, type Category, isSingle } from '../widgets/types';
import { Icon } from './Icon';

interface Props {
  active: ActivePreset;
  mutatePreset: MutatePreset;
}

/** "On screen": what is on this preset's board. Show points at a panel; the × takes it off, with Undo. */
export function OnScreen({ active, mutatePreset }: Props) {
  const { def: preset, data } = active;
  const rows = data.layout.flatMap((item) => {
    const def = boardDef(item.i, data.widgets);
    return def ? [{ id: item.i, def, title: boardTitle(preset, item.i, data.widgets) }] : [];
  });

  const remove = (id: BoardId, title: string) => {
    let removed: Removed = {};
    mutatePreset((d) => void (removed = removeFromBoard(d, id)));
    offerUndo(`${title} hidden`, () => mutatePreset((d) => restoreToBoard(d, id, removed)));
  };

  if (rows.length === 0) return <p className="hint">Nothing yet. Add something with Get More Widgets.</p>;
  return (
    <ul className="onscreen">
      {rows.map(({ id, def, title }) => (
        <li key={id} className="onscreen__row">
          <span className="onscreen__icon">
            <Icon name={def.icon} />
          </span>
          <button className="onscreen__name" title={`Point at ${title}`} onClick={() => callOut(id)}>
            {title}
            <small>{def.hint}</small>
          </button>
          <button className="icon-btn" title={`Take ${title} off the board`} aria-label={`Remove ${title}`} onClick={() => remove(id, title)}>
            <Icon name="x" size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** How many of a kind are on the board (a single panel is 0 or 1). */
function countOf(data: PresetData, def: AnyWidgetDef) {
  return isSingle(def) ? data.layout.filter((item) => item.i === def.kind).length : data.widgets.filter((w) => w.kind === def.kind).length;
}

/**
 * The library for what is typed and picked. A single panel goes by the name this preset gives it
 * on the board ("Build" for SMITE's slots), so searching for "build" finds it; its plain name still
 * works too.
 */
export function librarySectionsFor(opts: { query: string; category: Category | null; active: ActivePreset }): LibrarySection[] {
  const { query, category, active } = opts;
  const found = librarySections({ query, category, preset: active.base, presetName: active.def.name });
  if (!query.trim()) return found;
  const have = new Set(found.flatMap((s) => s.defs));
  const byTitle = WIDGETS.filter(
    (def) => isSingle(def) && !have.has(def) && (!category || def.category === category) && matchesQuery({ ...def, name: panelTitle(active.def, def.kind) }, query),
  );
  if (byTitle.length === 0) return found;
  // Back in the library's own order.
  const all = new Set([...have, ...byTitle]);
  return [{ title: '', defs: WIDGETS.filter((def) => all.has(def)) }];
}

interface BodyProps extends Props {
  /** Called after something is added or pointed at, so the window it is in can shut. */
  onDone?: () => void;
}

/**
 * "Get More Widgets": every kind of panel and widget there is, to search, filter by category and
 * add. The preset's recommended ones come first. A panel there can only be one of (or a widget marked
 * `onlyOne`) shows "Show" once it is on the board; other widgets can be added again and again.
 */
export function WidgetLibrary({ active, mutatePreset, onDone }: BodyProps) {
  const { def: preset, data } = active;
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category | null>(null);
  const sections = useMemo(() => librarySectionsFor({ query, category, active }), [query, category, active]);

  const add = (def: AnyWidgetDef) => {
    if (isSingle(def)) {
      mutatePreset((d) => setPanelShown(d, def.kind, true));
      callOut(def.kind);
    } else {
      const w = newWidget(def.kind);
      mutatePreset((d) => addWidgetTo(d, w));
      callOut(w.id);
    }
    onDone?.();
  };

  return (
    <div className="lib">
      <div className="lib__filters">
        <label className="lib__search">
          <Icon name="search" size={14} />
          <input type="search" aria-label="Search widgets" value={query} placeholder="Search widgets" onChange={(e) => setQuery(e.target.value)} />
        </label>
        <select className="lib__category" aria-label="Category" value={category ?? ''} onChange={(e) => setCategory((e.target.value || null) as Category | null)}>
          <option value="">All categories</option>
          {CATEGORIES.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      {sections.length === 0 && <p className="hint">Nothing matches that.</p>}
      {sections.map((section) => (
        <section key={section.title || 'results'} className="lib__section">
          {section.title && <h4>{section.title}</h4>}
          <ul className="lib__list">
            {section.defs.map((def) => {
              const count = countOf(data, def);
              const here = (isSingle(def) || def.onlyOne === true) && count > 0;
              // What this preset calls a single panel on its board, so the library and "On screen" agree.
              const name = isSingle(def) ? panelTitle(preset, def.kind) : def.name;
              // A single panel is pointed at by its kind, an only-one widget by its own id.
              const target = isSingle(def) ? def.kind : data.widgets.find((w) => w.kind === def.kind)?.id ?? def.kind;
              return (
                <li key={def.kind} className="lib__card">
                  <span className="lib__icon">
                    <Icon name={def.icon} />
                  </span>
                  <span className="lib__text">
                    {name}
                    <small>{def.hint}</small>
                    {!isSingle(def) && count > 0 && <small className="lib__count">{count} on screen</small>}
                  </span>
                  {here ? (
                    <button
                      className="btn btn--small"
                      aria-label={`Show ${name}`}
                      onClick={() => {
                        callOut(target);
                        onDone?.();
                      }}
                    >
                      Show
                    </button>
                  ) : (
                    <button className="btn btn--small" aria-label={`Add ${name}`} onClick={() => add(def)}>
                      <Icon name="plus" size={13} /> Add
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * "Get More Widgets" in its own window over the board, opened from the sidebar's button. Focus
 * starts in the search box and stays inside; Esc, the × or a click outside shuts it. (The sidebar
 * shuts it when the page goes into stream mode.)
 */
export function WidgetLibraryDialog({ active, mutatePreset, onClose }: Props & { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const title = useId();
  useDialog(box, { initial: () => box.current?.querySelector<HTMLElement>('input[type="search"]'), onEscape: onClose });
  // The game and the web widgets' pages are real windows in the app and would sit over this.
  useCover(true);
  const root = document.querySelector('.app') ?? document.body;

  return createPortal(
    <div className="gallery libdlg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="gallery__box libdlg__box" role="dialog" aria-labelledby={title} aria-modal="true">
        <header className="gallery__head">
          <h2 id={title}>Get More Widgets</h2>
          <p className="muted">Every panel and widget there is. Add as many as you like; they land on your board.</p>
          <button className="icon-btn gallery__close" onClick={onClose} aria-label="Close the widget library">
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="libdlg__body">
          <WidgetLibrary active={active} mutatePreset={mutatePreset} onDone={onClose} />
        </div>
      </div>
    </div>,
    root,
  );
}
