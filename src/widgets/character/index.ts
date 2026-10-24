import { defineWidget } from '../types';
import { CharacterPanel } from './CharacterPanel';

export const character = defineWidget({
  kind: 'character',
  name: 'Character',
  hint: 'Level, XP, zone and gold',
  icon: 'gem',
  category: 'WoW',
  keywords: 'level xp zone gold hardcore sheet',
  presets: ['wow'],
  single: true,
  w: 7,
  h: 8,
  minW: 5,
  minH: 6,
  panel: CharacterPanel,
});
