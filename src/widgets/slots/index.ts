import { defineWidget } from '../types';
import { SlotsPanel } from './SlotsPanel';

export const slots = defineWidget({
  kind: 'slots',
  name: 'Party',
  hint: 'Pictures with names',
  icon: 'image',
  category: 'Gaming',
  keywords: 'team build loadout pokemon items group members',
  presets: ['pokemon', 'smite2', 'wow', 'mcd2', 'terminal'],
  single: true,
  w: 7,
  h: 11,
  minW: 4,
  minH: 4,
  panel: SlotsPanel,
});
