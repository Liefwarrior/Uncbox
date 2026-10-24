import { type ReactNode, useMemo } from 'react';
import { type AccountingEntry, ageLabel, dayTotals, type DealRow, type FlipRow, type GoldSeries, goldSeries, isStale, percent, type RealmInfo, startOfToday, type UndercutRow, type AhStatus } from './ah';
import { useAh, useAhContext, type Where } from './api';
import { InstallButton } from './Setup';
import type { AhTab } from './settings';
import { Gold, ItemLink, Note, Price, Sparkline } from './Ui';

const SHOWN = 5;

function Card({ title, to, children }: { title: string; to?: { tab: AhTab; label: string }; children: ReactNode }) {
  const { goTab } = useAhContext();
  return (
    <section className="ah-card" aria-label={title}>
      <header>
        <h3>{title}</h3>
        {to && (
          <button type="button" className="ah-link" onClick={() => goTab(to.tab)}>
            {to.label}
          </button>
        )}
      </header>
      {children}
    </section>
  );
}

const whereKey = (r: Pick<RealmInfo, 'realm' | 'faction'>) => `${r.realm}|${r.faction}`;

/** The realm the tabs are reading: the one picked, else the newest scan. */
export function currentRealm(status: AhStatus, where: Where | null): RealmInfo | null {
  return status.realms.find((r) => where && r.realm === where.realm && r.faction === where.faction) ?? status.realms[0] ?? null;
}

function DataStatus({ status, where, onPick, onInstalled }: { status: AhStatus; where: Where | null; onPick: (w: Where | null) => void; onInstalled: () => void }) {
  const realm = currentRealm(status, where);
  const age = realm?.lastFullScan ? Math.max(0, Math.floor(Date.now() / 1000) - realm.lastFullScan) : null;
  const stale = isStale(age);
  return (
    <Card title="Data">
      <dl className="ah-facts">
        <div>
          <dt>Last full scan</dt>
          <dd>{ageLabel(age)}</dd>
        </div>
        <div>
          <dt>Addon</dt>
          <dd>{status.addonInstalled ? `Installed${status.flavor ? ` (${status.flavor.replace(/^_+|_+$/g, '').replace(/_/g, ' ')})` : ''}` : 'Not installed'}</dd>
        </div>
        {realm && (
          <div>
            <dt>Scans kept</dt>
            <dd>{realm.scans}</dd>
          </div>
        )}
      </dl>
      {status.realms.length > 1 && (
        <label className="ah-field">
          Realm
          <select value={realm ? whereKey(realm) : ''} onChange={(e) => {
            const next = status.realms.find((r) => whereKey(r) === e.target.value);
            onPick(next ? { realm: next.realm, faction: next.faction } : null);
          }}>
            {status.realms.map((r) => (
              <option key={whereKey(r)} value={whereKey(r)}>
                {r.realm} ({r.faction})
              </option>
            ))}
          </select>
        </label>
      )}
      {stale && (
        <p className="ah-note ah-stale" role="status">
          {age === null ? 'No full scan yet.' : 'The prices are getting old.'} Open the auction house in WoW and run <code>/uah scan</code>, then <code>/reload</code>.
        </p>
      )}
      {!status.addonInstalled && <InstallButton label="Install the WoW addons" onDone={onInstalled} />}
    </Card>
  );
}

function GoldCard() {
  const { hideGold } = useAhContext();
  // Nothing about your gold is even asked for while it is hidden.
  const gold = useAh<GoldSeries>(hideGold ? null : '/gold');
  const series = useMemo(() => goldSeries(gold.data), [gold.data]);
  return (
    <Card title="Gold now">
      <p className="ah-big">
        <Gold copper={hideGold ? 0 : gold.data ? gold.data.current : null} />
      </p>
      {hideGold ? <Note>Hidden while streaming. Turn on Show gold on stream in this widget’s settings to see it.</Note> : series[0].points.length > 1 ? <Sparkline series={series} label="Your gold over time" /> : <Note>The chart fills in as the addon records your gold over time.</Note>}
    </Card>
  );
}

function TodayCard() {
  const { hideGold } = useAhContext();
  const accounting = useAh<{ entries: AccountingEntry[] }>(hideGold ? null : '/accounting?days=2');
  const today = useMemo(() => dayTotals(accounting.data?.entries ?? [], startOfToday(Date.now())), [accounting.data]);
  return (
    <Card title="Today" to={{ tab: 'accounting', label: 'Accounting' }}>
      {hideGold ? (
        <Note>Hidden while streaming.</Note>
      ) : (
        <dl className="ah-facts">
          <div>
            <dt>Sales</dt>
            <dd>
              {today.sold} sold, <Gold copper={today.income} />
            </dd>
          </div>
          <div>
            <dt>Purchases</dt>
            <dd>
              {today.bought} bought, <Gold copper={today.spent} />
            </dd>
          </div>
        </dl>
      )}
    </Card>
  );
}

function DealsCard() {
  const deals = useAh<{ rows: DealRow[] }>(`/deals?limit=${SHOWN}`);
  const rows = deals.data?.rows.slice(0, SHOWN) ?? [];
  return (
    <Card title="Top deals" to={{ tab: 'deals', label: 'All deals' }}>
      {rows.length === 0 ? (
        <Note>No listings are under your deal threshold right now.</Note>
      ) : (
        <ul className="ah-list">
          {rows.map((r) => (
            <li key={`${r.item}-${r.price}`}>
              <ItemLink item={r.item} name={r.name} />
              <span>
                {r.quantity} at <Price copper={r.price} /> ({percent(r.percent)} of market)
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function FlipsCard() {
  const flips = useAh<{ rows: FlipRow[] }>(`/flips?limit=${SHOWN}`);
  const rows = flips.data?.rows.slice(0, SHOWN) ?? [];
  return (
    <Card title="Top flips" to={{ tab: 'deals', label: 'All flips' }}>
      {rows.length === 0 ? (
        <Note>Nothing to buy and relist for a profit right now.</Note>
      ) : (
        <ul className="ah-list">
          {rows.map((r) => (
            <li key={r.item}>
              <ItemLink item={r.item} name={r.name} />
              <span>
                <Price copper={r.profit} /> each, <Price copper={r.totalProfit} /> in all
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function UndercutsCard() {
  const undercuts = useAh<{ rows: UndercutRow[] }>('/undercuts');
  const rows = undercuts.data?.rows ?? [];
  return (
    <Card title="Undercut alerts" to={{ tab: 'selling', label: 'Selling' }}>
      {rows.length === 0 ? (
        <Note>Nobody has undercut your auctions.</Note>
      ) : (
        <ul className="ah-list">
          {rows.slice(0, SHOWN).map((r) => (
            <li key={`${r.char}-${r.item}-${r.myPrice}`}>
              <ItemLink item={r.item} name={r.name} />
              <span>
                undercut by <Price copper={r.undercutBy} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {rows.length > SHOWN && <p className="muted">and {rows.length - SHOWN} more</p>}
    </Card>
  );
}

/** The first tab: how fresh the data is, your gold, today, and the best few deals, flips and alerts. */
export function OverviewTab({ status, onPick, onInstalled }: { status: AhStatus; onPick: (w: Where | null) => void; onInstalled: () => void }) {
  const { where } = useAhContext();
  return (
    <div className="ah-overview">
      <DataStatus status={status} where={where} onPick={onPick} onInstalled={onInstalled} />
      <GoldCard />
      <TodayCard />
      <DealsCard />
      <FlipsCard />
      <UndercutsCard />
    </div>
  );
}
