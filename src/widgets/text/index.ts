import { defineWidget } from '../types';
import { defaultTextSettings } from './settings';
import { TextBody, TextSettingsForm } from './TextWidget';

export const text = defineWidget({
  kind: 'text',
  name: 'Text',
  hint: 'Any words you like',
  icon: 'type',
  category: 'Productivity',
  keywords: 'note label rules message banner',
  presets: ['pokemon'],
  w: 5,
  h: 3,
  minW: 2,
  minH: 2,
  defaults: defaultTextSettings,
  // Until there are words.
  empty: (s) => !s.text.trim(),
  body: TextBody,
  settings: TextSettingsForm,
});
