// The Discord bridge against a fake Discord: a local socket that speaks the same framed RPC
// protocol as the desktop app. Sign-in was verified against the real Discord on 2026-10-18, so
// these tests pin that exact request shape.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDiscordBridge, fixFor, friendlyAuthError, IpcConnection } from './discord.mjs';

const BUILT_IN = JSON.parse(readFileSync(new URL('./discord-app.json', import.meta.url), 'utf8')).clientId;

function frame(op, payload) {
  const json = Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
}

function readFrames(buffer, onFrame) {
  while (buffer.length >= 8) {
    const len = buffer.readInt32LE(4);
    if (buffer.length < 8 + len) break;
    onFrame(buffer.readInt32LE(0), JSON.parse(buffer.subarray(8, 8 + len).toString()));
    buffer = buffer.subarray(8 + len);
  }
  return buffer;
}

/** Listens where the bridge looks for discord-ipc-0 and answers with `respond`. */
function fakeDiscord(dir, respond) {
  const seen = [];
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = readFrames(Buffer.concat([buf, chunk]), (op, msg) => {
        seen.push({ op, msg });
        respond(op, msg, (o, p) => sock.write(frame(o, p)));
      });
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) =>
    server.listen(path.join(dir, 'discord-ipc-0'), () =>
      resolve({
        seen,
        close: () => {
          for (const s of sockets) s.destroy();
          return new Promise((r) => server.close(r));
        },
      }),
    ),
  );
}

/** Answers like a Discord the user is signed in to and in no voice channel. */
function happyDiscord({ authorize } = {}) {
  return (op, msg, reply) => {
    if (op === 0) return reply(1, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } });
    const answer = (data, evt = null) => reply(1, { cmd: msg.cmd, evt, nonce: msg.nonce, data });
    switch (msg.cmd) {
      case 'AUTHORIZE':
        return authorize ? authorize(answer) : answer({ code: 'the-code' });
      case 'AUTHENTICATE':
        return answer({ user: { id: '42', username: 'liefwarrior' } });
      case 'GET_VOICE_SETTINGS':
        return answer({ mute: false, deaf: true });
      default:
        return answer(null);
    }
  };
}

async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let dir;
let bridge;
let discord;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'uncbox-discord-'));
  vi.stubEnv('XDG_RUNTIME_DIR', dir);
  vi.stubEnv('UNCBOX_DISCORD_CLIENT_ID', '');
});

