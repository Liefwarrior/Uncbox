import { useCallback, useId, useMemo, useState } from 'react';
import { usePrivate } from '../../privacy';
import type { BodyProps, SettingsProps } from '../types';
import { type AhStatus, hidesGold } from './ah';
import { AccountingTab } from './AccountingTab';
import { AhContext, type AhContextValue, useAh, useAhContext, useWowahTick, type Where } from './api';
import { CraftingTab } from './CraftingTab';
import { DealsTab } from './DealsTab';
import { OverviewTab } from './OverviewTab';
import { RulesTab } from './RulesTab';
import { SearchTab } from './SearchTab';
import { SellingTab } from './SellingTab';
import { NoData } from './Setup';
import type { AhTab, AuctionHouseSettings } from './settings';
import { Note, Tabs } from './Ui';

/** The realm and faction picked in the settings, if the scans still have them. */
export function pickedRealm(status: AhStatus | null, settings: Pick<AuctionHouseSettings, 'realm' | 'faction'>): Where | null {
  if (!status || !settings.realm || !settings.faction) return null;
  return status.realms.some((r) => r.realm === settings.realm && r.faction === settings.faction) ? { realm: settings.realm, faction: settings.faction } : null;
}

function Tab({ tab, status, settings, set, item, onItem, reloadStatus }: { tab: AhTab; status: AhStatus; settings: AuctionHouseSettings; set: (patch: Partial<AuctionHouseSettings>) => void; item: string | null; onItem: (item: string | null) => void; reloadStatus: () => void }) {
  // The rules can be written before anything has been scanned; everything else needs data.
  if (tab === 'rules') return <RulesTab />;
  const empty = <NoData status={status} onInstalled={reloadStatus} />;
  if (!status.available || status.realms.length === 0) return empty;
  switch (tab) {
    case 'overview':
      return <OverviewTab status={status} onPick={(w) => set({ realm: w?.realm ?? '', faction: w?.faction ?? '' })} onInstalled={reloadStatus} />;
    case 'search':
      return <SearchTab query={settings.query} item={item} onItem={onItem} />;
    case 'deals':
      return <DealsTab />;
    case 'crafting':
      return <CraftingTab />;
    case 'selling':
      return <SellingTab />;
    case 'accounting':
      return <AccountingTab />;
  }
}

function Content({ settings, set, item, setItem }: { settings: AuctionHouseSettings; set: (patch: Partial<AuctionHouseSettings>) => void; item: string | null; setItem: (item: string | null) => void }) {
  const outer = useAhContext();
  const status = useAh<AhStatus>('/status', { scoped: false });
  const where = useMemo(() => pickedRealm(status.data, settings), [status.data, settings.realm, settings.faction]); // eslint-disable-line react-hooks/exhaustive-deps
  const value = useMemo<AhContextValue>(() => ({ ...outer, where }), [outer, where]);
  const panel = useId();

  const onTab = (tab: AhTab) => {
    // Pressing Search again comes back from an item to the list.
    if (tab === 'search' && settings.tab === 'search') setItem(null);
    set({ tab });
  };

  return (
    <AhContext.Provider value={value}>
      <Tabs tab={settings.tab} onTab={onTab} panelId={panel} />
      <div id={panel} className="ah-panel" role="tabpanel" aria-labelledby={`${panel}-tab-${settings.tab}`}>
        {status.error && !status.data ? (
          <Note tone="error">{status.error}</Note>
        ) : !status.data ? (
          <Note>Loading…</Note>
        ) : (
          <Tab tab={settings.tab} status={status.data} settings={settings} set={set} item={item} onItem={setItem} reloadStatus={status.reload} />
        )}
      </div>
    </AhContext.Provider>
  );
}

/**
 * The Auction House: a workbench for the open market, from what the UncboxAH addon scanned.
 * Tabs for an overview, searching items, deals and flips, crafting profit, what to sell,
 * accounting and the rules sent back to the game. It reads again whenever new data is ingested.
 */
export function AuctionHouseBody({ settings, set }: BodyProps<AuctionHouseSettings>) {
  const priv = usePrivate();
  const tick = useWowahTick();
  const [item, setItem] = useState<string | null>(null);
  const goTab = useCallback((tab: AhTab) => set({ tab }), [set]);
  const openItem = useCallback(
    (key: string) => {
      setItem(key);
      set({ tab: 'search' });
    },
    [set],
  );
  const value = useMemo<AhContextValue>(() => ({ tick, where: null, hideGold: hidesGold(priv, settings), goTab, openItem }), [tick, priv, settings, goTab, openItem]);
  return (
    <AhContext.Provider value={value}>
      <div className="ah no-drag">
        <Content settings={settings} set={set} item={item} setItem={setItem} />
      </div>
    </AhContext.Provider>
  );
}

export function AuctionHouseSettingsForm({ settings, set }: SettingsProps<AuctionHouseSettings>) {
  return (
    <>
      <label className="inline">
        <input type="checkbox" checked={settings.showGoldOnStream} onChange={(e) => set({ showGoldOnStream: e.target.checked })} /> Show gold on stream
      </label>
      <p className="hint">While you’re on air (stream mode, OBS live, or the On air switch) your gold, sales and purchases are hidden unless this is on. Item prices are never hidden.</p>
    </>
  );
}
