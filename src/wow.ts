import { useEffect, useState, useSyncExternalStore } from 'react';
import { offerUndo, showNotice } from './undo';

// The WoW addon, from the page's side: whether it's installed (server/wow.mjs finds WoW and puts it
// there by itself), whether the strip has been seen in the game, and the settings the addon is
// told on /reload. Shared by the Get set up list, the sidebar, the game panel and the app.

export type WowModule = 'character' | 'quests' | 'party' | 'guild' | 'raid' | 'loot';

export interface WowSettings {
  strip: { enabled: boolean; corner: 'TOPLEFT' | 'TOPRIGHT' };
  modules: Record<WowModule, boolean>;
  /** Loot below this quality (0 gray … 6) isn't recorded. */
  lootMinQuality: number;
}

export const DEFAULT_WOW_SETTINGS: WowSettings = {
  strip: { enabled: true, corner: 'TOPLEFT' },
  modules: { character: true, quests: true, party: true, guild: true, raid: true, loot: true },
  lootMinQuality: 2,
};

export interface WowInstall {
  flavor: string;
  /** "WoW Forever (beta)", "Classic Era"… */
  label: string;
  path: string;
  /** The game programs in the folder (WowClassic.exe…). */
  exes: string[];
  /** The Uncbox addon's version there, or null when it isn't installed. */
  version: string | null;
  addons: Record<string, string | null>;
}

export interface WowStatus {
  /** The addon version Uncbox ships. */
  bundled: string | null;
  addons: Record<string, string>;
  preferred: string | null;
  installs: WowInstall[];
  autoInstall: boolean;
  flavor: string;
  settings: WowSettings;
}

/** What the server did to one install on its own: see integrations/wow/install.mjs. */
export interface InstallReport {
  path: string;
  flavor: string;
  label: string;
  addons: { name: string; action: 'installed' | 'updated' | 'reinstalled' | 'removed' | 'current'; from: string | null; to: string | null }[];
}

/** How long after the strip was last read it still counts as "seen in game". */
export const SEEN_WITHIN_MS = 10 * 60_000;

const json = { 'Content-Type': 'application/json' };
export const postWow = (path: string, body: object = {}) =>
  fetch(`/api/wow/${path}`, { method: 'POST', headers: json, body: JSON.stringify(body) }).then(async (r) =>
    r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => null))?.error ?? r.statusText)),
  );

// ---- the plain-words lines for the Get set up list ----

/** "Addon installed": done when the preferred install has this version of the addon. */
export function addonLine(status: WowStatus | null): { done: boolean; note: string } {
  if (!status) return { done: false, note: 'Looking for WoW…' };
  if (!status.installs.length) return { done: false, note: 'WoW wasn’t found on this PC' };
  const here = status.installs.find((i) => i.path === status.preferred) ?? status.installs[0];
  if (here.version === null) {
    return { done: false, note: status.autoInstall ? `Installing in ${here.label}…` : `Not in ${here.label} yet` };
  }
  if (status.bundled && here.version !== status.bundled) return { done: false, note: `Version ${here.version}, ${status.bundled} is ready` };
  return { done: true, note: `Version ${here.version} in ${here.label}` };
}

/** "Seen in game": done when the strip was read in the last 10 minutes. */
export function seenLine(seenAt: number, now: number): { done: boolean; note: string } {
  if (!seenAt) return { done: false, note: 'Start WoW, or type /reload in it' };
  const ago = now - seenAt;
  if (ago > SEEN_WITHIN_MS) return { done: false, note: 'Not lately. Type /reload in WoW' };
  const minutes = Math.floor(ago / 60_000);
  return { done: true, note: minutes < 1 ? 'Just now' : `${minutes} minute${minutes === 1 ? '' : 's'} ago` };
}

/** "Game window": done once WoW is the game panel's source. */
export function windowLine(sourceSet: boolean, running: boolean): { done: boolean; note: string } {
  if (sourceSet) return { done: true, note: 'Showing in the game panel' };
  return { done: false, note: running ? 'WoW is running. Click to show it' : 'Start WoW and it shows up here' };
}

/** The toast for what the server installed or updated by itself, with what Undo removes. */
export function announcement(changed: InstallReport[]): { message: string; undo: string[] | null } | null {
  const installed = changed.filter((r) => r.addons.some((a) => a.action === 'installed'));
  if (installed.length) return { message: 'Uncbox installed its WoW addon. Type /reload in WoW.', undo: installed.map((r) => r.path) };
  const updated = changed.flatMap((r) => r.addons.filter((a) => a.action === 'updated'));
  if (updated.length) return { message: `Uncbox updated its WoW addon to ${updated[0].to}. Type /reload in WoW.`, undo: null };
  return null;
}

/** The game window to put in the panel: the running WoW program, without ".exe", as the app matches windows. */
export function wowWindowMatch(exe: string) {
  return { process: exe.replace(/\.exe$/i, ''), title: 'World of Warcraft' };
}

/** Programs to look for before the server has said which WoW is installed. */
const COMMON_EXES = ['WowClassic.exe', 'WowClassicB.exe', 'WowB.exe', 'Wow.exe'];

