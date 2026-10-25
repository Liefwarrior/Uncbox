import { defineWidget } from '../types';
import { SystemBody } from './SystemWidget';

export const system = defineWidget({
  kind: 'system',
  name: 'System',
  hint: 'CPU, graphics card and memory',
  icon: 'gauge',
  category: 'Gaming',
  keywords: 'cpu gpu memory ram temperature performance',
  presets: ['smite2', 'steam', 'terminal'],
  w: 4,
  h: 4,
  minW: 3,
  minH: 3,
  defaults: () => ({}),
  body: SystemBody,
});
