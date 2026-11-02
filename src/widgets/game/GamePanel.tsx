import { useEffect, useState } from 'react';
import { BLOCK, ROWS } from '../../../integrations/wow/codec';
import { useWowLink } from '../../../integrations/wow/useWowLink';
import { useReplayBuffer } from '../../clips/replay';
import { shareGameStream } from '../../hud/reader';
import { useDeviceStream, useVideoDevices, useWindowStream } from '../../media';
import { send, shell } from '../../native';
import { useSteam } from '../../steam';
import { useWowRunning, useWowStatus, wowWindowMatch } from '../../wow';
import type { GameSettings, VideoFit, VideoSource } from '../../state/model';
import type { PanelContext } from '../types';
import { useBoard } from '../../components/boardContext';
import { CropEditor } from '../../components/CropEditor';
import { CroppedVideo } from '../../components/CroppedVideo';
import { Dropdown } from '../../components/Dropdown';
import { Icon, type IconName } from '../../components/Icon';
import { NativeGame, useNativeGame } from './NativeGame';

const SOURCES: { id: VideoSource; label: string; icon: IconName; hint: string }[] = [
  { id: 'device', label: 'Capture card', icon: 'video', hint: 'A console plugged into this PC' },
  { id: 'window', label: 'Window', icon: 'monitor', hint: 'An emulator or PC game' },
  { id: 'chroma', label: 'Green screen', icon: 'droplet', hint: 'Keep your game capture in OBS' },
  // Only in the native shell, which can move a game's own window into the panel.
  ...(shell ? [{ id: 'native' as const, label: 'Play here', icon: 'play' as const, hint: 'Your game itself, played right in Uncbox' }] : []),
];

/** Steam's two views, which the app opens and puts in the panel (Steam Big Picture preset). */
const STEAM_VIEWS = [
  {
    id: 'bigpicture',
    label: 'Big Picture',
    icon: 'gamepad' as const,
    hint: 'Steam on the TV-style screen, played right here',
    match: { process: 'steamwebhelper', title: 'Steam Big Picture Mode', exact: true },
  },
  {
    id: 'library',
    label: 'Steam library',
    icon: 'list' as const,
    hint: 'The regular Steam window, right here',
    match: { process: 'steamwebhelper', title: 'Steam', exact: true },
  },
];

const FITS: { id: VideoFit; label: string }[] = [
  { id: 'contain', label: 'Fit' },
  { id: 'cover', label: 'Fill' },
  { id: 'stretch', label: 'Stretch' },
];

