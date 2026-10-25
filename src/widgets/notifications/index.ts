import { defineWidget } from '../types';
import { NotificationsBody, NotificationsSettingsForm } from './NotificationsWidget';
import { defaultNotificationsSettings } from './settings';

export const notifications = defineWidget({
  kind: 'notifications',
  name: 'Notifications',
  hint: 'Windows notifications as they arrive',
  icon: 'bell',
  category: 'Media & info',
  keywords: 'toasts alerts messages',
  presets: ['desk'],
  w: 6,
  h: 5,
  minW: 4,
  minH: 3,
  defaults: defaultNotificationsSettings,
  body: NotificationsBody,
  settings: NotificationsSettingsForm,
});
