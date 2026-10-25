import { useMemo } from 'react';
import { WowNotice } from '../shared/WowBits';
import { type RaidSummary, shortDate, useSetupNotice, useWowData } from '../shared/wowGuild';
import type { BodyProps, SettingsProps } from '../types';
import { progression } from './goals';
import type { GoalsSettings } from './settings';

// Guild goals: how far the guild is through each raid, boss by boss, from the kills the addon saw.

export function GoalsBody({ settings: s, editing }: BodyProps<GoalsSettings>) {
  const raids = useWowData<{ raids: RaidSummary[] }>('/api/wow/raids?limit=100', ['raids']);
  const progress = useMemo(() => progression(raids.data?.raids ?? [], { hideUntouched: s.hideUntouched }), [raids.data, s.hideUntouched]);
  const hasKills = progress.killed > 0;
  const notice = useSetupNotice(hasKills, raids.error);
  if (!raids.data && !raids.error) return editing ? <p className="muted">Looking at your raids…</p> : null;
  if (!hasKills && notice) return <WowNotice notice={notice} quiet={!editing} icon="flag" />;

  return (
    <div className="wg-goals">
      <header className="wg-head">
        <strong>
          {progress.killed} boss{progress.killed === 1 ? '' : 'es'} down
        </strong>
        {progress.total > 0 && <span className="muted">of {progress.total} in these raids</span>}
      </header>
      {progress.raids.length === 0 ? (
        <p className="muted">No boss kills yet. They tick off here as you kill them.</p>
      ) : (
        <ul className="wg-goal-list">
          {progress.raids.map((r) => (
            <li key={r.zone} className={r.known && r.killed === r.total ? 'is-done' : ''}>
              <div className="wg-goal__head">
                <strong>{r.zone}</strong>
                <span className="muted">{r.known ? `${r.killed} of ${r.total}` : `${r.killed} killed`}</span>
              </div>
              {r.known && <progress className="wg-bar" value={r.killed} max={r.total} aria-label={`${r.zone}: ${r.killed} of ${r.total} bosses`} />}
              {s.showBosses && (
                <ul className="wg-bosses">
                  {r.bosses.map((b) => (
                    <li key={b.name} className={b.killedAt !== null ? 'is-down' : 'muted'}>
                      <span aria-hidden="true">{b.killedAt !== null ? '✓' : '○'}</span> {b.name}
                      {b.killedAt !== null && <span className="muted"> · {shortDate(b.killedAt)}</span>}
                      <span className="wg-sr">{b.killedAt !== null ? ' (killed)' : ' (not yet)'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function GoalsSettingsForm({ settings: s, set }: SettingsProps<GoalsSettings>) {
  return (
    <>
      <label className="inline">
        <input type="checkbox" checked={s.showBosses} onChange={(e) => set({ showBosses: e.target.checked })} /> List every boss
      </label>
      <label className="inline">
        <input type="checkbox" checked={s.hideUntouched} onChange={(e) => set({ hideUntouched: e.target.checked })} /> Only raids you have started
      </label>
    </>
  );
}
