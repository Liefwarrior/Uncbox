import { MAX_HISTORY, type MatchState, type RecordState, uid } from '../state/model';
import type { MutatePreset } from '../state/useAppState';
import { Digits } from './Digits';
import { Icon } from './Icon';
import { kdaRatio } from './MatchPanel';
import { Panel } from './Panel';

function streakOf(history: RecordState['history']) {
  if (history.length === 0) return '';
  const first = history[0].win;
  let n = 0;
  while (n < history.length && history[n].win === first) n++;
  return `${first ? 'W' : 'L'}${n}`;
}

interface Props {
  record: RecordState;
  match: MatchState;
  title: string;
  mutatePreset: MutatePreset;
}

/** Session win/loss record. Logging a result files the current match and zeroes its K/D/A. */
export function RecordPanel({ record, match, title, mutatePreset }: Props) {
  const games = record.wins + record.losses;
  const rate = games ? record.wins / games : 0;
  const streak = streakOf(record.history);
  const R = 34;
  const C = 2 * Math.PI * R;

  const log = (win: boolean) =>
    mutatePreset((d) => {
      const m = d.match;
      d.record.history.unshift({ id: uid(), god: m.god, role: m.role, k: m.k, d: m.d, a: m.a, win, at: Date.now() });
      d.record.history = d.record.history.slice(0, MAX_HISTORY);
      if (win) d.record.wins++;
      else d.record.losses++;
      Object.assign(d.match, { k: 0, d: 0, a: 0 });
    });

  return (
    <Panel
      id="record"
      title={title}
      menu={[
        {
          label: 'Start a new session',
          icon: 'reset',
          confirm: 'Click again to clear the record',
          onSelect: () => mutatePreset((d) => void (d.record = { wins: 0, losses: 0, history: [] })),
        },
      ]}
    >
      <div className="record">
        <div className="record__top">
          <svg className="ring" viewBox="0 0 80 80" aria-hidden="true">
            <circle className="ring__track" cx="40" cy="40" r={R} />
            <circle
              className="ring__fill"
              cx="40"
              cy="40"
              r={R}
              strokeDasharray={C}
              strokeDashoffset={C * (1 - rate)}
            />
          </svg>
          <div className="record__rate">
            <strong>{games ? <Digits value={`${Math.round(rate * 100)}%`} /> : '—'}</strong>
            <span>Win rate</span>
          </div>
          <div className="record__wl">
            <Digits key={`w${record.wins}`} className="record__w bump" value={record.wins} />
            <span className="record__dash">–</span>
            <Digits key={`l${record.losses}`} className="record__l bump" value={record.losses} />
            {streak && <span className={`streak streak--${streak[0]}`}>{streak}</span>}
          </div>
        </div>

        <div className="record__log ctl">
          <button className="btn btn--win" onClick={() => log(true)} title={`Log a win${match.god ? ` on ${match.god}` : ''}`}>
            <Icon name="trophy" size={14} /> Win
          </button>
          <button className="btn btn--loss" onClick={() => log(false)} title="Log a loss">
            Loss
          </button>
        </div>

        <ol className="history">
          {record.history.slice(0, 8).map((h) => (
            <li key={h.id} className={`history__item ${h.win ? 'is-win' : 'is-loss'}`}>
              <span className="history__result">{h.win ? 'W' : 'L'}</span>
              <span className="history__god">{h.god || '—'}</span>
              <span className="history__kda">
                {h.k}/{h.d}/{h.a} · {kdaRatio(h.k, h.d, h.a)}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </Panel>
  );
}
