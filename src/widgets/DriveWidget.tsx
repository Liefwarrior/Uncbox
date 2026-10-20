import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { openPage } from '../discord';
import { Icon } from '../components/Icon';
import type { WidgetSettings } from '../state/model';
import {
  DRIVE_VIEWS,
  type DriveFile,
  type DriveSource,
  type DriveView,
  driveView,
  fileIcon,
  fileKind,
  formatModified,
  google,
  openFile,
  useDriveFiles,
  useGoogle,
  useLocalDrive,
} from './drive';

type SetSettings = (patch: Partial<WidgetSettings>) => void;

/**
 * The Google Drive widget: setup (paste your Google client, sign in) the first time, then your
 * files. Without a Google sign-in it can still browse Google Drive for desktop, if that's installed.
 */
export function DriveBody({ s, set }: { s: WidgetSettings; set: SetSettings }) {
  const { status, reachable } = useGoogle();
  const local = useLocalDrive();
  const [wantsGoogle, setWantsGoogle] = useState(false);

  if (!reachable) return <p className="muted">Google Drive needs Uncbox running on this PC.</p>;
  if (!status || !local) return <p className="muted">Getting your Drive…</p>;

  if (status.signedIn && !status.needsConsent) {
    return <Files s={s} set={set} source="cloud" note={status.email} />;
  }
  if (local.available && !wantsGoogle) {
    return (
      <Files
        s={s}
        set={set}
        source="local"
        note="Google Drive for desktop"
        footer={
          <button className="btn btn--small" onClick={() => setWantsGoogle(true)}>
            Connect Google Drive for Starred, Shared and search
          </button>
        }
      />
    );
  }
  if (!status.configured) return <SetupClient onCancel={local.available ? () => setWantsGoogle(false) : undefined} />;
  return <SignIn needsConsent={status.needsConsent} onCancel={local.available ? () => setWantsGoogle(false) : undefined} />;
}

// ---- setup ----

const STEPS: { text: string; page: 'google-credentials' | 'google-consent' | 'google-drive-api'; button: string }[] = [
  { text: 'Open Google Cloud Console and create a project (or pick one you have).', page: 'google-credentials', button: 'Open Cloud Console' },
  { text: 'Turn on the Google Drive API for that project.', page: 'google-drive-api', button: 'Open Drive API' },
  { text: 'Set up the consent screen: choose External, then add your own Google address under Test users.', page: 'google-consent', button: 'Open consent screen' },
  { text: 'Create credentials: OAuth client ID, with the type Desktop app.', page: 'google-credentials', button: 'Open Credentials' },
];

/** The first step: paste the client ID and secret from Google Cloud Console. */
export function SetupClient({ onCancel, onSaved }: { onCancel?: () => void; onSaved?: () => void }) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await google.saveClient(clientId, clientSecret);
      setClientSecret('');
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save that.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="drive drive--setup no-drag">
      <h3>Connect Google Drive</h3>
      <p className="muted">Uncbox signs in with your own Google client, so your files never go through anyone else. It takes a few minutes, once.</p>
      <ol className="drive__steps">
        {STEPS.map((step) => (
          <li key={step.text}>
            {step.text}{' '}
            <button type="button" className="btn btn--small" onClick={() => openPage(step.page)}>
              {step.button}
            </button>
          </li>
        ))}
        <li>Paste the client ID and client secret here.</li>
      </ol>
      <form className="widget-settings" onSubmit={(e) => void submit(e)}>
        <label>
          Client ID
          <input data-setup="" value={clientId} placeholder="123456-abc.apps.googleusercontent.com" autoComplete="off" spellCheck={false} onChange={(e) => setClientId(e.target.value)} />
        </label>
        <label>
          Client secret
          <input type="password" value={clientSecret} placeholder="GOCSPX-…" autoComplete="off" spellCheck={false} onChange={(e) => setClientSecret(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <span className="row">
          <button className="btn btn--small btn--accent" type="submit" disabled={saving || !clientId.trim() || !clientSecret.trim()}>
            Save
          </button>
          {onCancel && (
            <button className="btn btn--small" type="button" onClick={onCancel}>
              Back
            </button>
          )}
        </span>
        <p className="hint">The secret stays in Uncbox’s data folder on this PC. It isn’t saved with your presets.</p>
      </form>
    </div>
  );
}

