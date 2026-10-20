// The Google Calendar widget's server side. It uses the Google sign-in (server/google.mjs) with the
// read-only Calendar scope, asked for through `requireScopes`, so someone who signed in for Drive
// only sees "Allow calendar access" in the widget.
//
//   GET  /api/calendar/events?days=N   the next N days (1, 3 or 7) from every calendar that is
//                                      ticked in Google Calendar, merged and sorted by start:
//                                      { events: [{ id, calendar, color, title, start, end, allDay,
//                                        location, meetUrl, htmlLink }] }
//   POST /api/calendar/open            { url } opens an event or a meeting link in the browser
//
// Timed events carry Google's own date-time ("2026-10-20T15:00:00-07:00"). All-day events carry
// plain dates ("2026-10-20", and `end` is the day after the last one, as Google says it): they
// belong to a calendar day, not to an instant, so the page reads them as that day on its own
// clock. Nothing here is kept: answers are cached for a minute and that's all.
//
// Meeting links are found in the event (Google Meet, its conference data) or, failing that, in
// the location and description (Zoom, Teams, Meet). Only https links to those services open.

import { GOOGLE_SCOPES, apiProblem } from './google.mjs';
import { openInBrowser } from './open.mjs';

const API = 'https://www.googleapis.com/calendar/v3';
const DAYS = [1, 3, 7];
const CACHE_MS = 60_000;
const MAX_CALENDARS = 25;
const MAX_EVENTS = 200;
const EVENT_FIELDS =
  'items(id,status,summary,start,end,location,description,hangoutLink,htmlLink,conferenceData/entryPoints,attendees(self,responseStatus))';

// ---- meeting links ----

/** Where a meeting link may point: the video services this knows, over https. */
const MEETING_HOST = /(^|\.)(meet\.google\.com|zoom\.us|zoom\.com|zoomgov\.com|teams\.microsoft\.com|teams\.live\.com)$/i;
/** Where Uncbox opens an event page. */
const EVENT_HOST = /^(www\.google\.com|calendar\.google\.com)$/i;

/** A meeting link that is safe to open, as a clean address, or '' if it isn't one. */
export function safeMeetingUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && MEETING_HOST.test(u.hostname) ? u.href : '';
  } catch {
    return '';
  }
}

/** An event page address that is safe to open ('' if not). */
export function safeEventUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && EVENT_HOST.test(u.hostname) && u.pathname.startsWith('/calendar') ? u.href : '';
  } catch {
    return '';
  }
}

/** Anything the page may open from the widget: a meeting link or an event page. */
export const safeOpenUrl = (url) => safeMeetingUrl(url) || safeEventUrl(url);

// Links in free text. They stop at spaces, quotes and angle brackets (the description can be HTML).
const LINK = /https:\/\/[^\s"'<>\\]+/gi;

/** The first meeting link written in some text (a location or description), or ''. */
export function meetUrlInText(text) {
  if (typeof text !== 'string' || !text) return '';
  const found = text.match(LINK) ?? [];
  for (const raw of found) {
    // A sentence ending in the link brings its punctuation along.
    const url = safeMeetingUrl(raw.replace(/[.,;:!?)\]}]+$/, '').replace(/&amp;/g, '&'));
    if (url) return url;
  }
  return '';
}

/**
 * The link to join an event, or ''. In order: Google's own Meet link, a video entry point in the
 * conference data (Zoom and Teams add-ons put theirs there), then a link in the location, then in
 * the description.
 */
export function meetUrlFrom(item) {
  const direct = safeMeetingUrl(item.hangoutLink ?? '');
  if (direct) return direct;
  const video = (item.conferenceData?.entryPoints ?? []).find((p) => p?.entryPointType === 'video' && safeMeetingUrl(p.uri));
  if (video) return safeMeetingUrl(video.uri);
  return meetUrlInText(item.location) || meetUrlInText(item.description);
}

// ---- events ----

/** "2026-10-20" as midnight of that day on this PC's clock. NaN if it isn't a date. */
export function localDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : NaN;
}

/** When an event starts, in ms. All-day events start at midnight of their day, here. */
export function startOf(event) {
  return event.allDay ? localDate(event.start) : new Date(event.start).getTime();
}

/** What the page gets for one Calendar API event, or null for one that doesn't belong on the list. */
export function toEvent(item, calendar) {
  if (!item || item.status === 'cancelled') return null;
  // Declined invitations stay on Google's calendar but are not on anyone's plan.
  if ((item.attendees ?? []).some((a) => a.self && a.responseStatus === 'declined')) return null;
  const allDay = Boolean(item.start?.date && !item.start?.dateTime);
  const start = allDay ? item.start.date : item.start?.dateTime;
  let end = allDay ? item.end?.date : item.end?.dateTime;
  if (!start || Number.isNaN(allDay ? localDate(start) : Date.parse(start))) return null;
  if (!end) end = start;
  return {
    id: `${calendar.id}:${item.id}`,
    calendar: calendar.name,
    color: calendar.color,
    title: String(item.summary ?? '').trim() || '(No title)',
    start,
    end,
    allDay,
    location: String(item.location ?? '').trim(),
    meetUrl: meetUrlFrom(item),
    htmlLink: safeEventUrl(item.htmlLink ?? ''),
  };
}

