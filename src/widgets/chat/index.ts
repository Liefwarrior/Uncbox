import { defineWidget } from '../types';
import { ChatPanel } from './ChatPanel';

export const chat = defineWidget({
  kind: 'chat',
  name: 'Chat',
  hint: 'Your Twitch chat',
  icon: 'message',
  category: 'Streaming',
  keywords: 'twitch messages viewers',
  presets: ['pokemon', 'smite2', 'wow', 'mcd2', 'steam', 'terminal'],
  single: true,
  w: 7,
  h: 9,
  minW: 4,
  minH: 4,
  panel: ChatPanel,
});
