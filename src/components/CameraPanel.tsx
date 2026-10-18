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
  const setDevice = (id: string | null) => mutate((s) => void (s.camera.deviceId = id));

  return (
    <Panel
      id="camera"
      title={title}
      bleed
      empty={!stream}
      menu={[
        { label: 'Camera on', checked: camera.enabled, onSelect: () => setEnabled(!camera.enabled) },
        { label: 'Mirror', checked: camera.mirrored, onSelect: () => mutate((s) => void (s.camera.mirrored = !s.camera.mirrored)) },
        // Device names only show once the browser has camera permission, i.e. after it is on.
        camera.enabled && 'divider',
        camera.enabled && { label: 'Default camera', checked: !camera.deviceId, onSelect: () => setDevice(null) },
        ...(camera.enabled
          ? devices.map((d, i) => ({
              label: d.label || `Camera ${i + 1}`,
              checked: camera.deviceId === d.deviceId,
              onSelect: () => setDevice(d.deviceId),
            }))
          : []),
      ]}
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
