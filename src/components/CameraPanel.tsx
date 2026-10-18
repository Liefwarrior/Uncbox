import { useDeviceStream, useVideoDevices } from '../media';
import type { CameraSettings } from '../state/model';
import type { Mutate } from '../state/useAppState';
import { CroppedVideo } from './CroppedVideo';
import { Icon } from './Icon';
import { Panel } from './Panel';

export function CameraPanel({ camera, title, mutate }: { camera: CameraSettings; title: string; mutate: Mutate }) {
  const { stream, error, retry } = useDeviceStream(camera.enabled, camera.deviceId);
  const devices = useVideoDevices(stream);
  const setEnabled = (enabled: boolean) => mutate((s) => void (s.camera.enabled = enabled));

  return (
    <Panel
      id="camera"
      title={title}
      bleed
      empty={!stream}
      actions={
        <>
          {camera.enabled && (
            <select
              value={camera.deviceId ?? ''}
              onChange={(e) => mutate((s) => void (s.camera.deviceId = e.target.value || null))}
              title="Camera"
            >
              <option value="">Default camera</option>
              {devices.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || `Camera ${i + 1}`}
                </option>
              ))}
            </select>
          )}
          <button
            className={`icon-btn ${camera.mirrored ? 'on' : ''}`}
            title="Mirror"
            onClick={() => mutate((s) => void (s.camera.mirrored = !s.camera.mirrored))}
          >
            <Icon name="flip" />
          </button>
          <button
            className={`icon-btn ${camera.enabled ? 'on' : ''}`}
            title={camera.enabled ? 'Turn camera off' : 'Turn camera on'}
            onClick={() => setEnabled(!camera.enabled)}
          >
            <Icon name="video" />
          </button>
        </>
      }
    >
      {stream ? (
        <CroppedVideo stream={stream} fit="cover" mirrored={camera.mirrored} />
      ) : (
        <div className="camera-empty ctl">
          {!camera.enabled ? (
            <>
              <button className="btn btn--accent ctl" data-setup onClick={() => setEnabled(true)}>
                <Icon name="video" /> Start camera
              </button>
              <p className="muted ctl">Using OBS for your camera? Hide this panel.</p>
            </>
          ) : error ? (
            <>
              <p className="error">{error}</p>
              <button className="btn" onClick={retry}>
                Retry
              </button>
            </>
          ) : (
            <p className="muted">Starting camera…</p>
          )}
        </div>
      )}
    </Panel>
  );
}
