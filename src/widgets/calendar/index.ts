import { defineWidget } from '../types';
import { CalendarBody, CalendarSettingsForm } from './CalendarWidget';
import { cleanCalendarSettings, defaultCalendarSettings } from './settings';

export const calendar = defineWidget({
  kind: 'calendar',
  name: 'Calendar',
  hint: 'What’s next, with a Join button for meetings',
  icon: 'calendar',
  category: 'Productivity',
  keywords: 'google events meeting schedule agenda',
  presets: ['desk'],
  w: 6,
  h: 6,
  minW: 3,
  minH: 2,
  defaults: defaultCalendarSettings,
  clean: cleanCalendarSettings,
  body: CalendarBody,
  settings: CalendarSettingsForm,
});
