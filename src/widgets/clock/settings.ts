import { localHour12 } from '../shared/time';

export type ClockSettings = {
  /** An IANA time zone ("Europe/London"), or '' for this PC's. */
  timeZone: string;
  hour12: boolean;
  seconds: boolean;
};

export const defaultClockSettings = (): ClockSettings => ({
  timeZone: '',
  hour12: localHour12(),
  seconds: false,
});
