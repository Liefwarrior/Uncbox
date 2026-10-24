import { useCallback, useEffect, useState } from 'react';
import { useBoard } from '../../components/boardContext';
import type { MenuEntry } from '../../components/Menu';
import { Panel } from '../../components/Panel';
import type { PanelContext } from '../types';

interface Install {
  flavor: string;
  path: string;
  /** The installed addon's version, or null when it isn't installed there. */
  version: string | null;
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

const MESSAGE_MS = 8000;

/**
 * The Uncbox addon in every WoW install on this PC: what's there, and one click to install,
 * update, reinstall or remove it everywhere.
 */
function useAddon() {
  const [bundled, setBundled] = useState('');
  const [installs, setInstalls] = useState<Install[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  const load = useCallback(
    () =>
      fetch('/api/wow/status')
        .then((r) => (r.ok ? r.json() : null))
        .then((s) => {
          if (!s) return;
          setBundled(s.bundled ?? '');
          setInstalls(s.installs ?? []);
        })
        .catch(() => {}),
    [],
  );
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), MESSAGE_MS);
    return () => clearTimeout(t);
  }, [message]);

  const where = (list: Install[]) => list.map((i) => `WoW ${flavorName(i.flavor)}`).join(' and ');
  const run = async (action: 'install' | 'uninstall') => {
    setBusy(true);
    setMessage(null);
    try {
      if (!installs.length) {
        await post('/api/wow/reveal');
        setMessage({ text: 'Couldn’t find WoW. Copy the Uncbox folder that just opened into WoW’s Interface\\AddOns folder.' });
        return;
      }
      await post(`/api/wow/${action}`);
      setMessage({
        text:
          action === 'install'
            ? `Installed in ${where(installs)}. Type /reload in WoW (or restart it). If WoW calls it out of date, tick Load out of date AddOns.`
            : `Removed from ${where(installs)}. Type /reload in WoW to unload it.`,
      });
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
      void load();
    }
  };

  const installed = installs.filter((i) => i.version !== null);
  const outdated = installed.some((i) => i.version !== bundled) || (installed.length > 0 && installed.length < installs.length);
  const installLabel = !installed.length ? 'Install the addon' : outdated ? `Update the addon to ${bundled}` : 'Reinstall the addon';
  const menu: MenuEntry[] = [
    { label: installLabel, icon: 'reset', disabled: busy, onSelect: () => void run('install') },
    installed.length > 0 && {
      label: 'Remove the addon',
      icon: 'x',
      disabled: busy,
      confirm: 'Click again to remove it from WoW',
      onSelect: () => void run('uninstall'),
    },
  ];
  return { installed, outdated, bundled, busy, message, run, menu };
}

/** The WoW quest log, read-only: the addon keeps it up to date. */
export function QuestsPanel({ data, title }: PanelContext) {
  const { quests } = data;
  const linked = data.wowLinkAt > 0;
  const { editing } = useBoard();
  const addon = useAddon();
  return (
    <Panel id="quests" title={title} empty={quests.length === 0} menu={addon.menu}>
      {editing && addon.message && <p className={`addon-message ${addon.message.error ? 'error' : ''}`}>{addon.message.text}</p>}
      {editing && !addon.message && linked && addon.outdated && (
        <button className="btn btn--small addon-message" onClick={() => void addon.run('install')}>
          Update the WoW addon to {addon.bundled}
        </button>
      )}
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
        <Setup addon={addon} />
      ) : null}
    </Panel>
  );
}

function Setup({ addon }: { addon: ReturnType<typeof useAddon> }) {
  return (
    <div className="voice__setup no-drag">
      <ol>
        <li>Install the Uncbox addon.</li>
        <li>
          Start WoW, or type <code>/reload</code> if it’s open.
        </li>
        <li>Show WoW in the game panel: as a Window, or with Play here and clips on.</li>
      </ol>
      <button className="btn btn--accent" data-setup="" disabled={addon.busy} onClick={() => void addon.run('install')}>
        {addon.installed.length ? (addon.outdated ? `Update addon to ${addon.bundled}` : 'Reinstall addon') : 'Install addon'}
      </button>
      <p className="hint">
        The addon flashes a thin strip along the game’s top edge when something changes. Uncbox reads it and crops it out.
      </p>
    </div>
  );
}
