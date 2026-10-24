import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { type ItemRow, nextSort, percent, type Sort, type SortKey, sortItems } from './ah';
import { query as queryString, useAh } from './api';
import { ItemDetailView } from './ItemDetailView';
import { ItemTitle, Note, Price, SortHeader, Table } from './Ui';

/** Typing waits this long before asking, so each letter doesn't send a request. */
const TYPING_MS = 250;

interface ItemsReply {
  total: number;
  items: ItemRow[];
}

/** Every item Uncbox has prices for, searchable and sortable; click one for its history and ladder. */
export function SearchTab({ query, item, onItem }: { query: string; item: string | null; onItem: (item: string | null) => void }) {
  const [text, setText] = useState(query);
  const [asked, setAsked] = useState(query.trim());
  const [sort, setSort] = useState<Sort>({ key: 'market', order: 'desc' });

  // The palette's "AH: search" puts what to look for in the settings.
  useEffect(() => void setText(query), [query]);
  useEffect(() => {
    const t = setTimeout(() => setAsked(text.trim()), TYPING_MS);
    return () => clearTimeout(t);
  }, [text]);

  const items = useAh<ItemsReply>(item ? null : `/items${queryString({ q: asked, sort: sort.key, order: sort.order, limit: 500 })}`);
  const rows = useMemo(() => sortItems(items.data?.items ?? [], sort), [items.data, sort]);

  if (item) return <ItemDetailView item={item} onBack={() => onItem(null)} />;

  const onSort = (key: SortKey) => setSort((s) => nextSort(s, key));
  return (
    <div className="ah-search">
      <label className="ah-searchbox">
        <Icon name="search" size={14} />
        <input type="search" aria-label="Search items" placeholder="Search items by name" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {items.error && <Note tone="error">{items.error}</Note>}
      {!items.data && !items.error && <Note>Loading…</Note>}
      {items.data && rows.length === 0 && <Note>{asked ? `Nothing in your scans matches “${asked}”.` : 'No items have prices yet.'}</Note>}
      {rows.length > 0 && (
        <>
          <p className="ah-count muted" role="status">
            {rows.length < (items.data?.total ?? 0) ? `Showing ${rows.length} of ${items.data?.total} items` : `${rows.length} item${rows.length === 1 ? '' : 's'}`}
          </p>
          <Table label="Items">
            <thead>
              <tr>
                <SortHeader label="Item" column="name" sort={sort} onSort={onSort} />
                <SortHeader label="Market" column="market" sort={sort} onSort={onSort} />
                <SortHeader label="Min buyout" column="minBuyout" sort={sort} onSort={onSort} />
                <SortHeader label="Historical" column="historical" sort={sort} onSort={onSort} wide />
                <SortHeader label="Sale rate" column="saleRate" sort={sort} onSort={onSort} wide />
                <SortHeader label="Volatility" column="volatility" sort={sort} onSort={onSort} wide />
                <SortHeader label="Qty" column="quantity" sort={sort} onSort={onSort} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.item}>
                  <th scope="row">
                    <button type="button" className="ah-link" onClick={() => onItem(r.item)}>
                      <ItemTitle item={r.item} name={r.name} quality={r.quality} />
                    </button>
                  </th>
                  <td><Price copper={r.market} /></td>
                  <td><Price copper={r.minBuyout} /></td>
                  <td className="ah-wide"><Price copper={r.historical} /></td>
                  <td className="ah-wide ah-num">{percent(r.saleRate)}</td>
                  <td className="ah-wide ah-num">{percent(r.volatility)}</td>
                  <td className="ah-num">{r.quantity}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
    </div>
  );
}
