import { defineWidget } from '../types';
import { RecordPanel } from './RecordPanel';

export const record = defineWidget({
  kind: 'record',
  name: 'Session',
  hint: 'Wins, losses and streak',
  icon: 'trophy',
  category: 'SMITE 2',
  keywords: 'wins losses streak history record',
  presets: ['smite2'],
  single: true,
  w: 5,
  h: 7,
  minW: 4,
  minH: 5,
  panel: RecordPanel,
});
