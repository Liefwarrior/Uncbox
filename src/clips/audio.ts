import { useSyncExternalStore } from 'react';
import { send, shell } from '../native';
import type { ShellMessage } from '../native';

// The page's side of the sound kept for clips. While the replay buffer runs inside the Uncbox app,
// the app (ClipAudio.cs) keeps the last 70 seconds of the game's, Discord's and the mic's sound,
// each apart, and tells us what it found and how loud each is. When a clip is saved, replay.ts
// asks it for the clip's stretch of that sound (requestClipAudio in native.ts).

export interface SoundStatus {
  state: 'off' | 'starting' | 'on' | 'error';
  /** 'app': the captured game's own sound; 'desktop': all sound except Discord (its window wasn't found). */
  game: 'app' | 'desktop';
  gameName: string;
  discord: boolean;
  mic: boolean;
  /** Why the mic isn't recorded, in plain words, when it was asked for and isn't working. */
  micError: string;
  error: string;
}

export interface SoundLevels {
  game: number;
  discord: number;
  mic: number;
}

const OFF: SoundStatus = { state: 'off', game: 'app', gameName: '', discord: false, mic: false, micError: '', error: '' };
const QUIET: SoundLevels = { game: 0, discord: 0, mic: 0 };

let status = OFF;
let levels = QUIET;
/** The page wants the sound on (a stop that arrives later from the app is then an old one). */
let wanted = false;
let stopTimer: ReturnType<typeof setTimeout> | undefined;
const statusListeners = new Set<() => void>();
const levelListeners = new Set<() => void>();

function setStatus(next: SoundStatus) {
  status = next;
  statusListeners.forEach((l) => l());
}
function setLevels(next: SoundLevels) {
  levels = next;
  levelListeners.forEach((l) => l());
}

let connected = false;
function connect() {
  if (connected || !shell) return;
  connected = true;
  shell.addEventListener('message', (e) => {
    const msg = e.data as ShellMessage;
    if (msg?.type === 'cliplevels') {
      if (wanted) setLevels({ game: msg.game, discord: msg.discord, mic: msg.mic });
    } else if (msg?.type === 'clipaudio' && 'state' in msg) {
      if (msg.state === 'on') setStatus({ ...OFF, state: 'on', game: msg.game, gameName: msg.gameName, discord: msg.discord, mic: msg.mic, micError: msg.micError ?? '' });
      else if (msg.state === 'error') {
        wanted = false;
        setStatus({ ...OFF, state: 'error', error: msg.error });
        setLevels(QUIET);
      } else if (!wanted) {
        setStatus(OFF);
        setLevels(QUIET);
      }
    }
  });
}

/**
 * Starts keeping the sound (or restarts it with another mic). `title` is the label of the game
 * capture's video track, which the app uses to find the game's program; `mic` is a device id,
 * 'default', or null for no mic.
 */
export function startClipSound(title: string, mic: string | null) {
  if (!shell) return;
  connect();
  clearTimeout(stopTimer);
  wanted = true;
  setStatus({ ...OFF, state: 'starting' });
  send({ type: 'clipaudio', on: true, title, mic });
}

/** Stops keeping the sound (and lets go of the mic). A start right behind it (a changed mic) cancels it. */
export function stopClipSound() {
  if (!shell) return;
  clearTimeout(stopTimer);
  wanted = false;
  stopTimer = setTimeout(() => {
    if (wanted) return;
    send({ type: 'clipaudio', on: false });
    setStatus(OFF);
    setLevels(QUIET);
  }, 0);
}

/**
 * What a save should do about sound: ask the app for it, or save video only. `reason` says why
 * there is none when something went wrong; it is empty when sound simply isn't in use (turned off,
 * or no app), which needs no word at the save.
 */
export function soundPlan(): { ask: true } | { ask: false; reason: string } {
  if (wanted) return { ask: true };
  return { ask: false, reason: status.state === 'error' ? status.error : '' };
}

export function useClipSound(): SoundStatus {
  return useSyncExternalStore(
    (l) => {
      statusListeners.add(l);
      return () => statusListeners.delete(l);
    },
    () => status,
  );
}

/** The meters' levels, apart from the status so only the meters redraw five times a second. */
export function useClipLevels(): SoundLevels {
  return useSyncExternalStore(
    (l) => {
      levelListeners.add(l);
      return () => levelListeners.delete(l);
    },
    () => levels,
  );
}

/**
 * The quiet line under the Sound row: what each source is, e.g. "Game: World of Warcraft ·
 * Discord: on · Mic: on". `wantsMic` is whether a mic was picked.
 */
export function describeSound(s: SoundStatus, wantsMic: boolean): string {
  const game =
    s.game === 'app'
      ? `Game: ${s.gameName || 'the game'}`
      : `Game: all desktop sound${s.discord ? ' except Discord' : ''} (couldn’t find the game’s app)`;
  const discord = `Discord: ${s.discord ? 'on' : 'not running'}`;
  const mic = !wantsMic ? 'Mic: off' : s.mic ? 'Mic: on' : `Mic: ${s.micError || 'not connected'}`;
  return [game, discord, mic].join(' · ');
}
