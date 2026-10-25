import { settingsMenu } from '../frame';
import { defineWidget } from '../types';
import { DriveBody } from './DriveWidget';
import { cleanDriveSettings, defaultDriveSettings } from './settings';

export const drive = defineWidget({
  kind: 'drive',
  name: 'Google Drive',
  hint: 'Your recent, starred and shared files',
  icon: 'cloud',
  category: 'Productivity',
  keywords: 'google files documents storage',
  presets: ['desk'],
  w: 6,
  h: 6,
  minW: 4,
  minH: 4,
  defaults: defaultDriveSettings,
  clean: cleanDriveSettings,
  body: DriveBody,
  // Signing out and replacing the Google client live in the body's own account view.
  menu: settingsMenu,
});
