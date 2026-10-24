import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useBoard } from '../../components/boardContext';
import { openPage } from '../../discord';
import {
  type Category,
  count,
  sparkPoints,
  TITLE_MAX,
  twitchApi,
  type TwitchStatus,
  type TwitchStream,
  uptime,
  useTwitchStatus,
  useTwitchStream,
} from './twitch';

/** The Twitch widget: the stream's numbers, and (outside stream mode) setup and a form to change the title and category. */
export function TwitchBody() {
  const { editing } = useBoard();
  const status = useTwitchStatus();
  if (!status) return null;
  if (!status.signedIn) {
    if (!editing) return <p className="muted">Connect Twitch from edit mode.</p>;
    return (
      <div className="twitch no-drag">
        {!status.configured ? <Connect /> : <SignIn status={status} />}
      </div>
    );
  }
  return <Channel status={status} editing={editing} />;
}

// ---- setup ----

function Connect() {
  const [id, setId] = useState('');
  const [problem, setProblem] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setProblem('');
    twitchApi.setClientId(id).catch((err: Error) => setProblem(err.message));
  };
  return (
    <form className="twitch__setup" onSubmit={submit}>
      <strong>Connect Twitch</strong>
      <ol>
        <li>
          Open the{' '}
          <button className="link-btn" type="button" onClick={() => openPage('twitch-console')}>
            Twitch developer console
          </button>{' '}
          and click <b>Register Your Application</b>.
        </li>
        <li>
          Name it anything. Set the OAuth Redirect URL to <code>http://localhost</code>, Category to <b>Application Integration</b> and
          Client Type to <b>Public</b>.
        </li>
        <li>Create it, click <b>Manage</b>, and paste its Client ID here.</li>
      </ol>
      <span className="row">
        <input value={id} placeholder="Client ID" spellCheck={false} autoComplete="off" onChange={(e) => setId(e.target.value)} />
        <button className="btn btn--small btn--accent" type="submit" disabled={!id.trim()}>
          Save
        </button>
      </span>
      {problem && <p className="error">{problem}</p>}
    </form>
  );
}

function SignIn({ status }: { status: TwitchStatus }) {
  const [code, setCode] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  const start = () => {
    setBusy(true);
    setProblem('');
    twitchApi
      .signIn()
      .then(setCode)
      .catch((err: Error) => setProblem(err.message))
      .finally(() => setBusy(false));
  };
  // A code that ran out or was refused comes back as the status's error; ask again from the top.
  useEffect(() => {
    if (!status.signingIn) setCode(null);
  }, [status.signingIn]);

  const message = problem || status.error;
  return (
    <div className="twitch__setup">
      <strong>Sign in to Twitch</strong>
      {code && status.signingIn ? (
        <>
          <p className="twitch__code" aria-label="Your code">
            {code.userCode}
          </p>
          <p>
            Go to <b>twitch.tv/activate</b> and enter this code.
          </p>
          <span className="row">
            <button className="btn btn--small btn--accent" type="button" onClick={() => openPage('twitch-activate')}>
              Open
            </button>
            <button className="btn btn--small" type="button" onClick={start} disabled={busy}>
              New code
            </button>
          </span>
          <small className="muted">Waiting for you to approve it…</small>
        </>
      ) : (
        <>
          <p className="muted">
            {status.signingIn ? 'A sign-in is waiting for its code. Ask for a new one to see it.' : 'Uncbox shows your stream and lets you change its title and category.'}
          </p>
          <span className="row">
            <button className="btn btn--small btn--accent" type="button" onClick={start} disabled={busy}>
              {status.signingIn ? 'New code' : 'Sign in'}
            </button>
            <button className="link-btn" type="button" onClick={() => void twitchApi.setClientId('').catch(() => {})}>
              Use a different client ID
            </button>
          </span>
        </>
      )}
      {message && <p className="error">{message}</p>}
    </div>
  );
}

// ---- the channel ----

function Channel({ status, editing }: { status: TwitchStatus; editing: boolean }) {
  const stream = useTwitchStream(true);
  return (
    <div className="twitch">
      {stream ? <Header stream={stream} /> : <p className="muted">Getting {status.displayName}’s stream…</p>}
      {editing && stream && <EditStream stream={stream} />}
      {editing && (
        <p className="twitch__account no-drag">
          Signed in as {status.displayName}.{' '}
          <button className="link-btn" type="button" onClick={() => void twitchApi.signOut().catch(() => {})}>
            Sign out
          </button>
        </p>
      )}
    </div>
  );
}

