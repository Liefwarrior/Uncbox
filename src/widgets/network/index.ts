import { defineWidget } from '../types';
import { NetworkBody, NetworkSettingsForm } from './NetworkWidget';
import { defaultNetworkSettings } from './settings';

export const network = defineWidget({
  kind: 'network',
  name: 'Ping & FPS',
  hint: 'Your connection, and frame rate in a game',
  icon: 'wifi',
  category: 'Gaming',
  keywords: 'latency lag jitter packet loss framerate network internet',
  presets: ['smite2', 'wow', 'mcd2', 'steam', 'terminal'],
  w: 4,
  h: 4,
  minW: 2,
  minH: 2,
  defaults: defaultNetworkSettings,
  body: NetworkBody,
  settings: NetworkSettingsForm,
});
