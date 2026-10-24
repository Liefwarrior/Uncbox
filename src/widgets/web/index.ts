import { defineWidget } from '../types';
import { cleanWebSettings, defaultWebSettings } from './settings';
import { WebPanel } from './WebWidget';

export const web = defineWidget({
  kind: 'web',
  name: 'Web',
  hint: 'Any web page: YouTube, a wiki, a dashboard',
  icon: 'globe',
  category: 'Media & info',
  keywords: 'browser website page youtube wiki internet',
  presets: ['desk'],
  w: 8,
  h: 7,
  minW: 3,
  minH: 3,
  defaults: defaultWebSettings,
  clean: cleanWebSettings,
  // It keeps the page and its history while the settings form is open, so it draws its own panel.
  panel: WebPanel,
});
