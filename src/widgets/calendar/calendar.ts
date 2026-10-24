// The Calendar widget's logic, as plain functions of the events and the time, so it can be tested
// with a fixed clock. The events come from the Uncbox server (server/calendar.mjs).
//
// Timed events carry a full date-time. All-day events carry plain dates ("2026-10-20"; `end` is
// the day after the last day). A plain date is a day on the viewer's own clock, never an instant:
// reading "2026-10-20" with `new Date()` would mean midnight UTC, which is the evening before in
// the Americas.

export interface CalendarEvent {
  id: string;
  /** The calendar it's on, and that calendar's colour. */
  calendar: string;
  color: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  /** Where to join the meeting (Meet, Zoom, Teams), or ''. */
  meetUrl: string;
  /** The event's page in Google Calendar, or ''. */
  htmlLink: string;
}

export const DAY_MS = 86_400_000;
/** An event this close to starting is highlighted. */
export const SOON_MS = 15 * 60_000;

/** "2026-10-20" as midnight of that day on this clock. NaN if it isn't a date. */
export function localDate(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : NaN;
}

/** Midnight at the start of the day `ms` falls on. */
export const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

/** The day after, by the calendar (a day with a clock change is not 24 hours). */
const nextDay = (dayStart: number) => {
  const d = new Date(dayStart);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};

/** When an event starts and ends, in ms. An all-day event spans whole days, from midnight to midnight. */
export function eventSpan(e: CalendarEvent): { start: number; end: number } {
  if (e.allDay) {
    const start = localDate(e.start);
    const end = localDate(e.end);
    return { start, end: Number.isNaN(end) || end <= start ? nextDay(start) : end };
  }
  const start = Date.parse(e.start);
  const end = Date.parse(e.end);
  return { start, end: Number.isNaN(end) || end < start ? start : end };
}

/** Where an event is relative to `now`: all-day, under way, soon (within 15 minutes), later, or over. */
export type EventPhase = 'allday' | 'now' | 'soon' | 'later' | 'past';

export function eventPhase(e: CalendarEvent, now: number): EventPhase {
  const { start, end } = eventSpan(e);
  if (e.allDay) return end <= startOfDay(now) ? 'past' : 'allday';
  if (end <= now && start < now) return 'past';
  if (start <= now) return 'now';
  return start - now <= SOON_MS ? 'soon' : 'later';
}

/** Under way or about to start: shown highlighted. */
export const isHighlighted = (e: CalendarEvent, now: number) => {
  const phase = eventPhase(e, now);
  return phase === 'now' || phase === 'soon';
};

/** How far through an event that's under way, 0 to 1. */
export function progress(e: CalendarEvent, now: number): number {
  const { start, end } = eventSpan(e);
  if (end <= start) return 0;
  return Math.min(1, Math.max(0, (now - start) / (end - start)));
}

/** "in 12 min", "in 1 h 5 min", "in 2 days"; "now" once it has started. */
export function startsIn(e: CalendarEvent, now: number): string {
  const { start } = eventSpan(e);
  const left = start - now;
  if (left <= 0) return 'now';
  const minutes = Math.ceil(left / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `in ${hours} h ${minutes % 60} min` : `in ${hours} h`;
  const days = Math.floor(hours / 24);
  return `in ${days} ${days === 1 ? 'day' : 'days'}`;
}

/** "3:30 PM" (or "15:30"), in the viewer's clock. */
export function clockTime(ms: number, hour12: boolean): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', hour12 }).format(ms);
}

/** The time column of a row: the start time, or "All day". */
export const eventTime = (e: CalendarEvent, hour12: boolean) => (e.allDay ? 'All day' : clockTime(eventSpan(e).start, hour12));

export interface EventGroup {
  /** "Today", "Tomorrow", then "Wed, Oct 22". */
  label: string;
  /** Midnight of the day, in ms. */
  day: number;
  events: CalendarEvent[];
}

/** "Today", "Tomorrow", or the weekday and date. */
export function dayLabel(day: number, now: number): string {
  const today = startOfDay(now);
  if (day === today) return 'Today';
  if (day === nextDay(today)) return 'Tomorrow';
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(day);
}

/**
 * The events to list, soonest first and grouped by the day they start on. Finished events are
 * left out. One that began on an earlier day and is still going (a trip, a long all-day event) is
 * listed under Today. All-day events lead their day.
 */
export function groupEvents(events: CalendarEvent[], now: number, options: { hideAllDay?: boolean } = {}): EventGroup[] {
  const today = startOfDay(now);
  const groups = new Map<number, EventGroup>();
  const sorted = events
    .filter((e) => !(options.hideAllDay && e.allDay) && eventPhase(e, now) !== 'past' && !Number.isNaN(eventSpan(e).start))
    .sort((a, b) => eventSpan(a).start - eventSpan(b).start || Number(b.allDay) - Number(a.allDay));
  for (const e of sorted) {
    const day = Math.max(startOfDay(eventSpan(e).start), today);
    let group = groups.get(day);
    if (!group) groups.set(day, (group = { label: dayLabel(day, now), day, events: [] }));
    group.events.push(e);
  }
  return [...groups.values()].sort((a, b) => a.day - b.day);
}

/** The event the compact layout shows: the one under way, else the next timed one. */
export function nextEvent(events: CalendarEvent[], now: number): CalendarEvent | null {
  const timed = events
    .filter((e) => !e.allDay && eventPhase(e, now) !== 'past')
    .sort((a, b) => eventSpan(a).start - eventSpan(b).start);
  return timed.find((e) => eventPhase(e, now) === 'now') ?? timed[0] ?? null;
}

/**
 * When the current stretch of busy time ends, or null if nothing is on right now. Meetings that
 * overlap or run back to back count as one stretch. All-day events don't make anyone busy.
 */
export function busyUntil(events: CalendarEvent[], now: number): number | null {
  const spans = events.filter((e) => !e.allDay).map(eventSpan).filter((s) => s.start <= now && s.end > now);
  if (!spans.length) return null;
  let until = Math.max(...spans.map((s) => s.end));
  const later = events.filter((e) => !e.allDay).map(eventSpan).sort((a, b) => a.start - b.start);
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of later) {
      if (s.start <= until && s.end > until) {
        until = s.end;
        grew = true;
      }
    }
  }
  return until;
}

// ---- stream mode ----

/**
 * Stream mode shows what's on the screen to everyone watching, so the widget keeps its details
 * to itself unless "Show on stream" is on. In the editor (not stream mode) it always shows them.
 */
export const shouldRedact = (streamMode: boolean, showOnStream: boolean) => streamMode && !showOnStream;

/** All a stream sees of the calendar: "Busy until 3:00 PM", or "Free". */
export function streamSummary(events: CalendarEvent[], now: number, hour12: boolean): string {
  const until = busyUntil(events, now);
  return until === null ? 'Free' : `Busy until ${clockTime(until, hour12)}`;
}
