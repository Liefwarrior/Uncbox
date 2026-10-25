import { type MatchState, SMITE_ROLES } from '../../state/model';
import { Digits } from '../../components/Digits';
import { Icon } from '../../components/Icon';
import { Panel } from '../../components/Panel';
import type { PanelContext } from '../types';

const STATS = [
  { key: 'k', label: 'Kills' },
  { key: 'd', label: 'Deaths' },
  { key: 'a', label: 'Assists' },
] as const;

export function kdaRatio(k: number, d: number, a: number) {
  return k + d + a === 0 ? '—' : ((k + a) / Math.max(1, d)).toFixed(2);
}

/** The match in progress: god, role, mode and a live K/D/A line. */
export function MatchPanel({ data, title, mutatePreset }: PanelContext) {
  const match = data.match;
  const set = (patch: Partial<MatchState>) => mutatePreset((d) => void Object.assign(d.match, patch));

  return (
    <Panel
      id="match"
      title={title}
      menu={[{ label: 'Reset kills, deaths and assists', icon: 'reset', onSelect: () => set({ k: 0, d: 0, a: 0 }) }]}
    >
      <div className="match">
        <input
          className="ghost-input match__god"
          value={match.god}
          placeholder="God"
          onChange={(e) => set({ god: e.target.value })}
        />
        <div className="match__meta">
          <select
            className="match__role"
            value={match.role}
            aria-label="Role"
            title="Role"
            onChange={(e) => set({ role: e.target.value as MatchState['role'] })}
          >
            <option value="">Role</option>
            {SMITE_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          {/* On stream the picker is out of the way and the role is just text. */}
          {match.role && <span className="role on match__role-text">{match.role}</span>}
          <input
            className="ghost-input match__mode"
            value={match.mode}
            placeholder="Mode"
            onChange={(e) => set({ mode: e.target.value })}
          />
        </div>
        <div className="kda">
          {STATS.map(({ key, label }) => (
            <div key={key} className={`kda__stat kda__stat--${key}`}>
              <button
                className="kda__value"
                title={`Add one (${label})`} aria-label={`Add one (${label})`}
                onClick={() => mutatePreset((d) => void d.match[key]++)}
              >
                <Digits key={match[key]} className="bump" value={match[key]} />
              </button>
              <span className="kda__label">{label}</span>
              <button
                className="icon-btn ctl kda__minus"
                title={`Remove one (${label})`} aria-label={`Remove one (${label})`}
                onClick={() => mutatePreset((d) => void (d.match[key] = Math.max(0, d.match[key] - 1)))}
              >
                <Icon name="minus" size={12} />
              </button>
            </div>
          ))}
          <div className="kda__stat kda__stat--ratio">
            <Digits className="kda__value" value={kdaRatio(match.k, match.d, match.a)} />
            <span className="kda__label">KDA</span>
          </div>
        </div>
      </div>
    </Panel>
  );
}
