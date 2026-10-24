import { defineWidget } from '../types';
import { AuctionHouseBody, AuctionHouseSettingsForm } from './AuctionHouseWidget';
import { auctionHouseForSharing, cleanAuctionHouseSettings, defaultAuctionHouseSettings } from './settings';

export const auctionhouse = defineWidget({
  kind: 'auctionhouse',
  name: 'Auction House',
  hint: 'Prices, deals and your auctions, from WoW',
  icon: 'coins',
  category: 'WoW',
  keywords: 'ah auction market prices deals flips crafting gold accounting tsm auctionator tradeskillmaster sell scan',
  presets: ['wow'],
  onlyOne: true,
  // A workbench: it starts big, and still shows the tabs (with fewer columns) when it is small.
  w: 12,
  h: 12,
  minW: 5,
  minH: 5,
  defaults: defaultAuctionHouseSettings,
  clean: cleanAuctionHouseSettings,
  forSharing: auctionHouseForSharing,
  body: AuctionHouseBody,
  settings: AuctionHouseSettingsForm,
});
