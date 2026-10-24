import { type ReactNode, useEffect, useRef, useState } from 'react';
import { WidgetFrame } from '../frame';
import type { WidgetProps } from '../types';
import { useBoard } from '../../components/boardContext';
import { Icon } from '../../components/Icon';
import { bitrateText, dropLevel, droppedPercent, loadObsSettings, type ObsAction, obsAction, type ObsSnapshot, saveObsSettings, useObs } from '../../obs';

// The OBS widget: stream health at the top, then the buttons that run OBS. In stream mode only the
// status is shown, so viewers never see (or can click) the controls.

/** The widget's panel. "OBS connection" in its menu shows the connection form, even while connected. */
export function ObsPanel({ widget, name, mutatePreset }: WidgetProps<object>) {
  const obs = useObs();
  const [setup, setSetup] = useState(false);
  return (
    <WidgetFrame
      widget={widget}
      name={name}
      mutatePreset={mutatePreset}
      // Nothing to show viewers while OBS isn't there.
      empty={!obs?.connected && !setup}
      menu={[{ label: 'OBS connection', icon: 'list', onSelect: () => setSetup((o) => !o) }]}
    >
      <ObsBody obs={obs} setup={setup} onSetupDone={() => setSetup(false)} />
    </WidgetFrame>
  );
}

function ObsBody({ obs, setup, onSetupDone }: { obs: ObsSnapshot | null; setup: boolean; onSetupDone: () => void }) {
  const { editing } = useBoard();
  if (!obs) return null;
  if (!obs.connected || setup) return editing ? <ObsSetup obs={obs} onDone={onSetupDone} /> : null;
  return <ObsLive obs={obs} controls={editing} />;
}

function Pill({ kind, children }: { kind: 'live' | 'rec' | 'idle'; children: ReactNode }) {
  return <span className={`obs-pill obs-pill--${kind}`}>{children}</span>;
}

