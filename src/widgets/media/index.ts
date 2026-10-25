import { defineWidget } from '../types';
import { MediaBody } from './MediaWidget';

export const media = defineWidget({
  kind: 'media',
  name: 'Now playing',
  hint: 'The song or video playing on this PC',
  icon: 'music',
  category: 'Media & info',
  keywords: 'music spotify song player skip pause',
  presets: ['pokemon', 'steam', 'terminal', 'desk'],
  w: 6,
  h: 3,
  minW: 4,
  minH: 2,
  defaults: () => ({}),
  body: MediaBody,
});