function useTick(on: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

const SPARK_W = 84;
const SPARK_H = 24;

function Header({ stream }: { stream: TwitchStream }) {
  const now = useTick(stream.live);
  const points = sparkPoints(stream.samples, SPARK_W, SPARK_H);
  return (
    <>
      <div className="twitch__top">
        <span className={`twitch__pill ${stream.live ? 'is-live' : ''}`}>
          {stream.live ? `LIVE · ${uptime(stream.startedAt, now)}` : 'Offline'}
        </span>
        {stream.live && (
          <span className="twitch__viewers">
            <strong>{count(stream.viewers)}</strong> watching
            {points && (
              <svg className="twitch__spark" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} width={SPARK_W} height={SPARK_H} aria-hidden="true">
                <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
              </svg>
            )}
          </span>
        )}
      </div>
      <p className="twitch__title">{stream.title || 'No title yet'}</p>
      {stream.game.name && <p className="twitch__game">{stream.game.name}</p>}
      <dl className="twitch__counts">
        <div>
          <dt>Followers</dt>
          <dd>{count(stream.followers)}</dd>
        </div>
        <div>
          <dt>Subs</dt>
          <dd>{count(stream.subs)}</dd>
        </div>
      </dl>
      {stream.latestFollowers.length > 0 && <p className="twitch__latest">Newest: {stream.latestFollowers.join(', ')}</p>}
    </>
  );
}

// ---- changing the stream ----

function EditStream({ stream }: { stream: TwitchStream }) {
  const [title, setTitle] = useState(stream.title);
  const [game, setGame] = useState({ id: stream.game.id, name: stream.game.name });
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<Category[]>([]);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // Follow the stream until the streamer starts typing; after that their words win.
  useEffect(() => {
    if (dirty) return;
    setTitle(stream.title);
    setGame({ id: stream.game.id, name: stream.game.name });
  }, [stream.title, stream.game.id, stream.game.name, dirty]);

  // Search as they type, once they pause.
  const searching = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (!q) return setFound([]);
    const mine = ++searching.current;
    const t = setTimeout(() => {
      twitchApi
        .categories(q)
        .then((list) => mine === searching.current && setFound(list))
        .catch(() => mine === searching.current && setFound([]));
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  // "Saved" goes away by itself.
  useEffect(() => {
    if (!result?.ok) return;
    const t = setTimeout(() => setResult(null), 3000);
    return () => clearTimeout(t);
  }, [result]);

  const changed = title.trim() !== stream.title || game.id !== stream.game.id;
  const save = (e: FormEvent) => {
    e.preventDefault();
    const change: { title?: string; gameId?: string } = {};
    if (title.trim() !== stream.title) change.title = title;
    if (game.id !== stream.game.id) change.gameId = game.id;
    setSaving(true);
    setResult(null);
    twitchApi
      .save(change)
      .then(() => {
        setDirty(false);
        setResult({ ok: true, text: 'Saved' });
      })
      .catch((err: Error) => setResult({ ok: false, text: err.message }))
      .finally(() => setSaving(false));
  };

  return (
    <form className="twitch__edit no-drag" onSubmit={save}>
      <strong>Edit stream</strong>
      <label>
        Title
        <input
          value={title}
          maxLength={TITLE_MAX}
          onChange={(e) => {
            setTitle(e.target.value);
            setDirty(true);
          }}
        />
        <small className={`twitch__counter ${title.length >= TITLE_MAX ? 'is-full' : ''}`}>
          {title.length}/{TITLE_MAX}
        </small>
      </label>
      <label>
        Category
        <input value={query} placeholder={game.name || 'Search categories'} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {game.name && !query && <p className="twitch__picked">Now: {game.name}</p>}
      {found.length > 0 && (
        <ul className="twitch__results">
          {found.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => {
                  setGame({ id: c.id, name: c.name });
                  setDirty(true);
                  setQuery('');
                }}
              >
                <img src={c.boxArt} alt="" loading="lazy" />
                <span>{c.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <span className="row">
        <button className="btn btn--small btn--accent" type="submit" disabled={!changed || saving || !title.trim()}>
          Save
        </button>
        {result && <span className={result.ok ? 'twitch__saved' : 'error'}>{result.text}</span>}
      </span>
    </form>
  );
}
