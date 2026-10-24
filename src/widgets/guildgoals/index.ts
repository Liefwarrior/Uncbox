import { defineWidget } from '../types';
import { GoalsBody, GoalsSettingsForm } from './GoalsWidget';
import { defaultGoalsSettings } from './settings';

export const guildgoals = defineWidget({
  kind: 'guildgoals',
  name: 'Guild goals',
  hint: 'Boss by boss, how far the guild is through each raid',
  icon: 'flag',
  category: 'WoW',
  keywords: 'guild goals progress progression raid bosses killed checklist onyxia molten core hyjal',
  presets: ['wow'],
  w: 6,
  h: 10,
  minW: 3,
  minH: 3,
  defaults: defaultGoalsSettings,
  body: GoalsBody,
  settings: GoalsSettingsForm,
});