/** The second step: Google's own page opens in the browser; this updates when it's done. */
function SignIn({ needsConsent, onCancel }: { needsConsent: boolean; onCancel?: () => void }) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');

  const start = async () => {
    setError('');
    try {
      await google.signIn();
      setWaiting(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t start sign-in.');
    }
  };

  return (
    <div className="drive drive--setup no-drag">
      <h3>{needsConsent ? 'Allow access to your files' : 'Sign in with Google'}</h3>
      <p className="muted">
        {needsConsent
          ? 'Uncbox needs permission to see your Drive files. Sign in again and tick the Drive box.'
          : 'Your browser opens Google’s sign-in. Choose the account you added as a test user, and allow Drive.'}
      </p>
      <span className="row">
        <button className="btn btn--accent" onClick={() => void start()}>
          <Icon name="cloud" size={16} /> Sign in with Google
        </button>
        {onCancel && (
          <button className="btn" onClick={onCancel}>
            Back
          </button>
        )}
      </span>
      {waiting && <p className="muted">Finish in your browser. This updates by itself when you’re done.</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

// ---- the files ----

function Files({ s, set, source, note, footer }: { s: WidgetSettings; set: SetSettings; source: DriveSource; note: string; footer?: ReactNode }) {
  const saved = driveView(s.driveView);
  // Drive for desktop has no stars or sharing to read, only what's in the folder.
  const view: DriveView = source === 'local' && (saved === 'starred' || saved === 'shared') ? 'recent' : saved;
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [noThumb, setNoThumb] = useState<Set<string>>(new Set());

  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 350);
    return () => clearTimeout(t);
  }, [text]);

  const { files, error, loading, hasMore, more, reload } = useDriveFiles(source, view, view === 'search' ? query : '');

  const tabs = DRIVE_VIEWS.filter((v) => source === 'cloud' || v.id === 'recent' || v.id === 'search');
  const typing = (value: string) => {
    setText(value);
    if (value && view !== 'search') set({ driveView: 'search' });
  };

  // These need the person to do something, not just wait.
  if (error?.code === 'scope') return <SignIn needsConsent onCancel={undefined} />;

  return (
    <div className="drive no-drag">
      <div className="drive__head">
        <div className="drive__tabs" role="tablist">
          {tabs.map((v) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={view === v.id}
              className={`btn btn--small ${view === v.id ? 'btn--on' : ''}`}
              onClick={() => set({ driveView: v.id })}
            >
              {v.label}
            </button>
          ))}
        </div>
        <button className={`icon-btn ${loading ? 'is-spinning' : ''}`} title="Refresh" aria-label="Refresh" onClick={reload}>
          <Icon name="refresh" size={14} />
        </button>
      </div>
      <label className="drive__search">
        <Icon name="search" size={14} />
        <input
          type="search"
          value={text}
          placeholder={source === 'local' ? 'Search file names' : 'Search your Drive'}
          onChange={(e) => typing(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && setQuery(text.trim())}
        />
      </label>

      <div className="drive__list">
        {error ? (
          <p className="error">{error.message}</p>
        ) : !files ? (
          <p className="muted">Loading…</p>
        ) : !files.length ? (
          <p className="muted">{view === 'search' && query ? 'Nothing matches that.' : view === 'starred' ? 'No starred files.' : view === 'shared' ? 'Nothing shared with you.' : 'No files yet.'}</p>
        ) : (
          <ul>
            {files.map((f) => (
              <FileRow key={f.id} file={f} source={source} thumb={source === 'cloud' && f.hasThumb && !noThumb.has(f.id)} onThumbError={() => setNoThumb((old) => new Set(old).add(f.id))} />
            ))}
          </ul>
        )}
        {hasMore && (
          <button className="btn btn--small" onClick={more} disabled={loading}>
            More files
          </button>
        )}
      </div>
      <footer className="drive__foot">
        <small className="muted">{note}</small>
        {footer}
      </footer>
    </div>
  );
}

function FileRow({ file, source, thumb, onThumbError }: { file: DriveFile; source: DriveSource; thumb: boolean; onThumbError: () => void }) {
  const openable = source === 'local' || Boolean(file.webViewLink);
  return (
    <li className={thumb ? 'has-thumb' : ''}>
      <button className="drive__file" disabled={!openable} title={`Open ${file.name}`} onClick={() => openFile(file, source)}>
        <span className="drive__icon" aria-hidden="true">
          <Icon name={fileIcon(file.mimeType)} size={18} />
        </span>
        {thumb && <img className="drive__thumb" src={`/api/drive/thumb/${encodeURIComponent(file.id)}`} alt="" loading="lazy" onError={onThumbError} />}
        <span className="drive__name">
          <strong>{file.name}</strong>
          <small>{fileKind(file.mimeType)}</small>
        </span>
        <span className="drive__owner">{file.owner}</span>
        <time className="drive__when" dateTime={file.modifiedTime}>
          {formatModified(file.modifiedTime)}
        </time>
      </button>
    </li>
  );
}

// ---- settings ----

/** Sign out and replace the client live here. */
export function DriveSettings({ onDone }: { onDone: () => void }) {
  const { status } = useGoogle();
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState('');

  const signOut = async () => {
    setError('');
    try {
      await google.signOut();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t sign out.');
    }
  };

  return (
    <div className="widget-settings no-drag">
      {status && (
        <p className="muted">
          {status.signedIn ? `Signed in as ${status.email || 'your Google account'}.` : status.configured ? 'A Google client is saved. Not signed in.' : 'No Google client yet.'}
        </p>
      )}
      {replacing || (status && !status.configured) ? (
        <SetupClient onCancel={status?.configured ? () => setReplacing(false) : undefined} onSaved={() => setReplacing(false)} />
      ) : (
        <span className="row">
          {status?.signedIn && (
            <button className="btn btn--small" onClick={() => void signOut()}>
              Sign out
            </button>
          )}
          {status?.configured && (
            <button className="btn btn--small" onClick={() => setReplacing(true)}>
              Replace client
            </button>
          )}
          <button className="btn btn--small" onClick={() => openPage('google-credentials')}>
            Open Cloud Console
          </button>
        </span>
      )}
      {replacing && status?.signedIn && <p className="hint">Saving a new client signs you out. You’ll sign in again with it.</p>}
      {error && <p className="error">{error}</p>}
      <button className="btn btn--small btn--accent" type="button" onClick={onDone}>
        Done
      </button>
    </div>
  );
}
