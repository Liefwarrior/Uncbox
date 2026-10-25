import { useCallback, useEffect, useRef, useState } from 'react';
import { clampTrim, discordBitrate, frameShare, isSoft, lastSeconds } from '../clips/plan';
import type { Trim } from '../clips/plan';
import { copyLink, openInDrive } from '../clips/drive';
import { clipUrl, watchClip } from '../clips/replay';
import { makeVertical, sendToDiscord } from '../clips/share';
import type { Edit, Progress, Report } from '../clips/share';
import { wasCancelled } from '../clips/transcode';
import { scrubText, usePrivate } from '../privacy';
import { Icon } from './Icon';

export type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; text: string; fraction: number | null }
  | { kind: 'done'; text: string; watch?: string; link?: string }
  | { kind: 'error'; text: string };

export interface Job {
  status: Status;
  busy: boolean;
  /** Runs one job at a time. `done` is the message (and clip to watch, or Drive link) for when it works. */
  run: (task: (report: Report, signal: AbortSignal) => Promise<{ text: string; watch?: string; link?: string }>) => void;
  cancel: () => void;
}

/** One long job (making a vertical clip, sending to Discord) and how far along it is. */
export function useJob(): Job {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const abort = useRef<AbortController | null>(null);
  const busy = status.kind === 'busy';

  const run: Job['run'] = useCallback((task) => {
    if (abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setStatus({ kind: 'busy', text: 'Getting ready…', fraction: null });
    const report = (p: Progress) => setStatus({ kind: 'busy', ...p });
    task(report, controller.signal)
      .then((done) => setStatus({ kind: 'done', ...done }))
      .catch((err) => setStatus(wasCancelled(err) ? { kind: 'idle' } : { kind: 'error', text: err instanceof Error ? err.message : String(err) }))
      .finally(() => (abort.current = null));
  }, []);

  const cancel = useCallback(() => abort.current?.abort(), []);
  // Closing the player stops whatever it was doing.
  useEffect(() => cancel, [cancel]);
  return { status, busy, run, cancel };
}

/** The line under the buttons: progress, the result, or what went wrong. */
export function StatusLine({ job }: { job: Job }) {
  const { status } = job;
  const hidden = usePrivate();
  if (status.kind === 'idle') return null;
  if (status.kind === 'error') return <p className="clip-status error" role="alert" aria-live="assertive">{hidden ? scrubText(status.text) : status.text}</p>;
  if (status.kind === 'done') {
    return (
      <p className="clip-status clip-status--done" role="status">
        <Icon name="check" size={14} /> {status.text}
        {status.watch && (
          <button className="btn btn--small" onClick={() => watchClip(status.watch!)}>
            <Icon name="play" size={13} /> Watch
          </button>
        )}
        {status.link && <DriveLink link={status.link} />}
      </p>
    );
  }
  const percent = status.fraction === null ? null : Math.round(status.fraction * 100);
  return (
    <div className="clip-status" role="status">
      <span>
        {status.text} {percent !== null && `${percent}%`}
      </span>
      <progress max={1} value={status.fraction ?? undefined} />
      <button className="btn btn--small" onClick={job.cancel}>
        Cancel
      </button>
    </div>
  );
}

/** After "Saved to Drive": copy the link, or open the clip's Drive page. */
function DriveLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <button
        className="btn btn--small"
        onClick={() =>
          void copyLink(link).then((ok) => {
            setCopied(ok);
            if (ok) setTimeout(() => setCopied(false), 2000);
          })
        }
      >
        <Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? 'Copied' : 'Copy link'}
      </button>
      <button className="btn btn--small" onClick={() => openInDrive(link)}>
        <Icon name="external" size={13} /> Open
      </button>
    </>
  );
}

const QUICK: { label: string; seconds: number | null }[] = [
  { label: 'Whole clip', seconds: null },
  { label: 'Last 30 s', seconds: 30 },
  { label: 'Last 15 s', seconds: 15 },
];

const seconds = (n: number) => `${n.toFixed(1)} s`;

/**
 * Over the clip's video: a 9:16 frame to slide left and right, and where to start and stop.
 * "Save vertical" makes the short; "Send to Discord" sends the same framing and trim.
 */
