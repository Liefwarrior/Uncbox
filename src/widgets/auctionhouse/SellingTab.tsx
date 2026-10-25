import { ageLabel, percent, type SellRow, totalValue, type UndercutRow } from './ah';
import { useAh } from './api';
import { Gold, ItemLink, Note, Price, Table } from './Ui';

const chars = (c: Record<string, number>) => Object.entries(c).map(([name, n]) => `${name} ${n}`).join(', ');

/** What to sell from your bags and bank, most valuable first, and the auctions someone has undercut. */
export function SellingTab() {
  const sell = useAh<{ rows: SellRow[] }>('/sell?limit=200');
  const under = useAh<{ rows: UndercutRow[] }>('/undercuts');
  const rows = sell.data?.rows ?? [];
  const cut = under.data?.rows ?? [];

  return (
    <div className="ah-selling">
      <section>
        <header className="ah-sectionhead">
          <h3>What to sell</h3>
          {rows.length > 0 && (
            <span className="muted">
              Worth about <Gold copper={totalValue(rows)} /> in your bags and bank
            </span>
          )}
        </header>
        {sell.error && <Note tone="error">{sell.error}</Note>}
        {!sell.data && !sell.error && <Note>Loading…</Note>}
        {sell.data && rows.length === 0 && <Note>Nothing in your bags or bank has a price yet. Open your bags and bank in WoW, scan the auction house, then /reload.</Note>}
        {rows.length > 0 && (
          <Table label="What to sell">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Qty</th>
                <th scope="col">Each</th>
                <th scope="col">Worth</th>
                <th scope="col" className="ah-wide">Sale rate</th>
                <th scope="col" className="ah-wide">Where</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.item}>
                  <th scope="row"><ItemLink item={r.item} name={r.name} /></th>
                  <td className="ah-num">{r.quantity}</td>
                  <td><Price copper={r.unitValue} /></td>
                  <td><Gold copper={r.value} /></td>
                  <td className="ah-wide ah-num">{percent(r.saleRate)}</td>
                  <td className="ah-wide">{chars(r.chars)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section>
        <header className="ah-sectionhead">
          <h3>Undercut</h3>
        </header>
        {under.error && <Note tone="error">{under.error}</Note>}
        {under.data && cut.length === 0 && <Note>Nobody has undercut your auctions as far as your last scan can tell.</Note>}
        {cut.length > 0 && (
          <>
            <p className="ah-hint-box" role="note">
              Cancel these in game: <code>/uah cancel</code> (at the auction house window).
            </p>
            <Table label="Undercut auctions">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col" className="ah-wide">Character</th>
                  <th scope="col">Qty</th>
                  <th scope="col">Yours</th>
                  <th scope="col">Lowest</th>
                  <th scope="col">Under by</th>
                  <th scope="col" className="ah-wide">Seen</th>
                </tr>
              </thead>
              <tbody>
                {cut.map((r) => (
                  <tr key={`${r.char}-${r.item}-${r.myPrice}`}>
                    <th scope="row"><ItemLink item={r.item} name={r.name} /></th>
                    <td className="ah-wide">{r.char}</td>
                    <td className="ah-num">{r.quantity}</td>
                    <td><Price copper={r.myPrice} /></td>
                    <td><Price copper={r.lowest} /></td>
                    <td><Price copper={r.undercutBy} /></td>
                    <td className="ah-wide">{ageLabel(Math.max(0, Math.floor(Date.now() / 1000) - r.seen))}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        )}
      </section>
    </div>
  );
}
