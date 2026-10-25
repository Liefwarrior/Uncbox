import { defineWidget } from '../types';
import { LauncherBody } from './LauncherWidget';
import { cleanLauncherSettings, defaultLauncherSettings } from './settings';

export const launcher = defineWidget({
  kind: 'launcher',
  name: 'Launcher',
  hint: 'Quick buttons for apps, folders and sites',
  icon: 'rocket',
  category: 'Productivity',
  keywords: 'shortcuts apps start open links buttons',
  presets: ['desk'],
  w: 6,
  h: 4,
  minW: 2,
  minH: 2,
  defaults: defaultLauncherSettings,
  clean: cleanLauncherSettings,
  body: LauncherBody,
  // Nothing to show until a tile is added.
  empty: (s) => !s.launcherTiles.length,
  // The body's `open` is "arranging the tiles".
  menu: ({ open, toggle }) => [{ label: open ? 'Done editing tiles' : 'Edit tiles', icon: 'pencil', onSelect: toggle }],
});
