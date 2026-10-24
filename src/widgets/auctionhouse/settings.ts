import type { Widget } from '../../state/model';

/** The widget's tabs, in the order they are drawn. */
export const AH_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'search', label: 'Search' },
  { id: 'deals', label: 'Deals' },
  { id: 'crafting', label: 'Crafting' },
  { id: 'selling', label: 'Selling' },
  { id: 'accounting', label: 'Accounting' },
  { id: 'rules', label: 'Rules' },
] as const;

export type AhTab = (typeof AH_TABS)[number]['id'];

const isTab = (v: unknown): v is AhTab => AH_TABS.some((t) => t.id === v);

export type AuctionHouseSettings = {
  /** The tab that was open last. */
  tab: AhTab;
  /** What to look for in Search. The palette's "AH: search" fills it in. */
  query: string;
  /** The realm and faction picked when more than one has been scanned; '' follows the newest scan. */
  realm: string;
  faction: string;
  /** Stream mode hides gold totals and accounting unless this is on. */
  showGoldOnStream: boolean;
};

export const defaultAuctionHouseSettings = (): AuctionHouseSettings => ({
  tab: 'overview',
  query: '',
  realm: '',
  faction: '',
  showGoldOnStream: false,
});

export function cleanAuctionHouseSettings(s: AuctionHouseSettings): AuctionHouseSettings {
  if (!isTab(s.tab)) s.tab = 'overview';
  s.query = s.query.slice(0, 80);
  s.realm = s.realm.slice(0, 80);
  s.faction = s.faction.slice(0, 40);
  return s;
}

/** Realm, search and tab only mean something on this PC's scans, so a shared preset starts fresh. */
export function auctionHouseForSharing(s: AuctionHouseSettings): AuctionHouseSettings {
  return { ...s, query: '', realm: '', faction: '' };
}

/** An Auction House widget; its settings are typed. */
export const isAuctionHouseWidget = (w: Widget): w is Widget<AuctionHouseSettings> => w.kind === 'auctionhouse';
