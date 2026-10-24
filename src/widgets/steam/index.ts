import { defineWidget } from '../types';
import { SteamPanel } from './SteamPanel';

export const steam = defineWidget({
  kind: 'steam',
  name: 'Steam',
  hint: 'What you’re playing on Steam, live',
  icon: 'gamepad',
  category: 'Steam',
  keywords: 'library achievements playtime recent games',
  presets: ['steam'],
  single: true,
  w: 7,
  h: 9,
  minW: 4,
  minH: 4,
  panel: SteamPanel,
});
