import { defineWidget } from '../types';
import { AttendanceBody, AttendanceSettingsForm } from './AttendanceWidget';
import { cleanAttendanceSettings, defaultAttendanceSettings } from './settings';

export const attendance = defineWidget({
  kind: 'attendance',
  name: 'Raid attendance',
  hint: 'Who came to the last raids, with a CSV for loot council',
  icon: 'calendar',
  category: 'WoW',
  keywords: 'raid attendance table percent dkp loot council csv export raiders missed',
  presets: ['wow'],
  w: 10,
  h: 10,
  minW: 4,
  minH: 3,
  defaults: defaultAttendanceSettings,
  clean: cleanAttendanceSettings,
  body: AttendanceBody,
  settings: AttendanceSettingsForm,
});
