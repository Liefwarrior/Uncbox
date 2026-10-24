import { useEffect, useState } from 'react';
import { useSmite } from '../../smite';
import { Panel } from '../../components/Panel';
import type { PanelContext } from '../types';

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Both teams' gods, from the SMITE 2 draft as it happens, with yours marked and the match clock. */
export function TeamsPanel({ title }: PanelContext) {
  const snap = useSmite();
  const [, tick] = useState(0);
  const live = snap?.phase === 'match';
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);
  const seen = Boolean(snap && (snap.allies.length || snap.enemies.length));

  return (
    <Panel id="teams" title={title} empty={!seen}>
      {!seen ? (
        <p className="muted">Both teams show up here as gods are locked in the draft. Uncbox reads them from SMITE 2’s log.</p>
      ) : (
        <div className="teams">
          <p className="teams__status">
            {snap!.phase === 'draft' ? 'Draft' : snap!.phase === 'match' ? snap!.mode || 'Match' : 'Last match'}
            {live && snap!.startedAt > 0 && <span className="teams__clock">{clock(Date.now() - snap!.startedAt)}</span>}
          </p>
          <div className="teams__sides">
            <ol className="teams__side teams__side--allies">
              {snap!.allies.map((g) => (
                <li key={g} className={g === snap!.god ? 'is-me' : ''}>
                  {g}
                </li>
              ))}
            </ol>
            <span className="teams__vs">vs</span>
            <ol className="teams__side teams__side--enemies">
              {snap!.enemies.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </Panel>
  );
}
