import { defineWidget } from '../types';
import { DiscordPanel } from './DiscordPanel';

export const discord = defineWidget({
  kind: 'discord',
  name: 'Discord',
  hint: 'Who is talking in voice',
  icon: 'headphones',
  category: 'Gaming',
  keywords: 'voice chat call friends mute',
  presets: ['pokemon', 'smite2', 'wow', 'mcd2', 'steam', 'terminal'],
  single: true,
  w: 4,
  h: 7,
  minW: 3,
  minH: 3,
  panel: DiscordPanel,
});
