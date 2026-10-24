import { useMemo, useState } from 'react';
import { type AccountingEntry, type AccountingSummary, feesOf, type GoldSeries, goldSeries, shortDateTime } from './ah';
import { useAh, useAhContext } from './api';
import { Choice, Gold, ItemLink, LineChart, type LineStyle, Note, Table } from './Ui';

const RANGES = [
  { id: 7, label: '7 days' },
  { id: 30, label: '30 days' },
  { id: 90, label: '90 days' },
] as const;

const GOLD_LINE: LineStyle[] = [{ id: 'gold', label: 'Gold', className: 'ah-line--market' }];

const TYPE_LABEL: Record<string, string> = { sold: 'Sold', bought: 'Bought', expired: 'Expired', cancelled: 'Cancelled', post: 'Posted' };
const SHOWN_AT_FIRST = 100;

/** The entries are listed this many at a time. */
export const pageOf = <T,>(rows: readonly T[], shown: number): T[] => rows.slice(0, shown);

function Summary({ s }: { s: AccountingSummary }) {
  return (
    <dl className="ah-facts ah-facts--grid ah-summary">
      <div>
        <dt>Sales</dt>
        <dd>
          {s.sales} sold, <Gold copper={s.gross} />
        </dd>
      </div>
      <div>
        <dt>Purchases</dt>
        <dd>
          {s.purchases} bought, <Gold copper={s.spent} />
        </dd>
      </div>
      <div>
        <dt>Expired</dt>
        <dd>{s.expired}</dd>
      </div>
      <div>
        <dt>Cancelled</dt>
        <dd>{s.cancelled}</dd>
      </div>
      <div title="The auction house’s cut of your sales, plus the deposits of auctions that expired">
        <dt>Fees</dt>
        <dd>
          <Gold copper={feesOf(s)} />
        </dd>
      </div>
      <div>
        <dt>Net</dt>
        <dd className={s.profit < 0 ? 'ah-loss' : 'ah-gain'}>
          <Gold copper={s.profit} />
        </dd>
      </div>
    </dl>
  );
}

/** Sales, purchases, fees and net over a week, a month or a quarter; every entry; and your gold over time. Hidden on stream by default. */
export function AccountingTab() {
  const { hideGold } = useAhContext();
  const [days, setDays] = useState<number>(30);
  const [shown, setShown] = useState(SHOWN_AT_FIRST);
  const accounting = useAh<{ summary: AccountingSummary; entries: AccountingEntry[] }>(hideGold ? null : `/accounting?days=${days}`);
  const gold = useAh<GoldSeries>(hideGold ? null : '/gold');
  const series = useMemo(() => goldSeries(gold.data), [gold.data]);

  if (hideGold) {
    return (
      <div className="ah-empty">
        <h3>Hidden while streaming</h3>
        <p className="muted">Your sales, purchases and gold stay off the stream. To show them, turn on Show gold on stream in this widget’s settings (the ⋯ menu, while editing).</p>
      </div>
    );
  }

  const entries = accounting.data?.entries ?? [];
  return (
    <div className="ah-accounting">
      <Choice label="Time span" value={days} options={RANGES} onChange={(d) => (setDays(d), setShown(SHOWN_AT_FIRST))} />
      {accounting.error && <Note tone="error">{accounting.error}</Note>}
      {!accounting.data && !accounting.error && <Note>Loading…</Note>}
      {accounting.data && <Summary s={accounting.data.summary} />}

      <section aria-label="Gold over time">
        <h3>Gold over time</h3>
        {gold.data && series[0].points.length > 1 ? <LineChart series={series} lines={GOLD_LINE} label="Your gold over time" /> : <Note>The chart fills in as the addon records your gold. Open your mailbox or the auction house in WoW, then /reload.</Note>}
      </section>

      <section aria-label="Entries">
        <h3>Entries</h3>
        {accounting.data && entries.length === 0 && <Note>Nothing was sold, bought or posted in this time. Open your mailbox in WoW so Uncbox can read your sales.</Note>}
        {entries.length > 0 && (
          <>
            <Table label="Accounting entries">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">What</th>
                  <th scope="col">Item</th>
                  <th scope="col">Qty</th>
                  <th scope="col">Price</th>
                  <th scope="col" className="ah-wide">Fee</th>
                  <th scope="col" className="ah-wide">Character</th>
                </tr>
              </thead>
              <tbody>
                {pageOf(entries, shown).map((e) => (
                  <tr key={e.id}>
                    <td>{shortDateTime(e.t)}</td>
                    <td>{TYPE_LABEL[e.type] ?? e.type}</td>
                    <th scope="row">{e.item ? <ItemLink item={e.item} name={e.name} /> : (e.name ?? '')}</th>
                    <td className="ah-num">{e.qty}</td>
                    <td><Gold copper={e.price} /></td>
                    <td className="ah-wide">{e.cut || e.deposit ? <Gold copper={e.type === 'expired' ? e.deposit : e.cut} /> : ''}</td>
                    <td className="ah-wide">{e.char}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {shown < entries.length && (
              <button type="button" className="btn btn--small" onClick={() => setShown((n) => n + SHOWN_AT_FIRST)}>
                Show {Math.min(SHOWN_AT_FIRST, entries.length - shown)} more
              </button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
