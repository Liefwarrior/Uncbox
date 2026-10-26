import { useEffect, useRef, useState } from 'react';
import { usePrivate } from '../privacy';
import { send, shell } from '../native';
import type { StreamSettings } from '../state/model';
import type { Mutate } from '../state/useAppState';
import { useArmed } from '../useArmed';
import { useNow } from '../widgets/shared/useNow';
import { installTools, useDownloads } from '../widgets/downloads/downloads';
import { checkStreamTools, saveStreamKey, streamKeyFromTwitch } from '../stream/api';
import { useAudioLevels, useMics } from '../stream/audio';
import { streamLine, toolsLine } from '../stream/format';
import { endStream, goLive, useStreamController } from '../stream/live';
import { QUALITIES, qualityLabel, qualityOf, qualityValues, type QualityId } from '../stream/quality';
import { isStreaming, useStream, useToolsChecked } from '../stream/status';
import { Icon } from './Icon';

// The sidebar's side of streaming from Uncbox (src/stream): the Streaming section where it is
// set up, and the Go live buttons under Stream mode.

/** Whether a stream is going, trying to start, or trying to come back: the settings that need a restart are locked. */
function useBusy(): boolean {
  const status = useStream();
  const ctl = useStreamController();
  return ctl.phase !== 'idle' || isStreaming(status) || status.state === 'stopping';
}

/** "Stream with" and, with Uncbox picked, the key, screen, quality and sound. */
export function StreamSection({ settings, mutate }: { settings: StreamSettings; mutate: Mutate }) {
  const set = (patch: Partial<StreamSettings>) => mutate((s) => void Object.assign(s.stream, patch));
  const uncbox = settings.with === 'uncbox';
  // Switching to OBS under a running stream would take away the button that ends it.
  const busy = useBusy();
  return (
    <>
      <label className="side-field">
        Stream with
        <select className="select--block" disabled={busy} value={settings.with} onChange={(e) => set({ with: e.target.value === 'uncbox' ? 'uncbox' : 'obs' })}>
          <option value="obs">OBS</option>
          <option value="uncbox">Uncbox</option>
        </select>
      </label>
      {uncbox ? <UncboxStreaming settings={settings} set={set} /> : <p className="hint">OBS does the streaming, as before. Pick Uncbox to stream from here.</p>}
    </>
  );
}

function UncboxStreaming({ settings, set }: { settings: StreamSettings; set: (patch: Partial<StreamSettings>) => void }) {
  const status = useStream();
  const ctl = useStreamController();
  const busy = useBusy();
  const downloads = useDownloads(true);
  const checked = useToolsChecked();
  const [problem, setProblem] = useState('');

  // Look for FFmpeg and NVENC now, and again once an install of FFmpeg finishes.
  useEffect(() => void checkStreamTools(), []);
  const installing = downloads.install.running;
  const wasInstalling = useRef(installing);
  useEffect(() => {
    if (wasInstalling.current && !installing) void checkStreamTools(true);
    wasInstalling.current = installing;
  }, [installing]);

  const tools = toolsLine(status.tools, checked);
  const quality = qualityOf(settings);
  const installFfmpeg = async () => setProblem(await installTools('ffmpeg'));

  // While the stream is going, a volume change reaches the app at once.
  const going = ctl.phase === 'running';
  useEffect(() => {
    if (shell && going) send({ type: 'streamaudiovolume', desktopVolume: settings.desktopVolume, micVolume: settings.micVolume });
  }, [going, settings.desktopVolume, settings.micVolume]);

  return (
    <>
      <StreamKey busy={busy} />
      <label className="side-field">
        Screen
        <select className="select--block" disabled={busy} value={settings.screen} onChange={(e) => set({ screen: Number(e.target.value) })}>
          {[0, 1, 2, 3].map((n) => (
            <option key={n} value={n}>
              Screen {n + 1}
            </option>
          ))}
          {settings.screen > 3 && <option value={settings.screen}>Screen {settings.screen + 1}</option>}
        </select>
      </label>
      <label className="side-field">
        Quality
        <select
          className="select--block"
          disabled={busy}
          value={quality ?? 'custom'}
          onChange={(e) => {
            const id = e.target.value as QualityId;
            if (QUALITIES.some((q) => q.id === id)) set(qualityValues(id));
          }}
        >
          {QUALITIES.map((q) => (
            <option key={q.id} value={q.id}>
              {q.label}
            </option>
          ))}
          {!quality && <option value="custom">{qualityLabel(settings)}</option>}
        </select>
      </label>
      <Sound settings={settings} set={set} busy={busy} live={status.state === 'live'} />
      <p className={`stream__tools ${tools.state === 'ready' ? 'is-ready' : ''}`}>{tools.text}</p>
      {tools.state === 'missing' && (
        <div className="clips__actions">
          {downloads.tools?.winget !== false && (
            <button className="btn btn--small" disabled={installing} onClick={() => void installFfmpeg()}>
              {installing ? 'Installing…' : 'Install FFmpeg'}
            </button>
          )}
          <button className="btn btn--small" onClick={() => void checkStreamTools(true)}>
            Check again
          </button>
        </div>
      )}
      {problem && <p className="error">{problem}</p>}
    </>
  );
}

