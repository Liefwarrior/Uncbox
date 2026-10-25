import { useState } from 'react';
import { Icon } from '../../components/Icon';
import { formatMoney, parseMoney } from '../../money';
import { isDefaultOperation, type Operation, type PostOperation, type ShopOperation } from './ah';
import { ahRequest, useAh } from './api';
import { DeleteButton, FormulaField, Result } from './RulesShared';
import { Note } from './Ui';

/** An operation as it is typed: everything is text until it is saved. */
interface Draft {
  id: string | null;
  kind: 'post' | 'shop';
  name: string;
  minPrice: string;
  normalPrice: string;
  maxPrice: string;
  undercut: string;
  stackSize: string;
  stacks: string;
  duration: string;
  keepQuantity: string;
  /** Shopping only, as a percent. */
  minSaleRate: string;
}

const blank = (kind: 'post' | 'shop'): Draft => ({
  id: null,
  kind,
  name: '',
  minPrice: 'first(70% dbmarket, 70% dbhistorical)',
  normalPrice: 'first(dbmarket, dbminbuyout, dbhistorical)',
  maxPrice: kind === 'post' ? '300% first(dbmarket, dbhistorical, dbminbuyout)' : 'first(80% dbmarket, 80% dbhistorical)',
  undercut: '1c',
  stackSize: '1',
  stacks: '1',
  duration: '24',
  keepQuantity: '0',
  minSaleRate: '0',
});

const fromOperation = (o: Operation): Draft =>
  o.kind === 'post'
    ? { ...blank('post'), id: o.id, name: o.name, minPrice: o.minPrice, normalPrice: o.normalPrice, maxPrice: o.maxPrice, undercut: formatMoney(o.undercut), stackSize: String(o.stackSize), stacks: String(o.stacks), duration: String(o.duration), keepQuantity: String(o.keepQuantity) }
    : { ...blank('shop'), id: o.id, name: o.name, maxPrice: o.maxPrice, minSaleRate: String(Math.round(o.minSaleRate * 100)) };

/** What goes to the server for a draft, or what is wrong with it. The server checks the formulas. */
export function operationBody(d: Draft): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  if (!d.name.trim()) return { ok: false, error: 'Give it a name.' };
  if (d.kind === 'shop') {
    const rate = d.minSaleRate.trim() === '' ? 0 : Number(d.minSaleRate);
    if (!(rate >= 0 && rate <= 100)) return { ok: false, error: 'Min sale rate must be between 0 and 100.' };
    return { ok: true, body: { kind: 'shop', name: d.name.trim(), maxPrice: d.maxPrice.trim(), minSaleRate: rate / 100 } };
  }
  const undercut = parseMoney(d.undercut);
  if (undercut === null) return { ok: false, error: 'Write the undercut like 1c, 50c or 1s.' };
  return {
    ok: true,
    body: {
      kind: 'post',
      name: d.name.trim(),
      minPrice: d.minPrice.trim(),
      normalPrice: d.normalPrice.trim(),
      maxPrice: d.maxPrice.trim(),
      undercut,
      stackSize: Number(d.stackSize),
      stacks: Number(d.stacks),
      duration: Number(d.duration),
      keepQuantity: Number(d.keepQuantity),
    },
  };
}

