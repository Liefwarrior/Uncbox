import { defineWidget } from '../types';
import { MatchPanel } from './MatchPanel';

export const match = defineWidget({
  kind: 'match',
  name: 'Match',
  hint: 'Kills, deaths and assists',
  icon: 'flame',
  category: 'SMITE 2',
  keywords: 'kda god role mode kills deaths assists',
  presets: ['smite2'],
  single: true,
  w: 5,
  h: 7,
  minW: 4,
  minH: 6,
  panel: MatchPanel,
});
