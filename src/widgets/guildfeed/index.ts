import { defineWidget } from '../types';
import { FeedBody, FeedSettingsForm } from './FeedWidget';
import { cleanFeedSettings, defaultFeedSettings } from './settings';

export const guildfeed = defineWidget({
  kind: 'guildfeed',
  name: 'Guild news',
  hint: 'Joins, promotions, level-ups, boss kills and loot, live',
  icon: 'newspaper',
  category: 'WoW',
  keywords: 'guild feed news activity joins leaves promotions level boss kill loot log stream',
  presets: ['wow'],
  w: 6,
  h: 8,
  minW: 3,
  minH: 3,
  defaults: defaultFeedSettings,
  clean: cleanFeedSettings,
  body: FeedBody,
  settings: FeedSettingsForm,
});
