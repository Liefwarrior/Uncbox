import { defineWidget } from '../types';
import { cleanFocusSettings, defaultFocusSettings } from './focus';
import { FocusBody, FocusSettingsForm } from './FocusWidget';

export const focus = defineWidget({
  kind: 'focus',
  name: 'Focus timer',
  hint: 'Work and break rounds, with a chime',
  icon: 'timer',
  category: 'Productivity',
  keywords: 'pomodoro break work study timer rounds',
  presets: ['desk'],
  w: 4,
  h: 5,
  minW: 3,
  minH: 3,
  defaults: defaultFocusSettings,
  clean: cleanFocusSettings,
  body: FocusBody,
  settings: FocusSettingsForm,
});
