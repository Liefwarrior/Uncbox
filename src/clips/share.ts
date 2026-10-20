import { useEffect, useSyncExternalStore } from 'react';
import { DISCORD_MAX_BYTES } from './plan';
import type { Trim } from './plan';
import { transcode } from './transcode';

// What happens to a clip after it is saved: making a vertical short from it, and sending it to
// Discord. The Discord webhook is a secret kept by the server (server/webhook.mjs); the page only
// learns whether one is set and the last four characters of it.

export interface WebhookStatus {
  set: boolean;
  /** "…a1b2", so it's clear which webhook is set without showing it. */
  hint: string;
}

let webhook: WebhookStatus = { set: false, hint: '' };
const listeners = new Set<() => void>();
function setWebhookStatus(next: WebhookStatus) {
  webhook = next;
  listeners.forEach((l) => l());
}

const failure = async (res: Response, fallback: string): Promise<Error> =>
  new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || fallback);

const unreachable = () => new Error('Couldn’t reach Uncbox. Is it still running?');

function loadWebhook() {
  fetch('/api/clips/discord')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
    .then((s: WebhookStatus) => setWebhookStatus({ set: s.set, hint: s.hint }))
    .catch(() => {});
}

export function useWebhook(): WebhookStatus {
  useEffect(loadWebhook, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => webhook,
  );
}

/** Saves (or replaces) the webhook. Resolves to '' or the reason it wasn't accepted. */
export async function setWebhook(url: string): Promise<string> {
  try {
    const res = await fetch('/api/clips/discord', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) return (await failure(res, 'Couldn’t save the webhook.')).message;
    setWebhookStatus(await res.json());
    return '';
  } catch {
    return unreachable().message;
  }
}

export async function removeWebhook() {
  try {
    const res = await fetch('/api/clips/discord/remove', { method: 'POST' });
    if (res.ok) setWebhookStatus(await res.json());
  } catch {
    /* still set; the button is still there to try again */
  }
}

/** What a long job is doing right now, for the status line. */
export interface Progress {
  text: string;
  /** 0 to 1, or null when there's no way to tell how far along it is. */
  fraction: number | null;
}
export type Report = (p: Progress) => void;

export interface Edit {
  name: string;
  trim: Trim | null;
  frame: number | null;
}

/** Makes the vertical short and saves it next to the other clips. Resolves to its file name. */
export async function makeVertical(edit: Edit, report: Report, signal: AbortSignal): Promise<string> {
  const text = 'Making your vertical clip…';
  report({ text, fraction: 0 });
  const blob = await transcode({ ...edit, target: 'vertical' }, (fraction) => report({ text, fraction }), signal);
  report({ text: 'Saving…', fraction: null });
  let res: Response;
  try {
    res = await fetch('/api/clips?kind=vertical', { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: blob, signal });
  } catch (err) {
    throw signal.aborted ? err : unreachable();
  }
  if (!res.ok) throw await failure(res, `Couldn’t save the clip (${res.status}).`);
  return ((await res.json()) as { name: string }).name;
}

/**
 * Sends a clip to the webhook. A clip that's already under Discord's limit goes as it is; anything
 * trimmed, reframed or too big is first re-encoded smaller (and smaller still, a couple of times, if
 * a try comes out over).
 */
export async function sendToDiscord(edit: Edit, report: Report, signal: AbortSignal): Promise<void> {
  const post = async (init: RequestInit) => {
    try {
      return await fetch('/api/clips/discord/send', { method: 'POST', signal, ...init });
    } catch (err) {
      throw signal.aborted ? err : unreachable();
    }
  };

  if (!edit.trim && edit.frame === null) {
    report({ text: 'Sending to Discord…', fraction: null });
    const res = await post({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: edit.name }) });
    if (res.ok) return;
    const body = (await res.clone().json().catch(() => ({}))) as { code?: string };
    if (body.code !== 'too-big') throw await failure(res, 'Discord didn’t take the clip.');
  }

  const text = 'Making a Discord-sized copy…';
  let blob: Blob | null = null;
  for (let squeeze = 1; squeeze > 0.5; squeeze *= 0.75) {
    report({ text, fraction: 0 });
    const copy = await transcode({ ...edit, target: 'discord', squeeze }, (fraction) => report({ text, fraction }), signal);
    if (copy.size <= DISCORD_MAX_BYTES) {
      blob = copy;
      break;
    }
  }
  if (!blob) throw new Error('This is too long to fit in Discord’s 10 MB. Try a shorter trim.');

  report({ text: 'Sending to Discord…', fraction: null });
  const res = await post({ headers: { 'Content-Type': 'video/mp4' }, body: blob });
  if (!res.ok) throw await failure(res, 'Discord didn’t take the clip.');
}
