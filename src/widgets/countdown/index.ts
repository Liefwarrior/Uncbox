import { defineWidget } from '../types';
import { CountdownBody, CountdownSettingsForm } from './CountdownWidget';
import { defaultCountdownSettings } from './settings';

export const countdown = defineWidget({
  kind: 'countdown',
  name: 'Countdown',
  hint: 'Time left until something',
  icon: 'timer',
  category: 'Productivity',
  keywords: 'timer until event raid night release date',
  presets: ['wow'],
  w: 4,
  h: 3,
  minW: 3,
  minH: 2,
  defaults: defaultCountdownSettings,
  // Until a time is picked.
  empty: (s) => !s.target,
  body: CountdownBody,
  settings: CountdownSettingsForm,
});
