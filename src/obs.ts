import { useEffect, useState } from 'react';
import { listen, onConnection } from './events';

// OBS, live from the Uncbox server (server/obs.mjs), which talks to OBS over its WebSocket server.
// The password stays on the server; this side only ever sees whether one is set.

export type ObsStatus = 'offline' | 'online' | 'auth';

export interface ObsSnapshot {
  status: ObsStatus;
  connected: boolean;
  stream: {
    active: boolean;
    reconnecting: boolean;
    /** "00:12:34". */
    timecode: string;
    /** Kilobits per second, or null until there are two readings to compare. */
    bitrate: number | null;
    congestion: number;
    dropped: number;
    total: number;
  };
  record: { active: boolean; paused: boolean; timecode: string };
  scene: string;
  scenes: string[];
  stats: { cpu: number; fps: number; renderSkipped: number; renderTotal: number; outputSkipped: number; outputTotal: number };
  inputs: { name: string; muted: boolean }[];
  studioMode: boolean;
  virtualCam: boolean;
  replayBuffer: boolean;
  replaySavedAt: number;
}

export interface ObsSettings {
  host: string;
  port: number;
  passwordSet: boolean;
}

/** The latest OBS snapshot, or null before it arrives. Reading it is what starts the server's connection. */
export function useObs(on = true): ObsSnapshot | null {
  const [snap, setSnap] = useState<ObsSnapshot | null>(null);
  useEffect(() => {
    if (!on) return;
    let alive = true;
    const load = () =>
      fetch('/api/obs')
        .then((r) => r.json())
        .then((s) => alive && setSnap(s))
        .catch(() => {});
    const stopConnection = onConnection(load);
    const stop = listen('obs', (data) => setSnap(JSON.parse(data)));
    return () => {
      alive = false;
      stop();
      stopConnection();
    };
  }, [on]);
  return snap;
}

export type ObsAction =
  | { type: 'SetCurrentProgramScene'; sceneName: string }
  | { type: 'ToggleInputMute'; inputName: string }
  | { type: 'StartStream' | 'StopStream' | 'StartRecord' | 'StopRecord' | 'PauseRecord' | 'ResumeRecord' }
  | { type: 'StartReplayBuffer' | 'StopReplayBuffer' | 'SaveReplayBuffer' | 'StartVirtualCam' | 'StopVirtualCam' };

/** Asks OBS to do something. Resolves to '' when it did, or to what to tell the person when it didn't. */
export async function obsAction(action: ObsAction): Promise<string> {
  try {
    const r = await fetch('/api/obs/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
    if (r.ok) return '';
    return (await r.json().catch(() => ({}))).error || 'OBS didn’t do that.';
  } catch {
    return 'Couldn’t reach Uncbox.';
  }
}

export async function loadObsSettings(): Promise<ObsSettings | null> {
  try {
    const r = await fetch('/api/obs/settings');
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Saves the connection settings (a password only when one is given) and says what went wrong, or ''. */
export async function saveObsSettings(s: { host: string; port: string; password?: string }): Promise<string> {
  try {
    const r = await fetch('/api/obs/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) });
    if (r.ok) return '';
    return (await r.json().catch(() => ({}))).error || 'Couldn’t save that.';
  } catch {
    return 'Couldn’t reach Uncbox.';
  }
}

/** Frames the stream has dropped, as a percentage of those sent. */
export function droppedPercent(stream: Pick<ObsSnapshot['stream'], 'dropped' | 'total'>): number {
  return stream.total > 0 ? (stream.dropped / stream.total) * 100 : 0;
}

/** How worried to look about dropped frames: fine up to 1 %, amber over 1 %, red over 5 %. */
export function dropLevel(percent: number): 'ok' | 'warn' | 'bad' {
  return percent > 5 ? 'bad' : percent > 1 ? 'warn' : 'ok';
}

/** 6000 → "6.0 Mbps", 800 → "800 kbps". */
export function bitrateText(kbps: number): string {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`;
}