/** Events from every calendar, soonest first (all-day events lead their day). */
export function mergeEvents(lists) {
  return lists
    .flat()
    .sort((a, b) => startOf(a) - startOf(b) || Number(b.allDay) - Number(a.allDay) || a.title.localeCompare(b.title))
    .slice(0, MAX_EVENTS);
}

/** Midnight at the start of this PC's day. */
export const startOfDay = (ms) => new Date(new Date(ms).setHours(0, 0, 0, 0)).getTime();

/** The Calendar API question for one calendar: events from this morning to `days` from now. */
export function buildEventsQuery(now, days) {
  return new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    // From the start of today: an all-day event for today began at midnight. Timed events that
    // have already ended are dropped after (see keepEvent).
    timeMin: new Date(startOfDay(now)).toISOString(),
    timeMax: new Date(now + days * 86_400_000).toISOString(),
    maxResults: '50',
    fields: EVENT_FIELDS,
  });
}

/** Drops timed events that have finished; all-day ones stay for their whole day. */
export function keepEvent(event, now) {
  if (event.allDay) return localDate(event.end) > startOfDay(now);
  return Date.parse(event.end) > now;
}

/** The days ahead the widget asked for: 1, 3 or 7. */
export const cleanDays = (value) => {
  const n = Number(value);
  return DAYS.includes(n) ? n : 3;
};

/** The calendars to read: the ones ticked in Google Calendar, with a name and a colour each. */
export function selectedCalendars(items) {
  return (items ?? [])
    .filter((c) => c?.id && c.selected === true && !c.deleted && c.accessRole !== 'none')
    .slice(0, MAX_CALENDARS)
    .map((c) => ({ id: c.id, name: c.summaryOverride || c.summary || c.id, color: /^#[0-9a-f]{6}$/i.test(c.backgroundColor ?? '') ? c.backgroundColor : '#4285f4' }));
}

/**
 * @param {object} o
 * @param {ReturnType<import('./google.mjs').createGoogle>} o.google
 * @param {(target: string) => void} [o.open]  opens a page in the browser; swapped out by the tests
 * @param {() => number} [o.now]
 */
export function createCalendar({ google, isLocal, sendJson, readJson, open = openInBrowser, now = Date.now }) {
  google.requireScopes(GOOGLE_SCOPES.calendar);
  /** "account|days" → { at, events } */
  const cache = new Map();

  const signInFirst = async (res) => {
    const status = await google.snapshot();
    return sendJson(
      res,
      401,
      status.signedIn
        ? { code: 'scope', error: 'Allow calendar access to see your events. Sign in again and tick the Calendar box.' }
        : { code: 'signin', error: 'Sign in with Google first.' },
    );
  };

  async function load(days) {
    const at = now();
    const calendars = await google.fetch(`${API}/users/me/calendarList?minAccessRole=freeBusyReader&maxResults=250&fields=items(id,summary,summaryOverride,backgroundColor,selected,deleted,accessRole)`);
    const listed = await calendars.json().catch(() => ({}));
    if (!calendars.ok) return { problem: apiProblem(calendars.status, listed, 'Google Calendar') };
    const query = buildEventsQuery(at, days);
    const results = await Promise.all(
      selectedCalendars(listed.items).map(async (cal) => {
        const r = await google.fetch(`${API}/calendars/${encodeURIComponent(cal.id)}/events?${query}`);
        const body = await r.json().catch(() => ({}));
        return r.ok ? { events: (body.items ?? []).map((i) => toEvent(i, cal)).filter(Boolean) } : { problem: apiProblem(r.status, body, 'Google Calendar') };
      }),
    );
    // One calendar that won't load (say, it was just unshared) shouldn't blank the rest.
    const worked = results.filter((r) => r.events);
    if (results.length && !worked.length) return { problem: results[0].problem };
    return { events: mergeEvents(worked.map((r) => r.events)).filter((e) => keepEvent(e, at)) };
  }

  async function events(res, url) {
    if (!(await google.hasScopes(GOOGLE_SCOPES.calendar))) return signInFirst(res);
    const days = cleanDays(url.searchParams.get('days'));
    const key = `${(await google.snapshot()).email}|${days}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return sendJson(res, 200, { events: hit.events.filter((e) => keepEvent(e, now())) });
    const got = await load(days);
    if (got.problem) {
      const { status, ...rest } = got.problem;
      return sendJson(res, status, rest);
    }
    cache.set(key, { at: now(), events: got.events });
    while (cache.size > 12) cache.delete(cache.keys().next().value);
    return sendJson(res, 200, { events: got.events });
  }

  async function openIt(res, body) {
    const target = typeof body?.url === 'string' ? safeOpenUrl(body.url) : '';
    if (!target) return sendJson(res, 400, { error: 'That isn’t a calendar or meeting link.' });
    open(target);
    return sendJson(res, 200, { ok: true });
  }

  return async function handle(req, res, url) {
    if (!isLocal(req)) return sendJson(res, 403, { error: 'Run this on the PC Uncbox is on.' });
    const action = url.pathname.slice('/api/calendar'.length);
    try {
      if (req.method === 'GET' && action === '/events') return await events(res, url);
      if (req.method === 'POST' && action === '/open') return await openIt(res, await readJson(req));
      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      return sendJson(res, err.status || 500, {
        code: err.status === 401 ? 'signin' : 'other',
        error: err.status ? err.message : 'Couldn’t read Google Calendar.',
      });
    }
  };
}
