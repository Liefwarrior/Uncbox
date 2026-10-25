import { type ReactNode, useEffect, useState } from 'react';
import { openPage } from '../../discord';
import { Icon } from '../../components/Icon';
import { usePrivate } from '../../privacy';
import type { BodyProps } from '../types';
import {
  DRIVE_VIEWS,
  type DriveFile,
  type DriveSource,
  type DriveView,
  driveView,
  fileIcon,
  fileKind,
  formatModified,
  openFile,
  useDriveFiles,
  useLocalDrive,
} from './drive';
import { DRIVE_FEATURE, google, hasGoogleScopes, useGoogle } from '../shared/google';
import { SetupClient, SignIn } from '../shared/GoogleSetup';
import type { DriveSettings } from './settings';

type SetSettings = (patch: Partial<DriveSettings>) => void;

/**
 * The Google Drive widget: setup (paste your Google client, sign in) the first time, then your
 * files. Without a Google sign-in it can still browse Google Drive for desktop, if that's installed.
 */
export function DriveBody({ settings: s, set, open, close }: BodyProps<DriveSettings>) {
  const { status, reachable } = useGoogle();
  const local = useLocalDrive();
  const [wantsGoogle, setWantsGoogle] = useState(false);
  const hidden = usePrivate();

  // Signing out and replacing the client work outside edit mode too.
  if (open) return <DriveAccount onDone={close} />;
  if (!reachable) return <p className="muted">Google Drive needs Uncbox running on this PC.</p>;
  if (!status || !local) return <p className="muted">Getting your Drive…</p>;

  // Other widgets may have asked for more than Drive needs; only Drive's own permission counts here.
  if (hasGoogleScopes(status, DRIVE_FEATURE.scopes)) {
    return hidden ? <HiddenFiles /> : <Files s={s} set={set} source="cloud" note={status.email} />;
  }
  if (local.available && !wantsGoogle) {
    if (hidden) return <HiddenFiles />;
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
  const back = local.available ? () => setWantsGoogle(false) : undefined;
  if (!status.configured) return <SetupClient feature={DRIVE_FEATURE} onCancel={back} />;
  return <SignIn feature={DRIVE_FEATURE} needsConsent={status.signedIn} onCancel={back} />;
}

// ---- the files ----

/** File names, thumbnails and the account are public while on air, so none are asked for or drawn. */
function HiddenFiles() {
  return (
    <div className="drive drive--setup no-drag">
      <p className="muted">
        <Icon name="eyeOff" size={14} /> Files hidden while you’re on air.
      </p>
    </div>
  );
}

function Files({ s, set, source, note, footer }: { s: DriveSettings; set: SetSettings; source: DriveSource; note: string; footer?: ReactNode }) {
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
  if (error?.code === 'scope') return <SignIn feature={DRIVE_FEATURE} needsConsent />;

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

// ---- the account ----

/** Sign out and replace the client live here. */
function DriveAccount({ onDone }: { onDone: () => void }) {
  const { status } = useGoogle();
  const hidden = usePrivate();
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
          {status.signedIn ? `Signed in as ${(!hidden && status.email) || 'your Google account'}.` : status.configured ? 'A Google client is saved. Not signed in.' : 'No Google client yet.'}
        </p>
      )}
      {replacing || (status && !status.configured) ? (
        <SetupClient feature={DRIVE_FEATURE} onCancel={status?.configured ? () => setReplacing(false) : undefined} onSaved={() => setReplacing(false)} />
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
