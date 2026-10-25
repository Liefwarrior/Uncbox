import { useState } from 'react';
import { Icon } from '../../components/Icon';
import { type ShoppingEntry, type ShoppingList, withShoppingItem } from './ah';
import { ahRequest, useAh } from './api';
import { DeleteButton, FormulaPreview, ItemPicker, Result, useItemNames } from './RulesShared';
import { Note } from './Ui';

interface Draft {
  id: string | null;
  name: string;
  items: ShoppingEntry[];
}

/** What goes to the server for a draft: blank prices are left out so the shopping rule's applies. */
export const shoppingBody = (d: Draft) => ({
  name: d.name.trim(),
  items: d.items.map((e) => ({ ...(e.item ? { item: e.item } : {}), ...(e.name ? { name: e.name } : {}), ...(e.maxPrice?.trim() ? { maxPrice: e.maxPrice.trim() } : {}) })),
});

/** Shopping lists: what to look for, and the most to pay for each. */
export function ShoppingPanel() {
  const lists = useAh<{ shopping: ShoppingList[] }>('/shopping', { scoped: false });
  const nameOf = useItemNames();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [typed, setTyped] = useState('');
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  const done = (text: string) => {
    setMessage({ text });
    setDraft(null);
    lists.reload();
  };
  const fail = (err: unknown) => setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
  const save = async () => {
    if (!draft) return;
    try {
      if (draft.id) await ahRequest('PUT', `/shopping/${encodeURIComponent(draft.id)}`, shoppingBody(draft));
      else await ahRequest('POST', '/shopping', shoppingBody(draft));
      done(`Saved ${draft.name.trim()}.`);
    } catch (err) {
      fail(err);
    }
  };
  const remove = async (id: string) => {
    try {
      await ahRequest('DELETE', `/shopping/${encodeURIComponent(id)}`);
      done('Deleted.');
    } catch (err) {
      fail(err);
    }
  };

  if (draft) {
    const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
    const change = (i: number, patch: Partial<ShoppingEntry>) => set({ items: draft.items.map((e, at) => (at === i ? { ...e, ...patch } : e)) });
    const addTyped = () => {
      const name = typed.trim();
      if (name) set({ items: [...draft.items, { name }] });
      setTyped('');
    };
    return (
      <form className="ah-editor" aria-label={draft.id ? `Edit ${draft.name}` : 'New shopping list'} onSubmit={(e) => (e.preventDefault(), void save())}>
        <h3>{draft.id ? 'Edit shopping list' : 'New shopping list'}</h3>
        <label className="ah-field">
          Name
          <input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Flask ingredients" />
        </label>
        <div className="ah-field">
          Things to look for ({draft.items.length})
          {draft.items.length === 0 && <Note>Nothing yet. Search below, or type a name the game can search for.</Note>}
          <ul className="ah-rows">
            {draft.items.map((e, i) => (
              <li key={`${e.item ?? e.name}-${i}`}>
                <div className="ah-shopping__entry">
                  <strong>{e.item ? nameOf(e.item) : e.name}</strong>
                  <label className="ah-field">
                    <span className="ah-sr">Most to pay for {e.item ? nameOf(e.item) : e.name}</span>
                    <input value={e.maxPrice ?? ''} placeholder="Most to pay (blank uses the shopping rule)" spellCheck={false} onChange={(ev) => change(i, { maxPrice: ev.target.value })} />
                  </label>
                  {e.maxPrice?.trim() ? <FormulaPreview formula={e.maxPrice} /> : null}
                </div>
                <button type="button" className="icon-btn" aria-label={`Remove ${e.item ? nameOf(e.item) : e.name}`} onClick={() => set({ items: draft.items.filter((_, at) => at !== i) })}>
                  <Icon name="x" size={12} />
                </button>
              </li>
            ))}
          </ul>
          <ItemPicker label="Add an item" onPick={(it) => set({ items: withShoppingItem(draft.items, it.item) })} />
          <div className="ah-editor__row">
            <label className="ah-field">
              Or a name to search for
              <input value={typed} placeholder="Elixir of the Mongoose" onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTyped())} />
            </label>
            <button type="button" className="btn btn--small" disabled={!typed.trim()} onClick={addTyped}>
              Add name
            </button>
          </div>
        </div>
        <div className="ah-editor__buttons">
          <button type="submit" className="btn btn--accent btn--small" disabled={!draft.name.trim()}>
            Save list
          </button>
          <button type="button" className="btn btn--small" onClick={() => (setDraft(null), setMessage(null))}>
            Cancel
          </button>
          {draft.id && <DeleteButton label="Delete list" onDelete={() => void remove(draft.id!)} />}
        </div>
        <Result message={message} />
      </form>
    );
  }

  const list = lists.data?.shopping ?? [];
  return (
    <div className="ah-rules-list">
      <header className="ah-sectionhead">
        <h3>Shopping lists</h3>
        <button type="button" className="btn btn--small" onClick={() => (setMessage(null), setDraft({ id: null, name: '', items: [] }))}>
          <Icon name="plus" size={13} /> New list
        </button>
      </header>
      <p className="hint">In game, the Uncbox tab at the auction house has one button per list. It finds listings under your max price.</p>
      {lists.error && <Note tone="error">{lists.error}</Note>}
      {lists.data && list.length === 0 && <Note>No shopping lists yet.</Note>}
      <ul className="ah-rows">
        {list.map((l) => (
          <li key={l.id}>
            <div>
              <strong>{l.name}</strong>
              <span className="muted">
                {' '}
                {l.items.length} thing{l.items.length === 1 ? '' : 's'} to look for
              </span>
            </div>
            <button type="button" className="btn btn--small" aria-label={`Edit ${l.name}`} onClick={() => (setMessage(null), setDraft({ id: l.id, name: l.name, items: l.items.map((e) => ({ ...e })) }))}>
              <Icon name="pencil" size={13} /> Edit
            </button>
          </li>
        ))}
      </ul>
      <Result message={message} />
    </div>
  );
}
