import { useCallback, useEffect, useRef, useState } from 'react';
import { whileCovered } from './native';

function describe(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
      return 'Camera blocked. Allow it in site settings.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'That device is not connected. Pick another one.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The device is busy. Another app (often OBS) has it open. Close that source and retry.';
    default:
      return err instanceof Error ? err.message : String(err);
  }
}

function stopAll(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Video input devices (webcams, capture cards). Labels stay blank until the page has camera permission. */
export function useVideoDevices(refreshKey: unknown) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      navigator.mediaDevices
        ?.enumerateDevices()
        .then((all) => alive && setDevices(all.filter((d) => d.kind === 'videoinput')))
        .catch(() => {});
    load();
    navigator.mediaDevices?.addEventListener('devicechange', load);
    return () => {
      alive = false;
      navigator.mediaDevices?.removeEventListener('devicechange', load);
    };
  }, [refreshKey]);
  return devices;
}

/** Live stream from a capture card or webcam. A null deviceId opens the system default. */
export function useDeviceStream(enabled: boolean, deviceId: string | null) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser cannot capture video here. Open the dashboard via http://localhost.');
      return;
    }
    let alive = true;
    let opened: MediaStream | null = null;
    setError(null);
    navigator.mediaDevices
      .getUserMedia({
        audio: false,
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60 },
        },
      })
      .then((s) => {
        if (!alive) return stopAll(s);
        opened = s;
        setStream(s);
      })
      .catch((err) => alive && setError(describe(err)));
    return () => {
      alive = false;
      stopAll(opened);
      setStream(null);
    };
  }, [enabled, deviceId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { stream, error, retry };
}

/**
 * Captures another window or screen (an emulator, usually). Browsers only allow this from a
 * click, so it is started by pick() and has to be picked again after a page reload.
 */
export function useWindowStream(enabled: boolean) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<MediaStream | null>(null);

  const replace = useCallback((next: MediaStream | null) => {
    if (current.current !== next) stopAll(current.current);
    current.current = next;
    setStream(next);
  }, []);

  useEffect(() => {
    if (!enabled) replace(null);
  }, [enabled, replace]);

  useEffect(() => () => stopAll(current.current), []);

  const pick = useCallback(async () => {
    setError(null);
    try {
      const s = await whileCovered(() =>
        navigator.mediaDevices.getDisplayMedia({
          // Chrome captures windows at 30 fps unless a maximum is asked for; ideal alone isn't enough.
          video: { frameRate: { ideal: 60, max: 60 } },
          audio: false,
        }),
      );
      // Fires when the user clicks the browser's "Stop sharing" bar or closes the window.
      s.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (current.current === s) replace(null);
      });
      replace(s);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') return; // cancelled the picker
      setError(describe(err));
    }
  }, []);

  return { stream, error, pick };
}
