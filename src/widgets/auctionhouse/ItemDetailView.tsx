import { type ReactNode, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import {
  ageLabel,
  type Group,
  type ItemDetail,
  itemLabel,
  priceSeries,
  percent,
  type ShoppingList,
  qualityColor,
  qualityName,
  wowheadUrl,
  withItem,
  withShoppingItem,
} from './ah';
import { ahRequest, openWowhead, useAh, useAhContext } from './api';
import { LineChart, type LineStyle, Note, Price, Table } from './Ui';

const LINES: LineStyle[] = [
  { id: 'market', label: 'Market', className: 'ah-line--market', dashed: true },
  { id: 'minBuyout', label: 'Min buyout', className: 'ah-line--min' },
];

/** Puts the item in one of your groups or shopping lists; says what happened. */
function AddTo({ item }: { item: string }) {
  const groups = useAh<{ groups: Group[] }>('/groups', { scoped: false });
  const lists = useAh<{ shopping: ShoppingList[] }>('/shopping', { scoped: false });
  const { goTab } = useAhContext();
  const [group, setGroup] = useState('');
  const [list, setList] = useState('');
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  const groupList = groups.data?.groups ?? [];
  const shoppingLists = lists.data?.shopping ?? [];
  const chosenGroup = groupList.find((g) => g.id === group) ?? groupList[0];
  const chosenList = shoppingLists.find((l) => l.id === list) ?? shoppingLists[0];

  const run = async (what: string, work: () => Promise<unknown>, reload: () => void) => {
    try {
      await work();
      setMessage({ text: what });
      reload();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    }
  };

  return (
    <div className="ah-addto">
      <div className="ah-addto__row">
        <label className="ah-field">
          <span className="ah-sr">Group</span>
          <select value={chosenGroup?.id ?? ''} disabled={groupList.length === 0} onChange={(e) => setGroup(e.target.value)}>
            {groupList.length === 0 && <option value="">No groups yet</option>}
            {groupList.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn--small"
          disabled={!chosenGroup}
          onClick={() => chosenGroup && void run(`Added to ${chosenGroup.name}.`, () => ahRequest('PUT', `/groups/${encodeURIComponent(chosenGroup.id)}`, { items: withItem(chosenGroup.items, item) }), groups.reload)}
        >
          <Icon name="plus" size={13} /> Add to group
        </button>
      </div>
      <div className="ah-addto__row">
        <label className="ah-field">
          <span className="ah-sr">Shopping list</span>
          <select value={chosenList?.id ?? ''} disabled={shoppingLists.length === 0} onChange={(e) => setList(e.target.value)}>
            {shoppingLists.length === 0 && <option value="">No shopping lists yet</option>}
            {shoppingLists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn--small"
          disabled={!chosenList}
          onClick={() => chosenList && void run(`Added to ${chosenList.name}.`, () => ahRequest('PUT', `/shopping/${encodeURIComponent(chosenList.id)}`, { items: withShoppingItem(chosenList.items, item) }), lists.reload)}
        >
          <Icon name="plus" size={13} /> Add to shopping list
        </button>
      </div>
      {(groupList.length === 0 || shoppingLists.length === 0) && !groups.error && (
        <p className="hint">
          Make a group or a shopping list in{' '}
          <button type="button" className="ah-link" onClick={() => goTab('rules')}>
            Rules
          </button>{' '}
          first.
        </p>
      )}
      {message && (
        <p className={`ah-note ${message.error ? 'error' : 'muted'}`} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}

const Stat = ({ label, children }: { label: string; children: ReactNode }) => (
  <div>
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
);

/** One item: its price history, the ladder of what is listed, your own auctions and its numbers. */
export function ItemDetailView({ item, onBack }: { item: string; onBack: () => void }) {
  const detail = useAh<ItemDetail>(`/item/${encodeURIComponent(item)}?days=60`);
  const d = detail.data;
  const series = useMemo(() => priceSeries(d?.history), [d]);
  const name = itemLabel(d?.info.name, item);
  const url = wowheadUrl(item);
  const mine = new Set((d?.mine ?? []).map(([price]) => price));
  const total = (d?.ladder ?? []).reduce((n, [, q]) => n + q, 0);

  return (
    <div className="ah-detail">
      <header className="ah-detail__head">
        <button type="button" className="btn btn--small" onClick={onBack}>
          <Icon name="arrowLeft" size={13} /> All items
        </button>
        <h3 style={{ color: qualityColor(d?.info.quality) }}>
          {name}
          <span className="ah-sr"> ({qualityName(d?.info.quality)})</span>
        </h3>
        {url && (
          <button type="button" className="btn btn--small" onClick={() => openWowhead(item)} title="Open this item on Wowhead in your browser">
            <Icon name="external" size={13} /> Wowhead
          </button>
        )}
      </header>

      {detail.error && <Note tone="error">{detail.error}</Note>}
      {!d && !detail.error && <Note>Loading…</Note>}
      {d && (
        <>
          <section aria-label="Price history">
            <LineChart series={series} lines={LINES} label={`Price history of ${name}`} />
          </section>

          <section aria-label="Numbers">
            <dl className="ah-facts ah-facts--grid">
              <Stat label="Market value"><Price copper={d.prices.market} /></Stat>
              <Stat label="Min buyout"><Price copper={d.prices.minBuyout} /></Stat>
              <Stat label="Historical"><Price copper={d.prices.historical} /></Stat>
              <Stat label="Your average sale"><Price copper={d.prices.avgSell} /></Stat>
              <Stat label="Sale rate">{percent(d.prices.saleRate)}</Stat>
              <Stat label="Volatility">{percent(d.prices.volatility)}</Stat>
              <Stat label="Vendor price"><Price copper={d.info.vendor} /></Stat>
              <Stat label="Crafting cost"><Price copper={d.prices.crafting} /></Stat>
              <Stat label="Listed">{total}</Stat>
              {d.info.ilvl ? <Stat label="Item level">{d.info.ilvl}</Stat> : null}
              {d.scanTime ? <Stat label="Last seen">{ageLabel(Math.max(0, Math.floor(Date.now() / 1000) - d.scanTime))}</Stat> : null}
            </dl>
          </section>

          <section aria-label="Add this item">
            <AddTo item={item} />
          </section>

          <section aria-label="What is listed">
            <h4>On the auction house</h4>
            {d.ladder.length === 0 ? (
              <Note>None are listed in the latest scan.</Note>
            ) : (
              <Table label="Price ladder">
                <thead>
                  <tr>
                    <th scope="col">Price each</th>
                    <th scope="col">Listed</th>
                    <th scope="col" className="ah-wide">Yours</th>
                  </tr>
                </thead>
                <tbody>
                  {d.ladder.map(([price, qty]) => (
                    <tr key={price} className={mine.has(price) ? 'is-mine' : undefined}>
                      <td><Price copper={price} /></td>
                      <td className="ah-num">{qty}</td>
                      <td className="ah-wide">{mine.has(price) ? 'Yes' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </section>

          <section aria-label="Your auctions">
            <h4>Your auctions</h4>
            {d.mine.length === 0 ? (
              <Note>You have none of this up.</Note>
            ) : (
              <Table label="Your auctions by price">
                <thead>
                  <tr>
                    <th scope="col">Price each</th>
                    <th scope="col">Up for sale</th>
                  </tr>
                </thead>
                <tbody>
                  {d.mine.map(([price, qty]) => (
                    <tr key={price}>
                      <td><Price copper={price} /></td>
                      <td className="ah-num">{qty}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </section>

          {d.listings && d.listings.rows.length > 0 && (
            <section aria-label="Latest search">
              <h4>Latest search in game</h4>
              <Table label="Latest listings">
                <thead>
                  <tr>
                    <th scope="col">Price</th>
                    <th scope="col">Count</th>
                    <th scope="col">Seller</th>
                    <th scope="col" className="ah-wide">Time left</th>
                  </tr>
                </thead>
                <tbody>
                  {d.listings.rows.slice(0, 40).map(([price, count, seller, timeLeft], i) => (
                    <tr key={i}>
                      <td><Price copper={price} /></td>
                      <td className="ah-num">{count}</td>
                      <td>{seller ?? ''}</td>
                      <td className="ah-wide">{timeLeft ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </section>
          )}
        </>
      )}
    </div>
  );
}
