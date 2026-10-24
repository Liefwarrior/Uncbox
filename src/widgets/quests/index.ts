import { defineWidget } from '../types';
import { QuestsPanel } from './QuestsPanel';

export const quests = defineWidget({
  kind: 'quests',
  name: 'Quest log',
  hint: 'Your quests, live from WoW',
  icon: 'list',
  category: 'WoW',
  keywords: 'objectives addon',
  presets: ['wow'],
  single: true,
  w: 5,
  h: 8,
  minW: 4,
  minH: 4,
  panel: QuestsPanel,
});