/** The stream key: whether it is set (and its last four characters), and ways to set or forget it. */
function StreamKey({ busy }: { busy: boolean }) {
  const { key } = useStream();
  // The key's last characters are on screen in the sidebar: not while the screen is public.
  const hidden = usePrivate();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);

  const close = () => {
    setEditing(false);
    setText('');
    setError('');
  };
  const run = async (job: () => Promise<string>, done?: () => void) => {
    setWorking(true);
    const why = await job();
    setWorking(false);
    setError(why);
    if (!why) done?.();
  };

  if (editing) {
    return (
      <form
        className="clips__discord"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => saveStreamKey(text), close);
        }}
      >
        {/* Hidden as you type, like a password: anyone with it can stream to your channel. */}
        <input type="password" autoComplete="off" spellCheck={false} autoFocus placeholder="live_…" aria-label="Twitch stream key" value={text} onChange={(e) => setText(e.target.value)} />
        {error && <p className="error">{error}</p>}
        <p className="hint">On Twitch: Creator Dashboard, Settings, Stream, Primary Stream key. It stays on this PC.</p>
        <div className="clips__actions">
          <button className="btn btn--small btn--accent" disabled={!text.trim() || working}>
            {working ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn btn--small" onClick={close}>
            Cancel
          </button>
        </div>
      </form>
    );
  }
  return (
    <div className="clips__discord">
      <p className="hint">{key.set ? (hidden ? 'Stream key set' : `Stream key set ····${key.hint}`) : 'No stream key yet'}</p>
      <div className="clips__actions">
        <button className="btn btn--small" disabled={busy || working} onClick={() => setEditing(true)}>
          {key.set ? 'Replace key' : 'Paste stream key'}
        </button>
        <button className="btn btn--small" disabled={busy || working} onClick={() => void run(streamKeyFromTwitch)}>
          Get it from Twitch
        </button>
        {key.set && (
          <button className="btn btn--small" disabled={busy || working} onClick={() => void run(() => saveStreamKey(''))}>
            Forget
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** Desktop sound and the mic, with a volume for each and (while live) a level meter. */
function Sound({ settings, set, busy, live }: { settings: StreamSettings; set: (patch: Partial<StreamSettings>) => void; busy: boolean; live: boolean }) {
  const mics = useMics(Boolean(shell));
  if (!shell) return <p className="hint">Sound needs the Uncbox app. Opened in a browser, the stream has no sound.</p>;
  const known = settings.mic === null || settings.mic === 'default' || mics.some((m) => m.id === settings.mic);
  const defaultMic = mics.find((m) => m.isDefault);
  return (
    <>
      <ul className="toggles">
        <li>
          <label>
            <input type="checkbox" checked={settings.desktop} disabled={busy} onChange={(e) => set({ desktop: e.target.checked })} />
            <span className="toggle" />
            <span className="toggles__text">
              Desktop sound
              <small>What Windows plays: the game, music, voice chat</small>
            </span>
          </label>
        </li>
      </ul>
      <label className="side-field">
        Mic
        <select className="select--block" disabled={busy} value={settings.mic ?? ''} onChange={(e) => set({ mic: e.target.value === '' ? null : e.target.value })}>
          <option value="">No mic</option>
          <option value="default">{defaultMic ? `Default (${defaultMic.name})` : 'Default mic'}</option>
          {mics.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
          {!known && mics.length > 0 && <option value={settings.mic ?? ''}>That mic isn’t connected</option>}
        </select>
      </label>
      <Volumes settings={settings} set={set} live={live} />
    </>
  );
}

function Volumes({ settings, set, live }: { settings: StreamSettings; set: (patch: Partial<StreamSettings>) => void; live: boolean }) {
  const levels = useAudioLevels(live);
  return (
    <div className="stream__volumes">
      {settings.desktop && <Volume label="Desktop volume" value={settings.desktopVolume} onChange={(v) => set({ desktopVolume: v })} level={live ? levels.desktop : null} />}
      {settings.mic !== null && <Volume label="Mic volume" value={settings.micVolume} onChange={(v) => set({ micVolume: v })} level={live ? levels.mic : null} />}
    </div>
  );
}

function Volume({ label, value, onChange, level }: { label: string; value: number; onChange: (v: number) => void; level: number | null }) {
  return (
    <div className="stream__volume">
      <label>
        <span>{label}</span>
        <input type="range" min={0} max={200} step={5} value={Math.round(value * 100)} aria-valuetext={`${Math.round(value * 100)} percent`} onChange={(e) => onChange(Number(e.target.value) / 100)} />
      </label>
      {level !== null && <Meter label={`${label} level`} value={level} />}
    </div>
  );
}

/** A level bar. Peaks are small numbers for ordinary sound, so the bar follows their square root, which is closer to how loudness is heard. */
function Meter({ label, value }: { label: string; value: number }) {
  const shown = Math.sqrt(Math.min(1, Math.max(0, value)));
  return (
    <div className="stream__meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={1} aria-valuenow={Math.round(value * 100) / 100}>
      <span style={{ width: `${Math.round(shown * 100)}%` }} />
    </div>
  );
}

/** Under the Stream mode button, with Uncbox picked: Go live, Test stream and, while it runs, its status and End stream. */
export function GoLive({ settings }: { settings: StreamSettings }) {
  return settings.with === 'uncbox' ? <GoLiveControls settings={settings} /> : null;
}

function GoLiveControls({ settings }: { settings: StreamSettings }) {
  const status = useStream();
  const ctl = useStreamController();
  const busy = useBusy();
  const live = useArmed();
  const end = useArmed();
  const now = useNow();

  const tools = toolsLine(status.tools, useToolsChecked());
  const reason = !status.key.set ? 'Add your stream key under Streaming below first.' : tools.state !== 'ready' ? tools.text : '';
  const error = ctl.error || (status.state === 'error' || status.state === 'dropped' ? status.error : '');

  if (!busy) {
    return (
      <div className="golive">
        <button className={`btn btn--accent golive__go ${live.armed ? 'is-armed' : ''}`} disabled={Boolean(reason)} onClick={() => live.trigger(() => void goLive(settings, false))}>
          <Icon name="radio" size={15} /> {live.armed ? 'Go live?' : 'Go live'}
        </button>
        <button className="side-link side-link--quiet" disabled={Boolean(reason)} onClick={() => void goLive(settings, true)}>
          Test stream (not public)
        </button>
        {reason && <p className="hint">{reason}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    );
  }
  return (
    <div className="golive">
      <p className={`golive__status ${status.state === 'live' ? 'is-live' : ''}`}>{streamLine(status, ctl, now)}</p>
      {ctl.note && <p className="hint">{ctl.note}</p>}
      {error && <p className="error">{error}</p>}
      <button className={`side-link side-link--quiet ${end.armed ? 'is-armed' : ''}`} onClick={() => end.trigger(() => void endStream())}>
        {end.armed ? 'End stream?' : 'End stream'}
      </button>
    </div>
  );
}
