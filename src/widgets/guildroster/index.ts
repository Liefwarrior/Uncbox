import { defineWidget } from '../types';
import { RosterBody, RosterSettingsForm } from './RosterWidget';
import { cleanRosterSettings, defaultRosterSettings } from './settings';

export const guildroster = defineWidget({
  kind: 'guildroster',
  name: 'Guild roster',
  hint: 'Who is online now, with class, level, rank and zone',
  icon: 'users',
  category: 'WoW',
  keywords: 'guild members online who raid officer rank class list search find',
  presets: ['wow'],
  w: 8,
  h: 12,
  minW: 3,
  minH: 2,
  defaults: defaultRosterSettings,
  clean: cleanRosterSettings,
  body: RosterBody,
  settings: RosterSettingsForm,
});
