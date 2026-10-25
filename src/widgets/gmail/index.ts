import { defineWidget } from '../types';
import { GmailBody, GmailSettingsForm } from './GmailWidget';
import { cleanGmailSettings, defaultGmailSettings } from './settings';

export const gmail = defineWidget({
  kind: 'gmail',
  name: 'Gmail',
  hint: 'Unread count and the latest senders',
  icon: 'mail',
  category: 'Productivity',
  keywords: 'google email inbox mail messages',
  presets: ['desk'],
  w: 5,
  h: 5,
  minW: 2,
  minH: 2,
  defaults: defaultGmailSettings,
  clean: cleanGmailSettings,
  body: GmailBody,
  settings: GmailSettingsForm,
});
