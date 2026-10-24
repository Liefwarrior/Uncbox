import { useState } from 'react';
import { callOut } from '../callout';
import { addWidgetTo, type Removed, removeFromBoard, restoreToBoard, setPanelShown } from '../layout';
import type { BoardId, PresetData } from '../state/model';
import type { ActivePreset } from '../state/presets';
import type { MutatePreset } from '../state/useAppState';
import { offerUndo } from '../undo';
import { librarySections } from '../widgets/library';
import { boardDef, boardTitle, newWidget } from '../widgets/registry';
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

  if (rows.length === 0) return <p className="hint">Nothing yet. Add something from Get More Widgets below.</p>;
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
 * "Get More Widgets": every kind of panel and widget there is, to search, filter by category and
 * add. The preset's recommended ones come first. A panel there can only be one of (or a widget marked
 * `onlyOne`) shows "On screen" once it is on the board; other widgets can be added again and again.
 */
export function WidgetLibrary({ active, mutatePreset }: Props) {
  const { base, def: preset, data } = active;
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category | null>(null);
  const sections = librarySections({ query, category, preset: base, presetName: preset.name });

  const add = (def: AnyWidgetDef) => {
    if (isSingle(def)) {
      mutatePreset((d) => setPanelShown(d, def.kind, true));
      callOut(def.kind);
      return;
    }
    const w = newWidget(def.kind);
    mutatePreset((d) => addWidgetTo(d, w));
    callOut(w.id);
  };

  return (
    <div className="lib">
      <label className="lib__search">
        <Icon name="search" size={14} />
        <input type="search" aria-label="Search widgets" value={query} placeholder="Search widgets" onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="lib__chips" role="group" aria-label="Category">
        <button className="lib__chip" aria-pressed={category === null} onClick={() => setCategory(null)}>
          All
        </button>
        {CATEGORIES.map((name) => (
          <button key={name} className="lib__chip" aria-pressed={category === name} onClick={() => setCategory(category === name ? null : name)}>
            {name}
          </button>
        ))}
      </div>

      {sections.length === 0 && <p className="hint">Nothing matches that.</p>}
      {sections.map((section) => (
        <section key={section.title || 'results'} className="lib__section">
          {section.title && <h4>{section.title}</h4>}
          <ul className="lib__list">
            {section.defs.map((def) => {
              const count = countOf(data, def);
              const here = (isSingle(def) || def.onlyOne === true) && count > 0;
              // A single panel is pointed at by its kind, an only-one widget by its own id.
              const target = isSingle(def) ? def.kind : data.widgets.find((w) => w.kind === def.kind)?.id ?? def.kind;
              return (
                <li key={def.kind} className="lib__card">
                  <span className="lib__icon">
                    <Icon name={def.icon} />
                  </span>
                  <span className="lib__text">
                    {def.name}
                    <small>{def.hint}</small>
                    {!isSingle(def) && count > 0 && <small className="lib__count">{count} on screen</small>}
                  </span>
                  {here ? (
                    <span className="lib__actions">
                      <span className="lib__here">On screen</span>
                      <button className="btn btn--small" aria-label={`Show ${def.name}`} onClick={() => callOut(target)}>
                        Show
                      </button>
                    </span>
                  ) : (
                    <button className="btn btn--small" aria-label={`Add ${def.name}`} onClick={() => add(def)}>
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
