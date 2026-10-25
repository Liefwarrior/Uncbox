import { defineWidget } from '../types';
import { defaultWeatherSettings, weatherForSharing } from './settings';
import { WeatherBody, WeatherSettingsForm } from './WeatherWidget';

export const weather = defineWidget({
  kind: 'weather',
  name: 'Weather',
  hint: 'Now and today, for any place',
  icon: 'sun',
  category: 'Media & info',
  keywords: 'forecast temperature rain',
  presets: ['desk'],
  w: 4,
  h: 4,
  minW: 3,
  minH: 3,
  defaults: defaultWeatherSettings,
  forSharing: weatherForSharing,
  // Until a place is picked.
  empty: (s) => !s.lat && !s.lon,
  body: WeatherBody,
  settings: WeatherSettingsForm,
});
