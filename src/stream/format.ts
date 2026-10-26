import { bitrateText } from '../obs';
import type { ControllerState } from './controller';
import { RETRY_DELAYS_MS } from './retry';
import type { StreamStatus, StreamTools } from './status';

/** "5:12" under an hour, "1:02:33" from then on. */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** "● Live 1:02:33 · 5.9 Mbps · 0 dropped", or "● Test …" for a test stream. */
export function liveLine(status: Pick<StreamStatus, 'test' | 'startedAt' | 'stats'>, now: number): string {
  const parts = [`● ${status.test ? 'Test' : 'Live'} ${elapsedText(status.startedAt ? now - status.startedAt : 0)}`];
  if (status.stats) parts.push(bitrateText(status.stats.kbps), `${status.stats.dropped} dropped`);
  return parts.join(' · ');
}

/** The one line under the stream buttons while a stream is starting, going, trying again or ending. */
export function streamLine(status: Pick<StreamStatus, 'state' | 'test' | 'startedAt' | 'stats'>, ctl: Pick<ControllerState, 'phase' | 'retries' | 'retryIn'>, now: number): string {
  const of = `try ${ctl.retries} of ${RETRY_DELAYS_MS.length}`;
  if (ctl.phase === 'ending' || status.state === 'stopping') return 'Ending the stream…';
  if (ctl.retryIn !== null) return `Lost the connection. Trying again in ${ctl.retryIn} s (${of})`;
  if (ctl.phase === 'preparing') return ctl.retries > 0 ? `Reconnecting… (${of})` : 'Starting the stream…';
  if (status.state === 'live') return liveLine(status, now);
  if (status.state === 'dropped') return 'The stream dropped.';
  return 'Starting the stream…';
}

/** What the check found, in plain words: ready, or what is missing. `checked` is false until the first answer. */
export function toolsLine(tools: StreamTools, checked: boolean): { state: 'checking' | 'ready' | 'missing' | 'unsupported'; text: string } {
  if (!checked) return { state: 'checking', text: 'Checking this PC…' };
  if (!tools.ffmpeg) return { state: 'missing', text: 'FFmpeg isn’t installed: install it from the Downloads widget.' };
  if (tools.ddagrab === false) return { state: 'unsupported', text: 'This FFmpeg can’t capture the screen. Update it from the Downloads widget.' };
  if (tools.nvenc === false) return { state: 'unsupported', text: 'This PC can’t use NVENC, which needs an NVIDIA graphics card, so Uncbox can’t stream from it.' };
  return { state: 'ready', text: 'Ready: NVENC on your graphics card' };
}
