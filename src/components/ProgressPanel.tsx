import { useState } from 'react';
import { counter, MAX_MILESTONES, milestone, type PresetData } from '../state/model';
import type { MutatePreset } from '../state/useAppState';
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
  const [renaming, setRenaming] = useState<number | null>(null);
  const rename = (i: number, name: string) => {
    mutatePreset((d) => void (d.milestones.items[i].name = name.trim()));
    setRenaming(null);
  };

  return (
    <Panel
      id="progress"
      title={title}
      actions={
        <button
          className="btn btn--small"
          title="Add counter"
          onClick={() => mutatePreset((d) => void d.counters.push(counter('Counter')))}
        >
          <Icon name="plus" size={14} /> Counter
        </button>
      }
    >
      <div className="milestones">
        <div className="milestones__head">
          <input
            className="ghost-input milestones__label"
            value={milestones.label}
            placeholder="Milestones"
            onChange={(e) => mutatePreset((d) => void (d.milestones.label = e.target.value))}
          />
          <span className="milestones__count">
            {done}/{milestones.items.length}
          </span>
          <span className="ctl row">
            <button
              className="icon-btn"
              title="Remove last"
              disabled={milestones.items.length <= 1}
              onClick={() => mutatePreset((d) => void d.milestones.items.pop())}
            >
              <Icon name="minus" size={14} />
            </button>
            <button
              className="icon-btn"
              title="Add one"
              disabled={milestones.items.length >= MAX_MILESTONES}
              onClick={() => mutatePreset((d) => void d.milestones.items.push(milestone()))}
            >
              <Icon name="plus" size={14} />
            </button>
          </span>
        </div>
        <div className={`milestones__row ${named ? 'is-named' : ''}`}>
          {milestones.items.map((m, i) =>
            renaming === i ? (
              <input
                key={m.id}
                className="chip chip--input"
                autoFocus
                defaultValue={m.name}
                placeholder="Name"
                onBlur={(e) => rename(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') rename(i, e.currentTarget.value);
                  if (e.key === 'Escape') setRenaming(null);
                }}
              />
            ) : (
            <button
              key={m.id}
              className={`${m.name ? 'chip' : 'pip'} ${m.done ? 'on' : ''}`}
              title={`${m.name || `#${i + 1}`} · double-click to name`}
              onClick={() => mutatePreset((d) => void (d.milestones.items[i].done = !d.milestones.items[i].done))}
              onDoubleClick={() => setRenaming(i)}
            >
              {m.name ? (
                <>
                  <span className="chip__mark">{m.done && <Icon name="check" size={12} />}</span>
                  {m.name}
                </>
              ) : null}
            </button>
            ),
          )}
        </div>
      </div>

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
            <button
              className="icon-btn ctl"
              title="Remove counter"
              onClick={() => mutatePreset((d) => void d.counters.splice(i, 1))}
            >
              <Icon name="x" size={14} />
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
