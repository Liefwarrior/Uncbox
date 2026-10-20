import type { DamageSide, TopCard } from '../smite/screen';
import { agoText, useScreen } from '../smite/store';
import { useNow } from '../smite/useNow';
import { Panel } from './Panel';

const num = (n: number | null) => (n === null ? '–' : n.toLocaleString('en-US'));

function Side({ label, side, tone }: { label: string; side: DamageSide; tone: 'dealt' | 'taken' }) {
  const top = Math.max(1, ...side.rows.map((r) => r.amount));
  return (
    <section className={`damage-side damage-side--${tone}`}>
      <h3>
        <b>{num(side.total)}</b> {label}
      </h3>
      <ul>
        {side.rows.map((r, i) => (
          <li key={`${r.ability}${i}`} style={{ '--share': `${Math.round((r.amount / top) * 100)}%` } as React.CSSProperties}>
            <span className="damage-row__amount">{num(r.amount)}</span>
            <span className="damage-row__hits">×{r.hits}</span>
            <span className="damage-row__name">{r.ability || '?'}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const CARDS = [
  ['damage', 'Top damage'],
  ['kills', 'Top kills'],
  ['gold', 'Top gold'],
  ['mitigated', 'Top mitigated'],
] as const;

const who = (c: TopCard['ally']) => (c ? `${c.player}${c.god ? ` · ${c.god}` : ''}` : '–');

/** Damage dealt and taken, and the ability behind each number, from the T screen. */
export function DamagePanel({ title }: { title: string }) {
  const { combat, cards } = useScreen();
  const now = useNow(Boolean(combat));

  return (
    <Panel id="damage" title={title} empty={!combat}>
      {!combat ? (
        <p className="muted">Hold T in a match and your damage dealt and taken shows up here.</p>
      ) : (
        <div className="damage">
          <p className="board__ago">
            from T, {agoText(now - combat.at)} ago{combat.value.window ? `, last ${combat.value.window}s` : ''}
          </p>
          <Side label="Damage dealt" side={combat.value.dealt} tone="dealt" />
          <Side label="Damage taken" side={combat.value.taken} tone="taken" />
          {cards && (
            <dl className="damage-top">
              {CARDS.map(([key, name]) => (
                <div key={key}>
                  <dt>{name}</dt>
                  <dd>
                    <span className="damage-top__ally">{who(cards.value[key].ally)}</span>
                    <span className="damage-top__enemy">{who(cards.value[key].enemy)}</span>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </Panel>
  );
}
