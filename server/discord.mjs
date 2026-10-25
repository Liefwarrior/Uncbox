// Discord voice bridge. Talks to the Discord desktop app over its local RPC pipe, follows the
// voice channel you are in, and reports members, who is speaking, and mute/deafen state.
//
// Discord only lets an app use voice RPC after the user authorizes it. Two ways to have an app:
//
// - Built in: Uncbox's own Discord app (server/discord-app.json or UNCBOX_DISCORD_CLIENT_ID).
//   It is a "Public Client", so sign-in uses PKCE and no secret ships with Uncbox. Until Discord
//   approves its RPC scopes, only accounts listed as App Testers on it (up to 50) can sign in.
// - Your own: a developer app the user creates; Client ID only if Public Client is on, otherwise
//   Client ID and Secret. Any secret and all tokens stay in data/discord.json, never in the page.

import { EventEmitter } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { offline } from './switches.mjs';
import { writeJsonAtomic } from './datafile.mjs';

function builtInClientId() {
  if (process.env.UNCBOX_DISCORD_CLIENT_ID) return process.env.UNCBOX_DISCORD_CLIENT_ID.trim();
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'discord-app.json');
    return String(JSON.parse(readFileSync(file, 'utf8')).clientId ?? '').trim();
  } catch {
    return '';
  }
}
const BUILT_IN_CLIENT_ID = builtInClientId();

/** PKCE pair: the challenge goes to Discord with AUTHORIZE, the verifier with the token exchange. */
function pkcePair() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const SCOPES = ['rpc', 'rpc.voice.read', 'rpc.voice.write'];
const VOICE_TYPES = new Set([2, 13]); // voice, stage
const RETRY_MS = 5000;
const HANDSHAKE_TIMEOUT_MS = 8000;
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const REDIRECT_URI = 'http://localhost';

