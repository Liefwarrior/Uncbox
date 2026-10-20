import { useEffect, useRef, useState } from 'react';
import { keyLabel, isClipKey } from '../clips/keys';
import { CLIP_SECONDS, clipUrl, revealClip, saveClip, useClips, watchClip } from '../clips/replay';
import { removeWebhook, sendToDiscord, setWebhook, useWebhook } from '../clips/share';
import { useCover } from '../native';
import type { ClipSettings } from '../state/model';
import type { Mutate } from '../state/useAppState';
import { StatusLine, VerticalEditor, useJob } from './ClipEditor';
import { Icon } from './Icon';

const TOAST_MS = 6000;
const SHOWN = 5;

/** "Uncbox 2026-10-18 21-30-05.mp4" → "Oct 18, 9:30:05 PM", or "9:30:05 PM" for today. */
function when(at: number) {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / 1e6))} MB`;

/** The sidebar's Clips section: on/off, the clip key, save now, and the latest clips. */
export function ClipsSection({ settings, mutate }: { settings: ClipSettings; mutate: Mutate }) {
  const clips = useClips();
  const [binding, setBinding] = useState(false);
  const key = keyLabel(settings.key);

  useEffect(() => {
    if (!binding) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') return setBinding(false);
      if (!isClipKey(e.code)) return;
      mutate((s) => void (s.clips.key = e.code));
      setBinding(false);
    };
    // Capture phase, so F8 and Esc don't also toggle stream mode while picking a key.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [binding, mutate]);

  const status = !settings.enabled
    ? 'Off'
    : clips.error
      ? clips.error
      : clips.recording
        ? clips.seconds >= CLIP_SECONDS
          ? `Keeping the last ${CLIP_SECONDS} seconds`
          : `Keeping the last ${clips.seconds} seconds`
        : 'Starts when your game is showing';

  return (
    <>
      <h3>Clips</h3>
      <ul className="toggles">
        <li>
          <label>
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) => mutate((s) => void (s.clips.enabled = e.target.checked))}
            />
            <span className="toggle" />
            <span className="toggles__text">
              Instant replay
              <small>
                Press <kbd>{key}</kbd> to save the last minute
              </small>
            </span>
          </label>
        </li>
      </ul>
      {settings.enabled && (
        <>
          <p className={`clips__status ${clips.recording && !clips.error ? 'is-on' : ''} ${clips.error ? 'error' : ''}`}>
            <span className="clips__dot" />
            {status}
          </p>
          <div className="clips__actions">
            <button className="btn btn--small" disabled={!clips.recording || clips.saving} onClick={() => void saveClip()}>
              <Icon name="film" size={14} /> {clips.saving ? 'Saving…' : 'Save clip'}
            </button>
            <button
              className={`btn btn--small ${binding ? 'btn--on' : ''}`}
              title="Change the clip key"
              onClick={() => setBinding((b) => !b)}
            >
              {binding ? 'Press a key…' : <>Key <kbd>{key}</kbd></>}
            </button>
          </div>
          {binding && <p className="hint">F keys, symbols like = - [ ], the number pad, or Insert to Page Down. Esc cancels.</p>}
          {clips.hotkey === 'unsupported' && (
            <p className="hint">The key only works while Uncbox is in front. Use Save clip, or run Uncbox on Windows.</p>
          )}
        </>
      )}
      {clips.clips.length > 0 && (
        <ul className="clips__list">
          {clips.clips.slice(0, SHOWN).map((c) => (
            <li key={c.name}>
              <button className="side-link" title="Watch" onClick={() => watchClip(c.name)}>
                <Icon name="play" size={13} />
                <span>{when(c.at)}</span>
                <small>
                  {c.name.includes(' vertical') && 'Vertical · '}
                  {megabytes(c.size)}
                </small>
              </button>
            </li>
          ))}
        </ul>
      )}
      <DiscordWebhook />
      <button className="side-link side-link--quiet" title={clips.dir} onClick={() => revealClip()}>
        <Icon name="folder" /> Open clips folder
      </button>
    </>
  );
}

/** Where "Send to Discord" sends clips. The server keeps the URL; this only ever shows its last characters. */
function DiscordWebhook() {
  const { set, hint } = useWebhook();
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const close = () => {
    setEditing(false);
    setUrl('');
    setError('');
  };
  const save = async () => {
    setSaving(true);
    const problem = await setWebhook(url);
    setSaving(false);
    if (problem) setError(problem);
    else close();
  };

  if (!editing) {
    return (
      <div className="clips__discord">
        <p className="hint">
          Discord webhook: {set ? `set (${hint})` : 'not set'}
        </p>
        <div className="clips__actions">
          <button className="btn btn--small" onClick={() => setEditing(true)}>
            {set ? 'Replace' : 'Add webhook'}
          </button>
          {set && (
            <button className="btn btn--small" onClick={() => void removeWebhook()}>
              Remove
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <form
      className="clips__discord"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {/* Hidden as you type, like a password: it lets anyone post to your channel. */}
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        autoFocus
        placeholder="https://discord.com/api/webhooks/…"
        aria-label="Discord webhook URL"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      {error && <p className="error">{error}</p>}
      <p className="hint">In Discord: channel settings, Integrations, Webhooks, Copy Webhook URL. It stays on this PC.</p>
      <div className="clips__actions">
        <button className="btn btn--small btn--accent" disabled={!url.trim() || saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn--small" onClick={close}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** "Clip saved" with a Watch button, for a few seconds after each clip. Hidden in stream mode. */
export function ClipToast() {
  const { saved, saveError } = useClips();
  const key = saved ? `saved:${saved.at}` : saveError ? `error:${saveError}` : '';
  const [hidden, setHidden] = useState('');

  useEffect(() => {
    if (!key) return;
    const t = setTimeout(() => setHidden(key), TOAST_MS);
    return () => clearTimeout(t);
  }, [key]);

  if (!key || hidden === key) return null;
  return (
    <div className="toast toast--clip" role="status">
      {saved ? (
        <>
          <span>Clip saved</span>
          <button className="toast__undo" onClick={() => watchClip(saved.name)}>
            <Icon name="play" size={13} /> Watch
          </button>
        </>
      ) : (
        <span className="error">{saveError}</span>
      )}
    </div>
  );
}

/** Plays a saved clip over the dashboard. */
export function ClipPlayer() {
  const { playing } = useClips();
  useCover(Boolean(playing));
  // Keyed, so each clip starts with a fresh editor and no leftover "Sent to Discord".
  return playing ? <Player key={playing} playing={playing} /> : null;
}

/** The player itself, with Make vertical and Send to Discord. */
function Player({ playing }: { playing: string }) {
  const { set: discord } = useWebhook();
  const job = useJob();
  const [editing, setEditing] = useState(false);

  // While something is being made, Esc and a click outside stop that rather than closing the player.
  const { busy, cancel } = job;
  const close = () => (busy ? cancel() : watchClip(null));
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const vertical = playing.includes(' vertical');
  return (
    <div className="clip-player" role="dialog" aria-label="Clip" onClick={close}>
      <div className={`clip-player__box ${editing ? 'is-editing' : ''}`} onClick={(e) => e.stopPropagation()}>
        {editing ? (
          <VerticalEditor name={playing} job={job} discord={discord} />
        ) : (
          <video src={clipUrl(playing)} controls autoPlay />
        )}
        <StatusLine job={job} />
        <div className="clip-player__bar">
          <span>{playing.replace(/\.mp4$/, '')}</span>
          <span className="spacer" />
          {!vertical && (
            <button className={`btn btn--small ${editing ? 'btn--on' : ''}`} disabled={busy} onClick={() => setEditing((e) => !e)}>
              <Icon name="crop" size={14} /> {editing ? 'Back to the clip' : 'Make vertical'}
            </button>
          )}
          {!editing && (
            <button
              className="btn btn--small"
              disabled={busy || !discord}
              title={discord ? 'Send this clip to your Discord channel' : 'Add a Discord webhook under Clips first'}
              onClick={() =>
                job.run(async (report, signal) => {
                  await sendToDiscord({ name: playing, trim: null, frame: null }, report, signal);
                  return { text: 'Sent to Discord.' };
                })
              }
            >
              <Icon name="message" size={14} /> Send to Discord
            </button>
          )}
          <button className="btn btn--small" onClick={() => revealClip(playing)}>
            <Icon name="folder" size={14} /> Show in folder
          </button>
          <button className="icon-btn" title="Close" onClick={close}>
            <Icon name="x" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
