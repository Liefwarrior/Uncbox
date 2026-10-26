// The Twitch widget's server side: the device-code sign-in, refresh-token rotation, how Twitch's
// answers become the widget's snapshot, title checks and the watch/unwatch lifecycle. Twitch is
// never called: every request goes to a fake fetch, and the saved file is kept in memory.

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyTokenResponse, createTwitch, createTwitchStore, LEASE_MS, POLL_MS, reduceSnapshot, validateTitle } from './twitch.mjs';

const CLIENT = 'abcdefghijklmnopqrstuvwxyz0123';
const DEVICE = 'urn:ietf:params:oauth:grant-type:device_code';

const reply = (status, body) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A fake Twitch. `routes` maps "METHOD host/path" to a handler (or a fixed [status, body]); every call is logged. */
function fakeTwitch(routes) {
  const calls = [];
  const fn = vi.fn(async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? 'GET'} ${u.host}${u.pathname}`;
    const params = new URLSearchParams(typeof init.body === 'string' && !init.body.startsWith('{') ? init.body : '');
    calls.push({ key, query: u.searchParams, params, headers: init.headers ?? {}, body: init.body });
    const route = routes[key];
    if (!route) throw new Error(`unexpected request: ${key}`);
    const out = typeof route === 'function' ? route({ query: u.searchParams, params, calls }) : route;
    return reply(...out);
  });
  fn.calls = calls;
  return fn;
}

function memoryStore(initial = {}) {
  let saved = structuredClone(initial);
  return { get: async () => structuredClone(saved), set: async (d) => void (saved = structuredClone(d)), clear: async () => void (saved = {}), peek: () => saved };
}

function make({ fetchImpl, store = memoryStore({ clientId: CLIENT }), events = [] } = {}) {
  const twitch = createTwitch({
    broadcastEvent: (name, data) => events.push([name, data]),
    sendJson: () => {},
    isLocal: () => true,
    readJson: async () => ({}),
    dataDir: '',
    fetchImpl,
    store,
  });
  return { twitch, store, events };
}

const signedInStore = (extra = {}) =>
  memoryStore({ clientId: CLIENT, accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3_600_000, userId: '99', login: 'uncle', displayName: 'Uncle', ...extra });

describe('validateTitle', () => {
  it('trims and tidies a title', () => {
    expect(validateTitle('  Raid   night\n')).toEqual({ ok: true, title: 'Raid night' });
  });

  it('turns control characters and newlines into spaces', () => {
    expect(validateTitle('a\u0000b\nc')).toEqual({ ok: true, title: 'a b c' });
  });

  it('refuses an empty title', () => {
    expect(validateTitle('   ').ok).toBe(false);
    expect(validateTitle(undefined).ok).toBe(false);
  });

  it('allows 140 characters and no more', () => {
    expect(validateTitle('x'.repeat(140)).ok).toBe(true);
    const long = validateTitle('x'.repeat(141));
    expect(long.ok).toBe(false);
    expect(long.error).toContain('141');
  });

  it('counts a character, not a UTF-16 unit', () => {
    expect(validateTitle('🎮'.repeat(140)).ok).toBe(true);
    expect(validateTitle('🎮'.repeat(141)).ok).toBe(false);
  });
});

describe('classifyTokenResponse', () => {
  it('reads the tokens on success', () => {
    const r = classifyTokenResponse(200, { access_token: 'a', refresh_token: 'r', expires_in: 100 }, 1000);
    expect(r).toEqual({ kind: 'success', tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: 101_000 } });
  });

  it.each([
    [{ status: 400, message: 'authorization_pending' }, 'pending'],
    [{ status: 400, message: 'slow_down' }, 'slow'],
    [{ status: 400, message: 'expired_token' }, 'expired'],
    [{ status: 400, message: 'invalid device code' }, 'expired'],
    [{ status: 400, message: 'access_denied' }, 'denied'],
    [{ status: 500, message: 'boom' }, 'error'],
  ])('%j is %s', ({ status, message }, kind) => {
    expect(classifyTokenResponse(status, { message }).kind).toBe(kind);
  });
});

describe('reduceSnapshot', () => {
  const stream = {
    data: [{ viewer_count: 42, started_at: '2026-10-20T10:00:00Z', title: 'Live title', game_id: '7', game_name: 'SMITE 2', thumbnail_url: 'https://x/live_{width}x{height}.jpg' }],
  };
  const channel = { data: [{ title: 'Channel title', game_id: '9', game_name: 'Just Chatting' }] };
  const followers = { total: 1234, data: [{ user_name: 'Ann' }, { user_name: 'Bo' }, { user_login: 'cy' }] };

  it('reads a live stream', () => {
    const r = reduceSnapshot({ stream, channel: null, followers, subs: { total: 17 } });
    expect(r).toEqual({
      live: true,
      viewers: 42,
      startedAt: Date.parse('2026-10-20T10:00:00Z'),
      title: 'Live title',
      game: { id: '7', name: 'SMITE 2' },
      thumbnail: 'https://x/live_440x248.jpg',
      followers: 1234,
      subs: 17,
      latestFollowers: ['Ann', 'Bo', 'cy'],
    });
  });

  it('prefers the channel’s title and category, which are fresher after an edit', () => {
    const r = reduceSnapshot({ stream, channel, followers, subs: null });
    expect(r.title).toBe('Channel title');
    expect(r.game).toEqual({ id: '9', name: 'Just Chatting' });
  });

  it('reads an offline channel from the channel answer', () => {
    const r = reduceSnapshot({ stream: { data: [] }, channel, followers, subs: null });
    expect(r).toMatchObject({ live: false, viewers: 0, startedAt: 0, thumbnail: '', title: 'Channel title' });
  });

  it('gives a null count, not zero, for what Twitch wouldn’t say', () => {
    const r = reduceSnapshot({ stream: { data: [] }, channel, followers: null, subs: null });
    expect(r.followers).toBeNull();
    expect(r.subs).toBeNull();
    expect(r.latestFollowers).toEqual([]);
  });

  it('keeps the five newest followers at most', () => {
    const many = { total: 9, data: Array.from({ length: 9 }, (_, i) => ({ user_name: `f${i}` })) };
    expect(reduceSnapshot({ stream, channel, followers: many, subs: null }).latestFollowers).toHaveLength(5);
  });
});

describe('the file store', () => {
  let dir;
  beforeEach(async () => void (dir = await mkdtemp(path.join(os.tmpdir(), 'uncbox-twitch-'))));
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('keeps what it is given, and is empty before that', async () => {
    const store = createTwitchStore(dir);
    expect(await store.get()).toEqual({});
    await store.set({ clientId: CLIENT, refreshToken: 'r' });
    expect(await store.get()).toEqual({ clientId: CLIENT, refreshToken: 'r' });
    expect(JSON.parse(await readFile(path.join(dir, 'twitch.json'), 'utf8')).refreshToken).toBe('r');
    await store.clear();
    expect(await store.get()).toEqual({});
    await expect(stat(path.join(dir, 'twitch.json'))).rejects.toThrow();
  });
});

describe('device code sign-in', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const device = { device_code: 'dev-code', user_code: 'ABCDEFGH', verification_uri: 'https://www.twitch.tv/activate?device-code=ABCDEFGH', expires_in: 1800, interval: 5 };
  const tokens = { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 14000, scope: ['x'], token_type: 'bearer' };

  /** Fake Twitch whose token endpoint gives these answers in order, the last one repeating. */
  function signInWith(answers) {
    let n = 0;
    return fakeTwitch({
      'POST id.twitch.tv/oauth2/device': [200, device],
      'POST id.twitch.tv/oauth2/token': () => answers[Math.min(n++, answers.length - 1)],
      'GET id.twitch.tv/oauth2/validate': [200, { client_id: CLIENT, login: 'uncle', user_id: '99', expires_in: 14000 }],
      'GET api.twitch.tv/helix/users': [200, { data: [{ id: '99', login: 'uncle', display_name: 'Uncle' }] }],
    });
  }
  const pending = [400, { status: 400, message: 'authorization_pending' }];
  const tokenCalls = (f) => f.calls.filter((c) => c.key === 'POST id.twitch.tv/oauth2/token');

  it('asks for a code with the right scopes and hands back what the page shows', async () => {
    const fetchImpl = signInWith([pending]);
    const { twitch } = make({ fetchImpl });
    const out = await twitch.startSignIn();
    expect(out).toEqual({ userCode: 'ABCDEFGH', verificationUri: device.verification_uri, expiresIn: 1800 });
    const ask = fetchImpl.calls[0];
    expect(ask.params.get('client_id')).toBe(CLIENT);
    expect(ask.params.get('scopes')).toBe('channel:manage:broadcast moderator:read:followers channel:read:subscriptions bits:read channel:read:stream_key');
    expect(ask.params.has('client_secret')).toBe(false);
    twitch.close();
  });

  it('needs a client ID first', async () => {
    const { twitch } = make({ fetchImpl: signInWith([pending]), store: memoryStore() });
    await expect(twitch.startSignIn()).rejects.toMatchObject({ status: 409 });
  });

  it('keeps asking at the interval while the code is pending', async () => {
    const fetchImpl = signInWith([pending]);
    const { twitch } = make({ fetchImpl });
    await twitch.startSignIn();
    await vi.advanceTimersByTimeAsync(4_900);
    expect(tokenCalls(fetchImpl)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(tokenCalls(fetchImpl)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tokenCalls(fetchImpl)).toHaveLength(2);
    expect(tokenCalls(fetchImpl)[0].params.get('grant_type')).toBe(DEVICE);
    expect(tokenCalls(fetchImpl)[0].params.get('device_code')).toBe('dev-code');
    expect((await twitch.status()).signingIn).toBe(true);
    twitch.close();
  });

  it('slows down by five seconds when Twitch says slow_down', async () => {
    const fetchImpl = signInWith([[400, { message: 'slow_down' }], pending]);
    const { twitch } = make({ fetchImpl });
    await twitch.startSignIn();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tokenCalls(fetchImpl)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9_900); // The next ask is due 10 s after the last, not 5.
    expect(tokenCalls(fetchImpl)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(tokenCalls(fetchImpl)).toHaveLength(2);
    twitch.close();
  });

  it('stops with a plain message when the code expires', async () => {
    const fetchImpl = signInWith([[400, { message: 'expired_token' }]]);
    const { twitch, events } = make({ fetchImpl });
    await twitch.startSignIn();
    await vi.advanceTimersByTimeAsync(5_000);
    const status = await twitch.status();
    expect(status.signingIn).toBe(false);
    expect(status.signedIn).toBe(false);
    expect(status.error).toMatch(/ran out/);
    expect(events.at(-1)[0]).toBe('twitch');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops when the code’s time is up, even if Twitch never said', async () => {
    const fetchImpl = signInWith([pending]);
    const { twitch } = make({ fetchImpl });
    await twitch.startSignIn();
    await vi.advanceTimersByTimeAsync(1_810_000);
    expect((await twitch.status()).error).toMatch(/ran out/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('signs in on success, saves the tokens and says so', async () => {
    const fetchImpl = signInWith([pending, [200, tokens]]);
    const { twitch, store, events } = make({ fetchImpl });
    await twitch.startSignIn();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await twitch.status()).toEqual({ configured: true, signedIn: true, signingIn: false, login: 'uncle', displayName: 'Uncle', error: '' });
    expect(store.peek()).toMatchObject({ clientId: CLIENT, accessToken: 'access-1', refreshToken: 'refresh-1', userId: '99' });
    expect(events.at(-1)).toEqual(['twitch', expect.objectContaining({ signedIn: true, login: 'uncle' })]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never puts a token in what the page is told', async () => {
    const fetchImpl = signInWith([[200, tokens]]);
    const { twitch, events } = make({ fetchImpl });
    await twitch.startSignIn();
    await vi.advanceTimersByTimeAsync(5_000);
    const told = JSON.stringify([await twitch.status(), events]);
    expect(told).not.toContain('access-1');
    expect(told).not.toContain('refresh-1');
  });

  it('survives a dropped connection while waiting', async () => {
    let n = 0;
    const fetchImpl = fakeTwitch({
      'POST id.twitch.tv/oauth2/device': [200, device],
      'POST id.twitch.tv/oauth2/token': () => {
        if (n++ === 0) throw new Error('offline');
        return pending;
      },
    });
    const { twitch } = make({ fetchImpl });
    await twitch.startSignIn();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tokenCalls(fetchImpl)).toHaveLength(2);
    expect((await twitch.status()).signingIn).toBe(true);
    twitch.close();
  });

  it('a new sign-in replaces the old one’s waiting', async () => {
    const fetchImpl = signInWith([pending]);
    const { twitch } = make({ fetchImpl });
    await twitch.startSignIn();
    await twitch.startSignIn();
    expect(vi.getTimerCount()).toBe(1);
    twitch.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('says so when Twitch turns the client ID down', async () => {
    const fetchImpl = fakeTwitch({ 'POST id.twitch.tv/oauth2/device': [400, { message: 'invalid client' }] });
    const { twitch } = make({ fetchImpl });
    await expect(twitch.startSignIn()).rejects.toThrow(/client ID/);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('refresh tokens', () => {
  const refreshed = { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 14000 };
  const search = [200, { data: [{ id: '33214', name: 'Fortnite', box_art_url: 'https://x/33214-{width}x{height}.jpg' }] }];

  it('swaps in the new refresh token each time, since the old one stops working', async () => {
    let handedOut = 0;
    const fetchImpl = fakeTwitch({
      'POST id.twitch.tv/oauth2/token': ({ params }) => {
        handedOut++;
        return [200, { access_token: `access-${handedOut + 1}`, refresh_token: `refresh-${handedOut + 1}`, expires_in: 14000 }];
      },
      'GET api.twitch.tv/helix/search/categories': search,
    });
    // Starts out about to expire, so the first use refreshes.
    const store = signedInStore({ expiresAt: Date.now() + 60_000 });
    const { twitch } = make({ fetchImpl, store });
    await twitch.categories('fort');
    expect(fetchImpl.calls[0].params.get('grant_type')).toBe('refresh_token');
    expect(fetchImpl.calls[0].params.get('refresh_token')).toBe('refresh-1');
    expect(fetchImpl.calls[0].params.has('client_secret')).toBe(false);
    expect(store.peek()).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2', userId: '99' });
    expect(fetchImpl.calls[1].headers.Authorization).toBe('Bearer access-2');
    expect(fetchImpl.calls[1].headers['Client-Id']).toBe(CLIENT);

    // Fresh now, so no second refresh; once it ages, the new refresh token is the one sent.
    await twitch.categories('fort');
    expect(fetchImpl.calls.filter((c) => c.key.endsWith('/token'))).toHaveLength(1);
    store.peek().expiresAt = 0;
    const { twitch: later } = make({ fetchImpl, store });
    await later.categories('fort');
    expect(fetchImpl.calls.filter((c) => c.key.endsWith('/token')).at(-1).params.get('refresh_token')).toBe('refresh-2');
  });

  it('shares one refresh between requests made at the same time', async () => {
    const fetchImpl = fakeTwitch({ 'POST id.twitch.tv/oauth2/token': [200, refreshed], 'GET api.twitch.tv/helix/search/categories': search });
    const { twitch } = make({ fetchImpl, store: signedInStore({ expiresAt: 0 }) });
    await Promise.all([twitch.categories('a'), twitch.categories('b'), twitch.categories('c')]);
    expect(fetchImpl.calls.filter((c) => c.key.endsWith('/token'))).toHaveLength(1);
  });

  it('refreshes once and retries when Twitch rejects a token that looked fine', async () => {
    let first = true;
    const fetchImpl = fakeTwitch({
      'POST id.twitch.tv/oauth2/token': [200, refreshed],
      'GET api.twitch.tv/helix/search/categories': () => (first ? ((first = false), [401, { message: 'Invalid OAuth token' }]) : search),
    });
    const { twitch } = make({ fetchImpl, store: signedInStore() });
    expect(await twitch.categories('fort')).toEqual([{ id: '33214', name: 'Fortnite', boxArt: 'https://x/33214-52x72.jpg' }]);
    expect(fetchImpl.calls.filter((c) => c.key.endsWith('/token'))).toHaveLength(1);
  });

  it('signs out, keeping the client ID, when Twitch refuses the refresh token', async () => {
    const fetchImpl = fakeTwitch({ 'POST id.twitch.tv/oauth2/token': [400, { message: 'Invalid refresh token' }] });
    const store = signedInStore({ expiresAt: 0 });
    const { twitch, events } = make({ fetchImpl, store });
    await expect(twitch.categories('x')).rejects.toMatchObject({ status: 401 });
    expect(store.peek()).toEqual({ clientId: CLIENT });
    const status = await twitch.status();
    expect(status).toMatchObject({ configured: true, signedIn: false });
    expect(status.error).toMatch(/Sign in again/);
    expect(events.at(-1)[0]).toBe('twitch');
  });

  it('keeps the sign-in when Twitch simply can’t be reached', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    const store = signedInStore({ expiresAt: 0 });
    const { twitch } = make({ fetchImpl, store });
    await expect(twitch.categories('x')).rejects.toMatchObject({ status: 502 });
    expect(store.peek().refreshToken).toBe('refresh-1');
  });
});

describe('watching the stream', () => {
  const liveStream = (viewers, started_at) => ({ data: [{ viewer_count: viewers, started_at, title: 'Hi', game_id: '1', game_name: 'G', thumbnail_url: 'u_{width}x{height}' }] });
  let viewers;
  let startedAt;
  let offline;
  let fetchImpl;

  beforeEach(() => {
    vi.useFakeTimers();
    viewers = 10;
    startedAt = '2026-10-20T10:00:00Z';
    offline = false;
    fetchImpl = fakeTwitch({
      'GET id.twitch.tv/oauth2/validate': [200, { login: 'uncle', user_id: '99' }],
      'GET api.twitch.tv/helix/streams': () => [200, offline ? { data: [] } : liveStream(viewers, startedAt)],
      'GET api.twitch.tv/helix/channels': [200, { data: [{ title: 'Hi', game_id: '1', game_name: 'G' }] }],
      'GET api.twitch.tv/helix/channels/followers': [200, { total: 5, data: [{ user_name: 'Ann' }] }],
      'GET api.twitch.tv/helix/subscriptions': [400, { message: 'not an affiliate' }],
    });
  });
  afterEach(() => vi.useRealTimers());

  const streamCalls = () => fetchImpl.calls.filter((c) => c.key === 'GET api.twitch.tv/helix/streams');
  const make2 = (extra) => make({ fetchImpl, store: signedInStore({ expiresAt: Date.now() + 86_400_000 }), ...extra });

  it('reads right away, then every 30 seconds, and pushes each reading', async () => {
    const { twitch, events } = make2();
    await twitch.watch('w1');
    await vi.advanceTimersByTimeAsync(0);
    expect(streamCalls()).toHaveLength(1);
    expect(events.filter((e) => e[0] === 'twitchstream')).toHaveLength(1);
    expect(events.at(-1)[1]).toMatchObject({ live: true, viewers: 10, followers: 5, subs: null, latestFollowers: ['Ann'], samples: [10] });
    viewers = 14;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(streamCalls()).toHaveLength(2);
    expect(events.at(-1)[1].samples).toEqual([10, 14]);
    twitch.close();
  });

  it('asks Twitch for the signed-in channel only', async () => {
    const { twitch } = make2();
    await twitch.watch('w1');
    await vi.advanceTimersByTimeAsync(0);
    expect(streamCalls()[0].query.get('user_id')).toBe('99');
    const followers = fetchImpl.calls.find((c) => c.key.endsWith('/channels/followers'));
    expect(followers.query.get('broadcaster_id')).toBe('99');
    expect(followers.query.get('first')).toBe('5');
    twitch.close();
  });

  it('runs one timer however many widgets watch, and none once they’re all gone', async () => {
    const { twitch } = make2();
    expect(vi.getTimerCount()).toBe(0);
    await twitch.watch('w1');
    await twitch.watch('w2');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    expect(streamCalls()).toHaveLength(1);
    twitch.unwatch('w1');
    expect(vi.getTimerCount()).toBe(1);
    twitch.unwatch('w2');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5 * POLL_MS);
    expect(streamCalls()).toHaveLength(1);
  });

  it('gives up on a widget that stops checking in', async () => {
    const { twitch } = make2();
    await twitch.watch('gone');
    await vi.advanceTimersByTimeAsync(LEASE_MS + POLL_MS);
    expect(vi.getTimerCount()).toBe(0);
    const calls = streamCalls().length;
    await vi.advanceTimersByTimeAsync(5 * POLL_MS);
    expect(streamCalls()).toHaveLength(calls);
  });

  it('keeps going for a widget that keeps checking in', async () => {
    const { twitch } = make2();
    await twitch.watch('here');
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await twitch.watch('here');
    }
    expect(vi.getTimerCount()).toBe(1);
    expect(streamCalls().length).toBeGreaterThanOrEqual(6);
    twitch.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does nothing for a widget when nobody is signed in', async () => {
    const { twitch } = make({ fetchImpl, store: memoryStore({ clientId: CLIENT }) });
    expect(await twitch.watch('w1')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('stops everything on sign-out', async () => {
    fetchImpl = fakeTwitch({
      'GET id.twitch.tv/oauth2/validate': [200, { login: 'uncle', user_id: '99' }],
      'GET api.twitch.tv/helix/streams': [200, { data: [] }],
      'GET api.twitch.tv/helix/channels': [200, { data: [] }],
      'GET api.twitch.tv/helix/channels/followers': [200, { total: 0, data: [] }],
      'GET api.twitch.tv/helix/subscriptions': [200, { total: 0, data: [] }],
      'POST id.twitch.tv/oauth2/revoke': [200, {}],
    });
    const store = signedInStore({ expiresAt: Date.now() + 86_400_000 });
    const { twitch } = make({ fetchImpl, store });
    await twitch.watch('w1');
    await vi.advanceTimersByTimeAsync(0);
    await twitch.signOut();
    expect(vi.getTimerCount()).toBe(0);
    expect(store.peek()).toEqual({ clientId: CLIENT });
    const revoke = fetchImpl.calls.find((c) => c.key.endsWith('/revoke'));
    expect(revoke.params.get('token')).toBe('access-1');
    expect((await twitch.status()).signedIn).toBe(false);
  });

  it('checks the token against Twitch about once an hour while a widget watches', async () => {
    const { twitch } = make2();
    await twitch.watch('w1');
    await vi.advanceTimersByTimeAsync(0);
    const validates = () => fetchImpl.calls.filter((c) => c.key.endsWith('/validate')).length;
    expect(validates()).toBe(1);
    for (let i = 0; i < 110; i++) {
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await twitch.watch('w1');
    }
    expect(validates()).toBe(1); // 55 minutes in
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await twitch.watch('w1');
    }
    expect(validates()).toBe(2); // Just over the hour.
    twitch.close();
  });

  it('starts the sample line over when a new stream begins, and empties it when the stream ends', async () => {
    const { twitch, events } = make2();
    await twitch.watch('w1');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(events.at(-1)[1].samples).toEqual([10, 10]);
    startedAt = '2026-10-20T12:00:00Z';
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(events.at(-1)[1].samples).toEqual([10]);
    offline = true;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(events.at(-1)[1]).toMatchObject({ live: false, samples: [] });
    twitch.close();
  });
});

describe('changing the stream', () => {
  const channelRoutes = (patch) => ({
    'GET id.twitch.tv/oauth2/validate': [200, { login: 'uncle', user_id: '99' }],
    'PATCH api.twitch.tv/helix/channels': patch,
    'GET api.twitch.tv/helix/streams': [200, { data: [] }],
    'GET api.twitch.tv/helix/channels': [200, { data: [{ title: 'New title', game_id: '5', game_name: 'Five' }] }],
    'GET api.twitch.tv/helix/channels/followers': [200, { total: 1, data: [] }],
    'GET api.twitch.tv/helix/subscriptions': [200, { total: 0, data: [] }],
  });
  const store = () => signedInStore({ expiresAt: Date.now() + 86_400_000 });

  it('sends the cleaned title and category, then returns the fresh snapshot', async () => {
    const fetchImpl = fakeTwitch(channelRoutes([204, {}]));
    const { twitch } = make({ fetchImpl, store: store() });
    const snap = await twitch.updateChannel({ title: '  New   title ', gameId: '5' });
    const patch = fetchImpl.calls.find((c) => c.key === 'PATCH api.twitch.tv/helix/channels');
    expect(patch.query.get('broadcaster_id')).toBe('99');
    expect(JSON.parse(patch.body)).toEqual({ title: 'New title', game_id: '5' });
    expect(snap).toMatchObject({ title: 'New title', game: { id: '5', name: 'Five' } });
  });

  it('can change only the title', async () => {
    const fetchImpl = fakeTwitch(channelRoutes([204, {}]));
    const { twitch } = make({ fetchImpl, store: store() });
    await twitch.updateChannel({ title: 'Only this' });
    expect(JSON.parse(fetchImpl.calls.find((c) => c.key.startsWith('PATCH')).body)).toEqual({ title: 'Only this' });
  });

  it('turns away a bad title or category without calling Twitch', async () => {
    const fetchImpl = fakeTwitch(channelRoutes([204, {}]));
    const { twitch } = make({ fetchImpl, store: store() });
    await expect(twitch.updateChannel({ title: 'x'.repeat(141) })).rejects.toMatchObject({ status: 400 });
    await expect(twitch.updateChannel({ title: '' })).rejects.toMatchObject({ status: 400 });
    await expect(twitch.updateChannel({ gameId: 'abc' })).rejects.toMatchObject({ status: 400 });
    await expect(twitch.updateChannel({})).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('passes on Twitch’s own words when it refuses', async () => {
    const fetchImpl = fakeTwitch(channelRoutes([400, { message: 'title contains banned words' }]));
    const { twitch } = make({ fetchImpl, store: store() });
    await expect(twitch.updateChannel({ title: 'Hi' })).rejects.toThrow(/banned words/);
  });

  it('needs a sign-in', async () => {
    const { twitch } = make({ fetchImpl: fakeTwitch({}), store: memoryStore({ clientId: CLIENT }) });
    await expect(twitch.updateChannel({ title: 'Hi' })).rejects.toMatchObject({ status: 401 });
  });
});

describe('the stream key', () => {
  const store = () => signedInStore({ expiresAt: Date.now() + 86_400_000 });

  it('reads the key for the signed-in channel', async () => {
    const fetchImpl = fakeTwitch({ 'GET api.twitch.tv/helix/streams/key': [200, { data: [{ stream_key: 'live_99_abcdefghij' }] }] });
    const { twitch } = make({ fetchImpl, store: store() });
    expect(await twitch.streamKey()).toBe('live_99_abcdefghij');
    expect(fetchImpl.calls[0].query.get('broadcaster_id')).toBe('99');
  });

  it('says to sign in again when the sign-in predates the scope', async () => {
    const fetchImpl = fakeTwitch({
      'GET api.twitch.tv/helix/streams/key': [401, { message: 'Missing scope: channel:read:stream_key' }],
      'POST id.twitch.tv/oauth2/token': [200, { access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }],
    });
    const { twitch } = make({ fetchImpl, store: store() });
    await expect(twitch.streamKey()).rejects.toMatchObject({ code: 'needs-signin', status: 409 });
    const forbidden = fakeTwitch({ 'GET api.twitch.tv/helix/streams/key': [403, {}] });
    await expect(make({ fetchImpl: forbidden, store: store() }).twitch.streamKey()).rejects.toMatchObject({ code: 'needs-signin' });
  });

  it('needs a sign-in at all', async () => {
    const { twitch } = make({ fetchImpl: fakeTwitch({}) });
    await expect(twitch.streamKey()).rejects.toMatchObject({ code: 'not-signed-in', status: 401 });
  });

  it('does not pass on an empty answer', async () => {
    const fetchImpl = fakeTwitch({ 'GET api.twitch.tv/helix/streams/key': [200, { data: [] }] });
    await expect(make({ fetchImpl, store: store() }).twitch.streamKey()).rejects.toMatchObject({ status: 502 });
  });
});

describe('the client ID', () => {
  it('takes a client ID and refuses nonsense', async () => {
    const { twitch, store } = make({ fetchImpl: fakeTwitch({}), store: memoryStore() });
    await twitch.setClientId(` ${CLIENT} `);
    expect(store.peek()).toEqual({ clientId: CLIENT });
    expect((await twitch.status()).configured).toBe(true);
    await expect(twitch.setClientId('not an id!')).rejects.toMatchObject({ status: 400 });
  });

  it('signs out when the client ID changes, since the tokens belong to the old one', async () => {
    const fetchImpl = fakeTwitch({ 'POST id.twitch.tv/oauth2/revoke': [200, {}] });
    const store = signedInStore();
    const { twitch } = make({ fetchImpl, store });
    await twitch.setClientId('0123456789abcdefghij0123456789');
    expect(store.peek()).toEqual({ clientId: '0123456789abcdefghij0123456789' });
    expect((await twitch.status()).signedIn).toBe(false);
  });
});

describe('the routes', () => {
  function request(twitch, method, pathname, body, local = true) {
    return new Promise((resolve) => {
      const t = createTwitch({
        broadcastEvent: () => {},
        sendJson: (_res, status, json) => resolve({ status, json }),
        isLocal: () => local,
        readJson: async () => body ?? {},
        dataDir: '',
        fetchImpl: twitch.fetchImpl,
        store: twitch.store,
      });
      void t.handle({ method }, {}, new URL(`http://localhost${pathname}`));
    });
  }

  it('answers this PC only', async () => {
    const out = await request({ fetchImpl: fakeTwitch({}), store: memoryStore() }, 'GET', '/api/twitch/status', null, false);
    expect(out.status).toBe(403);
  });

  it('reports the status, and takes a client ID', async () => {
    const env = { fetchImpl: fakeTwitch({}), store: memoryStore() };
    expect((await request(env, 'GET', '/api/twitch/status')).json).toMatchObject({ configured: false, signedIn: false });
    const set = await request(env, 'POST', '/api/twitch/client', { clientId: CLIENT });
    expect(set.json).toMatchObject({ configured: true });
    expect((await request(env, 'POST', '/api/twitch/client', { clientId: '!' })).status).toBe(400);
    expect((await request(env, 'GET', '/api/twitch/nothing')).status).toBe(404);
    expect((await request(env, 'DELETE', '/api/twitch/status')).status).toBe(405);
  });
});
