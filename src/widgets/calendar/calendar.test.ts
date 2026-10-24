import { afterEach, describe, expect, it } from 'vitest';
import {
  type CalendarEvent,
  busyUntil,
  clockTime,
  dayLabel,
  eventPhase,
  eventSpan,
  groupEvents,
  isHighlighted,
  localDate,
  nextEvent,
  progress,
  shouldRedact,
  startsIn,
  streamSummary,
} from './calendar';

// A fixed clock: Tuesday 20 October 2026, 2:00 PM on whatever clock the test runs on.
const NOW = new Date(2026, 9, 20, 14, 0).getTime();
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

let n = 0;
function timed(title: string, start: number, end: number, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id: `e${n++}`, calendar: 'Me', color: '#4285f4', title, start: iso(start), end: iso(end), allDay: false, location: '', meetUrl: '', htmlLink: '', ...extra };
}
function allDay(title: string, start: string, end: string): CalendarEvent {
  return { id: `e${n++}`, calendar: 'Me', color: '#0b8043', title, start, end, allDay: true, location: '', meetUrl: '', htmlLink: '' };
}

// Tests that switch the time zone put this PC's back afterwards.
// (The page's types don't include Node's, so `process` is reached through globalThis.)
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const systemZone = env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
afterEach(() => {
  env.TZ = systemZone;
});

describe('groupEvents', () => {
  it('groups by day: Today, Tomorrow, then the weekday and date', () => {
    const events = [
      timed('Friday thing', at(23, 9), at(23, 10)),
      timed('Standup', at(20, 15), at(20, 15, 30)),
      timed('Dentist', at(21, 8), at(21, 9)),
      timed('Retro', at(20, 16), at(20, 17)),
    ];
    const groups = groupEvents(events, NOW);
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Tomorrow', dayLabel(at(23, 0), NOW)]);
    expect(groups[2].label).toMatch(/Fri.*Oct.*23|Fri.*23.*Oct/);
    expect(groups.map((g) => g.events.map((e) => e.title))).toEqual([['Standup', 'Retro'], ['Dentist'], ['Friday thing']]);
  });

  it('lists events soonest first however they arrive, with all-day events leading their day', () => {
    const events = [timed('Late', at(20, 18), at(20, 19)), timed('Early', at(20, 15), at(20, 16)), allDay('Holiday', '2026-10-20', '2026-10-21')];
    expect(groupEvents(events, NOW)[0].events.map((e) => e.title)).toEqual(['Holiday', 'Early', 'Late']);
  });

  it('leaves out events that are over, but keeps ones under way', () => {
    const events = [timed('Over', at(20, 12), at(20, 13)), timed('Going', at(20, 13, 30), at(20, 14, 30)), timed('Just ended', at(20, 13), at(20, 14))];
    expect(groupEvents(events, NOW).flatMap((g) => g.events.map((e) => e.title))).toEqual(['Going']);
  });

  it('can hide all-day events', () => {
    const events = [allDay('Holiday', '2026-10-20', '2026-10-21'), timed('Standup', at(20, 15), at(20, 16))];
    expect(groupEvents(events, NOW, { hideAllDay: true })[0].events.map((e) => e.title)).toEqual(['Standup']);
    expect(groupEvents([events[0]], NOW, { hideAllDay: true })).toEqual([]);
  });

  it('lists a multi-day event that started earlier under Today, and drops it after its last day', () => {
    const trip = allDay('Trip', '2026-10-18', '2026-10-22');
    expect(groupEvents([trip], NOW).map((g) => g.label)).toEqual(['Today']);
    expect(groupEvents([trip], at(22, 9))).toEqual([]);
  });

  it('is empty with nothing coming up', () => {
    expect(groupEvents([], NOW)).toEqual([]);
  });
});

describe('highlighting', () => {
  it('highlights an event under way or starting within 15 minutes', () => {
    expect(eventPhase(timed('a', at(20, 14, 15), at(20, 15)), NOW)).toBe('soon');
    expect(isHighlighted(timed('a', at(20, 14, 15), at(20, 15)), NOW)).toBe(true);
    expect(eventPhase(timed('b', at(20, 14, 16), at(20, 15)), NOW)).toBe('later');
    expect(isHighlighted(timed('b', at(20, 14, 16), at(20, 15)), NOW)).toBe(false);
    expect(eventPhase(timed('c', at(20, 13, 30), at(20, 14, 30)), NOW)).toBe('now');
    expect(eventPhase(timed('d', at(20, 14), at(20, 14, 30)), NOW)).toBe('now');
    expect(eventPhase(timed('e', at(20, 13), at(20, 14)), NOW)).toBe('past');
  });

  it('never highlights an all-day event', () => {
    const holiday = allDay('Holiday', '2026-10-20', '2026-10-21');
    expect(eventPhase(holiday, NOW)).toBe('allday');
    expect(isHighlighted(holiday, NOW)).toBe(false);
  });

  it('shows how far through an event is', () => {
    const meeting = timed('m', at(20, 13), at(20, 15));
    expect(progress(meeting, NOW)).toBe(0.5);
    expect(progress(meeting, at(20, 12))).toBe(0);
    expect(progress(meeting, at(20, 16))).toBe(1);
  });

  it('counts down in minutes, then hours and days', () => {
    const from = (ms: number) => timed('x', NOW + ms, NOW + ms + 3_600_000);
    expect(startsIn(from(12 * 60_000), NOW)).toBe('in 12 min');
    expect(startsIn(from(30_000), NOW)).toBe('in 1 min');
    expect(startsIn(from(60 * 60_000), NOW)).toBe('in 1 h');
    expect(startsIn(from(65 * 60_000), NOW)).toBe('in 1 h 5 min');
    expect(startsIn(from(26 * 3_600_000), NOW)).toBe('in 1 day');
    expect(startsIn(from(50 * 3_600_000), NOW)).toBe('in 2 days');
    expect(startsIn(from(-60_000), NOW)).toBe('now');
  });

  it('picks the event under way, else the next one, for the compact layout', () => {
    const going = timed('Going', at(20, 13, 30), at(20, 14, 30));
    const soon = timed('Soon', at(20, 14, 10), at(20, 15));
    const later = timed('Later', at(20, 17), at(20, 18));
    expect(nextEvent([later, soon, going], NOW)?.title).toBe('Going');
    expect(nextEvent([later, soon], NOW)?.title).toBe('Soon');
    expect(nextEvent([allDay('Holiday', '2026-10-20', '2026-10-21')], NOW)).toBeNull();
    expect(nextEvent([], NOW)).toBeNull();
  });
});

