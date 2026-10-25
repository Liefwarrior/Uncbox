import { useSmite } from '../../smite';
import type { Row } from '../../smite/screen';
import { agoText, useScreen } from '../../smite/store';
import { useNow } from '../../smite/useNow';
import { Panel } from '../../components/Panel';
import type { PanelContext } from '../types';

const show = (n: number | null) => (n === null ? '–' : String(n));

function Team({ name, rows, god }: { name: string; rows: Row[]; god: string }) {
  if (!rows.length) return null;
  return (
    <section className="board-team">
      <h3 className="board-team__name">{name}</h3>
      <div className="board-team__head" aria-hidden="true">
        <span>Lv</span>
        <span />
        <span>K</span>
        <span>D</span>
        <span>A</span>
        <span>Gold</span>
      </div>
      {rows.map((r, i) => (
        <div key={`${r.god}${r.player}${i}`} className={`board-row ${god && r.god === god ? 'is-me' : ''}`}>
          <span className="board-row__level">{show(r.level)}</span>
          <span className="board-row__who">
            <b>{r.player || '?'}</b>
            <small>{r.god}</small>
          </span>
          <span>{show(r.k)}</span>
          <span>{show(r.d)}</span>
          <span>{show(r.a)}</span>
          <span className="board-row__gold">{show(r.gold)}</span>
        </div>
      ))}
    </section>
  );
}

/** Everyone's god, level, K/D/A and gold from the Tab screen, plus the last few kills from the kill banner. */
export function ScoreboardPanel({ title }: PanelContext) {
  const { scoreboard, kills } = useScreen();
  const snap = useSmite();
  const now = useNow(Boolean(scoreboard || kills.length));
  const recent = kills.slice(-5).reverse();

  return (
    <Panel id="scoreboard" title={title} empty={!scoreboard && !recent.length}>
      {!scoreboard ? (
        <>
          <p className="muted">Hold Tab in a match and everyone’s K/D/A and gold show up here.</p>
          <Kills kills={recent} />
        </>
      ) : (
        <div className="board">
          <p className="board__ago">from Tab, {agoText(now - scoreboard.at)} ago</p>
          <Team name="Order" rows={scoreboard.value.order} god={snap?.god ?? ''} />
          <Team name="Chaos" rows={scoreboard.value.chaos} god={snap?.god ?? ''} />
          <Kills kills={recent} />
        </div>
      )}
    </Panel>
  );
}

function Kills({ kills }: { kills: ReturnType<typeof useScreen>['kills'] }) {
  if (!kills.length) return null;
  return (
    <section className="board-kills">
      <h3 className="board-team__name">Recent kills</h3>
      <ul>
        {kills.map((k) => (
          <li key={k.at}>
            {k.clock && <time>{k.clock}</time>}
            <span>
              <b>{k.killer || '?'}</b> got <b>{k.victim || '?'}</b>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
