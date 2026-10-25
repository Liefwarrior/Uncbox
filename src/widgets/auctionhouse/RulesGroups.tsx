import { useState } from 'react';
import { Icon } from '../../components/Icon';
import { type Group, type Operation, withItem } from './ah';
import { ahRequest, useAh } from './api';
import { DeleteButton, ItemPicker, Result, useItemNames } from './RulesShared';
import { Note } from './Ui';

interface Draft {
  /** The id of the group being changed; null for a new one. */
  id: string | null;
  name: string;
  items: string[];
  postOperation: string;
  shopOperation: string;
}

const blank = (): Draft => ({ id: null, name: '', items: [], postOperation: 'default-post', shopOperation: 'default-shop' });
const fromGroup = (g: Group): Draft => ({ id: g.id, name: g.name, items: [...g.items], postOperation: g.postOperation, shopOperation: g.shopOperation });

/** What goes to the server for a draft. */
export const groupBody = (d: Draft) => ({ name: d.name.trim(), items: d.items, postOperation: d.postOperation, shopOperation: d.shopOperation });

/** Groups: lists of items that share a posting rule and a shopping rule. */
export function GroupsPanel() {
  const groups = useAh<{ groups: Group[] }>('/groups', { scoped: false });
  const operations = useAh<{ operations: Operation[] }>('/operations', { scoped: false });
  const nameOf = useItemNames();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  const posts = (operations.data?.operations ?? []).filter((o) => o.kind === 'post');
  const shops = (operations.data?.operations ?? []).filter((o) => o.kind === 'shop');
  const opName = (id: string) => operations.data?.operations.find((o) => o.id === id)?.name ?? id;

  const save = async () => {
    if (!draft) return;
    try {
      if (draft.id) await ahRequest('PUT', `/groups/${encodeURIComponent(draft.id)}`, groupBody(draft));
      else await ahRequest('POST', '/groups', groupBody(draft));
      setMessage({ text: `Saved ${draft.name.trim()}.` });
      setDraft(null);
      groups.reload();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    }
  };
  const remove = async (id: string) => {
    try {
      await ahRequest('DELETE', `/groups/${encodeURIComponent(id)}`);
      setMessage({ text: 'Deleted.' });
      setDraft(null);
      groups.reload();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    }
  };

  if (draft) {
    const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
    return (
      <form className="ah-editor" aria-label={draft.id ? `Edit ${draft.name}` : 'New group'} onSubmit={(e) => (e.preventDefault(), void save())}>
        <h3>{draft.id ? 'Edit group' : 'New group'}</h3>
        <label className="ah-field">
          Name
          <input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Herbs" />
        </label>
        <div className="ah-editor__row">
          <label className="ah-field">
            Posting rule
            <select value={draft.postOperation} onChange={(e) => set({ postOperation: e.target.value })}>
              {posts.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <label className="ah-field">
            Shopping rule
            <select value={draft.shopOperation} onChange={(e) => set({ shopOperation: e.target.value })}>
              {shops.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="ah-field">
          Items ({draft.items.length})
          <ul className="ah-chips" aria-label="Items in this group">
            {draft.items.map((key) => (
              <li key={key} className="ah-chip">
                {nameOf(key)}
                <button type="button" className="icon-btn" aria-label={`Remove ${nameOf(key)}`} onClick={() => set({ items: draft.items.filter((i) => i !== key) })}>
                  <Icon name="x" size={12} />
                </button>
              </li>
            ))}
          </ul>
          {draft.items.length === 0 && <Note>No items yet. Search below to add some.</Note>}
          <ItemPicker label="Add an item" onPick={(it) => set({ items: withItem(draft.items, it.item) })} />
        </div>
        <div className="ah-editor__buttons">
          <button type="submit" className="btn btn--accent btn--small" disabled={!draft.name.trim()}>
            Save group
          </button>
          <button type="button" className="btn btn--small" onClick={() => (setDraft(null), setMessage(null))}>
            Cancel
          </button>
          {draft.id && <DeleteButton label="Delete group" onDelete={() => void remove(draft.id!)} />}
        </div>
        <Result message={message} />
      </form>
    );
  }

  const list = groups.data?.groups ?? [];
  return (
    <div className="ah-rules-list">
      <header className="ah-sectionhead">
        <h3>Groups</h3>
        <button type="button" className="btn btn--small" onClick={() => (setMessage(null), setDraft(blank()))}>
          <Icon name="plus" size={13} /> New group
        </button>
      </header>
      <p className="hint">A group is a list of items that share a posting rule and a shopping rule, like TradeSkillMaster’s groups.</p>
      {groups.error && <Note tone="error">{groups.error}</Note>}
      {groups.data && list.length === 0 && <Note>No groups yet. Make one for the items you sell the same way.</Note>}
      <ul className="ah-rows">
        {list.map((g) => (
          <li key={g.id}>
            <div>
              <strong>{g.name}</strong>
              <span className="muted">
                {' '}
                {g.items.length} item{g.items.length === 1 ? '' : 's'} · posts with {opName(g.postOperation)} · shops with {opName(g.shopOperation)}
              </span>
            </div>
            <button type="button" className="btn btn--small" onClick={() => (setMessage(null), setDraft(fromGroup(g)))} aria-label={`Edit ${g.name}`}>
              <Icon name="pencil" size={13} /> Edit
            </button>
          </li>
        ))}
      </ul>
      <Result message={message} />
    </div>
  );
}
