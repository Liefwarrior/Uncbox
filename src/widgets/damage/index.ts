import { defineWidget } from '../types';
import { DamagePanel } from './DamagePanel';

export const damage = defineWidget({
  kind: 'damage',
  name: 'Damage',
  hint: 'Damage dealt and taken, from the T screen',
  icon: 'zap',
  category: 'SMITE 2',
  keywords: 'dealt taken combat',
  presets: ['smite2'],
  single: true,
  w: 8,
  h: 9,
  minW: 4,
  minH: 5,
  panel: DamagePanel,
});
