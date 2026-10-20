import { useBoard } from '../components/Board';
import type { WidgetSettings } from '../state/model';
import {
  type CalendarEvent,
  eventPhase,
  eventSpan,
  eventTime,
  groupEvents,
  isHighlighted,
  nextEvent,
  progress,
  shouldRedact,
  startsIn,
  streamSummary,
} from './calendar';
import { CALENDAR_FEATURE, openLink, useGoogleData } from './google';
import { GoogleGate, GoogleProblem } from './GoogleSetup';
import { useNow } from './useNow';

type SetSettings = (patch: Partial<WidgetSettings>) => void;

const open = (url: string) => openLink('/api/calendar/open', url);

/** The Calendar widget: what's next on your calendars, with a Join button for meetings. */
export function CalendarBody({ s }: { s: WidgetSettings }) {
  return (
    <GoogleGate feature={CALENDAR_FEATURE}>
      <Events s={s} />
    </GoogleGate>
  );
}

function Events({ s }: { s: WidgetSettings }) {
  // Stream mode is the board when it isn't being edited; there, details stay hidden unless allowed.
  const { editing } = useBoard();
  const redact = shouldRedact(!editing, s.showOnStream);
  const { data, error } = useGoogleData<{ events: CalendarEvent[] }>(`/api/calendar/events?days=${s.calendarDays}`);
  // The countdowns and the progress bar move once a minute.
  const now = useNow(60_000);

  if (error && !data) return <GoogleProblem feature={CALENDAR_FEATURE} error={error} />;
  if (!data) return <p className="muted">Getting your calendar…</p>;
  const events = data.events;

  if (redact) {
    return (
      <div className="cal cal--private no-drag">
        <p className="cal__busy">{streamSummary(events, now, s.hour12)}</p>
      </div>
    );
  }

  const groups = groupEvents(events, now, { hideAllDay: s.calendarHideAllDay });
  const next = nextEvent(events, now);
  return (
    <div className="cal no-drag">
      <div className="cal__full">
        {!groups.length ? (
          <p className="muted">Nothing coming up.</p>
        ) : (
          groups.map((g) => (
            <section key={g.day} className="cal__group">
              <h4>{g.label}</h4>
              <ul>
                {g.events.map((e) => (
                  <Row key={e.id} event={e} now={now} hour12={s.hour12} />
                ))}
              </ul>
            </section>
          ))
        )}
        {error && <p className="error">{error.message}</p>}
      </div>
      <div className="cal__compact">
        {next ? (
          <button className="cal__next" disabled={!next.htmlLink} title={next.title} onClick={() => open(next.htmlLink)}>
            <strong>{next.title}</strong>
            <span>{startsIn(next, now)}</span>
          </button>
        ) : (
          <span className="muted">Nothing coming up</span>
        )}
      </div>
    </div>
  );
}

function Row({ event: e, now, hour12 }: { event: CalendarEvent; now: number; hour12: boolean }) {
  const hot = isHighlighted(e, now);
  const phase = eventPhase(e, now);
  // A location that is only a meeting link is what the Join button is for.
  const place = /^https?:\/\//i.test(e.location) ? '' : e.location;
  const pct = Math.round(progress(e, now) * 100);
  return (
    <li className={`cal__event ${hot ? 'is-hot' : ''} ${phase === 'now' ? 'is-now' : ''}`}>
      <button className="cal__open" disabled={!e.htmlLink} title={e.htmlLink ? `Open in Google Calendar (${e.calendar})` : e.calendar} onClick={() => open(e.htmlLink)}>
        <i className="cal__dot" style={{ background: e.color }} aria-hidden="true" />
        <time className="cal__time" dateTime={new Date(eventSpan(e).start).toISOString()}>
          {phase === 'now' ? 'Now' : eventTime(e, hour12)}
        </time>
        <span className="cal__what">
          <strong>{e.title}</strong>
          {place && <small>{place}</small>}
        </span>
      </button>
      {hot && e.meetUrl && (
        <button className="btn btn--small btn--accent cal__join" onClick={() => open(e.meetUrl)}>
          Join
        </button>
      )}
      {phase === 'now' && (
        <div className="cal__progress" role="progressbar" aria-label="How far through" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <i style={{ width: `${pct}%` }} />
        </div>
      )}
    </li>
  );
}

/** Days ahead, all-day events, and whether stream mode shows the details. */
export function CalendarSettings({ s, set }: { s: WidgetSettings; set: SetSettings }) {
  return (
    <>
      <label>
        Days ahead
        <select data-setup="" value={s.calendarDays} onChange={(e) => set({ calendarDays: Number(e.target.value) })}>
          <option value={1}>1 day</option>
          <option value={3}>3 days</option>
          <option value={7}>7 days</option>
        </select>
      </label>
      <label className="inline">
        <input type="checkbox" checked={s.calendarHideAllDay} onChange={(e) => set({ calendarHideAllDay: e.target.checked })} /> Hide all-day events
      </label>
      <label className="inline">
        <input type="checkbox" checked={s.showOnStream} onChange={(e) => set({ showOnStream: e.target.checked })} /> Show on stream
      </label>
      <p className="hint">Off, viewers only see “Busy until 3:00 PM” or “Free”, never your event names.</p>
    </>
  );
}
