import { defineWidget } from '../types';
import { LootBody, LootSettingsForm } from './LootWidget';
import { cleanLootSettings, defaultLootSettings } from './settings';

export const raidloot = defineWidget({
  kind: 'raidloot',
  name: 'Raid loot',
  hint: 'What dropped and who got it, and who is due a drop',
  icon: 'gem',
  category: 'WoW',
  keywords: 'raid loot drops history fair loot council dkp wowhead item epic csv export',
  presets: ['wow'],
  w: 8,
  h: 10,
  minW: 3,
  minH: 3,
  defaults: defaultLootSettings,
  clean: cleanLootSettings,
  body: LootBody,
  settings: LootSettingsForm,
});
