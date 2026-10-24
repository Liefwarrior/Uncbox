import { useBoard } from '../../components/boardContext';
import { Icon } from '../../components/Icon';
import type { BodyProps, SettingsProps } from '../types';
import { GMAIL_FEATURE, openLink, useGoogleData } from '../shared/google';
import { GoogleGate, GoogleProblem } from '../shared/GoogleSetup';
import { type GmailLabel, type GmailSummary, relativeTime, shouldRedact, streamView, summaryUrl, unreadText } from './gmail';
import type { GmailSettings } from './settings';
import { useNow } from '../shared/useNow';

const open = (url: string) => openLink('/api/gmail/open', url);

/** The Gmail glance: how many unread, and the latest few senders and subjects. */
export function GmailBody({ settings: s }: BodyProps<GmailSettings>) {
  return (
    <GoogleGate feature={GMAIL_FEATURE}>
      <Inbox s={s} />
    </GoogleGate>
  );
}

function Inbox({ s }: { s: GmailSettings }) {
  // Stream mode is the board when it isn't being edited; there, only the count shows unless allowed.
  const { editing } = useBoard();
  const redact = shouldRedact(!editing, s.showOnStream);
  const { data, error } = useGoogleData<GmailSummary>(summaryUrl(s.gmailLabel, s.gmailOnlyUnread));
  const now = useNow(60_000);

  if (error && !data) return <GoogleProblem feature={GMAIL_FEATURE} error={error} />;
  if (!data) return <p className="muted">Getting your mail…</p>;

  const view = streamView(data, redact);
  const watching = data.label.id !== 'INBOX' && !redact ? data.label.name : '';
  return (
    <div className="gmail no-drag">
      <div className="gmail__full">
        <header className="gmail__head">
          <strong className="gmail__count">{view.unread.toLocaleString()}</strong>
          <span>
            unread{watching && <small> in {watching}</small>}
          </span>
        </header>
        {!redact &&
          (view.messages.length ? (
            <ul className="gmail__list">
              {view.messages.map((m) => (
                <li key={m.id}>
                  <button className={`gmail__row ${m.unread ? 'is-unread' : ''}`} title={`${m.from}: ${m.subject}`} onClick={() => open(m.link)}>
                    <span className="gmail__from">{m.from}</span>
                    <span className="gmail__subject">{m.subject}</span>
                    <time className="gmail__when" dateTime={m.date}>
                      {relativeTime(m.date, now)}
                    </time>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{s.gmailOnlyUnread ? 'Nothing unread.' : 'No messages here.'}</p>
          ))}
        {error && <p className="error">{error.message}</p>}
      </div>
      <div className="gmail__compact">
        <Icon name="mail" size={20} />
        <strong>{unreadText(view.unread)}</strong>
      </div>
    </div>
  );
}

/** Only unread, which label to watch, and whether stream mode shows the details. */
export function GmailSettingsForm({ settings: s, set }: SettingsProps<GmailSettings>) {
  const { data, error } = useGoogleData<{ labels: GmailLabel[] }>('/api/gmail/labels', 0);
  const labels = data?.labels ?? [];
  // The saved label stays pickable even if the list hasn't loaded, or no longer has it.
  const options = labels.some((l) => l.id === s.gmailLabel) ? labels : [{ id: s.gmailLabel, name: s.gmailLabel === 'INBOX' ? 'Inbox' : s.gmailLabel, system: true }, ...labels];
  return (
    <>
      <label>
        Label to watch
        <select data-setup="" value={s.gmailLabel} onChange={(e) => set({ gmailLabel: e.target.value })}>
          {options.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      {error && !data && <p className="hint">Couldn’t load your labels yet. {error.code === 'scope' || error.code === 'signin' ? 'Sign in to Gmail in the widget first.' : error.message}</p>}
      <label className="inline">
        <input type="checkbox" checked={s.gmailOnlyUnread} onChange={(e) => set({ gmailOnlyUnread: e.target.checked })} /> Only unread
      </label>
      <label className="inline">
        <input type="checkbox" checked={s.showOnStream} onChange={(e) => set({ showOnStream: e.target.checked })} /> Show on stream
      </label>
      <p className="hint">Off, viewers only see the unread count, never who wrote or what about.</p>
    </>
  );
}
