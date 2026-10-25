import { defineWidget } from '../types';
import { RunPanel } from './RunPanel';

export const run = defineWidget({
  kind: 'run',
  name: 'Run',
  hint: 'Title and a timer',
  icon: 'timer',
  category: 'Gaming',
  keywords: 'session stopwatch speedrun played',
  presets: ['pokemon', 'smite2', 'wow', 'mcd2', 'steam', 'terminal', 'desk'],
  single: true,
  w: 5,
  h: 6,
  minW: 4,
  minH: 4,
  panel: RunPanel,
});
