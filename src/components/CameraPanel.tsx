import { useDeviceStream, useVideoDevices } from '../media';
import type { CameraSettings } from '../state/model';
import type { Mutate } from '../state/useAppState';
import { CroppedVideo } from './CroppedVideo';
import { Icon } from './Icon';
import { Panel } from './Panel';

export function CameraPanel({ camera, mutate }: { camera: CameraSettings; mutate: Mutate }) {
  const { stream, error, retry } = useDeviceStream(camera.enabled, camera.deviceId);
  const devices = useVideoDevices(stream);
  const setEnabled = (enabled: boolean) => mutate((s) => void (s.camera.enabled = enabled));

  return (
    <Panel
      title="Camera"
      className="panel--camera"
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
      <div className="camera-frame">
        {stream ? (
          <CroppedVideo stream={stream} fit="cover" mirrored={camera.mirrored} />
        ) : (
          <div className="camera-empty">
            {!camera.enabled ? (
              <>
                <button className="btn btn--accent ctl" onClick={() => setEnabled(true)}>
                  <Icon name="video" /> Start camera
                </button>
                <p className="muted ctl">If OBS already shows your webcam, hide this panel instead.</p>
              </>
            ) : error ? (
              <>
                <p className="error">{error}</p>
                <button className="btn" onClick={retry}>Retry</button>
              </>
            ) : (
              <p className="muted">Starting camera…</p>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
