import { defineWidget } from '../types';
import { ScoreboardPanel } from './ScoreboardPanel';

export const scoreboard = defineWidget({
  kind: 'scoreboard',
  name: 'Scoreboard',
  hint: 'Everyone’s K/D/A and gold, from the Tab screen',
  icon: 'list',
  category: 'SMITE 2',
  keywords: 'kda gold tab kills players',
  presets: ['smite2'],
  single: true,
  w: 9,
  h: 9,
  minW: 5,
  minH: 5,
  panel: ScoreboardPanel,
});
