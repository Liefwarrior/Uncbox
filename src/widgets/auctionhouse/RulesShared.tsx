import { createContext, type ReactNode, useContext, useEffect, useId, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { useArmed } from '../../useArmed';
import { formatMoney } from '../../money';
import { type FormulaResult, itemLabel, type ItemRow } from './ah';
import { query, testFormula, useAh, useAhContext } from './api';
import { ItemTitle, Note } from './Ui';

// Parts the Rules tab's editors share: the item picker, a formula with its live preview, and a
// delete button that asks twice.

/** The item formulas are previewed against (its key), or null for none. */
export const PreviewItemContext = createContext<string | null>(null);

/** How long a formula sits still before it is sent for a preview. */
const PREVIEW_MS = 350;

/** What a formula comes to for the chosen item, or what is wrong with it. */
export function FormulaPreview({ formula }: { formula: string }) {
  const item = useContext(PreviewItemContext);
  const { where } = useAhContext();
  const [result, setResult] = useState<FormulaResult | null>(null);

  useEffect(() => {
    if (!formula.trim()) {
      setResult(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => void testFormula(formula, item, where).then((r) => alive && setResult(r)), PREVIEW_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [formula, item, where]);

  const text = !result
    ? ''
    : !result.ok
      ? result.error ?? 'That formula doesn’t work.'
      : result.value === null || result.value === undefined
        ? item
          ? 'No price for this item (a price it needs has no data).'
          : 'Pick an item above to see a price.'
        : `= ${result.text ?? formatMoney(result.value)}`;
  return (
    <span className={`ah-preview ${result && !result.ok ? 'error' : 'muted'}`} role="status">
      {text}
    </span>
  );
}

/** A labelled text field for a formula, with its preview underneath. */
export function FormulaField({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <label className="ah-field ah-formula">
      {label}
      <input value={value} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      {hint && <small className="muted">{hint}</small>}
      <FormulaPreview formula={value} />
    </label>
  );
}

/** What the picker found: the first few matches of what was typed. */
const PICKER_SHOWN = 8;
const TYPING_MS = 250;

/** Searches the items Uncbox has prices for and calls back with the one chosen. */
export function ItemPicker({ label, onPick, placeholder = 'Search items by name' }: { label: string; onPick: (item: ItemRow) => void; placeholder?: string }) {
  const [text, setText] = useState('');
  const [asked, setAsked] = useState('');
  const list = useId();
  useEffect(() => {
    const t = setTimeout(() => setAsked(text.trim()), TYPING_MS);
    return () => clearTimeout(t);
  }, [text]);
  const found = useAh<{ items: ItemRow[] }>(asked ? `/items${query({ q: asked, sort: 'name', order: 'asc', limit: PICKER_SHOWN })}` : null);
  const items = asked ? (found.data?.items ?? []) : [];

  return (
    <div className="ah-picker">
      <label className="ah-searchbox">
        <Icon name="search" size={14} />
        <input type="search" aria-label={label} aria-controls={list} placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()} />
      </label>
      <ul id={list} className="ah-picker__list" aria-label={`${label}: matches`}>
        {items.map((it) => (
          <li key={it.item}>
            <button
              type="button"
              className="ah-link"
              onClick={() => {
                onPick(it);
                setText('');
                setAsked('');
              }}
            >
              <ItemTitle item={it.item} name={it.name} quality={it.quality} />
            </button>
          </li>
        ))}
      </ul>
      {asked && found.data && items.length === 0 && <Note>Nothing in your scans matches that.</Note>}
    </div>
  );
}

/** Item names for the keys in a group or list, from the items Uncbox knows (the first 500 by name). */
export function useItemNames(): (key: string) => string {
  const known = useAh<{ items: ItemRow[] }>(`/items${query({ sort: 'name', order: 'asc', limit: 500 })}`);
  const names = useMemo(() => new Map((known.data?.items ?? []).map((i) => [i.item, i.name])), [known.data]);
  return (key) => itemLabel(names.get(key), key);
}

/** A button that asks twice (the first click arms it), for deleting. */
export function DeleteButton({ label, onDelete }: { label: string; onDelete: () => void }) {
  const { armed, trigger } = useArmed();
  return (
    <button type="button" className="btn btn--small btn--danger" onClick={() => trigger(onDelete)}>
      <Icon name="trash" size={13} /> {armed ? 'Click again to delete' : label}
    </button>
  );
}

/** What went wrong (or right) with the last save, under an editor. */
export function Result({ message }: { message: { text: string; error?: boolean } | null }): ReactNode {
  return message ? (
    <p className={`ah-note ${message.error ? 'error' : 'muted'}`} role="status">
      {message.text}
    </p>
  ) : null;
}
