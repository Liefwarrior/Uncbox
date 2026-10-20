import { useCallback, useEffect, useRef, useState } from 'react';
import type { IconName } from '../components/Icon';
import { post } from './google';

// The Google Drive widget's data, from the Uncbox server (server/google.mjs and server/drive.mjs).
// The page never holds a Google token or the client secret: it only learns whether sign-in is set
// up and done, and asks the server for the files.

export type DriveView = 'recent' | 'starred' | 'shared' | 'search';
export const DRIVE_VIEWS: { id: DriveView; label: string }[] = [
  { id: 'recent', label: 'Recent' },
  { id: 'starred', label: 'Starred' },
  { id: 'shared', label: 'Shared' },
  { id: 'search', label: 'Search' },
];

/** The saved view, or Recent if the setting holds anything else. */
export const driveView = (saved: string): DriveView => (DRIVE_VIEWS.some((v) => v.id === saved) ? (saved as DriveView) : 'recent');

export interface DriveFile {
  /** Drive's file id, or for Drive for desktop the path inside the Drive folder. */
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink: string;
  hasThumb: boolean;
  owner: string;
}

/** What went wrong, with a code the widget can act on: signin, scope, api, busy, down, nolocal, other. */
export interface DriveError {
  code: string;
  message: string;
}

/** Where the files come from: your Google account, or the Google Drive for desktop folder. */
export type DriveSource = 'cloud' | 'local';

/** Opens a file: its Drive page in the browser, or (Drive for desktop) the file itself. */
export function openFile(file: DriveFile, source: DriveSource) {
  const body = source === 'local' ? { path: file.id } : { url: file.webViewLink };
  void post('/api/drive/open', body).catch(() => {});
}

/** Whether Google Drive for desktop is on this PC (null while asking). */
export function useLocalDrive(): { available: boolean; name: string } | null {
  const [local, setLocal] = useState<{ available: boolean; name: string } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/drive/local')
      .then((r) => (r.ok ? r.json() : { available: false, name: '' }))
      .then((d) => alive && setLocal(d))
      .catch(() => alive && setLocal({ available: false, name: '' }));
    return () => {
      alive = false;
    };
  }, []);
  return local;
}

export const REFRESH_MS = 60_000;

/**
 * A list of files, refreshed every minute while the page is visible (and when it comes back),
 * with "more" to add the next page. Nothing is fetched while `source` is null.
 */
export function useDriveFiles(source: DriveSource | null, view: DriveView, query: string) {
  const [files, setFiles] = useState<DriveFile[] | null>(null);
  const [error, setError] = useState<DriveError | null>(null);
  const [loading, setLoading] = useState(false);
  const [next, setNext] = useState('');
  /** Newer requests win: a slow answer to an old tab or search is dropped. */
  const latest = useRef(0);
  const extra = useRef(false);
  const key = `${source}|${view}|${query}`;

  const load = useCallback(
    async (pageToken = '') => {
      if (!source) return;
      const mine = ++latest.current;
      setLoading(true);
      try {
        const params = new URLSearchParams({ source, view, q: query });
        if (pageToken) params.set('pageToken', pageToken);
        const r = await fetch(`/api/drive/files?${params}`);
        const d = await r.json().catch(() => ({}));
        if (mine !== latest.current) return;
        if (!r.ok) {
          setError({ code: d.code || 'other', message: d.error || 'Couldn’t load your files.' });
          return;
        }
        setError(null);
        extra.current = Boolean(pageToken);
        setFiles((old) => (pageToken && old ? [...old, ...d.files] : d.files));
        setNext(d.nextPageToken || '');
      } catch {
        if (mine === latest.current) setError({ code: 'other', message: 'Couldn’t reach Uncbox. Is it still running?' });
      } finally {
        if (mine === latest.current) setLoading(false);
      }
    },
    // key stands for source, view and query.
    [key],
  );

  useEffect(() => {
    // A different tab or search starts with an empty list, not the last one's files.
    setFiles(null);
    setError(null);
    setNext('');
    extra.current = false;
    if (!source) return;
    void load();
    const tick = () => {
      // Not while hidden, and not once the person has paged further down (a refresh would drop it).
      if (document.visibilityState === 'visible' && !extra.current) void load();
    };
    const timer = setInterval(tick, REFRESH_MS);
    const visible = () => document.visibilityState === 'visible' && !extra.current && void load();
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      latest.current++;
    };
  }, [load, source]);

  return { files, error, loading, hasMore: Boolean(next), more: () => void load(next), reload: () => void load() };
}

/** One search of your Google Drive, for the command palette. Throws if the search fails or is cancelled. */
export async function searchDriveFiles(query: string, signal?: AbortSignal): Promise<DriveFile[]> {
  const params = new URLSearchParams({ source: 'cloud', view: 'search', q: query });
  const r = await fetch(`/api/drive/files?${params}`, { signal });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Couldn’t search Drive.');
  return d.files ?? [];
}

// ---- how files look ----

export type FileKind = 'folder' | 'image' | 'video' | 'audio' | 'file';

export function fileIcon(mimeType: string): IconName {
  if (mimeType === 'application/vnd.google-apps.folder') return 'folder';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'music';
  return 'file';
}

/** A short plain name for the kind of file ("Doc", "Sheet", "PDF"). */
export function fileKind(mimeType: string): string {
  const google: Record<string, string> = {
    'application/vnd.google-apps.document': 'Doc',
    'application/vnd.google-apps.spreadsheet': 'Sheet',
    'application/vnd.google-apps.presentation': 'Slides',
    'application/vnd.google-apps.form': 'Form',
    'application/vnd.google-apps.folder': 'Folder',
    'application/vnd.google-apps.drawing': 'Drawing',
  };
  if (google[mimeType]) return google[mimeType];
  if (mimeType === 'application/pdf') return 'PDF';
  if (mimeType.includes('wordprocessingml') || mimeType === 'application/msword') return 'Word';
  if (mimeType.includes('spreadsheetml') || mimeType === 'application/vnd.ms-excel') return 'Excel';
  if (mimeType.includes('presentationml') || mimeType === 'application/vnd.ms-powerpoint') return 'PowerPoint';
  if (mimeType.startsWith('image/')) return 'Image';
  if (mimeType.startsWith('video/')) return 'Video';
  if (mimeType.startsWith('audio/')) return 'Audio';
  if (mimeType.startsWith('text/')) return 'Text';
  return 'File';
}

/** "3:42 PM" for today, "Mar 4" for this year, "Mar 4, 2025" before. Empty if the date is unknown. */
export function formatModified(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  if (d.toDateString() === now.toDateString()) return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
  const sameYear = d.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' }).format(d);
}
