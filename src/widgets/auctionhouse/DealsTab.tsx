import { type FormEvent, useEffect, useState } from 'react';
import { formatMoney, parseMoney } from '../../money';
import { type DealRow, type DealsSettings, type FlipRow, perUnit, percent, type VendorFlipRow } from './ah';
import { ahRequest, query, useAh } from './api';
import { ItemLink, Note, Price, Table, Choice } from './Ui';

type View = 'deals' | 'flips' | 'vendor';
const VIEWS = [
  { id: 'deals', label: 'Deals' },
  { id: 'flips', label: 'Flips' },
  { id: 'vendor', label: 'Vendor flips' },
] as const;

const HELP: Record<View, string> = {
  deals: 'Listings priced under a share of market value, so you can buy them and sell at the usual price.',
  flips: 'Buy now, relist at market value. Profit is after the auction house’s cut and the deposit.',
  vendor: 'Auctions priced under what a vendor pays, so you can buy them and sell the items to a vendor.',
};

const LIMIT = 200;

/** Turns what was typed into the settings the server wants, or says what is wrong. */
export function readThresholds(form: { percent: string; saleRate: string; minMarket: string }, current: DealsSettings): { ok: true; settings: DealsSettings } | { ok: false; error: string } {
  const pct = Number(form.percent);
  if (!(pct > 0 && pct <= 100)) return { ok: false, error: 'Percent of market must be between 1 and 100.' };
  const rate = form.saleRate.trim() === '' ? 0 : Number(form.saleRate);
  if (!(rate >= 0 && rate <= 100)) return { ok: false, error: 'Min sale rate must be between 0 and 100.' };
  const market = form.minMarket.trim() === '' ? 0 : parseMoney(form.minMarket);
  if (market === null) return { ok: false, error: 'Write min market value like 5g, 50s or 2g 50s.' };
  return { ok: true, settings: { ...current, percent: pct / 100, minSaleRate: rate / 100, minMarket: market } };
}

function Thresholds({ settings, onSaved, showPercent }: { settings: DealsSettings; onSaved: () => void; showPercent: boolean }) {
  const fromSettings = (s: DealsSettings) => ({ percent: String(Math.round(s.percent * 100)), saleRate: String(Math.round(s.minSaleRate * 100)), minMarket: formatMoney(s.minMarket) });
  const [form, setForm] = useState(fromSettings(settings));
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  useEffect(() => setForm(fromSettings(settings)), [settings]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const read = readThresholds(form, settings);
    if (!read.ok) return setMessage({ text: read.error, error: true });
    try {
      await ahRequest('PUT', '/deals-settings', read.settings);
      setMessage({ text: 'Saved.' });
      onSaved();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    }
  };

  return (
    <form className="ah-thresholds" onSubmit={(e) => void save(e)}>
      {showPercent && (
        <label className="ah-field">
          Under % of market
          <input inputMode="numeric" value={form.percent} onChange={(e) => setForm({ ...form, percent: e.target.value })} />
        </label>
      )}
      <label className="ah-field">
        Min sale rate %
        <input inputMode="numeric" value={form.saleRate} onChange={(e) => setForm({ ...form, saleRate: e.target.value })} />
      </label>
      <label className="ah-field">
        Min market value
        <input value={form.minMarket} placeholder="5g" onChange={(e) => setForm({ ...form, minMarket: e.target.value })} />
      </label>
      <button type="submit" className="btn btn--small">
        Apply
      </button>
      {message && (
        <span className={message.error ? 'error' : 'muted'} role="status">
          {message.text}
        </span>
      )}
    </form>
  );
}

