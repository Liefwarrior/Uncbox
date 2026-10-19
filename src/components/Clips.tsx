import { useEffect, useState } from 'react';
import { keyLabel, isClipKey } from '../clips/keys';
import { CLIP_SECONDS, clipUrl, revealClip, saveClip, useClips, watchClip } from '../clips/replay';
import { useCover } from '../native';
import type { ClipSettings } from '../state/model';
import type { Mutate } from '../state/useAppState';
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
                <small>{megabytes(c.size)}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button className="side-link side-link--quiet" title={clips.dir} onClick={() => revealClip()}>
        <Icon name="folder" /> Open clips folder
      </button>
    </>
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
  useEffect(() => {
    if (!playing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      watchClip(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [playing]);

  if (!playing) return null;
  return (
    <div className="clip-player" role="dialog" aria-label="Clip" onClick={() => watchClip(null)}>
      <div className="clip-player__box" onClick={(e) => e.stopPropagation()}>
        <video src={clipUrl(playing)} controls autoPlay />
        <div className="clip-player__bar">
          <span>{playing.replace(/\.mp4$/, '')}</span>
          <span className="spacer" />
          <button className="btn btn--small" onClick={() => revealClip(playing)}>
            <Icon name="folder" size={14} /> Show in folder
          </button>
          <button className="icon-btn" title="Close" onClick={() => watchClip(null)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
