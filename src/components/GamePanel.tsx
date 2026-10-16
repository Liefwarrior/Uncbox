import { useState } from 'react';
import { useDeviceStream, useVideoDevices, useWindowStream } from '../media';
import type { GameSettings, VideoFit, VideoSource } from '../state/model';
import type { Mutate } from '../state/useAppState';
import { CroppedVideo } from './CroppedVideo';
import { Icon, type IconName } from './Icon';

const SOURCES: { id: VideoSource; label: string; icon: IconName; hint: string }[] = [
  { id: 'device', label: 'Capture device', icon: 'video', hint: 'Capture card for Switch, 3DS, GameCube… or any webcam-style input.' },
  { id: 'window', label: 'Window', icon: 'monitor', hint: 'An emulator window (mGBA, melonDS, Dolphin, RetroArch…) or a whole screen.' },
  { id: 'chroma', label: 'Chroma slot', icon: 'droplet', hint: 'A solid color you key out in OBS, with your game capture layered underneath.' },
];

const FITS: { id: VideoFit; label: string }[] = [
  { id: 'contain', label: 'Fit' },
  { id: 'cover', label: 'Fill' },
  { id: 'stretch', label: 'Stretch' },
];

interface Props {
  game: GameSettings;
  mutate: Mutate;
  streamMode: boolean;
}

export function GamePanel({ game, mutate, streamMode }: Props) {
  const device = useDeviceStream(game.source === 'device', game.deviceId);
  const win = useWindowStream(game.source === 'window');
  const devices = useVideoDevices(device.stream);
  const [cropOpen, setCropOpen] = useState(false);

  const stream = game.source === 'device' ? device.stream : game.source === 'window' ? win.stream : null;
  const error = game.source === 'device' ? device.error : game.source === 'window' ? win.error : null;
  const set = (patch: Partial<GameSettings>) => mutate((s) => void Object.assign(s.game, patch));
  const choose = (source: VideoSource) => {
    set({ source });
    // The window picker needs this click's user activation, so open it right away.
    if (source === 'window') void win.pick();
  };

  return (
    <section
      className={`panel panel--game ${game.source === 'chroma' ? 'is-chroma' : ''}`}
      style={game.source === 'chroma' ? { background: game.chroma } : undefined}
    >
      {stream ? (
        <CroppedVideo stream={stream} fit={game.fit} crop={game.crop} pixelated={game.pixelated} />
      ) : game.source !== 'chroma' ? (
        <div className="game-empty">
          {game.source === 'none' && (
            <>
              <img src="/favicon.svg" alt="" width={56} height={56} />
              <h3>Choose a game source</h3>
              <div className="source-cards">
                {SOURCES.map((s) => (
                  <button key={s.id} className="source-card" onClick={() => choose(s.id)}>
                    <Icon name={s.icon} size={22} />
                    <strong>{s.label}</strong>
                    <span>{s.hint}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {game.source === 'device' && (
            <>
              <h3>{error ? 'Capture device unavailable' : 'Connecting to capture device…'}</h3>
              {error && <p className="error">{error}</p>}
              {error && <button className="btn" onClick={device.retry}>Retry</button>}
            </>
          )}
          {game.source === 'window' && (
            <>
              <h3>Pick the window to show</h3>
              <p className="muted">Browsers ask again after every reload; that is a browser rule, not a bug.</p>
              {error && <p className="error">{error}</p>}
              <button className="btn btn--accent" onClick={() => void win.pick()}>
                <Icon name="monitor" /> Pick window
              </button>
            </>
          )}
        </div>
      ) : null}

      {!streamMode && (
        <div className="game-toolbar">
          <div className="seg">
            {[{ id: 'none' as const, label: 'None' }, ...SOURCES].map((s) => (
              <button key={s.id} className={game.source === s.id ? 'on' : ''} onClick={() => choose(s.id)}>
                {s.label}
              </button>
            ))}
          </div>

          {game.source === 'device' && (
            <select
              value={game.deviceId ?? ''}
              onChange={(e) => set({ deviceId: e.target.value || null })}
              title="Video input"
            >
              <option value="">System default</option>
              {devices.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || `Video input ${i + 1}`}
                </option>
              ))}
            </select>
          )}
          {game.source === 'window' && stream && (
            <button className="btn" onClick={() => void win.pick()}>Change window</button>
          )}
          {game.source === 'chroma' && (
            <label className="inline" title="Key this color out in OBS">
              Color <input type="color" value={game.chroma} onChange={(e) => set({ chroma: e.target.value })} />
            </label>
          )}

          <span className="spacer" />

          {(game.source === 'device' || game.source === 'window') && (
            <>
              <div className="seg">
                {FITS.map((f) => (
                  <button key={f.id} className={game.fit === f.id ? 'on' : ''} onClick={() => set({ fit: f.id })}>
                    {f.label}
                  </button>
                ))}
              </div>
              <label className="inline" title="Nearest-neighbour scaling keeps pixel art crisp">
                <input type="checkbox" checked={game.pixelated} onChange={(e) => set({ pixelated: e.target.checked })} />
                Sharp pixels
              </label>
              <button className={`btn ${cropOpen ? 'btn--on' : ''}`} onClick={() => setCropOpen((o) => !o)}>
                <Icon name="crop" /> Crop
              </button>
            </>
          )}
        </div>
      )}

      {cropOpen && !streamMode && (game.source === 'device' || game.source === 'window') && (
        <div className="crop-editor">
          <p className="muted">Trim the edges of the source, e.g. an emulator’s menu bar or a capture card’s black borders.</p>
          {(['top', 'bottom', 'left', 'right'] as const).map((edge) => (
            <label key={edge}>
              <span>{edge}</span>
              <input
                type="range"
                min={0}
                max={45}
                step={0.5}
                value={game.crop[edge]}
                onChange={(e) => mutate((s) => void (s.game.crop[edge] = Number(e.target.value)))}
              />
              <output>{game.crop[edge].toFixed(1)}%</output>
            </label>
          ))}
          <div className="row">
            <button className="btn" onClick={() => set({ crop: { top: 0, right: 0, bottom: 0, left: 0 } })}>
              Reset
            </button>
            <button className="btn btn--accent" onClick={() => setCropOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </section>
  );
}
