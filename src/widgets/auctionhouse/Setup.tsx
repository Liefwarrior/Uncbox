import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import type { AhStatus } from './ah';

// The first-run screens: the addon isn't installed, or it hasn't scanned anything yet.

const MESSAGE_MS = 12_000;

/** Installs the WoW addons (the Uncbox one and UncboxAH) into every WoW install found, like the quest log's button. */
export function useInstallAddons(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), MESSAGE_MS);
    return () => clearTimeout(t);
  }, [message]);

  const install = async () => {
    setBusy(true);
    setMessage(null);
    const post = async (route: string) => {
      const r = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(body?.error ?? r.statusText);
      return body as { paths?: string[] };
    };
    try {
      const done = await post('/api/wow/install');
      if (!done.paths?.length) {
        await post('/api/wow/reveal');
        setMessage({ text: 'Couldn’t find WoW. Copy the Uncbox folders that just opened into WoW’s Interface\\AddOns folder.' });
      } else {
        setMessage({ text: 'Installed. Type /reload in WoW (or restart it). If WoW calls it out of date, tick Load out of date AddOns.' });
      }
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
      onDone();
    }
  };
  return { install, busy, message };
}

/** The button, and what happened when it was pressed. */
export function InstallButton({ label = 'Install the WoW addons', onDone }: { label?: string; onDone: () => void }) {
  const { install, busy, message } = useInstallAddons(onDone);
  return (
    <>
      <button type="button" className="btn btn--accent" disabled={busy} onClick={() => void install()}>
        <Icon name="download" size={14} /> {label}
      </button>
      {message && (
        <p className={`ah-note ${message.error ? 'error' : 'muted'}`} role="status">
          {message.text}
        </p>
      )}
    </>
  );
}

/**
 * What to show instead of a tab while there is nothing to read: the engine can't run, the addon
 * isn't installed, or nothing has been scanned. Null once there is data.
 */
export function NoData({ status, onInstalled }: { status: AhStatus; onInstalled: () => void }) {
  if (!status.available) {
    return (
      <div className="ah-empty">
        <h3>The auction house tools need a newer Node</h3>
        <p className="muted">Uncbox keeps its auction data in a small database that needs Node 22.5 or newer. Update Node, then restart Uncbox.</p>
      </div>
    );
  }
  if (!status.addonInstalled && status.realms.length === 0) {
    return (
      <div className="ah-empty">
        <h3>Install the WoW addons</h3>
        <p className="muted">Uncbox reads the auction house through a small WoW addon. Install it, then scan the auction house once.</p>
        <InstallButton onDone={onInstalled} />
      </div>
    );
  }
  if (status.realms.length === 0) {
    return (
      <div className="ah-empty">
        <h3>No auction house data yet</h3>
        <p>
          Open the auction house in WoW and type <code>/uah scan</code>, then <code>/reload</code>.
        </p>
        <p className="muted">Uncbox picks the scan up within a few seconds of the reload and fills this in.</p>
      </div>
    );
  }
  return null;
}
