import { useEffect, useState } from 'react';
import { listen, onConnection } from './events';

// Client side of server/discord.mjs. The server owns the Discord connection and the secret;
// the page only sees this snapshot, pushed live as a named "discord" event on /api/events.

export type DiscordStatus = 'unconfigured' | 'connecting' | 'offline' | 'needs-auth' | 'authorizing' | 'ready' | 'error';

export interface VoiceMember {
  id: string;
  name: string;
  avatar: string;
  mute: boolean;
  deaf: boolean;
  speaking: boolean;
}

export interface DiscordSnapshot {
  status: DiscordStatus;
  error: string;
  /** A Discord app setting blocks sign-in; Uncbox opens that app's OAuth2 page for it. */
  fix: '' | 'redirect' | 'public-client';
  configured: boolean;
  /** Signed in through Uncbox's own Discord app rather than one the user made. */
  builtIn: boolean;
  hasBuiltIn: boolean;
  clientId: string;
  user: { id: string; name: string } | null;
  channel: { id: string; name: string; guildId: string | null } | null;
  self: { mute: boolean; deaf: boolean };
  members: VoiceMember[];
}

export interface Guild {
  id: string;
  name: string;
  icon: string;
}

export interface VoiceChannel {
  id: string;
  name: string;
}

const EMPTY: DiscordSnapshot = {
  status: 'connecting',
  error: '',
  fix: '',
  configured: false,
  builtIn: false,
  hasBuiltIn: false,
  clientId: '',
  user: null,
  channel: null,
  self: { mute: false, deaf: false },
  members: [],
};

/** `reachable` is false while the Uncbox server itself can't be reached. */
export function useDiscord() {
  const [snap, setSnap] = useState<DiscordSnapshot>(EMPTY);
  const [reachable, setReachable] = useState(true);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/discord')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
        .then((s) => {
          if (!alive) return;
          setSnap(s);
          setReachable(true);
        })
        .catch(() => alive && setReachable(false));
    // Pushed updates only arrive on change, so re-read the snapshot every time the stream
    // (re)connects: after a server restart the page would otherwise keep a stale state forever.
    const stopWatching = onConnection(() => void load(), () => setReachable(false));
    const stopListening = listen('discord', (data) => setSnap(JSON.parse(data)));
    void load();
    return () => {
      alive = false;
      stopWatching();
      stopListening();
    };
  }, []);
  return { ...snap, reachable };
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/discord${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json as T;
}

export const discordApi = {
  configure: (clientId: string, clientSecret: string) => call('/config', { clientId, clientSecret }),
  authorize: () => call('/authorize', {}),
  forget: () => call('/forget', {}),
  guilds: () => call<Guild[]>('/guilds'),
  channels: (guildId: string) => call<VoiceChannel[]>(`/channels?guild=${encodeURIComponent(guildId)}`),
  join: (channelId: string) => call('/join', { channelId }),
  leave: () => call('/leave', {}),
  voice: (patch: { mute?: boolean; deaf?: boolean }) => call('/voice', patch),
};

/**
 * Opens a setup page in the default browser, via the local server. With once = true it opens at
 * most once per browser session, so reloading the dashboard does not keep popping windows.
 */
export function openPage(target: 'discord-portal' | 'discord-oauth', once = false) {
  const key = `uncbox:opened:${target}`;
  try {
    if (once && sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
  } catch {
    // Storage blocked: open anyway.
  }
  void fetch('/api/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target }),
  });
}