/** Game programs to watch for, the preferred install's first. */
export function wowExes(status: WowStatus | null): string[] {
  const own = (status?.installs ?? [])
    .slice()
    .sort((a, b) => Number(b.path === status?.preferred) - Number(a.path === status?.preferred))
    .flatMap((i) => i.exes);
  return [...new Set([...own, ...(own.length ? [] : COMMON_EXES)])];
}

// ---- the status, shared ----

let status: WowStatus | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

function take(next: Partial<WowStatus> & { installs?: unknown }) {
  if (!next || !Array.isArray(next.installs)) return;
  status = next as WowStatus;
  notify();
}

export async function refreshWowStatus() {
  try {
    const r = await fetch('/api/wow/status');
    if (r.ok) take(await r.json());
  } catch {
    // The server isn't answering; the last status stands.
  }
}

/** The addon's status, refreshed now and every 20 seconds while `on`. Null until it arrives (or off a PC that can't tell). */
export function useWowStatus(on = true): WowStatus | null {
  useEffect(() => {
    if (!on) return;
    void refreshWowStatus();
    const t = setInterval(() => void refreshWowStatus(), 20_000);
    return () => clearInterval(t);
  }, [on]);
  return useSyncExternalStore(subscribe, () => status);
}

/** Changes the addon's settings; they take effect in WoW at the next /reload. */
export async function saveWowSettings(patch: { settings?: DeepPartial<WowSettings>; flavor?: string; autoInstall?: boolean }) {
  await postWow('settings', patch);
  await refreshWowStatus();
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Installs into one install (or every one), as asked by a click. */
export async function installWowAddon(path?: string) {
  const res = await postWow('install', path ? { path } : {});
  await refreshWowStatus();
  return res as { reports: InstallReport[] };
}

// ---- seen in game ----

const SEEN_KEY = 'uncbox.wowSeenAt';
const SEEN_EVERY_MS = 5000;

function loadSeen(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
}
let seenAt = loadSeen();

/** The strip was just read. Remembered across reloads, and told to the list at most every few seconds. */
export function markWowSeen(now = Date.now()) {
  if (now - seenAt < SEEN_EVERY_MS) return;
  seenAt = now;
  try {
    localStorage.setItem(SEEN_KEY, String(now));
  } catch {
    // Private window: it just isn't remembered.
  }
  notify();
}

/** When the strip was last read (milliseconds), or 0. */
export function useWowSeenAt(): number {
  return useSyncExternalStore(subscribe, () => seenAt);
}

/** The current time, updated every `ms`, so lines like "3 minutes ago" stay true. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// ---- by itself ----

/**
 * While the WoW preset is showing: asks the server to install or update the addon where needed,
 * and says so with a toast (with Undo for a new install). Once each time the preset comes up.
 */
export function useWowAutoSetup(on: boolean) {
  useEffect(() => {
    if (!on) return;
    let alive = true;
    void postWow('auto')
      .then((res) => {
        if (!alive) return;
        take(res);
        const said = announcement(res.changed ?? []);
        if (!said) return;
        const undo = said.undo;
        if (undo) {
          offerUndo(
            said.message,
            () => {
              void Promise.all(undo.map((path) => postWow('uninstall', { path })))
                .then(() => refreshWowStatus())
                .then(() => showNotice('Removed the WoW addon. Uncbox won’t install it again unless you ask.'))
                .catch(() => showNotice('Couldn’t remove the WoW addon.', true));
            },
            true,
          );
        } else {
          showNotice(said.message);
        }
      })
      // Not the PC WoW is on, or the server has no WoW to look at: nothing to do.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [on]);
}

/** The WoW program that is running right now (WowClassic.exe…), or null. Asks the server every few seconds while `on`. */
export function useWowRunning(on: boolean, st: WowStatus | null): string | null {
  const [running, setRunning] = useState<string | null>(null);
  const names = wowExes(st).join(',');
  useEffect(() => {
    if (!on) return setRunning(null);
    let alive = true;
    const ask = async () => {
      try {
        const r = await fetch(`/api/running?names=${encodeURIComponent(names.toLowerCase())}`);
        const list: string[] = r.ok ? ((await r.json()).running ?? []) : [];
        const exe = names.split(',').find((n) => list.includes(n.toLowerCase())) ?? null;
        if (alive) setRunning(exe);
      } catch {
        if (alive) setRunning(null);
      }
    };
    void ask();
    const t = setInterval(() => void ask(), 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [on, names]);
  return on ? running : null;
}

// ---- the strip's news, passed to the server ----

const LIVE_KINDS_FROM = 4;
let outgoing: { kind: number; text: string }[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function flushLive() {
  flushTimer = undefined;
  const messages = outgoing.splice(0, 100);
  if (outgoing.length) flushTimer = setTimeout(flushLive, 300);
  // Lost on a failure: the next SavedVariables read fills it in.
  if (messages.length) void postWow('live', { messages }).catch(() => {});
}

/** Guild and raid messages read off the strip go to the server in small batches; it keeps them in the database. */
export function sendWowLive(kind: number, text: string) {
  if (kind < LIVE_KINDS_FROM) return;
  outgoing.push({ kind, text });
  flushTimer ??= setTimeout(flushLive, 300);
}
