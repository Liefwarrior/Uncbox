import { useState } from 'react';
import { type ItemRow, itemLabel } from './ah';
import { ahRequest } from './api';
import { Icon } from '../../components/Icon';
import { GroupsPanel } from './RulesGroups';
import { OperationsPanel } from './RulesOperations';
import { ItemPicker, PreviewItemContext, Result } from './RulesShared';
import { ShoppingPanel } from './RulesShopping';
import { Choice } from './Ui';

type Part = 'groups' | 'operations' | 'shopping' | 'send';
const PARTS = [
  { id: 'groups', label: 'Groups' },
  { id: 'operations', label: 'Posting and shopping rules' },
  { id: 'shopping', label: 'Shopping lists' },
  { id: 'send', label: 'Send to game' },
] as const;

/** "Send to game": the rules reach the addon through a file it reads on /reload. */
function SendToGame() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const send = async () => {
    setBusy(true);
    try {
      const done = await ahRequest<{ dataFile: string | null }>('POST', '/refresh', {});
      setMessage(
        done.dataFile
          ? { text: 'Written. Type /reload in WoW to load your prices and rules.' }
          : { text: 'There is no UncboxAH addon folder to write to yet. Install the WoW addons first (Overview tab), then try again.', error: true },
      );
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ah-send">
      <h3>Send to game</h3>
      <p>
        WoW can’t read files while you play, so your groups, rules and shopping lists reach the game in a file Uncbox writes into the addon’s folder. Every time you save a rule it is written again.
        The game loads it when you type <code>/reload</code> (or log out and back in).
      </p>
      <p className="muted">Press the button to read WoW’s saved files again and write the file now.</p>
      <button type="button" className="btn btn--accent" disabled={busy} onClick={() => void send()}>
        <Icon name="refresh" size={14} /> Refresh and write the game file
      </button>
      <Result message={message} />
    </div>
  );
}

/** Groups, posting and shopping rules, and shopping lists; what you set here reaches the game on /reload. */
export function RulesTab() {
  const [part, setPart] = useState<Part>('groups');
  const [preview, setPreview] = useState<{ key: string; label: string } | null>(null);
  const picks = (it: ItemRow) => setPreview({ key: it.item, label: itemLabel(it.name, it.item) });

  return (
    <PreviewItemContext.Provider value={preview?.key ?? null}>
      <div className="ah-rules">
        <Choice label="Rules section" value={part} options={PARTS} onChange={setPart} />
        {(part === 'operations' || part === 'shopping') && (
          <div className="ah-previewbar">
            <span>
              Formula previews use: <strong>{preview ? preview.label : 'no item yet'}</strong>
            </span>
            {preview && (
              <button type="button" className="btn btn--small" onClick={() => setPreview(null)}>
                Clear
              </button>
            )}
            <ItemPicker label="Preview formulas against an item" placeholder="Pick an item to preview prices" onPick={picks} />
          </div>
        )}
        {part === 'groups' && <GroupsPanel />}
        {part === 'operations' && <OperationsPanel />}
        {part === 'shopping' && <ShoppingPanel />}
        {part === 'send' && <SendToGame />}
      </div>
    </PreviewItemContext.Provider>
  );
}
