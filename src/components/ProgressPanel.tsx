import { type AppState, MAX_MILESTONES, uid } from '../state/model';
import type { Mutate } from '../state/useAppState';
import { Icon } from './Icon';
import { Panel } from './Panel';

interface Props {
  milestones: AppState['milestones'];
  counters: AppState['counters'];
  mutate: Mutate;
}

export function ProgressPanel({ milestones, counters, mutate }: Props) {
  return (
    <Panel
      title="Progress"
      className="panel--progress"
      actions={
        <button
          className="btn btn--small"
          title="Add counter"
          onClick={() => mutate((s) => void s.counters.push({ id: uid(), label: 'Counter', value: 0 }))}
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
            onChange={(e) => mutate((s) => void (s.milestones.label = e.target.value))}
          />
          <span className="milestones__count">
            {milestones.done.filter(Boolean).length}/{milestones.done.length}
          </span>
          <span className="ctl row">
            <button
              className="icon-btn"
              title="One fewer"
              disabled={milestones.done.length <= 1}
              onClick={() => mutate((s) => void s.milestones.done.pop())}
            >
              <Icon name="minus" size={14} />
            </button>
            <button
              className="icon-btn"
              title="One more"
              disabled={milestones.done.length >= MAX_MILESTONES}
              onClick={() => mutate((s) => void s.milestones.done.push(false))}
            >
              <Icon name="plus" size={14} />
            </button>
          </span>
        </div>
        <div className="milestones__row">
          {milestones.done.map((done, i) => (
            <button
              key={i}
              className={`pip ${done ? 'on' : ''}`}
              title={done ? 'Mark as not done' : 'Mark as done'}
              onClick={() => mutate((s) => void (s.milestones.done[i] = !s.milestones.done[i]))}
            >
              {i + 1}
            </button>
          ))}
        </div>
      </div>

      <ul className="counters">
        {counters.map((c, i) => (
          <li key={c.id} className="counter">
            <input
              className="ghost-input counter__label"
              value={c.label}
              onChange={(e) => mutate((s) => void (s.counters[i].label = e.target.value))}
            />
            <button
              className="icon-btn ctl"
              title="Minus one"
              onClick={() => mutate((s) => void (s.counters[i].value = Math.max(0, s.counters[i].value - 1)))}
            >
              <Icon name="minus" size={14} />
            </button>
            <span className="counter__value">{c.value}</span>
            <button
              className="icon-btn ctl"
              title="Plus one"
              onClick={() => mutate((s) => void s.counters[i].value++)}
            >
              <Icon name="plus" size={14} />
            </button>
            <button
              className="icon-btn ctl counter__remove"
              title="Remove counter"
              onClick={() => mutate((s) => void s.counters.splice(i, 1))}
            >
              <Icon name="x" size={14} />
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
