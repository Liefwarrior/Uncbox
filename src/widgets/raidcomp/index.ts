import { defineWidget } from '../types';
import { RaidCompBody } from './RaidCompWidget';
import { cleanCompSettings, compForSharing, defaultCompSettings } from './settings';

export const raidcomp = defineWidget({
  kind: 'raidcomp',
  name: 'Raid composition',
  hint: 'Your raid by group: roles, classes, buffs, who is down',
  icon: 'shield',
  category: 'WoW',
  keywords: 'raid group party composition tank healer dps class buffs ready check dead offline subgroup',
  presets: ['wow'],
  w: 8,
  h: 12,
  minW: 3,
  minH: 2,
  defaults: defaultCompSettings,
  clean: cleanCompSettings,
  forSharing: compForSharing,
  body: RaidCompBody,
});
