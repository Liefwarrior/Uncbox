import { defineWidget } from '../types';
import { TeamsPanel } from './TeamsPanel';

export const teams = defineWidget({
  kind: 'teams',
  name: 'Teams',
  hint: 'Both teams’ gods, live from SMITE 2',
  icon: 'swap',
  category: 'SMITE 2',
  keywords: 'gods draft allies enemies lobby',
  presets: ['smite2'],
  single: true,
  w: 7,
  h: 7,
  minW: 4,
  minH: 4,
  panel: TeamsPanel,
});