function ObsLive({ obs, controls }: { obs: ObsSnapshot; controls: boolean }) {
  const { stream, record, stats } = obs;
  const [error, setError] = useState('');
  const [confirmStop, setConfirmStop] = useState(false);
  const [saved, setSaved] = useState(false);
  const errorTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const run = async (action: ObsAction) => {
    const problem = await obsAction(action);
    setError(problem);
    clearTimeout(errorTimer.current);
    if (problem) errorTimer.current = setTimeout(() => setError(''), 6000);
    return !problem;
  };
  useEffect(() => () => clearTimeout(errorTimer.current), []);

  // "Stop streaming?" asks once, then goes away by itself if nobody answers.
  useEffect(() => {
    if (!confirmStop) return;
    const t = setTimeout(() => setConfirmStop(false), 8000);
    return () => clearTimeout(t);
  }, [confirmStop]);
  useEffect(() => {
    if (!stream.active) setConfirmStop(false);
  }, [stream.active]);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(t);
  }, [saved]);

  const dropped = droppedPercent(stream);
  const level = dropLevel(dropped);

  return (
    <div className="widget-obs">
      <div className="obs-head">
        <div className="obs-pills">
          {stream.active && <Pill kind="live">{stream.reconnecting ? 'RECONNECTING' : 'LIVE'} {stream.timecode}</Pill>}
          {record.active && (
            <Pill kind="rec">
              {record.paused ? 'PAUSED' : 'REC'} {record.timecode}
            </Pill>
          )}
          {!stream.active && !record.active && <Pill kind="idle">Not live</Pill>}
        </div>
        <div className="obs-stats">
          {stream.active && stream.bitrate !== null && <span>{bitrateText(stream.bitrate)}</span>}
          {stream.active && (
            <span className={`obs-drop obs-drop--${level}`} title="Frames dropped before they reached the stream">
              {dropped < 10 ? dropped.toFixed(1) : Math.round(dropped)}% dropped
            </span>
          )}
          <span>CPU {Math.round(stats.cpu)}%</span>
          <span>{Math.round(stats.fps)} FPS</span>
        </div>
      </div>

      {!controls && obs.scene && <p className="obs-scene-name">{obs.scene}</p>}

      {controls && (
        <>
          <div className="obs-buttons">
            {confirmStop ? (
              <div className="obs-confirm" role="alertdialog" aria-label="Stop streaming?">
                <strong>Stop streaming?</strong>
                <button
                  className="btn btn--small obs-stop"
                  onClick={() => {
                    setConfirmStop(false);
                    void run({ type: 'StopStream' });
                  }}
                >
                  Yes
                </button>
                <button className="btn btn--small" onClick={() => setConfirmStop(false)}>
                  Cancel
                </button>
              </div>
            ) : stream.active ? (
              <button className="btn obs-big obs-big--on" onClick={() => setConfirmStop(true)}>
                <Icon name="cast" size={16} /> Stop stream
              </button>
            ) : (
              <button className="btn btn--accent obs-big" onClick={() => void run({ type: 'StartStream' })}>
                <Icon name="cast" size={16} /> Start stream
              </button>
            )}
            <button className={`btn obs-big ${record.active ? 'obs-big--on' : 'btn--accent'}`} onClick={() => void run({ type: record.active ? 'StopRecord' : 'StartRecord' })}>
              <Icon name="video" size={16} /> {record.active ? 'Stop recording' : 'Start recording'}
            </button>
          </div>
          <div className="obs-extras">
            {record.active && (
              <button className="btn btn--small" onClick={() => void run({ type: record.paused ? 'ResumeRecord' : 'PauseRecord' })}>
                <Icon name={record.paused ? 'play' : 'pause'} size={13} /> {record.paused ? 'Resume' : 'Pause'}
              </button>
            )}
            {obs.replayBuffer && (
              <button
                className="btn btn--small"
                onClick={() => {
                  void run({ type: 'SaveReplayBuffer' }).then((ok) => ok && setSaved(true));
                }}
              >
                <Icon name={saved ? 'check' : 'film'} size={13} /> {saved ? 'Saved' : 'Save replay'}
              </button>
            )}
            <button className={`btn btn--small ${obs.virtualCam ? 'btn--on' : ''}`} onClick={() => void run({ type: obs.virtualCam ? 'StopVirtualCam' : 'StartVirtualCam' })}>
              <Icon name="monitor" size={13} /> Virtual cam
            </button>
          </div>
          {error && <p className="error obs-error">{error}</p>}

          {obs.scenes.length > 0 && (
            <div className="obs-scenes">
              {obs.scenes.map((name) => (
                <button key={name} className={`btn btn--small obs-scene ${name === obs.scene ? 'btn--on' : ''}`} title={name} aria-pressed={name === obs.scene} onClick={() => name !== obs.scene && void run({ type: 'SetCurrentProgramScene', sceneName: name })}>
                  {name}
                </button>
              ))}
            </div>
          )}

          {obs.inputs.length > 0 && (
            <div className="obs-audio">
              {obs.inputs.map((input) => (
                <button key={input.name} className={`btn btn--small obs-mute ${input.muted ? 'is-muted' : ''}`} title={`${input.muted ? 'Unmute' : 'Mute'} ${input.name}`} aria-pressed={input.muted} onClick={() => void run({ type: 'ToggleInputMute', inputName: input.name })}>
                  <Icon name={input.muted ? 'micOff' : 'mic'} size={13} />
                  <span>{input.name}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ObsSetup({ obs, onDone }: { obs: ObsSnapshot; onDone: () => void }) {
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('4455');
  const [password, setPassword] = useState('');
  const [passwordSet, setPasswordSet] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadObsSettings().then((s) => {
      if (!alive || !s) return;
      setHost(s.host);
      setPort(String(s.port));
      setPasswordSet(s.passwordSet);
    });
    return () => {
      alive = false;
    };
  }, []);

  const save = async (clearPassword = false) => {
    setSaving(true);
    const problem = await saveObsSettings({ host, port, ...(clearPassword ? { password: '' } : password ? { password } : {}) });
    setSaving(false);
    setError(problem);
    if (problem) return;
    setPassword('');
    setPasswordSet(clearPassword ? false : passwordSet || Boolean(password));
    onDone();
  };

  const status = obs.connected
    ? 'Connected.'
    : obs.status === 'auth'
      ? 'OBS wants a password, or this one isn’t right.'
      : 'Waiting for OBS. It will connect by itself once OBS is open.';

  return (
    <form
      className="widget-settings obs-setup no-drag"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <strong>Connect to OBS</strong>
      <p className={obs.status === 'auth' ? 'error' : 'muted'}>{status}</p>
      <div className="row">
        <label>
          Host
          <input data-setup="" value={host} onChange={(e) => setHost(e.target.value)} />
        </label>
        <label className="obs-setup__port">
          Port
          <input inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
        </label>
      </div>
      <label>
        Password
        <input type="password" autoComplete="off" value={password} placeholder={passwordSet ? 'Saved (leave empty to keep it)' : 'Only if you set one in OBS'} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <p className="hint">In OBS: Tools → WebSocket Server Settings → Enable, then Show Connect Info</p>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="btn btn--small btn--accent" type="submit" disabled={saving}>
          Connect
        </button>
        {passwordSet && (
          <button className="btn btn--small" type="button" disabled={saving} onClick={() => void save(true)}>
            Remove password
          </button>
        )}
        {obs.connected && (
          <button className="btn btn--small" type="button" onClick={onDone}>
            Close
          </button>
        )}
      </div>
    </form>
  );
}
