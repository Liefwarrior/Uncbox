import { defineWidget } from '../types';
import { ClockBody, ClockSettingsForm } from './ClockWidget';
import { defaultClockSettings } from './settings';

export const clock = defineWidget({
  kind: 'clock',
  name: 'Clock',
  hint: 'The time, here or anywhere',
  icon: 'clock',
  category: 'Media & info',
  keywords: 'time date timezone',
  presets: ['steam', 'desk'],
  w: 4,
  h: 3,
  minW: 2,
  minH: 2,
  defaults: defaultClockSettings,
  body: ClockBody,
  settings: ClockSettingsForm,
});