function DealsTable({ rows }: { rows: DealRow[] }) {
  return (
    <Table label="Deals">
      <thead>
        <tr>
          <th scope="col">Item</th>
          <th scope="col">Price each</th>
          <th scope="col">Qty</th>
          <th scope="col">Market</th>
          <th scope="col" className="ah-wide">% of market</th>
          <th scope="col" className="ah-wide">Sale rate</th>
          <th scope="col">Profit each</th>
          <th scope="col">Profit total</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.item}-${r.price}`}>
            <th scope="row"><ItemLink item={r.item} name={r.name} /></th>
            <td><Price copper={r.price} /></td>
            <td className="ah-num">{r.quantity}</td>
            <td><Price copper={r.market} /></td>
            <td className="ah-wide ah-num">{percent(r.percent)}</td>
            <td className="ah-wide ah-num">{percent(r.saleRate)}</td>
            <td><Price copper={perUnit(r.profit, r.quantity)} /></td>
            <td><Price copper={r.profit} /></td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function FlipsTable({ rows }: { rows: FlipRow[] }) {
  return (
    <Table label="Flips">
      <thead>
        <tr>
          <th scope="col">Item</th>
          <th scope="col">Buy at</th>
          <th scope="col">Qty</th>
          <th scope="col">Market</th>
          <th scope="col" className="ah-wide">You keep</th>
          <th scope="col" className="ah-wide">Return</th>
          <th scope="col">Profit each</th>
          <th scope="col">Profit total</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.item}>
            <th scope="row"><ItemLink item={r.item} name={r.name} /></th>
            <td><Price copper={r.price} /></td>
            <td className="ah-num">{r.quantity}</td>
            <td><Price copper={r.market} /></td>
            <td className="ah-wide"><Price copper={r.net} /></td>
            <td className="ah-wide ah-num">{percent(r.roi)}</td>
            <td><Price copper={r.profit} /></td>
            <td><Price copper={r.totalProfit} /></td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function VendorTable({ rows }: { rows: VendorFlipRow[] }) {
  return (
    <Table label="Vendor flips">
      <thead>
        <tr>
          <th scope="col">Item</th>
          <th scope="col">Price each</th>
          <th scope="col">Qty</th>
          <th scope="col">Vendor pays</th>
          <th scope="col">Profit each</th>
          <th scope="col">Profit total</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.item}-${r.price}`}>
            <th scope="row"><ItemLink item={r.item} name={r.name} /></th>
            <td><Price copper={r.price} /></td>
            <td className="ah-num">{r.quantity}</td>
            <td><Price copper={r.vendor} /></td>
            <td><Price copper={r.profit} /></td>
            <td><Price copper={r.totalProfit} /></td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** Deals, flips and vendor flips, with the thresholds that decide what counts as a deal. */
export function DealsTab() {
  const [view, setView] = useState<View>('deals');
  const settings = useAh<DealsSettings>('/deals-settings', { scoped: false });
  const s = settings.data;
  const path =
    view === 'deals' && s ? `/deals${query({ percent: s.percent, minSaleRate: s.minSaleRate, minMarket: s.minMarket, limit: LIMIT })}`
    : view === 'flips' && s ? `/flips${query({ minSaleRate: s.minSaleRate, minMarket: s.minMarket, limit: LIMIT })}`
    : view === 'vendor' ? `/vendor-flips?limit=${LIMIT}`
    : null;
  const found = useAh<{ rows: unknown[] }>(path);
  const rows = found.data?.rows ?? [];

  return (
    <div className="ah-deals">
      <Choice label="Show" value={view} options={VIEWS} onChange={setView} />
      <p className="hint">{HELP[view]}</p>
      {s && view !== 'vendor' && <Thresholds settings={s} onSaved={settings.reload} showPercent={view === 'deals'} />}
      {found.error && <Note tone="error">{found.error}</Note>}
      {!found.data && !found.error && <Note>Loading…</Note>}
      {found.data && rows.length === 0 && (
        <Note>{view === 'vendor' ? 'No auction is priced under what a vendor pays.' : 'Nothing qualifies. Try a higher percent of market or a lower minimum.'}</Note>
      )}
      {rows.length > 0 && view === 'deals' && <DealsTable rows={rows as DealRow[]} />}
      {rows.length > 0 && view === 'flips' && <FlipsTable rows={rows as FlipRow[]} />}
      {rows.length > 0 && view === 'vendor' && <VendorTable rows={rows as VendorFlipRow[]} />}
    </div>
  );
}
