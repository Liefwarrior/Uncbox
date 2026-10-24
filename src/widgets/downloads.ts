import { useEffect, useSyncExternalStore } from 'react';
import { listen, onConnection } from '../events';
import { showNotice } from '../undo';

// Page side of the video downloader (server/ytdlp.mjs). The server runs yt-dlp and keeps the queue
// and the finished list; this keeps one copy of what it last said, shared by every downloader
// widget, the Web widget's menu and the command palette.

export type DownloadState = 'queued' | 'downloading' | 'merging' | 'done' | 'error' | 'cancelled';

export interface DownloadItem {
  id: string;
  url: string;
  title: string;
  percent: number;
  /** Bytes per second. */
  speed: number | null;
  /** Seconds left. */
  eta: number | null;
  height: number | null;
  fps: number | null;
  vcodec: string;
  state: DownloadState;
  /** The finished file's name (not its folder). */
  file: string;
  /** The clip name to play it under ("Downloads/<title>.mp4"), or '' for a file the player can't open (audio). */
  name: string;
  error: string;
  audioOnly: boolean;
}

export interface ToolStatus {
  found: boolean;
  path: string;
  version: string;
}

export interface Tools {
  ytdlp: ToolStatus;
  ffmpeg: ToolStatus;
  winget: boolean;
  helpUrl: string;
}

export interface InstallStatus {
  running: boolean;
  action: 'install' | 'upgrade' | '';
  tool: string;
  lines: string[];
  error: string;
}

export interface DownloadsSnapshot {
  /** The server answered at least once. */
  loaded: boolean;
  tools: Tools | null;
  install: InstallStatus;
  queue: DownloadItem[];
  history: DownloadItem[];
}

const NO_INSTALL: InstallStatus = { running: false, action: '', tool: '', lines: [], error: '' };
let snap: DownloadsSnapshot = { loaded: false, tools: null, install: NO_INSTALL, queue: [], history: [] };
const listeners = new Set<() => void>();
function set(patch: Partial<DownloadsSnapshot>) {
  snap = { ...snap, ...patch };
  listeners.forEach((l) => l());
}

// ---- how a download is described ----

/** "1080p60", "2160p60", "720p" (frame rates of 30 and under are left off, as sites do). */
export function qualityLabel(item: Pick<DownloadItem, 'height' | 'fps' | 'audioOnly'>): string {
  if (item.audioOnly) return 'Audio';
  if (!item.height) return '';
  const fps = item.fps && item.fps > 30 ? Math.round(item.fps) : '';
  return `${item.height}p${fps}`;
}

/** "H.264" for "avc1.640028", "VP9", "AV1", "H.265"; '' when unknown. */
export function codecLabel(vcodec: string): string {
  const c = vcodec.toLowerCase();
  if (!c || c === 'none') return '';
  if (c.startsWith('avc') || c.startsWith('h264')) return 'H.264';
  if (c.startsWith('vp09') || c.startsWith('vp9')) return 'VP9';
  if (c.startsWith('av01') || c.startsWith('av1')) return 'AV1';
  if (c.startsWith('hev') || c.startsWith('hvc') || c.startsWith('h265')) return 'H.265';
  if (c.startsWith('vp8')) return 'VP8';
  return vcodec.split('.')[0].toUpperCase();
}

/** "1080p60 · VP9", or just what is known. */
export function qualityText(item: DownloadItem): string {
  return [qualityLabel(item), item.audioOnly ? '' : codecLabel(item.vcodec)].filter(Boolean).join(' · ');
}

/** "3.2 MB/s", "840 KB/s". */
export function speedText(bytesPerSecond: number | null): string {
  if (!bytesPerSecond || bytesPerSecond < 0) return '';
  if (bytesPerSecond >= 1e6) return `${(bytesPerSecond / 1e6).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bytesPerSecond / 1e3))} KB/s`;
}

/** "1:05", "12:03", "1:02:03". */
export function etaText(seconds: number | null): string {
  if (seconds === null || seconds < 0 || !Number.isFinite(seconds)) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** The web address in typed text, or null: http or https, no spaces. Anything yt-dlp could be handed as an option is turned away. */
export function downloadUrl(text: string): string | null {
  const t = text.trim();
  if (!t || t.startsWith('-') || /\s/.test(t)) return null;
  try {
    const u = new URL(t);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname ? t : null;
  } catch {
    return null;
  }
}

/** What to call it in the list: its title, else the address. */
export const downloadName = (item: DownloadItem) => item.title || item.url;

// ---- talking to the server ----

async function send(route: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(`/api/ytdlp${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, data: { error: 'Couldn’t reach Uncbox.' } };
  }
}

const errorOf = (data: Record<string, unknown>) => (typeof data.error === 'string' && data.error ? data.error : 'Something went wrong.');

export async function refreshDownloads() {
  try {
    const res = await fetch('/api/ytdlp');
    if (!res.ok) return;
    const d = await res.json();
    set({ loaded: true, tools: d.tools, install: d.install ?? NO_INSTALL, queue: d.queue ?? [], history: d.history ?? [] });
  } catch {
    // Server restarting; the next connect asks again.
  }
}

/** Adds a download. Resolves to '' when it started, else what went wrong in words. */
export async function startDownload(url: string, audioOnly = false): Promise<string> {
  const address = downloadUrl(url);
  if (!address) return 'Paste a web address that starts with http:// or https://.';
  const { ok, data } = await send('/download', { url: address, audioOnly });
  return ok ? '' : errorOf(data);
}

/** The same, for places with nowhere to show a problem: a notice says how it went. */
export async function downloadFromHere(url: string) {
  const problem = await startDownload(url);
  showNotice(problem || 'Download started. Find it in a Video downloader widget.', Boolean(problem));
}

export const cancelDownload = (id: string) => void send('/cancel', { id });
export const revealDownload = (id: string) => void send('/reveal', { id });
export const clearDownloads = () => void send('/clear');

/** Installs (or updates) yt-dlp, ffmpeg or both with winget. Resolves to '' when it started, else why not. */
export async function installTools(tool: 'yt-dlp' | 'ffmpeg' | 'both', upgrade = false): Promise<string> {
  const { ok, data } = await send('/install', { tool, upgrade });
  return ok ? '' : errorOf(data);
}

// ---- the shared copy ----

let users = 0;
let stops: (() => void)[] = [];

function connect() {
  if (users++ === 0) {
    stops = [
      listen('ytdlp', (data) => {
        try {
          const d = JSON.parse(data);
          set({ queue: d.queue ?? [], history: d.history ?? [] });
        } catch {
          // A garbled push: the next one replaces it.
        }
      }),
      listen('ytdlp-install', (data) => {
        try {
          const d = JSON.parse(data);
          const wasRunning = snap.install.running;
          const { line: _line, ...install } = d;
          set({ install });
          // The tools may have just arrived (or been updated): ask where they are now.
          if (wasRunning && !install.running) void refreshDownloads();
        } catch {
          // Same.
        }
      }),
      onConnection(() => void refreshDownloads()),
    ];
  }
  void refreshDownloads();
  return () => {
    if (--users === 0) {
      stops.forEach((s) => s());
      stops = [];
    }
  };
}

/** What the server last said about downloads. Only listens while something shows it. */
export function useDownloads(active = true): DownloadsSnapshot {
  useEffect(() => (active ? connect() : undefined), [active]);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snap,
  );
}
