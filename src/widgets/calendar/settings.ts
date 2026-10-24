import { localHour12 } from '../shared/time';

export type CalendarSettings = {
  /** How many days ahead to show: 1, 3 or 7. */
  calendarDays: number;
  calendarHideAllDay: boolean;
  /** Times with am / pm, or on the 24-hour clock. */
  hour12: boolean;
  /** Show the details in stream mode too. Off by default: they're private. */
  showOnStream: boolean;
};

export const defaultCalendarSettings = (): CalendarSettings => ({ calendarDays: 3, calendarHideAllDay: false, hour12: localHour12(), showOnStream: false });

export function cleanCalendarSettings(s: CalendarSettings): CalendarSettings {
  if (![1, 3, 7].includes(s.calendarDays)) s.calendarDays = 3;
  return s;
}
