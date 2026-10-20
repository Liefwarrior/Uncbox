import { useEffect, useSyncExternalStore } from 'react';
import { listen } from '../events';
import type { Report } from './share';

// Saving clips to Google Drive. The server does the upload (server/driveupload.mjs) and tells every
// window how far it got with "driveupload" events; this keeps the latest word on each clip, so the
// player's progress line and the "uploading to Drive…" toast both read from the same place.

export interface DriveUpload {
  /** Going up now, finished, or failed. A cancelled upload is simply forgotten. */
  state: 'uploading' | 'done' | 'error';
  /** 0 to 1 while uploading. */
  fraction: number;
  /** The Drive page for the clip once it is there. */
  link: string;
  error: string;
}

/** What the server sends: { name, sent, total, done, error, link } (and cancelled). */
interface UploadEvent {
  name: string;
  sent: number;
  total: number;
  done: boolean;
  error: string;
  link: string;
  cancelled?: boolean;
}

/** The scope that lets Uncbox save to Drive (only files it made itself). */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** What the page needs to know before offering the button. */
export const canSaveToDrive = (g: { signedIn: boolean; scopes: string[] } | null) => Boolean(g?.signedIn && g.scopes.includes(DRIVE_FILE_SCOPE));

let uploads: Record<string, DriveUpload> = {};
const watchers = new Set<() => void>();
const perClip = new Map<string, Set<(u: DriveUpload | undefined) => void>>();

/** Folds one server event into what is known about that clip. Exported for the tests. */
export function applyEvent(current: Record<string, DriveUpload>, e: UploadEvent): Record<string, DriveUpload> {
  const next = { ...current };
  if (e.cancelled) delete next[e.name];
  else if (e.done) next[e.name] = e.error ? { state: 'error', fraction: 0, link: '', error: e.error } : { state: 'done', fraction: 1, link: e.link, error: '' };
  else next[e.name] = { state: 'uploading', fraction: e.total > 0 ? Math.min(1, e.sent / e.total) : 0, link: '', error: '' };
  return next;
}

let connected = false;
function connect() {
  if (connected) return;
  connected = true;
  listen('driveupload', (data) => {
    const e = JSON.parse(data) as UploadEvent;
    uploads = applyEvent(uploads, e);
    watchers.forEach((w) => w());
    perClip.get(e.name)?.forEach((f) => f(uploads[e.name]));
  });
}

/** Every clip's latest Drive upload, by file name. */
export function useDriveUploads(): Record<string, DriveUpload> {
  useEffect(connect, []);
  return useSyncExternalStore(
    (l) => {
      watchers.add(l);
      return () => watchers.delete(l);
    },
    () => uploads,
  );
}

const MESSAGE = 'Couldn’t save to Google Drive.';

/**
 * Uploads a saved clip. Progress comes through `report`; aborting `signal` stops the upload on the
 * server too. Resolves to the clip's Drive link.
 */
export async function saveToDrive(name: string, share: boolean, report: Report, signal: AbortSignal): Promise<string> {
  connect();
  const text = 'Saving to Google Drive…';
  report({ text, fraction: null });
  const watchSet = perClip.get(name) ?? new Set();
  perClip.set(name, watchSet);
  const progress = (u: DriveUpload | undefined) => u?.state === 'uploading' && report({ text, fraction: u.fraction });
  watchSet.add(progress);
  const stop = () => void fetch('/api/drive/upload/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).catch(() => {});
  signal.addEventListener('abort', stop, { once: true });
  try {
    let res: Response;
    try {
      res = await fetch('/api/drive/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, share }), signal });
    } catch (err) {
      throw signal.aborted ? err : new Error('Couldn’t reach Uncbox. Is it still running?');
    }
    const body = (await res.json().catch(() => ({}))) as { link?: string; error?: string };
    if (!res.ok) throw new Error(body.error || MESSAGE);
    return body.link ?? '';
  } finally {
    watchSet.delete(progress);
    signal.removeEventListener('abort', stop);
  }
}

/** Opens a Drive page in the browser. The server does it, since the window may be Uncbox's own. */
export function openInDrive(link: string) {
  void fetch('/api/drive/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: link }) }).catch(() => {});
}

/** Puts the link on the clipboard. Resolves to whether it worked. */
export async function copyLink(link: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(link);
    return true;
  } catch {
    return false;
  }
}