function pipePath(n) {
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${n}`;
  const dir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || '/tmp';
  return path.join(dir, `discord-ipc-${n}`);
}

/** One connection to Discord's IPC socket: framing, request/response by nonce, and events. */
export class IpcConnection extends EventEmitter {
  constructor(clientId) {
    super();
    this.clientId = clientId;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
  }

  async open() {
    for (let n = 0; n < 10; n++) {
      try {
        this.socket = await new Promise((resolve, reject) => {
          const s = net.connect(pipePath(n), () => resolve(s));
          s.once('error', reject);
        });
        break;
      } catch {
        // Try the next pipe number; Discord uses the first free one.
      }
    }
    if (!this.socket) throw Object.assign(new Error('Discord is not running'), { code: 'NO_DISCORD' });
    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('close', () => this.onClose());
    this.socket.on('error', () => {});
    const ready = new Promise((resolve, reject) => {
      // A Discord that is starting up or stuck can accept the pipe and never answer.
      const timer = setTimeout(() => {
        this.closeReason = new Error('Discord did not respond');
        this.socket?.destroy();
      }, HANDSHAKE_TIMEOUT_MS);
      this.once('ready', (data) => {
        clearTimeout(timer);
        resolve(data);
      });
      this.once('closed', (reason) => {
        clearTimeout(timer);
        reject(reason);
      });
    });
    this.write(OP.HANDSHAKE, { v: 1, client_id: this.clientId });
    return ready;
  }

  write(op, payload) {
    const json = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.alloc(8);
    header.writeInt32LE(op, 0);
    header.writeInt32LE(json.length, 4);
    this.socket?.write(Buffer.concat([header, json]));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const len = this.buffer.readInt32LE(4);
      if (this.buffer.length < 8 + len) break;
      let payload = null;
      try {
        payload = JSON.parse(this.buffer.subarray(8, 8 + len).toString('utf8'));
      } catch {
        // Malformed frame: skip it.
      }
      this.buffer = this.buffer.subarray(8 + len);
      if (payload) this.onFrame(op, payload);
    }
  }

  onFrame(op, payload) {
    if (op === OP.PING) return this.write(OP.PONG, payload);
    if (op === OP.CLOSE) {
      this.closeReason = Object.assign(new Error(payload.message || 'Discord closed the connection'), { code: payload.code });
      this.socket?.end();
      return;
    }
    if (payload.cmd === 'DISPATCH') {
      if (payload.evt === 'READY') this.emit('ready', payload.data);
      else this.emit('event', payload.evt, payload.data);
      return;
    }
    const waiter = this.pending.get(payload.nonce);
    if (!waiter) return;
    this.pending.delete(payload.nonce);
    if (payload.evt === 'ERROR') waiter.reject(Object.assign(new Error(payload.data?.message), { code: payload.data?.code }));
    else waiter.resolve(payload.data);
  }

  onClose() {
    const reason = this.closeReason || new Error('Discord connection closed');
    for (const w of this.pending.values()) w.reject(reason);
    this.pending.clear();
    this.socket = null;
    this.emit('closed', reason);
  }

  request(cmd, args = {}, evt) {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('Not connected to Discord'));
      const nonce = randomUUID();
      this.pending.set(nonce, { resolve, reject });
      this.write(OP.FRAME, { cmd, args, evt, nonce });
    });
  }

  close() {
    this.socket?.destroy();
  }
}

function avatarUrl(user) {
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=96`;
  const index = Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

function toMember(vs) {
  const u = vs.user ?? {};
  const v = vs.voice_state ?? {};
  return {
    id: u.id,
    name: vs.nick || u.global_name || u.username || 'Unknown',
    avatar: u.id ? avatarUrl(u) : '',
    mute: Boolean(v.mute || v.self_mute || vs.mute),
    deaf: Boolean(v.deaf || v.self_deaf),
  };
}

/** Which Discord app setting blocks sign-in, so the panel can open that page: 'redirect' or 'public-client'. */
export function fixFor(err) {
  // 'Missing "redirect_uri"': the app has no registered redirect, which PKCE sign-in needs.
  if (/redirect/i.test(err?.message ?? '')) return 'redirect';
  if (/invalid_client|secret/i.test(err?.message ?? '')) return 'public-client';
  return '';
}

/** What to tell the user when sign-in fails; `builtIn` is true for Uncbox's own Discord app. */
export function friendlyAuthError(err, builtIn) {
  if (/redirect/i.test(err?.message ?? '')) {
    return `This Discord app needs ${REDIRECT_URI} under OAuth2 → Redirects. Its settings just opened: add it, save, then connect again.`;
  }
  const msg = err?.message ?? '';
  // Code 5000 covers every OAuth2 failure (including Cancel), so go by Discord's message.
  if (/access_denied|cancel|closed/i.test(msg)) {
    return 'The Discord prompt was closed. Scroll to the bottom of it and click Authorize.';
  }
  // Unapproved apps only accept their owner and listed App Testers; anyone else gets invalid_scope.
  if (/invalid_scope/i.test(msg)) {
    return builtIn
      ? 'This Discord account is not a tester on the Uncbox app yet.'
      : 'Discord refused the voice permissions for this account. If you don’t own this app, ask its owner to add you under App Testers.';
  }
  if (/invalid_client|secret/i.test(msg)) {
    return 'Discord wants a Client Secret, or turn on Public Client for this app.';
  }
  return msg ? `Discord said: ${msg}` : 'Authorization didn’t finish. Try again.';
}

/**
 * statuses: unconfigured → connecting → (offline | needs-auth → authorizing) → ready
 */
export function createDiscordBridge({ dataDir, onChange }) {
  const file = path.join(dataDir, 'discord.json');
  let config = {};
  let ipc = null;
  let retryTimer = null;
  let stopped = false;
  const state = {
    status: 'unconfigured',
    error: '',
    user: null,
    channel: null,
    members: [],
    speaking: new Set(),
    self: { mute: false, deaf: false },
    fix: '',
  };
  let channelSubs = [];
  let emitTimer = null;

  // The user's own app wins over the built-in one; a secret only ever belongs to the user's own.
  const clientId = () => config.clientId || BUILT_IN_CLIENT_ID;
  const clientSecret = () => (config.clientId ? config.clientSecret || '' : '');

  const snapshot = () => ({
    status: state.status,
    error: state.error,
    /** A setting on the Discord app blocks sign-in: 'redirect' or 'public-client'. */
    fix: state.fix,
    configured: Boolean(clientId()),
    builtIn: !config.clientId && Boolean(BUILT_IN_CLIENT_ID),
    hasBuiltIn: Boolean(BUILT_IN_CLIENT_ID),
    clientId: config.clientId || '',
    user: state.user,
    channel: state.channel,
    self: state.self,
    members: state.members.map((m) => ({ ...m, speaking: state.speaking.has(m.id) })),
  });

  // Speaking events arrive in bursts; coalesce them so the browser gets at most ~30 updates/s.
  const changed = () => {
    if (emitTimer) return;
    emitTimer = setTimeout(() => {
      emitTimer = null;
      onChange(snapshot());
    }, 33);
  };
  const set = (patch) => {
    Object.assign(state, patch);
    changed();
  };

  async function load() {
    try {
      config = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      config = {};
    }
  }

  async function save() {
    await writeJsonAtomic(file, config, { mode: 0o600, pretty: true });
  }

  async function tokenRequest(params) {
    // Public clients (PKCE) send no secret; Discord checks the code_verifier instead.
    const body = new URLSearchParams({ client_id: clientId(), ...params });
    if (clientSecret()) body.set('client_secret', clientSecret());
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json.error_description || json.error || `Token request failed (${res.status})`);
    }
    config.tokenClientId = clientId();
    config.accessToken = json.access_token;
    config.refreshToken = json.refresh_token;
    config.expiresAt = Date.now() + (json.expires_in ?? 0) * 1000;
    await save();
  }

  async function exchangeCode(code, verifier) {
    // Verified against Discord (2026-10-18): the exchange works without a redirect_uri, as long as
    // the app has one registered (an app with none makes PKCE sign-in fail with "Missing redirect_uri").
    const params = { grant_type: 'authorization_code', code };
    if (verifier) params.code_verifier = verifier;
    await tokenRequest(params);
  }

  function clearChannel() {
    channelSubs = [];
    state.speaking.clear();
    set({ channel: null, members: [] });
  }

  async function watchChannel(channel) {
    const conn = ipc;
    for (const [evt, args] of channelSubs) conn?.request('UNSUBSCRIBE', args, evt).catch(() => {});
    clearChannel();
    if (!channel || !conn) return;
    const args = { channel_id: channel.id };
    channelSubs = ['VOICE_STATE_CREATE', 'VOICE_STATE_UPDATE', 'VOICE_STATE_DELETE', 'SPEAKING_START', 'SPEAKING_STOP'].map(
      (evt) => [evt, args],
    );
    await Promise.all(channelSubs.map(([evt, a]) => conn.request('SUBSCRIBE', a, evt).catch(() => {})));
    set({
      channel: { id: channel.id, name: channel.name || 'Voice', guildId: channel.guild_id || null },
      members: (channel.voice_states ?? []).map(toMember).filter((m) => m.id),
    });
  }

  async function refreshChannel() {
    const channel = await ipc?.request('GET_SELECTED_VOICE_CHANNEL').catch(() => null);
    await watchChannel(channel ?? null);
  }

  function onEvent(evt, data) {
    switch (evt) {
      case 'VOICE_CHANNEL_SELECT':
        void refreshChannel();
        break;
      case 'VOICE_STATE_CREATE':
      case 'VOICE_STATE_UPDATE': {
        const m = toMember(data);
        if (!m.id) break;
        const i = state.members.findIndex((x) => x.id === m.id);
        const members = [...state.members];
        if (i >= 0) members[i] = m;
        else members.push(m);
        set({ members });
        break;
      }
      case 'VOICE_STATE_DELETE': {
        const id = data?.user?.id;
        state.speaking.delete(id);
        set({ members: state.members.filter((m) => m.id !== id) });
        break;
      }
      case 'VOICE_SETTINGS_UPDATE':
        set({ self: { mute: Boolean(data?.mute), deaf: Boolean(data?.deaf) } });
        break;
      case 'SPEAKING_START':
        state.speaking.add(data.user_id);
        changed();
        break;
      case 'SPEAKING_STOP':
        state.speaking.delete(data.user_id);
        changed();
        break;
    }
  }

  async function authenticate() {
    if (config.expiresAt && config.expiresAt - Date.now() < 60_000 && config.refreshToken) {
      await tokenRequest({ grant_type: 'refresh_token', refresh_token: config.refreshToken });
    }
    let auth;
    try {
      auth = await ipc.request('AUTHENTICATE', { access_token: config.accessToken });
    } catch (err) {
      if (!config.refreshToken) throw err;
      await tokenRequest({ grant_type: 'refresh_token', refresh_token: config.refreshToken });
      auth = await ipc.request('AUTHENTICATE', { access_token: config.accessToken });
    }
    const u = auth?.user ?? {};
    set({ status: 'ready', error: '', user: { id: u.id, name: u.global_name || u.username || '' } });
    await ipc.request('SUBSCRIBE', {}, 'VOICE_CHANNEL_SELECT').catch(() => {});
    await ipc.request('SUBSCRIBE', {}, 'VOICE_SETTINGS_UPDATE').catch(() => {});
    const voice = await ipc.request('GET_VOICE_SETTINGS').catch(() => null);
    if (voice) set({ self: { mute: Boolean(voice.mute), deaf: Boolean(voice.deaf) } });
    await refreshChannel();
  }

  /** The live connection, once authorized; anything else is a 409 for the caller. */
  function ready() {
    if (!ipc || state.status !== 'ready') {
      throw Object.assign(new Error('Discord is not connected'), { status: 409 });
    }
    return ipc;
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    if (!stopped) retryTimer = setTimeout(connect, RETRY_MS);
  }

  async function connect() {
    clearTimeout(retryTimer);
    ipc?.close();
    ipc = null;
    if (!clientId()) {
      set({ status: 'unconfigured', error: '', user: null });
      clearChannel();
      return;
    }
    // UNCBOX_OFFLINE: never knock on the Discord app's pipe.
    if (offline()) {
      set({ status: 'offline', error: '' });
      return;
    }
    // Tokens belong to the app that issued them; drop them if the app changed.
    if (config.tokenClientId && config.tokenClientId !== clientId()) {
      config.accessToken = config.refreshToken = config.expiresAt = config.tokenClientId = undefined;
      await save().catch(() => {});
    }
    set({ status: 'connecting', error: '' });
    const conn = new IpcConnection(clientId());
    conn.on('event', onEvent);
    conn.on('closed', (reason) => {
      if (ipc !== conn) return;
      ipc = null;
      clearChannel();
      // 4000 = invalid client ID: retrying will not help until the config changes.
      if (reason?.code === 4000) set({ status: 'error', error: "Discord doesn't recognize that Application ID." });
      else {
        set({ status: 'offline', error: '' });
        scheduleRetry();
      }
    });
    ipc = conn;
    try {
      await conn.open();
    } catch (err) {
      if (ipc !== conn) return;
      ipc = null;
      if (err?.code === 4000) set({ status: 'error', error: "Discord doesn't recognize that Application ID." });
      else {
        set({ status: 'offline', error: '' });
        scheduleRetry();
      }
      return;
    }
    if (!config.accessToken) {
      set({ status: 'needs-auth' });
      return;
    }
    try {
      await authenticate();
    } catch (err) {
      config.accessToken = config.refreshToken = undefined;
      await save().catch(() => {});
      set({ status: 'needs-auth', error: err.message });
    }
  }

  return {
    async start() {
      await load();
      await connect();
    },
    snapshot,
    appId: () => clientId(),
    async configure({ clientId, clientSecret }) {
      const id = String(clientId ?? '').trim();
      const secret = String(clientSecret ?? '').trim();
      if (!/^\d{15,22}$/.test(id)) throw Object.assign(new Error('The Application ID should be a long number'), { status: 400 });
      // No secret is fine: that app must have Public Client on, and sign-in uses PKCE.
      const keepSecret = config.clientId === id ? config.clientSecret : undefined;
      config = { ...config, clientId: id, clientSecret: secret || keepSecret };
      await save();
      await connect();
    },
    async authorize() {
      if (!ipc) throw Object.assign(new Error('Discord is not connected'), { status: 409 });
      set({ status: 'authorizing', error: '', fix: '' });
      try {
        const pkce = clientSecret() ? null : pkcePair();
        // No redirect_uri here: Discord rejects one in RPC sign-in ("Redirect URI cannot be used in the
        // RPC OAuth2 Authorization flow"), though the app must still have one registered for PKCE.
        const args = { client_id: clientId(), scopes: SCOPES };
        if (pkce) Object.assign(args, { code_challenge: pkce.challenge, code_challenge_method: 'S256' });
        const { code } = await ipc.request('AUTHORIZE', args);
        await exchangeCode(code, pkce?.verifier);
        await authenticate();
      } catch (err) {
        set({ status: 'needs-auth', error: friendlyAuthError(err, snapshot().builtIn), fix: fixFor(err) });
      }
    },
    async guilds() {
      const data = await ready().request('GET_GUILDS');
      return (data?.guilds ?? []).map((g) => ({ id: g.id, name: g.name, icon: g.icon_url || '' }));
    },
    async channels(guildId) {
      if (!/^\d+$/.test(String(guildId))) throw Object.assign(new Error('Bad server ID'), { status: 400 });
      const data = await ready().request('GET_CHANNELS', { guild_id: String(guildId) });
      return (data?.channels ?? [])
        .filter((c) => VOICE_TYPES.has(c.type))
        .map((c) => ({ id: c.id, name: c.name }));
    },
    /** Moves you into a voice channel (force: also when you are already in another one). */
    async join(channelId) {
      if (!/^\d+$/.test(String(channelId))) throw Object.assign(new Error('Bad channel ID'), { status: 400 });
      await ready().request('SELECT_VOICE_CHANNEL', { channel_id: String(channelId), force: true });
      await refreshChannel();
    },
    async leave() {
      await ready().request('SELECT_VOICE_CHANNEL', { channel_id: null });
      await refreshChannel();
    },
    async setVoice({ mute, deaf }) {
      const args = {};
      if (typeof mute === 'boolean') args.mute = mute;
      if (typeof deaf === 'boolean') args.deaf = deaf;
      const data = await ready().request('SET_VOICE_SETTINGS', args);
      set({ self: { mute: Boolean(data?.mute ?? mute), deaf: Boolean(data?.deaf ?? deaf) } });
    },
    async forget() {
      config = {};
      await save();
      await connect();
    },
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      ipc?.close();
    },
  };
}
