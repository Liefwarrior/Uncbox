import { useEffect, useState } from 'react';
import { listen } from '../events';
import { Icon } from './Icon';
import { Panel } from './Panel';

// Steam, live from the Steam client on this PC (server/steam.mjs): what you're playing, for how
// long, achievements as they pop, and your recent games when you're between games.

interface Game {
  appid: number;
  name: string;
  lastPlayed: number;
  /** Minutes, as Steam counts them (it updates them when a game closes). */
  playtime: number;
}

interface SteamSnapshot {
  available: boolean;
  user?: { name: string };
  playing?:
    | (Game & {
        since: number;
        achievements: {
          unlocked: number;
          total: number;
          latest: { name: string; description: string; icon: string; at: number } | null;
        } | null;
      })
    | null;
  recent?: Game[];
}

function useSteam() {
  const [snap, setSnap] = useState<SteamSnapshot | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/steam')
      .then((r) => r.json())
      .then((s) => alive && setSnap(s))
      .catch(() => {});
    const stop = listen('steam', (data) => setSnap(JSON.parse(data)));
    return () => {
      alive = false;
      stop();
    };
  }, []);
  return snap;
}

function useTick(on: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

const art = (appid: number, file: string) => `/api/steam/art/${appid}/${file}`;
const hours = (minutes: number) => (minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 6) / 10} hrs`);

function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

/** An image that disappears instead of showing a broken icon when Steam has no such art. */
function Art({ src, className }: { src: string; className: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <img className={className} src={src} alt="" onError={() => setFailed(true)} />;
}

export function SteamPanel({ title }: { title: string }) {
  const steam = useSteam();
  const playing = steam?.playing ?? null;
  useTick(Boolean(playing));
  const recentAt = playing?.achievements?.latest?.at ?? 0;
  const fresh = recentAt > 0 && Date.now() - recentAt < 5 * 60_000;

  return (
    <Panel id="steam" title={title} bleed={Boolean(playing)} empty={!steam?.available}>
      {!steam ? null : !steam.available ? (
        <p className="muted">Steam wasn’t found on this PC. Uncbox reads it from the Steam app, so start Steam here.</p>
      ) : playing ? (
        <div className="steam-now">
          <div className="steam-now__hero">
            <Art className="steam-now__bg" src={art(playing.appid, 'library_hero.jpg')} />
            <Art className="steam-now__logo" src={art(playing.appid, 'logo.png')} />
          </div>
          <div className="steam-now__info">
            <span className="steam-now__label">Now playing</span>
            <strong>{playing.name}</strong>
            <div className="steam-now__stats">
              <span>
                <Icon name="timer" size={14} /> {clock(Date.now() - playing.since)} this session
              </span>
              {playing.playtime > 0 && <span>{hours(playing.playtime)} total</span>}
            </div>
            {playing.achievements && (
              <div className="steam-ach">
                <div className="steam-ach__bar">
                  <span style={{ width: `${(playing.achievements.unlocked / playing.achievements.total) * 100}%` }} />
                </div>
                <span className="steam-ach__count">
                  {playing.achievements.unlocked} / {playing.achievements.total} achievements
                </span>
                {playing.achievements.latest && (
                  <div className={`steam-ach__latest ${fresh ? 'is-fresh' : ''}`} key={playing.achievements.latest.at}>
                    {playing.achievements.latest.icon && (
                      <img
                        src={`https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${playing.appid}/${playing.achievements.latest.icon}`}
                        alt=""
                      />
                    )}
                    <span>
                      <small>{fresh ? 'Achievement unlocked' : 'Latest achievement'}</small>
                      {playing.achievements.latest.name}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="steam-idle">
          <div className="steam-idle__me">
            <Art className="steam-idle__avatar" src="/api/steam/avatar" />
            <span>
              <strong>{steam.user?.name}</strong>
              <small>Recently played</small>
            </span>
          </div>
          <ol className="steam-recent">
            {steam.recent?.map((g) => (
              <li key={g.appid}>
                <Art className="steam-recent__art" src={art(g.appid, 'library_600x900.jpg')} />
                <span className="steam-recent__name">{g.name}</span>
                <small>{hours(g.playtime)}</small>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Panel>
  );
}
