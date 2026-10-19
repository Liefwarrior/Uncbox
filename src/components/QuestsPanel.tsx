import { useState } from 'react';
import type { Quest } from '../state/model';
import { useBoard } from './Board';
import { Panel } from './Panel';

interface Install {
  flavor: string;
  path: string;
}

const post = (url: string, body?: object) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(
    async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => null))?.error ?? r.statusText))),
  );

/** "_classic_era_" → "classic era"; the WoW Forever beta lives in _classic_beta_. */
const flavorName = (flavor: string) =>
  flavor === '_classic_beta_' ? 'Forever beta' : flavor.replace(/^_+|_+$/g, '').replace(/_/g, ' ');

/** "Kobold Vermin slain: 4/10" → ["Kobold Vermin slain", "4/10"] */
function splitProgress(text: string): [string, string] {
  const m = /^(.*?):\s*(\d+)\s*\/\s*(\d+)$/.exec(text);
  return m ? [m[1], `${m[2]}/${m[3]}`] : [text, ''];
}

/** The WoW quest log, read-only: the addon keeps it up to date. */
export function QuestsPanel({ quests, linked, title }: { quests: Quest[]; linked: boolean; title: string }) {
  const { editing } = useBoard();
  return (
    <Panel id="quests" title={title} empty={quests.length === 0}>
      {quests.length > 0 ? (
        <ol className="quests">
          {quests.map((q, i) => (
            <li key={`${i}-${q.title}`} className={`quest quest--${q.state}`}>
              <p className="quest__head">
                {q.level > 0 && <span className="quest__level">[{q.level}]</span>}
                <span className="quest__title">{q.title}</span>
                {q.state !== 'open' && <span className="quest__tag">{q.state === 'complete' ? 'Complete' : 'Failed'}</span>}
              </p>
              {q.objectives.length > 0 && (
                <ul className="quest__goals">
                  {q.objectives.map((o, j) => {
                    const [text, count] = splitProgress(o.text);
                    return (
                      <li key={j} className={o.done ? 'is-done' : ''}>
                        <span>{text}</span>
                        {count && <span className="quest__count">{count}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          ))}
        </ol>
      ) : linked ? (
        <p className="muted">Your quest log is empty.</p>
      ) : editing ? (
        <Setup />
      ) : null}
    </Panel>
  );
}

function Setup() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const fail = (err: unknown) => setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
  const [choices, setChoices] = useState<Install[]>([]);

  const install = (to: Install) =>
    post('/api/wow/install', { path: to.path })
      .then(() => {
        setChoices([]);
        setMessage({
          text: `Installed for WoW ${flavorName(to.flavor)}. If WoW calls it out of date, tick Load out of date AddOns.`,
        });
      })
      .catch(fail);

  const start = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const { installs } = (await fetch('/api/wow/installs').then((r) => r.json())) as { installs: Install[] };
      if (installs.length === 1) await install(installs[0]);
      else if (installs.length > 1) setChoices(installs);
      else {
        await post('/api/wow/reveal');
        setMessage({ text: 'Couldn’t find WoW. Copy the Uncbox folder that just opened into WoW’s Interface\\AddOns folder.' });
      }
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="voice__setup no-drag">
      <ol>
        <li>Install the Uncbox addon.</li>
        <li>
          Start WoW, or type <code>/reload</code> if it’s open.
        </li>
        <li>Show WoW in the game window as a Window.</li>
      </ol>
      {choices.length > 0 ? (
        <div className="row">
          {choices.map((c) => (
            <button key={c.path} className="btn" onClick={() => void install(c)}>
              WoW {flavorName(c.flavor)}
            </button>
          ))}
        </div>
      ) : (
        <button className="btn btn--accent" data-setup="" disabled={busy} onClick={() => void start()}>
          Install addon
        </button>
      )}
      {message && <p className={message.error ? 'error' : 'muted'}>{message.text}</p>}
      <p className="hint">
        The addon flashes a thin strip along the game’s top edge when something changes. Uncbox reads it and crops it out.
      </p>
    </div>
  );
}
