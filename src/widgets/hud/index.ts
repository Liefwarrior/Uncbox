import { defineWidget } from '../types';
import { HudPanel } from './HudPanel';

export const hud = defineWidget({
  kind: 'hud',
  name: 'Stats',
  hint: 'Numbers read live off your game’s screen',
  icon: 'scan',
  category: 'Gaming',
  keywords: 'ocr screen reader emeralds triggers hud counter',
  presets: ['mcd2'],
  single: true,
  w: 5,
  h: 7,
  minW: 3,
  minH: 3,
  panel: HudPanel,
});