function Editor({ draft, setDraft, onSave, onCancel, onDelete, message }: { draft: Draft; setDraft: (d: Draft) => void; onSave: () => void; onCancel: () => void; onDelete: (() => void) | null; message: { text: string; error?: boolean } | null }) {
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const post = draft.kind === 'post';
  return (
    <form className="ah-editor" aria-label={draft.id ? `Edit ${draft.name}` : `New ${post ? 'posting' : 'shopping'} rule`} onSubmit={(e) => (e.preventDefault(), onSave())}>
      <h3>{draft.id ? 'Edit' : 'New'} {post ? 'posting rule' : 'shopping rule'}</h3>
      <label className="ah-field">
        Name
        <input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder={post ? 'Herbs, 24 hours' : 'Cheap herbs'} />
      </label>
      {post ? (
        <>
          <FormulaField label="Never post below" value={draft.minPrice} onChange={(v) => set({ minPrice: v })} hint="The lowest price you will sell at." />
          <FormulaField label="Normal price" value={draft.normalPrice} onChange={(v) => set({ normalPrice: v })} hint="Used when undercutting would go below the minimum." />
          <FormulaField label="Never post above" value={draft.maxPrice} onChange={(v) => set({ maxPrice: v })} />
          <div className="ah-editor__row">
            <label className="ah-field">
              Undercut by
              <input value={draft.undercut} onChange={(e) => set({ undercut: e.target.value })} />
            </label>
            <label className="ah-field">
              Stack size
              <input inputMode="numeric" value={draft.stackSize} onChange={(e) => set({ stackSize: e.target.value })} />
            </label>
            <label className="ah-field">
              Stacks
              <input inputMode="numeric" value={draft.stacks} onChange={(e) => set({ stacks: e.target.value })} />
            </label>
            <label className="ah-field">
              Duration
              <select value={draft.duration} onChange={(e) => set({ duration: e.target.value })}>
                <option value="12">12 hours</option>
                <option value="24">24 hours</option>
                <option value="48">48 hours</option>
              </select>
            </label>
            <label className="ah-field">
              Keep in bags
              <input inputMode="numeric" value={draft.keepQuantity} onChange={(e) => set({ keepQuantity: e.target.value })} />
            </label>
          </div>
        </>
      ) : (
        <>
          <FormulaField label="Pay at most" value={draft.maxPrice} onChange={(v) => set({ maxPrice: v })} hint="The most to pay for one." />
          <label className="ah-field">
            Only items that sell at least this often (%)
            <input inputMode="numeric" value={draft.minSaleRate} onChange={(e) => set({ minSaleRate: e.target.value })} />
          </label>
        </>
      )}
      <div className="ah-editor__buttons">
        <button type="submit" className="btn btn--accent btn--small">
          Save rule
        </button>
        <button type="button" className="btn btn--small" onClick={onCancel}>
          Cancel
        </button>
        {onDelete && <DeleteButton label="Delete rule" onDelete={onDelete} />}
      </div>
      <Result message={message} />
    </form>
  );
}

const describe = (o: Operation): string =>
  o.kind === 'post'
    ? `Posts ${(o as PostOperation).stacks} × ${(o as PostOperation).stackSize} for ${(o as PostOperation).duration} h, normal price ${(o as PostOperation).normalPrice}`
    : `Pays at most ${(o as ShopOperation).maxPrice}`;

/** Posting and shopping rules (what TradeSkillMaster calls operations), with a live preview of every formula. */
export function OperationsPanel() {
  const ops = useAh<{ operations: Operation[] }>('/operations', { scoped: false });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  const save = async () => {
    if (!draft) return;
    const made = operationBody(draft);
    if (!made.ok) return setMessage({ text: made.error, error: true });
    try {
      if (draft.id) await ahRequest('PUT', `/operations/${encodeURIComponent(draft.id)}`, made.body);
      else await ahRequest('POST', '/operations', made.body);
      setMessage({ text: `Saved ${draft.name.trim()}.` });
      setDraft(null);
      ops.reload();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    }
  };
  const remove = async (id: string) => {
    try {
      await ahRequest('DELETE', `/operations/${encodeURIComponent(id)}`);
      setMessage({ text: 'Deleted. Groups that used it go back to the default.' });
      setDraft(null);
      ops.reload();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    }
  };

  if (draft) {
    return <Editor draft={draft} setDraft={setDraft} onSave={() => void save()} onCancel={() => (setDraft(null), setMessage(null))} onDelete={draft.id && !isDefaultOperation(draft.id) ? () => void remove(draft.id!) : null} message={message} />;
  }

  const list = ops.data?.operations ?? [];
  const section = (kind: 'post' | 'shop', title: string) => (
    <section aria-label={title}>
      <header className="ah-sectionhead">
        <h3>{title}</h3>
        <button type="button" className="btn btn--small" onClick={() => (setMessage(null), setDraft(blank(kind)))}>
          <Icon name="plus" size={13} /> New
        </button>
      </header>
      <ul className="ah-rows">
        {list
          .filter((o) => o.kind === kind)
          .map((o) => (
            <li key={o.id}>
              <div>
                <strong>{o.name}</strong>
                <span className="muted"> {describe(o)}</span>
              </div>
              <button type="button" className="btn btn--small" aria-label={`Edit ${o.name}`} onClick={() => (setMessage(null), setDraft(fromOperation(o)))}>
                <Icon name="pencil" size={13} /> Edit
              </button>
            </li>
          ))}
      </ul>
    </section>
  );

  return (
    <div className="ah-rules-list">
      {ops.error && <Note tone="error">{ops.error}</Note>}
      {section('post', 'Posting rules')}
      {section('shop', 'Shopping rules')}
      <Result message={message} />
    </div>
  );
}
