import { useEffect, useState } from 'react';
import { listen } from '../../events';
import { keepAlive } from '../../keepAlive';
import { interpolatePosition } from './mediaProgress';

// What is playing on this PC, from the Uncbox server (server/widgets.mjs).

export interface Media {
  playing: boolean;
  app?: string;
  title?: string;
  artist?: string;
  album?: string;
  /** The cover's version (see mediaArtUrl), or '' when there isn't one. */
  art?: string;
  /** Seconds into the track when it was read, and how long ago that was when the page got it. */
  position?: number;
  age?: number;
  /** Seconds; 0 when unknown. */
  duration?: number;
  /** Which buttons the playing app allows. */
  controls?: { playPause: boolean; next: boolean; previous: boolean; seek: boolean };
}

/** A reading plus when this page got it, so the progress bar can carry on from there. */
export type MediaNow = Media & { receivedAt: number };

/**
 * Whether what is playing comes from a web browser, where the title is a tab's title and can be a
 * private page. A music app (Spotify) is something the streamer chose to play; a tab may not be.
 */
export const isBrowserSource = (app: string | undefined): boolean => /chrome|edge|firefox|brave|opera|vivaldi|arc|safari|browser/i.test(app ?? '');

export const mediaArtUrl = (version: string) => `/api/media/art?v=${encodeURIComponent(version)}`;

export function useMedia(): MediaNow | null {
  const [media, setMedia] = useState<MediaNow | null>(null);
  useEffect(() => {
    let alive = true;
    const take = (m: Media) => alive && setMedia({ ...m, receivedAt: performance.now() });
    // The first ask starts the server's reader; after that, changes arrive as events.
    fetch('/api/media')
      .then((r) => r.json())
      .then(take)
      .catch(() => {});
    const stop = listen('media', (data) => take(JSON.parse(data)));
    // The reader stops when nobody has asked for a while, so a showing widget keeps asking.
    const stopAsking = keepAlive('/api/media');
    return () => {
      alive = false;
      stop();
      stopAsking();
    };
  }, []);
  return media;
}

export type MediaAction = 'toggle' | 'next' | 'previous' | 'seek';

/** Presses a button on the music playing on this PC. The next reading shows the result. */
export function sendMediaControl(action: MediaAction, position?: number): void {
  fetch('/api/media/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, position }),
  }).catch(() => {});
}

/** Where the track is now, redrawn a few times a second while it plays. */
export function useMediaPosition(m: MediaNow): number {
  const at = () =>
    interpolatePosition({ position: m.position ?? 0, duration: m.duration ?? 0, playing: m.playing }, (m.age ?? 0) + performance.now() - m.receivedAt);
  const [position, setPosition] = useState(at);
  useEffect(() => {
    setPosition(at);
    if (!m.playing) return;
    const t = setInterval(() => setPosition(at), 250);
    return () => clearInterval(t);
    // at() reads m, which these cover.
  }, [m.position, m.age, m.duration, m.playing, m.receivedAt]);
  return position;
}
