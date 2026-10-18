import { useState } from 'react';
import { type Counter, counter, MAX_MILESTONES, milestone, type PresetData } from '../state/model';
import type { MutatePreset } from '../state/useAppState';
import { offerUndo } from '../undo';
import { Digits } from './Digits';
import { Icon } from './Icon';
import { Panel } from './Panel';

interface Props {
  milestones: PresetData['milestones'];
  counters: PresetData['counters'];
  title: string;
  mutatePreset: MutatePreset;
}

export function ProgressPanel({ milestones, counters, title, mutatePreset }: Props) {
  const done = milestones.items.filter((m) => m.done).length;
  const named = milestones.items.some((m) => m.name);
  const [editingList, setEditingList] = useState(false);
  const group = milestones.label || 'milestones';

  const removeCounter = (c: Counter, i: number) => {
    mutatePreset((d) => void (d.counters = d.counters.filter((x) => x.id !== c.id)));
    offerUndo(`${c.label || 'Counter'} removed`, () =>
      mutatePreset((d) => void (d.counters.some((x) => x.id === c.id) || d.counters.splice(Math.min(i, d.counters.length), 0, c))),
    );
  };

  return (
    <Panel
      id="progress"
      title={title}
      menu={[
        { label: `Edit ${group}`, icon: 'list', onSelect: () => setEditingList(true) },
        { label: 'Add a counter', icon: 'plus', onSelect: () => mutatePreset((d) => void d.counters.push(counter('Counter'))) },
      ]}
    >
      {editingList ? (
        <div className="list-editor no-drag">
          <input
            className="list-editor__label"
            value={milestones.label}
            placeholder="Name of the list, e.g. Badges"
            aria-label="List name"
            onChange={(e) => mutatePreset((d) => void (d.milestones.label = e.target.value))}
          />
          <ol>
            {milestones.items.map((m, i) => (
              <li key={m.id}>
                <span className="list-editor__n">{i + 1}</span>
                <input
                  value={m.name}
                  placeholder="No name (shows as a dot)"
                  onChange={(e) => mutatePreset((d) => void (d.milestones.items[i].name = e.target.value))}
                />
                <button
                  className="icon-btn"
                  title="Remove"
                  disabled={milestones.items.length <= 1}
                  onClick={() => mutatePreset((d) => void d.milestones.items.splice(i, 1))}
                >
                  <Icon name="x" size={14} />
                </button>
              </li>
            ))}
          </ol>
          <div className="row">
            <button
              className="btn btn--small"
              disabled={milestones.items.length >= MAX_MILESTONES}
              onClick={() => mutatePreset((d) => void d.milestones.items.push(milestone()))}
            >
              <Icon name="plus" size={14} /> Add one
            </button>
            <span className="spacer" />
            <button className="btn btn--small btn--accent" onClick={() => setEditingList(false)}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="milestones">
          <div className="milestones__head">
            <span className="milestones__label">{milestones.label}</span>
            <span className="milestones__count">
              {done}/{milestones.items.length}
            </span>
          </div>
          <div className={`milestones__row ${named ? 'is-named' : ''}`}>
            {milestones.items.map((m, i) => (
              <button
                key={m.id}
                className={`${m.name ? 'chip' : 'pip'} ${m.done ? 'on' : ''}`}
                title={`${m.name || `#${i + 1}`}: click to ${m.done ? 'undo' : 'mark done'}`}
                onClick={() => mutatePreset((d) => void (d.milestones.items[i].done = !d.milestones.items[i].done))}
              >
                {m.name ? (
                  <>
                    <span className="chip__mark">{m.done && <Icon name="check" size={12} />}</span>
                    {m.name}
                  </>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      )}

      <ul className="counters">
        {counters.map((c, i) => (
          <li key={c.id} className="counter">
            <input
              className="ghost-input counter__label"
              value={c.label}
              onChange={(e) => mutatePreset((d) => void (d.counters[i].label = e.target.value))}
            />
            <button
              className="icon-btn ctl"
              title="Minus one"
              onClick={() => mutatePreset((d) => void (d.counters[i].value = Math.max(0, d.counters[i].value - 1)))}
            >
              <Icon name="minus" size={14} />
            </button>
            <Digits key={c.value} className="counter__value bump" value={c.value} />
            <button className="icon-btn ctl" title="Plus one" onClick={() => mutatePreset((d) => void d.counters[i].value++)}>
              <Icon name="plus" size={14} />
            </button>
            <button className="icon-btn ctl" title="Remove counter" onClick={() => removeCounter(c, i)}>
              <Icon name="x" size={14} />
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