export function VerticalEditor({ name, job, discord }: { name: string; job: Job; discord: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [duration, setDuration] = useState(0);
  const [trim, setTrim] = useState<Trim>({ start: 0, end: 0 });
  const [size, setSize] = useState({ w: 1920, h: 1080 });
  // Where the frame sits across the free space: 0 against the left edge, 1 against the right.
  const [position, setPosition] = useState(0.5);

  const share = frameShare(size.w, size.h);
  const length = trim.end - trim.start;
  const whole = trim.start < 0.05 && trim.end > duration - 0.05;
  const edit = (): Edit => ({ name, trim: whole ? null : trim, frame: position });

  const onMeta = () => {
    const v = video.current!;
    setDuration(v.duration);
    setTrim({ start: 0, end: v.duration });
    setSize({ w: v.videoWidth || 1920, h: v.videoHeight || 1080 });
  };

  // Plays just the chosen part, over and over.
  const onTime = () => {
    const v = video.current!;
    if (v.currentTime >= trim.end || v.currentTime < trim.start - 0.3) v.currentTime = trim.start;
  };

  const setRange = (next: Trim, moved: 'start' | 'end') => {
    const t = clampTrim(next, duration, moved);
    setTrim(t);
    if (video.current) video.current.currentTime = moved === 'start' ? t.start : Math.max(t.start, t.end - 1);
  };

  const drag = useRef<{ x: number; position: number } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, position };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const width = stage.current?.getBoundingClientRect().width ?? 0;
    if (!d || !width) return;
    setPosition(Math.min(1, Math.max(0, d.position + (e.clientX - d.x) / (width * (1 - share)))));
  };

  return (
    <div className="vedit">
      <div className="vedit__stage" ref={stage}>
        <video ref={video} src={clipUrl(name)} muted loop autoPlay playsInline onLoadedMetadata={onMeta} onTimeUpdate={onTime} />
        <div
          className="vedit__frame"
          style={{ left: `${position * (1 - share) * 100}%`, width: `${share * 100}%` }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          title="Drag to choose what the vertical clip shows"
        />
      </div>

      <div className="vedit__controls">
        <label>
          Frame
          <input type="range" min={0} max={1} step={0.005} value={position} onChange={(e) => setPosition(Number(e.target.value))} />
        </label>
        <label>
          Start <output>{seconds(trim.start)}</output>
          <input type="range" min={0} max={duration || 1} step={0.1} value={trim.start} onChange={(e) => setRange({ ...trim, start: Number(e.target.value) }, 'start')} />
        </label>
        <label>
          End <output>{seconds(trim.end)}</output>
          <input type="range" min={0} max={duration || 1} step={0.1} value={trim.end} onChange={(e) => setRange({ ...trim, end: Number(e.target.value) }, 'end')} />
        </label>
        <div className="vedit__quick">
          {QUICK.map((q) => (
            <button
              key={q.label}
              className="btn btn--small"
              disabled={!duration}
              onClick={() => {
                const t = lastSeconds(duration, q.seconds);
                setTrim(t);
                if (video.current) video.current.currentTime = t.start;
              }}
            >
              {q.label}
            </button>
          ))}
          <span className="muted">{seconds(length)} long</span>
        </div>
      </div>

      <div className="vedit__actions">
        <button
          className="btn btn--accent"
          disabled={job.busy || !duration}
          onClick={() =>
            job.run(async (report, signal) => {
              const saved = await makeVertical(edit(), report, signal);
              return { text: 'Saved. It’s in your clips now.', watch: saved };
            })
          }
        >
          <Icon name="crop" size={14} /> Save vertical
        </button>
        <button
          className="btn"
          disabled={job.busy || !duration || !discord}
          title={discord ? 'Send this vertical clip to your Discord channel' : 'Add a Discord webhook under Clips first'}
          onClick={() =>
            job.run(async (report, signal) => {
              await sendToDiscord(edit(), report, signal);
              return { text: 'Sent to Discord.' };
            })
          }
        >
          <Icon name="message" size={14} /> Send to Discord
        </button>
      </div>
      {discord && length > 0 && isSoft(discordBitrate(length)) && (
        <p className="hint">Discord only takes 10 MB, so a copy this long will look a bit soft. A shorter trim looks sharper.</p>
      )}
    </div>
  );
}