describe('all-day events across time zones', () => {
  const zones = ['UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'Asia/Kolkata', 'Pacific/Auckland', 'Pacific/Kiritimati'];

  it('start at midnight of their day on the viewer’s clock, wherever that is', () => {
    for (const zone of zones) {
      env.TZ = zone;
      const span = eventSpan(allDay('Holiday', '2026-10-20', '2026-10-21'));
      const start = new Date(span.start);
      const end = new Date(span.end);
      expect([zone, start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), start.getMinutes()]).toEqual([zone, 2026, 9, 20, 0, 0]);
      expect([zone, end.getFullYear(), end.getMonth(), end.getDate(), end.getHours()]).toEqual([zone, 2026, 9, 21, 0]);
    }
  });

  it('are listed under Today on their day in any zone, and gone the day after', () => {
    for (const zone of zones) {
      env.TZ = zone;
      const holiday = allDay('Holiday', '2026-10-20', '2026-10-21');
      const noon = new Date(2026, 9, 20, 12).getTime();
      expect([zone, groupEvents([holiday], noon).map((g) => g.label)]).toEqual([zone, ['Today']]);
      expect([zone, groupEvents([holiday], new Date(2026, 9, 21, 0, 1).getTime())]).toEqual([zone, []]);
      expect([zone, groupEvents([holiday], new Date(2026, 9, 19, 23, 59).getTime()).map((g) => g.label)]).toEqual([zone, ['Tomorrow']]);
    }
  });

  it('are not read as UTC midnight (which would be the evening before in the Americas)', () => {
    env.TZ = 'America/Los_Angeles';
    expect(new Date('2026-10-20').getDate()).toBe(19);
    expect(new Date(localDate('2026-10-20')).getDate()).toBe(20);
  });

  it('keep timed events’ real instants', () => {
    env.TZ = 'Asia/Kolkata';
    const meeting = timed('Call', Date.UTC(2026, 9, 20, 9, 0), Date.UTC(2026, 9, 20, 10, 0), { start: '2026-10-20T09:00:00Z', end: '2026-10-20T10:00:00Z' });
    expect(eventSpan(meeting)).toEqual({ start: Date.UTC(2026, 9, 20, 9), end: Date.UTC(2026, 9, 20, 10) });
  });

  it('survive a bad date without throwing', () => {
    const odd = allDay('Odd', 'not a date', '');
    expect(Number.isNaN(eventSpan(odd).start)).toBe(true);
    expect(groupEvents([odd], NOW)).toEqual([]);
  });
});

describe('stream mode', () => {
  it('hides the details in stream mode unless “Show on stream” is on', () => {
    expect(shouldRedact(true, false)).toBe(true);
    expect(shouldRedact(true, true)).toBe(false);
    expect(shouldRedact(false, false)).toBe(false);
    expect(shouldRedact(false, true)).toBe(false);
  });

  it('says only when the busy stretch ends, or that you are free', () => {
    const meeting = timed('Secret therapy', at(20, 13, 30), at(20, 15));
    const summary = streamSummary([meeting], NOW, true);
    expect(summary).toBe(`Busy until ${clockTime(at(20, 15), true)}`);
    expect(summary).toContain('3:00');
    expect(summary).not.toContain('therapy');
    expect(streamSummary([timed('Later', at(20, 16), at(20, 17))], NOW, true)).toBe('Free');
    expect(streamSummary([], NOW, true)).toBe('Free');
  });

  it('counts back-to-back and overlapping meetings as one busy stretch', () => {
    const events = [timed('A', at(20, 13, 30), at(20, 14, 30)), timed('B', at(20, 14, 30), at(20, 15)), timed('C', at(20, 14, 45), at(20, 15, 30)), timed('D', at(20, 16), at(20, 17))];
    expect(busyUntil(events, NOW)).toBe(at(20, 15, 30));
  });

  it('does not count all-day events as busy', () => {
    expect(busyUntil([allDay('Holiday', '2026-10-20', '2026-10-21')], NOW)).toBeNull();
    expect(streamSummary([allDay('Holiday', '2026-10-20', '2026-10-21')], NOW, false)).toBe('Free');
  });

  it('respects the 24-hour clock', () => {
    expect(streamSummary([timed('A', at(20, 13), at(20, 15))], NOW, false)).toContain('15:00');
  });
});