export function GamePanel({ state, data, def, mutatePreset }: PanelContext) {
  const game = data.game;
  const preset = def.id;
  const clips = state.clips;
  // The WoW preset's data, to fill in from the addon strip in the video; null in other games.
  const wow = preset === 'wow' ? data : null;
  const { editing, hide, fitWidthToAspect } = useBoard();
  const device = useDeviceStream(game.source === 'device', game.deviceId);
  // Play here shows the game itself, but clips and the WoW link still read a capture of it.
  const win = useWindowStream(game.source === 'window' || game.source === 'native');
  const devices = useVideoDevices(device.stream);
  const [cropOpen, setCropOpen] = useState(false);
  const [aspect, setAspect] = useState(0);
  const set = (patch: Partial<GameSettings>) => mutatePreset((d) => void Object.assign(d.game, patch));
  // Steam's views (Steam preset, in the app): a game started from them takes the panel while it runs.
  const steamViews = shell && preset === 'steam' ? STEAM_VIEWS : [];
  const steamView = game.source === 'native' ? steamViews.find((v) => v.match.title === game.nativeGame?.title) : undefined;
  const steamNow = useSteam(Boolean(steamView));
  // The app does the switching itself, the moment the game's window opens: it's told where Steam's
  // games live and takes any new window from there.
  const commons = steamView ? (steamNow?.commons ?? []) : [];
  const commonsKey = JSON.stringify(commons);
  useEffect(() => {
    if (!shell) return;
    send({ type: 'follow', folders: JSON.parse(commonsKey) });
    return () => send({ type: 'follow', folders: [] });
  }, [commonsKey]);
  const native = useNativeGame(game.source === 'native', game.nativeGame, (nativeGame) => set({ nativeGame }));

  const stream = game.source === 'device' ? device.stream : game.source === 'window' || game.source === 'native' ? win.stream : null;
  const error = game.source === 'device' ? device.error : game.source === 'window' || game.source === 'native' ? win.error : null;
  const capturing = game.source === 'device' || game.source === 'window';
  // The addon draws its strip in the corner chosen in the sidebar.
  const wowStatus = useWowStatus(false);
  const stripPct = useWowLink(stream, wow, mutatePreset, wowStatus?.settings?.strip?.corner);
  // WoW running with no game set up yet: in the app it goes straight into the panel; in a browser,
  // which can't capture without a click, a "Show WoW" button waits in the empty panel. A source the
  // player chose is never changed.
  const wowRunning = useWowRunning(wow !== null && game.source === 'none', wowStatus);
  useEffect(() => {
    if (shell && wowRunning && game.source === 'none') set({ source: 'native', nativeGame: wowWindowMatch(wowRunning) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wowRunning, game.source]);
  // Viewers never see the addon's strip: crop at least down to its bottom edge.
  const crop = stripPct > game.crop.top ? { ...game.crop, top: stripPct } : game.crop;
  // Clips get the same crop, so they never show the strip either.
  useReplayBuffer(stream, crop, clips);
  // Play here can't move exclusive full screen, so games Uncbox knows are switched to windowed
  // fullscreen in their own settings (only while they're closed; it takes effect next start).
  useEffect(() => {
    if (game.source !== 'native') return;
    void fetch('/api/game-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset }),
    }).catch(() => {});
  }, [game.source, preset]);
  // The Stats panel reads numbers off the game picture.
  useEffect(() => {
    shareGameStream(stream);
    return () => shareGameStream(null);
  }, [stream]);
  // Playing WoW here without a capture, the strip's place is known anyway: the top few pixels.
  const stripPx = wow && game.source === 'native' && !stripPct ? ROWS * BLOCK + 1 : 0;
  const openSteam = (view: (typeof STEAM_VIEWS)[number]) => {
    native.switchTo(view.match);
    set({ source: 'native', nativeGame: view.match });
    void fetch('/api/steam/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ view: view.id }),
    }).catch(() => {});
  };
  const choose = (source: VideoSource) => {
    // From a Steam view, Play here means picking some other window.
    if (source === 'native' && steamView) {
      set({ nativeGame: null });
      native.pick();
      return;
    }
    set({ source });
    // The window picker needs this click's user activation, so open it right away.
    if (source === 'window') void win.pick();
  };

  return (
    <section
      aria-label="Game"
      className={`panel panel--game ${game.source === 'chroma' ? 'is-chroma' : ''} ${game.source === 'native' ? 'is-native' : ''} ${!stream && game.source !== 'chroma' && !(game.source === 'native' && native.attached) ? 'is-empty' : ''}`}
      style={game.source === 'chroma' ? { background: game.chroma } : undefined}
    >
      {game.source === 'native' ? (
        <NativeGame game={native} editing={editing} crop={crop} stripPx={stripPx} />
      ) : stream ? (
        <CroppedVideo
          stream={stream}
          fit={game.fit}
          crop={crop}
          pixelated={game.pixelated}
          onAspect={setAspect}
        />
      ) : game.source !== 'chroma' && editing ? (
        <div className="game-empty">
          {game.source === 'none' && (
            <>
              {wowRunning && !shell && (
                <button className="btn btn--accent" data-setup="" onClick={() => choose('window')}>
                  <Icon name="monitor" /> Show WoW
                </button>
              )}
              <h3>Where is your game?</h3>
              <div className="source-row">
                {SOURCES.map((s, i) => (
                  <button
                    key={s.id}
                    className="source-card"
                    data-setup={i === 0 ? '' : undefined}
                    onClick={() => choose(s.id)}
                  >
                    <Icon name={s.icon} size={22} />
                    <strong>{s.label}</strong>
                    <span>{s.hint}</span>
                  </button>
                ))}
                {steamViews.map((v) => (
                  <button key={v.id} className="source-card" onClick={() => openSteam(v)}>
                    <Icon name={v.icon} size={22} />
                    <strong>{v.label}</strong>
                    <span>{v.hint}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {game.source === 'device' && (
            <>
              <h3>{error ? 'Capture device unavailable' : 'Connecting to capture device…'}</h3>
              {error && <p className="error">{error}</p>}
              {error && (
                <button className="btn" onClick={device.retry}>
                  Retry
                </button>
              )}
            </>
          )}
          {game.source === 'window' && (
            <>
              <h3>Window capture</h3>
              <p className="muted">Your browser asks again after each reload.</p>
              {error && <p className="error">{error}</p>}
              <button className="btn btn--accent" onClick={() => void win.pick()}>
                <Icon name="monitor" /> Choose window
              </button>
            </>
          )}
        </div>
      ) : null}

      {editing && (
        <div className="game-toolbar">
          <span className="drag-handle game-toolbar__grip" title="Drag to move">
            <Icon name="grip" size={14} /> Game
          </span>
          <Dropdown
            label="Source"
            className="game-toolbar__source"
            value={steamView ? steamView.id : game.source}
            options={[{ id: 'none', label: 'None' }, ...SOURCES, ...steamViews.map((v) => ({ id: v.id, label: v.label, icon: v.icon }))]}
            onChange={(id) => {
              const view = steamViews.find((v) => v.id === id);
              if (view) openSteam(view);
              else choose(id as VideoSource);
            }}
          />

          {game.source === 'device' && (
            <select value={game.deviceId ?? ''} onChange={(e) => set({ deviceId: e.target.value || null })} title="Video input" aria-label="Video input">
              <option value="">System default</option>
              {devices.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || `Video input ${i + 1}`}
                </option>
              ))}
            </select>
          )}
          {game.source === 'window' && stream && (
            <button className="btn" onClick={() => void win.pick()}>
              Choose window
            </button>
          )}
          {game.source === 'native' && native.attached && !native.picking && (
            <>
              <button className="btn" title="Hand the keyboard and controller to the game" onClick={native.play}>
                <Icon name="play" /> Play
              </button>
              <button
                className="btn"
                title="The game gets the whole screen at its own resolution. Ctrl+Shift+F12 brings Uncbox back."
                onClick={native.fullScreen}
              >
                <Icon name="fit" /> Full screen
              </button>
              <button className="btn" onClick={native.pick}>
                Change game
              </button>
              <button
                className={`btn ${win.stream ? 'btn--on' : ''}`}
                title={
                  win.stream
                    ? 'Clips and the WoW link are reading the game. Click to pick the window again.'
                    : 'Clips and the WoW link read a capture of the game. Pick the same game window.'
                }
                onClick={() => void win.pick()}
              >
                <Icon name="film" /> {win.stream ? 'Clips on' : 'Turn on clips'}
              </button>
            </>
          )}
          {game.source === 'native' && native.picture && (
            <span className="game-toolbar__note" title="It keeps itself full screen, so Uncbox shows it as a picture">
              Controller and keyboard only.
              {native.picture.launchOption ? (
                <>
                  {' '}
                  For the mouse, add <code>{native.picture.launchOption}</code> to its Steam launch options.
                </>
              ) : (
                ' For the mouse, set it to windowed in its settings.'
              )}
            </span>
          )}
          {game.source === 'native' && error && <span className="error">{error}</span>}
          {game.source === 'native' && native.attached && !native.picking && (
            <button className={`btn ${cropOpen ? 'btn--on' : ''}`} title="Hide the game's edges under the dashboard" onClick={() => setCropOpen((o) => !o)}>
              <Icon name="crop" /> Crop
            </button>
          )}
          {game.source === 'chroma' && (
            <label className="inline" title="Key this color out in OBS">
              Color <input type="color" value={game.chroma} onChange={(e) => set({ chroma: e.target.value })} />
            </label>
          )}

          <span className="spacer" />

          {capturing && (
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
              <button
                className="btn"
                disabled={!stream || !aspect}
                title="Resize this window's width to the game's shape, removing the black bars"
                onClick={() => fitWidthToAspect('game', aspect)}
              >
                <Icon name="fit" /> Fit to game
              </button>
            </>
          )}
          <button className="icon-btn" title="Hide the game window" aria-label="Hide the game window" onClick={() => hide('game', 'Game')}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      {cropOpen && editing && (capturing || game.source === 'native') && (
        <CropEditor
          crop={game.crop}
          onChange={(edge, value) => mutatePreset((d) => void (d.game.crop[edge] = value))}
          onReset={() => set({ crop: { top: 0, right: 0, bottom: 0, left: 0 } })}
          onClose={() => setCropOpen(false)}
        />
      )}
    </section>
  );
}
