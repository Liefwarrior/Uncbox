import { Fragment, useMemo, useState } from 'react';
import { type CraftRow, margin, percent } from './ah';
import { query, useAh } from './api';
import { ItemLink, Note, Price, Table } from './Ui';

/** The professions in the rows, A to Z. */
export const professionsOf = (rows: readonly Pick<CraftRow, 'profession'>[]): string[] => [...new Set(rows.map((r) => r.profession))].sort((a, b) => a.localeCompare(b));

/** The recipes of one profession ('' is all of them). */
export const inProfession = (rows: readonly CraftRow[], profession: string): CraftRow[] => (profession ? rows.filter((r) => r.profession === profession) : [...rows]);

/** What each recipe you know earns: what the reagents cost against what the product sells for after the AH's cut. */
export function CraftingTab() {
  const [profession, setProfession] = useState('');
  const [incomplete, setIncomplete] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const crafting = useAh<{ rows: CraftRow[] }>(`/crafting${query({ includeIncomplete: incomplete ? 1 : '', limit: 300 })}`);
  const all = crafting.data?.rows ?? [];
  const professions = useMemo(() => professionsOf(all), [all]);
  const rows = useMemo(() => inProfession(all, profession), [all, profession]);

  return (
    <div className="ah-crafting">
      <div className="ah-toolbar">
        <label className="ah-field">
          Profession
          <select value={profession} onChange={(e) => setProfession(e.target.value)}>
            <option value="">All professions</option>
            {professions.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="inline">
          <input type="checkbox" checked={incomplete} onChange={(e) => setIncomplete(e.target.checked)} /> Include recipes with missing prices
        </label>
      </div>
      {crafting.error && <Note tone="error">{crafting.error}</Note>}
      {!crafting.data && !crafting.error && <Note>Loading…</Note>}
      {crafting.data && all.length === 0 && (
        <Note>
          {incomplete
            ? 'Uncbox hasn’t seen any recipes yet. Open each profession window in WoW, then /reload.'
            : 'No recipe has prices for everything yet. Open your professions in WoW and scan the auction house, or include recipes with missing prices.'}
        </Note>
      )}
      {all.length > 0 && rows.length === 0 && <Note>No recipes for that profession.</Note>}
      {rows.length > 0 && (
        <Table label="Recipes by profit">
          <thead>
            <tr>
              <th scope="col">Recipe</th>
              <th scope="col" className="ah-wide">Profession</th>
              <th scope="col">Cost</th>
              <th scope="col">Sells for</th>
              <th scope="col">Profit</th>
              <th scope="col">Margin</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const key = `${r.profession}|${r.item}`;
              const expanded = open === key;
              return (
                <Fragment key={key}>
                  <tr className={r.complete ? undefined : 'is-incomplete'}>
                    <th scope="row">
                      <button type="button" className="ah-link ah-expand" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : key)}>
                        <span aria-hidden="true">{expanded ? '▾ ' : '▸ '}</span>
                        {r.name}
                        {r.made > 1 ? ` (makes ${r.made})` : ''}
                      </button>
                    </th>
                    <td className="ah-wide">{r.profession}</td>
                    <td>{r.cost === null ? <span title="A reagent has no price">?</span> : <Price copper={r.cost} />}</td>
                    <td>{r.value === null ? <span title="The product has no price">?</span> : <Price copper={r.value} />}</td>
                    <td className={r.profit !== null && r.profit < 0 ? 'ah-loss' : undefined}>{r.profit === null ? '?' : <Price copper={r.profit} />}</td>
                    <td className="ah-num">{percent(margin(r.profit, r.value))}</td>
                  </tr>
                  {expanded && (
                    <tr className="ah-reagents">
                      <td colSpan={6}>
                        <ul>
                          {r.reagents.map((re) => (
                            <li key={re.item}>
                              {re.quantity} × <ItemLink item={re.item} name={re.name} /> at {re.unitCost === null ? 'no price' : <Price copper={re.unitCost} />}
                            </li>
                          ))}
                        </ul>
                        <p className="muted">
                          <ItemLink item={r.item} name={`See ${r.name} prices`} />
                        </p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}
