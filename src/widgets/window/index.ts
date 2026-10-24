import { defineWidget } from '../types';
import { cleanWindowSettings, defaultWindowSettings } from './settings';
import { WindowPanel } from './WindowPanel';

export const appWindow = defineWidget({
  kind: 'window',
  name: 'App window',
  hint: 'Another app’s window, such as Discord or Spotify',
  icon: 'monitor',
  category: 'Streaming',
  keywords: 'capture discord spotify program application window',
  w: 7,
  h: 8,
  minW: 3,
  minH: 3,
  defaults: defaultWindowSettings,
  clean: cleanWindowSettings,
  // The picture needs the window picker's click, so it draws its own panel.
  panel: WindowPanel,
});
