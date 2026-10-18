import { useEffect, useState } from 'react';

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
  configured: boolean;
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
  configured: false,
  clientId: '',
  user: null,
  channel: null,
  self: { mute: false, deaf: false },
  members: [],
};

export function useDiscord() {
  const [snap, setSnap] = useState<DiscordSnapshot>(EMPTY);
  useEffect(() => {
    let alive = true;
    fetch('/api/discord')
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => alive && s && setSnap(s))
      .catch(() => {});
    const events = new EventSource('/api/events');
    events.addEventListener('discord', (e) => setSnap(JSON.parse((e as MessageEvent).data)));
    return () => {
      alive = false;
      events.close();
    };
  }, []);
  return snap;
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