afterEach(async () => {
  bridge?.stop();
  await discord?.close();
  bridge = discord = undefined;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('sign-in', () => {
  it('authorizes with PKCE, no redirect_uri, and exchanges the code without a secret', async () => {
    discord = await fakeDiscord(dir, happyDiscord());
    const fetch = vi.fn(async () =>
      Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 604800 }),
    );
    vi.stubGlobal('fetch', fetch);
    bridge = createDiscordBridge({ dataDir: dir, onChange: () => {} });

    await bridge.start();
    expect(bridge.snapshot().status).toBe('needs-auth');
    expect(discord.seen[0]).toEqual({ op: 0, msg: { v: 1, client_id: BUILT_IN } });

    await bridge.authorize();

    const auth = discord.seen.find((f) => f.msg.cmd === 'AUTHORIZE').msg.args;
    expect(Object.keys(auth).sort()).toEqual(['client_id', 'code_challenge', 'code_challenge_method', 'scopes']);
    expect(auth).toMatchObject({
      client_id: BUILT_IN,
      scopes: ['rpc', 'rpc.voice.read', 'rpc.voice.write'],
      code_challenge_method: 'S256',
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://discord.com/api/oauth2/token');
    const body = Object.fromEntries(new URLSearchParams(init.body));
    expect(Object.keys(body).sort()).toEqual(['client_id', 'code', 'code_verifier', 'grant_type']);
    expect(body).toMatchObject({ client_id: BUILT_IN, grant_type: 'authorization_code', code: 'the-code' });
    // The verifier sent to the token endpoint is the one the AUTHORIZE challenge was made from.
    expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(auth.code_challenge);

    const snap = bridge.snapshot();
    expect(snap.status).toBe('ready');
    expect(snap.user).toEqual({ id: '42', name: 'liefwarrior' });
    expect(snap.self).toEqual({ mute: false, deaf: true });
  });

  it('turns a closed Discord prompt into a plain message', async () => {
    discord = await fakeDiscord(
      dir,
      happyDiscord({ authorize: (answer) => answer({ code: 5000, message: 'OAuth2 Error: access_denied' }, 'ERROR') }),
    );
    bridge = createDiscordBridge({ dataDir: dir, onChange: () => {} });
    await bridge.start();
    await bridge.authorize();
    expect(bridge.snapshot()).toMatchObject({
      status: 'needs-auth',
      error: 'The Discord prompt was closed. Scroll to the bottom of it and click Authorize.',
      fix: '',
    });
  });

  it('reports an unknown Application ID and stops retrying', async () => {
    discord = await fakeDiscord(dir, (op, _msg, reply) => {
      if (op === 0) reply(2, { code: 4000, message: 'Invalid Client ID' });
    });
    bridge = createDiscordBridge({ dataDir: dir, onChange: () => {} });
    await bridge.start();
    await until(() => bridge.snapshot().status !== 'connecting');
    expect(bridge.snapshot()).toMatchObject({ status: 'error', error: "Discord doesn't recognize that Application ID." });
  });

  it('shows Discord as not running when there is no pipe', async () => {
    bridge = createDiscordBridge({ dataDir: dir, onChange: () => {} });
    await bridge.start();
    expect(bridge.snapshot().status).toBe('offline');
  });

  it('gives up on a Discord that accepts the pipe but never answers', { timeout: 15000 }, async () => {
    discord = await fakeDiscord(dir, () => {});
    bridge = createDiscordBridge({ dataDir: dir, onChange: () => {} });
    const started = Date.now();
    await bridge.start();
    expect(bridge.snapshot().status).toBe('offline');
    expect(Date.now() - started).toBeGreaterThanOrEqual(7500);
  });
});

describe('IpcConnection framing', () => {
  function connection() {
    const conn = new IpcConnection('1');
    const written = [];
    conn.socket = { write: (b) => written.push(b), end() {}, destroy() {} };
    return { conn, written };
  }

  it('writes a little-endian op and length header before the JSON', () => {
    const { conn, written } = connection();
    conn.write(1, { hello: 'é' });
    const json = Buffer.from(JSON.stringify({ hello: 'é' }));
    expect(written[0].readInt32LE(0)).toBe(1);
    expect(written[0].readInt32LE(4)).toBe(json.length);
    expect(written[0].subarray(8)).toEqual(json);
  });

  it('reassembles frames split across chunks and splits frames sharing one', async () => {
    const { conn } = connection();
    const events = [];
    conn.on('event', (evt, data) => events.push([evt, data]));
    const a = frame(1, { cmd: 'DISPATCH', evt: 'SPEAKING_START', data: { user_id: '1' } });
    const b = frame(1, { cmd: 'DISPATCH', evt: 'SPEAKING_STOP', data: { user_id: '1' } });
    conn.onData(a.subarray(0, 5));
    conn.onData(Buffer.concat([a.subarray(5), b]));
    expect(events).toEqual([
      ['SPEAKING_START', { user_id: '1' }],
      ['SPEAKING_STOP', { user_id: '1' }],
    ]);
  });

  it('answers PING with PONG', () => {
    const { conn, written } = connection();
    conn.onData(frame(3, { n: 1 }));
    expect(written[0].readInt32LE(0)).toBe(4);
    expect(JSON.parse(written[0].subarray(8).toString())).toEqual({ n: 1 });
  });

  it('matches replies to requests by nonce and rejects Discord errors with their code', async () => {
    const { conn, written } = connection();
    const ok = conn.request('GET_GUILDS');
    const bad = conn.request('GET_CHANNELS');
    const [n1, n2] = written.map((w) => JSON.parse(w.subarray(8).toString()).nonce);
    conn.onData(frame(1, { cmd: 'GET_CHANNELS', evt: 'ERROR', nonce: n2, data: { code: 4006, message: 'Not authenticated' } }));
    conn.onData(frame(1, { cmd: 'GET_GUILDS', nonce: n1, data: { guilds: [] } }));
    await expect(ok).resolves.toEqual({ guilds: [] });
    await expect(bad).rejects.toMatchObject({ message: 'Not authenticated', code: 4006 });
  });

  it('skips a malformed frame and keeps reading', () => {
    const { conn } = connection();
    const events = [];
    conn.on('event', (evt) => events.push(evt));
    const junk = Buffer.from('{nope');
    const header = Buffer.alloc(8);
    header.writeInt32LE(1, 0);
    header.writeInt32LE(junk.length, 4);
    conn.onData(Buffer.concat([header, junk, frame(1, { cmd: 'DISPATCH', evt: 'VOICE_CHANNEL_SELECT', data: {} })]));
    expect(events).toEqual(['VOICE_CHANNEL_SELECT']);
  });
});

describe('sign-in error messages', () => {
  const err = (message) => new Error(message);

  it('sends a missing redirect to the app settings page', () => {
    expect(fixFor(err('Missing "redirect_uri"'))).toBe('redirect');
    expect(friendlyAuthError(err('Missing "redirect_uri"'), false)).toMatch(/needs http:\/\/localhost under OAuth2/);
  });

  it('asks for a secret or Public Client when Discord rejects the client', () => {
    expect(fixFor(err('invalid_client'))).toBe('public-client');
    expect(friendlyAuthError(err('invalid_client'), false)).toBe('Discord wants a Client Secret, or turn on Public Client for this app.');
  });

  it('explains testers for unapproved apps, differently for the built-in app', () => {
    expect(friendlyAuthError(err('invalid_scope'), true)).toBe('This Discord account is not a tester on the Uncbox app yet.');
    expect(friendlyAuthError(err('invalid_scope'), false)).toMatch(/App Testers/);
  });

  it('passes anything else through', () => {
    expect(fixFor(err('something odd'))).toBe('');
    expect(friendlyAuthError(err('something odd'), true)).toBe('Discord said: something odd');
    expect(friendlyAuthError(undefined, true)).toBe('Authorization didn’t finish. Try again.');
  });
});
