import { defineWidget } from '../types';
import { CameraPanel } from './CameraPanel';

export const camera = defineWidget({
  kind: 'camera',
  name: 'Camera',
  hint: 'Your webcam',
  icon: 'video',
  category: 'Streaming',
  keywords: 'webcam facecam',
  presets: ['pokemon', 'smite2', 'wow', 'mcd2', 'steam', 'terminal', 'desk'],
  single: true,
  w: 7,
  h: 7,
  minW: 3,
  minH: 3,
  panel: CameraPanel,
});
