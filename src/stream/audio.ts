import { useEffect, useState } from 'react';
import { type AudioDevice, send, shell, useShellMessages } from '../native';

// The sound for a stream comes from the Uncbox app (desktop sound and a mic, mixed). The page asks
// it which mics there are and, while the stream is on, hears how loud each source is.

/** The microphones the app lists, asked for once `on` turns true. Empty in a browser, where there is no app to ask. */
export function useMics(on: boolean): AudioDevice[] {
  const [mics, setMics] = useState<AudioDevice[]>([]);
  useShellMessages((msg) => {
    if (msg.type === 'audiodevices') setMics(msg.mics);
  });
  useEffect(() => {
    if (on && shell) send({ type: 'audiodevices' });
  }, [on]);
  return mics;
}

export interface Levels {
  desktop: number;
  mic: number;
}

const SILENT: Levels = { desktop: 0, mic: 0 };

/** How loud the stream's sources are, 0 to 1 each. Falls back to silence when `on` turns false. */
export function useAudioLevels(on: boolean): Levels {
  const [levels, setLevels] = useState<Levels>(SILENT);
  useShellMessages((msg) => {
    if (msg.type === 'audiolevels' && on) setLevels({ desktop: clamp01(msg.desktop), mic: clamp01(msg.mic) });
  });
  useEffect(() => {
    if (!on) setLevels(SILENT);
  }, [on]);
  return levels;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
