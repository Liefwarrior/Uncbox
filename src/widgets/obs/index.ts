import { defineWidget } from '../types';
import { ObsPanel } from './ObsWidget';

export const obs = defineWidget({
  kind: 'obs',
  name: 'OBS',
  hint: 'Stream health, scenes and recording',
  icon: 'cast',
  category: 'Streaming',
  keywords: 'stream recording scenes live bitrate dropped frames',
  presets: ['pokemon', 'smite2', 'wow', 'mcd2', 'steam', 'terminal'],
  w: 6,
  h: 6,
  minW: 3,
  minH: 2,
  defaults: () => ({}),
  // It draws its own panel: what it shows and its menu depend on OBS being connected.
  panel: ObsPanel,
});
