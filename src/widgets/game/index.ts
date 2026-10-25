import { defineWidget } from '../types';
import { GamePanel } from './GamePanel';

export const game = defineWidget({
  kind: 'game',
  name: 'Game',
  hint: 'Your game, big',
  icon: 'gamepad',
  category: 'Gaming',
  keywords: 'capture screen emulator console window play',
  presets: ['pokemon', 'smite2', 'wow', 'mcd2', 'steam', 'terminal'],
  single: true,
  w: 17,
  h: 17,
  minW: 6,
  minH: 6,
  panel: GamePanel,
});
