import { defineWidget } from '../types';
import { ProgressPanel } from './ProgressPanel';

export const progress = defineWidget({
  kind: 'progress',
  name: 'Progress',
  hint: 'Goals to tick off, and counters',
  icon: 'check',
  category: 'Gaming',
  keywords: 'milestones badges goals deaths counter tally',
  presets: ['pokemon', 'wow', 'mcd2', 'terminal', 'desk'],
  single: true,
  w: 6,
  h: 7,
  minW: 4,
  minH: 4,
  panel: ProgressPanel,
});
