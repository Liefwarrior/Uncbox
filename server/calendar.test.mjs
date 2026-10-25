// The Calendar widget's server side: finding the meeting link, all-day events, the Calendar API
// questions, the scope request, the route (with a fake Google), and the 60-second cache.
// Nothing here reaches Google.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanDays, buildEventsQuery, createCalendar, keepEvent, localDate, meetUrlFrom, meetUrlInText, mergeEvents, safeEventUrl, safeMeetingUrl, safeOpenUrl, selectedCalendars, startOf, toEvent } from './calendar.mjs';
import { GOOGLE_SCOPES, createGoogle } from './google.mjs';

const CAL = { id: 'me@example.com', name: 'Me', color: '#4285f4' };
const originalZone = process.env.TZ;
const systemZone = originalZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
afterEach(() => {
  process.env.TZ = systemZone;
});

describe('meetUrlFrom', () => {
  it('uses Google’s own Meet link first', () => {
    const item = { hangoutLink: 'https://meet.google.com/abc-defg-hij', location: 'https://zoom.us/j/1' };
    expect(meetUrlFrom(item)).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('then a video entry point in the conference data (not the phone one)', () => {
    const item = {
      conferenceData: {
        entryPoints: [
          { entryPointType: 'phone', uri: 'tel:+1-555-0100' },
          { entryPointType: 'video', uri: 'https://acme.zoom.us/j/123456789?pwd=abc' },
        ],
      },
    };
    expect(meetUrlFrom(item)).toBe('https://acme.zoom.us/j/123456789?pwd=abc');
  });

  it('then a Zoom, Teams or Meet link in the location', () => {
    expect(meetUrlFrom({ location: 'https://us02web.zoom.us/j/987654321' })).toBe('https://us02web.zoom.us/j/987654321');
    expect(meetUrlFrom({ location: 'Teams: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0' })).toBe(
      'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0',
    );
    expect(meetUrlFrom({ location: 'https://meet.google.com/xyz-abcd-efg' })).toBe('https://meet.google.com/xyz-abcd-efg');
  });

  it('then the description, even inside HTML, and without a sentence’s full stop', () => {
    const html = 'Agenda<br>Join: <a href="https://acme.zoom.us/j/555?pwd=x&amp;y=1">https://acme.zoom.us/j/555?pwd=x&amp;y=1</a><br>Bring notes.';
    expect(meetUrlFrom({ description: html })).toBe('https://acme.zoom.us/j/555?pwd=x&y=1');
    expect(meetUrlFrom({ description: 'Join at https://meet.google.com/aaa-bbbb-ccc.' })).toBe('https://meet.google.com/aaa-bbbb-ccc');
  });

  it('prefers the location to the description', () => {
    expect(meetUrlFrom({ location: 'https://meet.google.com/loc-aaaa-bbb', description: 'https://zoom.us/j/1' })).toBe('https://meet.google.com/loc-aaaa-bbb');
  });

  it('ignores links that are not meetings, or not https, or only look like them', () => {
    expect(meetUrlFrom({})).toBe('');
    expect(meetUrlFrom({ location: 'Room 4, https://example.com/zoom.us/j/1' })).toBe('');
    expect(meetUrlFrom({ location: 'http://zoom.us/j/1' })).toBe('');
    expect(meetUrlFrom({ hangoutLink: 'https://evil.example/meet.google.com/abc' })).toBe('');
    expect(meetUrlFrom({ location: 'https://zoom.us.evil.example/j/1' })).toBe('');
    expect(meetUrlFrom({ location: 'https://user:pw@zoom.us/j/1' })).toBe('');
    expect(meetUrlInText(null)).toBe('');
    expect(meetUrlInText(42)).toBe('');
  });

  it('skips a bad video entry point and falls through', () => {
    const item = { conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://evil.example/x' }] }, location: 'https://zoom.us/j/9' };
    expect(meetUrlFrom(item)).toBe('https://zoom.us/j/9');
  });
});

describe('what may be opened', () => {
  it('opens meeting links and Google Calendar event pages, nothing else', () => {
    expect(safeMeetingUrl('https://meet.google.com/abc-defg-hij')).toBeTruthy();
    expect(safeMeetingUrl('https://example.com/')).toBe('');
    expect(safeEventUrl('https://www.google.com/calendar/event?eid=abc')).toBeTruthy();
    expect(safeEventUrl('https://calendar.google.com/calendar/u/0/r/eventedit/abc')).toBeTruthy();
    expect(safeEventUrl('https://www.google.com/search?q=calendar')).toBe('');
    expect(safeEventUrl('javascript:alert(1)')).toBe('');
    expect(safeOpenUrl('file:///C:/Windows/System32/calc.exe')).toBe('');
    expect(safeOpenUrl('not a url')).toBe('');
  });
});

describe('toEvent', () => {
  it('keeps what the page shows and nothing else', () => {
    const e = toEvent(
      {
        id: 'ev1',
        summary: 'Standup',
        start: { dateTime: '2026-10-20T15:00:00-07:00' },
        end: { dateTime: '2026-10-20T15:15:00-07:00' },
        location: 'Room 4',
        description: 'secret agenda',
        hangoutLink: 'https://meet.google.com/abc-defg-hij',
        htmlLink: 'https://www.google.com/calendar/event?eid=abc',
        attendees: [{ self: true, responseStatus: 'accepted' }],
      },
      CAL,
    );
    expect(e).toEqual({
      id: 'me@example.com:ev1',
      calendar: 'Me',
      color: '#4285f4',
      title: 'Standup',
      start: '2026-10-20T15:00:00-07:00',
      end: '2026-10-20T15:15:00-07:00',
      allDay: false,
      location: 'Room 4',
      meetUrl: 'https://meet.google.com/abc-defg-hij',
      htmlLink: 'https://www.google.com/calendar/event?eid=abc',
    });
    expect(JSON.stringify(e)).not.toContain('secret agenda');
  });

  it('keeps all-day events as plain dates', () => {
    const e = toEvent({ id: 'h', summary: 'Holiday', start: { date: '2026-10-20' }, end: { date: '2026-10-21' } }, CAL);
    expect(e).toMatchObject({ allDay: true, start: '2026-10-20', end: '2026-10-21' });
  });

  it('skips cancelled and declined events, and ones with no usable start', () => {
    const when = { start: { dateTime: '2026-10-20T15:00:00Z' }, end: { dateTime: '2026-10-20T16:00:00Z' } };
    expect(toEvent({ id: 'a', status: 'cancelled', ...when }, CAL)).toBeNull();
    expect(toEvent({ id: 'b', ...when, attendees: [{ self: true, responseStatus: 'declined' }] }, CAL)).toBeNull();
    expect(toEvent({ id: 'c', ...when, attendees: [{ responseStatus: 'declined' }] }, CAL)).not.toBeNull();
    expect(toEvent({ id: 'd' }, CAL)).toBeNull();
    expect(toEvent({ id: 'e', start: { dateTime: 'garbage' } }, CAL)).toBeNull();
    expect(toEvent(null, CAL)).toBeNull();
  });

  it('titles an event with no title, and drops an event link that is not Google’s', () => {
    const e = toEvent({ id: 'x', start: { date: '2026-10-20' }, end: { date: '2026-10-21' }, htmlLink: 'https://evil.example/' }, CAL);
    expect(e.title).toBe('(No title)');
    expect(e.htmlLink).toBe('');
  });
});

describe('all-day events and time zones', () => {
  const zones = ['UTC', 'America/Los_Angeles', 'Europe/London', 'Asia/Kolkata', 'Pacific/Auckland'];

  it('are the day on the PC’s own clock in every zone', () => {
    for (const zone of zones) {
      process.env.TZ = zone;
      const d = new Date(localDate('2026-10-20'));
      expect([zone, d.getDate(), d.getHours()]).toEqual([zone, 20, 0]);
    }
    expect(localDate('2026-10-2x')).toBeNaN();
  });

  it('sort among timed events by that midnight', () => {
    for (const zone of zones) {
      process.env.TZ = zone;
      const timed = toEvent({ id: 't', summary: 'Early', start: { dateTime: new Date(2026, 9, 20, 6).toISOString() }, end: { dateTime: new Date(2026, 9, 20, 7).toISOString() } }, CAL);
      const holiday = toEvent({ id: 'h', summary: 'Holiday', start: { date: '2026-10-20' }, end: { date: '2026-10-21' } }, CAL);
      expect([zone, mergeEvents([[timed], [holiday]]).map((e) => e.title)]).toEqual([zone, ['Holiday', 'Early']]);
      expect(startOf(holiday)).toBe(new Date(2026, 9, 20).getTime());
    }
  });

  it('stay for their whole day and go when it ends', () => {
    for (const zone of zones) {
      process.env.TZ = zone;
      const holiday = toEvent({ id: 'h', summary: 'Holiday', start: { date: '2026-10-20' }, end: { date: '2026-10-21' } }, CAL);
      expect([zone, keepEvent(holiday, new Date(2026, 9, 20, 23, 59).getTime())]).toEqual([zone, true]);
      expect([zone, keepEvent(holiday, new Date(2026, 9, 21, 0, 0).getTime())]).toEqual([zone, false]);
    }
  });

  it('timed events are kept until they end', () => {
    const e = toEvent({ id: 't', summary: 'x', start: { dateTime: '2026-10-20T15:00:00Z' }, end: { dateTime: '2026-10-20T16:00:00Z' } }, CAL);
    expect(keepEvent(e, Date.parse('2026-10-20T15:59:00Z'))).toBe(true);
    expect(keepEvent(e, Date.parse('2026-10-20T16:00:00Z'))).toBe(false);
  });
});

describe('the Calendar API question', () => {
  it('runs from the start of today to the days ahead, one event per occurrence, in order', () => {
    const now = new Date(2026, 9, 20, 14, 30).getTime();
    const q = Object.fromEntries(buildEventsQuery(now, 3));
    expect(q.singleEvents).toBe('true');
    expect(q.orderBy).toBe('startTime');
    expect(q.timeMin).toBe(new Date(2026, 9, 20, 0, 0).toISOString());
    expect(q.timeMax).toBe(new Date(now + 3 * 86_400_000).toISOString());
    expect(q.fields).toContain('conferenceData');
  });

  it('takes 1, 3 or 7 days', () => {
    expect([1, 3, 7].map(cleanDays)).toEqual([1, 3, 7]);
    expect(['2', 'x', null, 30].map(cleanDays)).toEqual([3, 3, 3, 3]);
  });

  it('reads only the calendars ticked in Google Calendar', () => {
    const picked = selectedCalendars([
      { id: 'a', summary: 'Mine', backgroundColor: '#123456', selected: true },
      { id: 'b', summary: 'Hidden', selected: false },
      { id: 'c', summary: 'Holidays', summaryOverride: 'Days off', selected: true, backgroundColor: 'red' },
      { id: 'd', summary: 'Gone', selected: true, deleted: true },
    ]);
    expect(picked).toEqual([
      { id: 'a', name: 'Mine', color: '#123456' },
      { id: 'c', name: 'Days off', color: '#4285f4' },
    ]);
  });
});

// ---- the route, with a fake Google ----

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: new Headers() });

/** A Calendar module whose Google is a fake: `signedIn` and `scopes` set what the sign-in covers. */
function fake({ scopes = GOOGLE_SCOPES.calendar, signedIn = true, answer, local = true } = {}) {
  const calls = [];
  const required = [];
  const google = {
    requireScopes: (list) => required.push(...list),
    hasScopes: async (list) => signedIn && list.every((s) => scopes.includes(s)),
    snapshot: async () => ({ signedIn, email: 'me@example.com', scopes }),
    fetch: async (url) => {
      calls.push(String(url));
      return answer(String(url));
    },
  };
  let clock = new Date(2026, 9, 20, 14, 0).getTime();
  const opened = [];
  const handle = createCalendar({ google, isLocal: () => local, sendJson: (res, status, body) => (res.out = { status, body }), readJson: async (req) => req.body, open: (t) => opened.push(t), now: () => clock });
  return {
    calls,
    required,
    opened,
    tick: (ms) => (clock += ms),
    async route(pathname, { method = 'GET', body } = {}) {
      const res = {};
      await handle({ method, body }, res, new URL(pathname, 'http://127.0.0.1:5170'));
      return res.out;
    },
  };
}

const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();
const calendarList = {
  items: [
    { id: 'me@example.com', summary: 'Me', backgroundColor: '#4285f4', selected: true },
    { id: 'team@example.com', summary: 'Team', backgroundColor: '#0b8043', selected: true },
    { id: 'off@example.com', summary: 'Off', selected: false },
  ],
};
const eventsFor = {
  'me@example.com': { items: [{ id: 'm1', summary: 'Later', start: { dateTime: at(20, 17) }, end: { dateTime: at(20, 18) } }, { id: 'm0', summary: 'Over', start: { dateTime: at(20, 9) }, end: { dateTime: at(20, 10) } }] },
  'team@example.com': { items: [{ id: 't1', summary: 'Standup', start: { dateTime: at(20, 15) }, end: { dateTime: at(20, 15, 15) }, hangoutLink: 'https://meet.google.com/abc-defg-hij' }, { id: 't2', summary: 'Holiday', start: { date: '2026-10-20' }, end: { date: '2026-10-21' } }] },
};
const google = (url) => {
  if (url.includes('/calendarList')) return json(200, calendarList);
  const id = decodeURIComponent(/calendars\/([^/]+)\/events/.exec(url)[1]);
  return json(200, eventsFor[id]);
};

describe('GET /api/calendar/events', () => {
  it('asks for the calendar scope when it is made', () => {
    expect(fake({ answer: google }).required).toEqual(GOOGLE_SCOPES.calendar);
  });

  it('merges the ticked calendars, sorted, without what is over', async () => {
    const t = fake({ answer: google });
    const { status, body } = await t.route('/api/calendar/events?days=3');
    expect(status).toBe(200);
    expect(body.events.map((e) => [e.calendar, e.title, e.allDay])).toEqual([
      ['Team', 'Holiday', true],
      ['Team', 'Standup', false],
      ['Me', 'Later', false],
    ]);
    expect(body.events[1]).toMatchObject({ color: '#0b8043', meetUrl: 'https://meet.google.com/abc-defg-hij' });
    // The unticked calendar is never read.
    expect(t.calls.some((c) => c.includes('off%40example.com'))).toBe(false);
    const events = t.calls.filter((c) => c.includes('/events?'));
    expect(events).toHaveLength(2);
    expect(events[0]).toContain('singleEvents=true');
    expect(events[0]).toContain('orderBy=startTime');
  });

  it('keeps an answer for 60 seconds, then asks again', async () => {
    const t = fake({ answer: google });
    await t.route('/api/calendar/events?days=3');
    const first = t.calls.length;
    t.tick(59_000);
    await t.route('/api/calendar/events?days=3');
    expect(t.calls.length).toBe(first);
    t.tick(2_000);
    await t.route('/api/calendar/events?days=3');
    expect(t.calls.length).toBe(first * 2);
  });

  it('keeps separate answers for separate day counts', async () => {
    const t = fake({ answer: google });
    await t.route('/api/calendar/events?days=1');
    const first = t.calls.length;
    await t.route('/api/calendar/events?days=7');
    expect(t.calls.length).toBe(first * 2);
  });

  it('says “Allow calendar access” is needed when the sign-in is only for Drive', async () => {
    const t = fake({ scopes: ['openid', 'email', ...GOOGLE_SCOPES.drive], answer: google });
    const { status, body } = await t.route('/api/calendar/events');
    expect(status).toBe(401);
    expect(body.code).toBe('scope');
    expect(t.calls).toEqual([]);
  });

  it('says to sign in first when not signed in', async () => {
    const t = fake({ signedIn: false, scopes: [], answer: google });
    expect(await t.route('/api/calendar/events')).toMatchObject({ status: 401, body: { code: 'signin' } });
  });

  it('explains a Calendar API that is not turned on', async () => {
    const t = fake({ answer: () => json(403, { error: { message: 'Google Calendar API has not been used in project 1 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } }) });
    const { status, body } = await t.route('/api/calendar/events');
    expect(status).toBe(403);
    expect(body.code).toBe('api');
    expect(body.error).toContain('Google Calendar API');
  });

  it('shows the rest when one calendar will not load', async () => {
    const t = fake({
      answer: (url) => (url.includes('team%40example.com') ? json(404, { error: { message: 'Not Found' } }) : google(url)),
    });
    const { status, body } = await t.route('/api/calendar/events');
    expect(status).toBe(200);
    expect(body.events.map((e) => e.title)).toEqual(['Later']);
  });

  it('is for this PC only', async () => {
    const t = fake({ answer: google, local: false });
    expect((await t.route('/api/calendar/events')).status).toBe(403);
    expect(t.calls).toEqual([]);
  });
});

describe('POST /api/calendar/open', () => {
  it('opens an event page or a meeting link', async () => {
    const t = fake({ answer: google });
    for (const url of ['https://www.google.com/calendar/event?eid=abc', 'https://meet.google.com/abc-defg-hij', 'https://us02web.zoom.us/j/1']) {
      expect((await t.route('/api/calendar/open', { method: 'POST', body: { url } })).status).toBe(200);
    }
    expect(t.opened).toHaveLength(3);
  });

  it('refuses anything else', async () => {
    const t = fake({ answer: google });
    for (const body of [{ url: 'https://evil.example/' }, { url: 'file:///C:/x.exe' }, { url: 'ms-settings:' }, {}, { url: 5 }]) {
      expect((await t.route('/api/calendar/open', { method: 'POST', body })).status).toBe(400);
    }
    expect(t.opened).toEqual([]);
  });
});

describe('the scope request, with the real sign-in', () => {
  it('shows a Drive-only sign-in as needing consent once Calendar is required, and asks only for Calendar', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'uncbox-cal-'));
    try {
      const real = createGoogle({
        broadcastEvent: () => {},
        sendJson: (res, status, body) => (res.out = { status, body }),
        isLocal: () => true,
        readJson: async (req) => req.body,
        dataDir,
        port: 5170,
        fetchImpl: async (url, init = {}) => {
          if (String(url).includes('/token')) {
            const body = Object.fromEntries(init.body);
            return json(200, body.grant_type === 'authorization_code'
              ? { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: ['openid', 'email', ...GOOGLE_SCOPES.drive].join(' '), id_token: `h.${Buffer.from(JSON.stringify({ email: 'me@example.com' })).toString('base64url')}.s` }
              : { access_token: 'a2', expires_in: 3600 });
          }
          return json(200, {});
        },
        openUrl: () => {},
      });
      real.requireScopes(GOOGLE_SCOPES.drive);
      const call = async (method, pathname, body) => {
        const res = { writeHead() {}, end() {} };
        await real.handle({ method, body }, res, new URL(pathname, 'http://127.0.0.1:5170'));
        return res.out;
      };
      await call('POST', '/api/google/client', { clientId: '1234567890-abcdefghijklmnop.apps.googleusercontent.com', clientSecret: 'GOCSPX-super-secret-value' });
      const started = await call('POST', '/api/google/signin', { scopes: GOOGLE_SCOPES.drive });
      await call('GET', `/api/google/callback?code=abc&state=${new URL(started.body.url).searchParams.get('state')}`);
      expect((await call('GET', '/api/google/status')).body).toMatchObject({ signedIn: true, needsConsent: false });

      // Calendar joins: the Drive sign-in no longer covers everything that's required...
      createCalendar({ google: real, isLocal: () => true, sendJson: () => {}, readJson: async () => ({}) });
      expect(await real.hasScopes(GOOGLE_SCOPES.calendar)).toBe(false);
      expect(await real.hasScopes(GOOGLE_SCOPES.drive)).toBe(true);
      expect((await call('GET', '/api/google/status')).body.needsConsent).toBe(true);

      // ...and asking for Calendar adds just it to what Drive already has.
      const again = await call('POST', '/api/google/signin', { scopes: GOOGLE_SCOPES.calendar });
      const asked = new URL(again.body.url).searchParams.get('scope').split(' ');
      expect(asked).toContain(GOOGLE_SCOPES.calendar[0]);
      expect(asked).toEqual(expect.arrayContaining(GOOGLE_SCOPES.drive));
      expect(new URL(again.body.url).searchParams.get('include_granted_scopes')).toBe('true');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
