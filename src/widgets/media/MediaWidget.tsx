import type { MouseEvent } from 'react';
import { useBoard } from '../../components/boardContext';
import { Icon } from '../../components/Icon';
import { usePrivate } from '../../privacy';
import { isBrowserSource, type MediaNow, mediaArtUrl, sendMediaControl, useMedia, useMediaPosition } from './media';
import { formatClock, progressFraction, seekPosition } from './mediaProgress';

export function MediaBody() {
  const m = useMedia();
  // In stream mode it only shows what's playing; the buttons and the seek bar are for the editor.
  const { editing } = useBoard();
  // On air, what a browser tab is playing stays off screen; only that something is playing shows.
  const hidden = usePrivate();
  if (!m) return null;
  if (!m.title) return <p className="muted">Nothing is playing.</p>;
  return <MediaPlayer m={hidden && isBrowserSource(m.app) ? hideDetails(m) : m} canControl={editing} />;
}

/** The same reading with the title, artist, album and cover taken out. */
const hideDetails = (m: MediaNow): MediaNow => ({ ...m, title: 'Playing in a browser', artist: '', album: '', art: '' });

function MediaPlayer({ m, canControl }: { m: MediaNow; canControl: boolean }) {
  const can = m.controls ?? { playPause: false, next: false, previous: false, seek: false };
  const duration = m.duration ?? 0;
  const position = useMediaPosition(m);
  const seekable = canControl && can.seek && duration > 0;
  const seekTo = (e: MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width > 0) sendMediaControl('seek', seekPosition((e.clientX - box.left) / box.width, duration));
  };
  return (
    <div className={`widget-media ${m.playing ? 'is-playing' : ''}`}>
      {m.art && <div className="widget-media__backdrop" style={{ backgroundImage: `url(${mediaArtUrl(m.art)})` }} />}
      {m.art ? <img src={mediaArtUrl(m.art)} alt="" /> : <span className="widget-media__art"><Icon name="music" size={22} /></span>}
      <div className="widget-media__info">
        <strong>{m.title}</strong>
        {m.artist && <span>{m.artist}</span>}
        <small>{[m.app, !m.playing && 'Paused'].filter(Boolean).join(' · ')}</small>
      </div>
      {duration > 0 && (
        <div className="widget-media__timeline">
          <span>{formatClock(position)}</span>
          <div
            className={`widget-media__bar ${seekable ? 'is-seekable' : ''}`}
            role={seekable ? 'slider' : 'progressbar'}
            aria-label="Position"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(position)}
            onClick={seekable ? seekTo : undefined}
          >
            <i style={{ width: `${progressFraction(position, duration) * 100}%` }} />
          </div>
          <span>{formatClock(duration)}</span>
        </div>
      )}
      {canControl && (
        <div className="widget-media__controls">
          <button className="widget-media__skip" disabled={!can.previous} title="Previous" aria-label="Previous" onClick={() => sendMediaControl('previous')}>
            <Icon name="skipBack" size={18} />
          </button>
          <button
            className="widget-media__play"
            disabled={!can.playPause}
            title={m.playing ? 'Pause' : 'Play'}
            aria-label={m.playing ? 'Pause' : 'Play'}
            onClick={() => sendMediaControl('toggle')}
          >
            <Icon name={m.playing ? 'pause' : 'play'} size={20} />
          </button>
          <button className="widget-media__skip" disabled={!can.next} title="Next" aria-label="Next" onClick={() => sendMediaControl('next')}>
            <Icon name="skipForward" size={18} />
          </button>
        </div>
      )}
    </div>
  );
}
