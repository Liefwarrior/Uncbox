// Twitch sign-in and the live stream info for the Twitch widget. Chat stays anonymous and
// separate (src/twitch.ts); this is for the streamer's own channel: how it is doing, and changing
// its title and category.
//
// Sign-in is Twitch's Device Code flow with a public client: you paste a client ID from
// dev.twitch.tv/console (no secret), get a short code, and type it at twitch.tv/activate. No
// redirect is needed. The client ID and the tokens live only in data/twitch.json on this PC: the
// page is never sent a token, only whether you're signed in and as whom.
//
//   GET  /api/twitch/status       { configured, signedIn, signingIn, login, displayName, error }
//   POST /api/twitch/client       { clientId }   ('' forgets it)
//   POST /api/twitch/signin       → { userCode, verificationUri, expiresIn }; the answer comes as a "twitch" event
//   POST /api/twitch/signout      revokes the tokens
//   POST /api/twitch/watch        { id } → the latest snapshot; call again every ~30 s while a widget is shown
//   POST /api/twitch/unwatch      { id }
//   POST /api/twitch/channel      { title?, gameId? } changes the stream's title and/or category
//   GET  /api/twitch/categories   ?q= → [{ id, name, boxArt }]
//
// While a widget watches, the stream is read every 30 s and pushed as a "twitchstream" event.
// With nobody watching, nothing runs. Everything here is for this PC only.

import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from './datafile.mjs';

const ID_URL = 'https://id.twitch.tv/oauth2';
const HELIX = 'https://api.twitch.tv/helix';

export const SCOPES = 'channel:manage:broadcast moderator:read:followers channel:read:subscriptions bits:read channel:read:stream_key';
export const POLL_MS = 30_000;
/** A widget that hasn't checked in for this long is taken to be gone (closed window, crash). */
export const LEASE_MS = 90_000;
export const TITLE_MAX = 140;
const REFRESH_EARLY_MS = 5 * 60_000;
/** Twitch asks apps with a session to check their token hourly. */
const VALIDATE_EVERY_MS = 60 * 60_000;
const MAX_SAMPLES = 720;
const CLIENT_ID = /^[A-Za-z0-9]{20,50}$/;

// ---- pure pieces, exported for the tests ----

/** A stream title Twitch will take: { ok: true, title } cleaned up, or { ok: false, error }. */
export function validateTitle(input) {
  if (typeof input !== 'string') return { ok: false, error: 'The title has to be text.' };
  const title = input.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!title) return { ok: false, error: 'Give the stream a title.' };
  const length = [...title].length;
  if (length > TITLE_MAX) return { ok: false, error: `Titles can be up to ${TITLE_MAX} characters. This one is ${length}.` };
  return { ok: true, title };
}

/**
 * What Twitch's token endpoint said while we wait for the code to be entered:
 * success (with tokens), pending, slow (poll less often), expired, denied or error.
 */
export function classifyTokenResponse(status, body, now = Date.now()) {
  if (status === 200 && body?.access_token) return { kind: 'success', tokens: tokensFrom(body, now) };
  const said = String(body?.message ?? body?.error ?? '').toLowerCase();
  if (said.includes('authorization_pending')) return { kind: 'pending' };
  if (said.includes('slow_down')) return { kind: 'slow' };
  if (said.includes('expired_token') || said.includes('invalid device code')) return { kind: 'expired' };
  if (said.includes('access_denied')) return { kind: 'denied' };
  return { kind: 'error', message: said || `status ${status}` };
}

function tokensFrom(body, now) {
  return {
    accessToken: String(body.access_token),
    refreshToken: String(body.refresh_token ?? ''),
    expiresAt: now + (Number(body.expires_in) || 3600) * 1000,
  };
}

const thumbnail = (url) => (typeof url === 'string' ? url.replace('{width}', '440').replace('{height}', '248') : '');
const boxArt = (url) => (typeof url === 'string' ? url.replace('{width}', '52').replace('{height}', '72') : '');
const count = (n) => (Number.isFinite(n) ? n : null);

/**
 * Twitch's answers (each the parsed JSON, or null when it wasn't available) → what the widget
 * shows. The channel's own title and category win over the stream's, which can lag a minute
 * behind an edit. A missing followers or subscriptions answer (not an affiliate, scope not
 * granted) is a null count, not a zero.
 */
export function reduceSnapshot({ stream, channel, followers, subs }) {
  const s = stream?.data?.[0];
  const c = channel?.data?.[0];
  const live = Boolean(s);
  return {
    live,
    viewers: live ? Number(s.viewer_count) || 0 : 0,
    startedAt: live ? Date.parse(s.started_at) || 0 : 0,
    title: String(c?.title ?? s?.title ?? ''),
    game: { id: String(c?.game_id ?? s?.game_id ?? ''), name: String(c?.game_name ?? s?.game_name ?? '') },
    thumbnail: live ? thumbnail(s.thumbnail_url) : '',
    followers: count(followers?.total),
    subs: count(subs?.total),
    latestFollowers: (followers?.data ?? []).map((f) => String(f.user_name ?? f.user_login ?? '')).filter(Boolean).slice(0, 5),
  };
}

/** Twitch's error in plain words. */
function problem(status, message = '') {
  if (status === 401) return 'Twitch signed you out. Sign in again.';
  if (status === 403) return 'Twitch says this account isn’t allowed to do that.';
  if (status === 429) return 'Twitch asks you to slow down. Try again in a moment.';
  if (status >= 500) return 'Twitch is having trouble right now. Try again in a minute.';
  const said = String(message).trim().slice(0, 200);
  return said ? `Twitch said no: ${said}` : `Twitch said no (${status}).`;
}

const fail = (status, message) => Object.assign(new Error(message), { status });

// ---- where it's kept: one small JSON file in the data folder ----

export function createTwitchStore(dataDir) {
  const file = path.join(dataDir, 'twitch.json');
  return {
    async get() {
      try {
        const saved = JSON.parse(await readFile(file, 'utf8'));
        return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
      } catch {
        return {};
      }
    },
    async set(data) {
      await writeJsonAtomic(file, data, { mode: 0o600 });
    },
    async clear() {
      await unlink(file).catch((err) => {
        if (err.code !== 'ENOENT') throw err;
      });
    },
  };
}

// ---- the feature ----

/** `fetchImpl`, `store` and `now` are only swapped out by the tests. */
export function createTwitch({
  broadcastEvent,
  sendJson,
  isLocal,
  readJson,
  dataDir,
  fetchImpl = (...args) => fetch(...args),
  store = createTwitchStore(dataDir),
  now = () => Date.now(),
}) {
  let data = null; // { clientId, accessToken, refreshToken, expiresAt, userId, login, displayName }
  let loading = null;
  let flow = null; // The sign-in waiting for its code: { deviceCode, interval, endsAt, timer }
  let lastError = '';
  let lastValidated = 0;
  let saveChain = Promise.resolve();

  const load = () => (loading ??= store.get().then((d) => (data = d)));
  const save = () => (saveChain = saveChain.then(() => store.set(data)));

  const signedIn = () => Boolean(data?.refreshToken && data?.userId);
  const status = async () => {
    await load();
    return {
      configured: Boolean(data.clientId),
      signedIn: signedIn(),
      signingIn: Boolean(flow),
      login: signedIn() ? data.login ?? '' : '',
      displayName: signedIn() ? data.displayName || data.login || '' : '',
      error: lastError,
    };
  };
  const announce = async () => broadcastEvent('twitch', await status());

  async function form(url, fields) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  // ---- sign-in (device code flow) ----

  function cancelFlow() {
    if (flow?.timer) clearTimeout(flow.timer);
    flow = null;
  }

  async function startSignIn() {
    await load();
    if (!data.clientId) throw fail(409, 'Add your Twitch client ID first.');
    cancelFlow();
    lastError = '';
    let res;
    try {
      res = await form(`${ID_URL}/device`, { client_id: data.clientId, scopes: SCOPES });
    } catch {
      throw fail(502, 'Couldn’t reach Twitch. Check your internet connection.');
    }
    if (res.status !== 200 || !res.body.device_code) {
      throw fail(502, res.status === 400 || res.status === 401 ? 'Twitch doesn’t accept that client ID. Check it in the Twitch console.' : problem(res.status, res.body.message));
    }
    const mine = {
      deviceCode: String(res.body.device_code),
      interval: Math.max(1, Number(res.body.interval) || 5),
      endsAt: now() + (Number(res.body.expires_in) || 1800) * 1000,
      timer: null,
    };
    flow = mine;
    waitThenPoll(mine);
    return {
      userCode: String(res.body.user_code),
      verificationUri: String(res.body.verification_uri || 'https://www.twitch.tv/activate'),
      expiresIn: Number(res.body.expires_in) || 1800,
    };
  }

  const waitThenPoll = (f) => (f.timer = setTimeout(() => void pollForCode(f), f.interval * 1000));

  async function endFlow(f, message) {
    if (flow !== f) return;
    flow = null;
    lastError = message;
    await announce();
  }

  async function pollForCode(f) {
    f.timer = null;
    if (flow !== f) return;
    if (now() >= f.endsAt) return endFlow(f, 'That code ran out. Click Sign in for a new one.');
    let res;
    try {
      res = await form(`${ID_URL}/token`, {
        client_id: data.clientId,
        scopes: SCOPES,
        device_code: f.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
    } catch {
      // A hiccup in the connection; the code is still good, so try again.
      if (flow === f) waitThenPoll(f);
      return;
    }
    if (flow !== f) return;
    const answer = classifyTokenResponse(res.status, res.body, now());
    switch (answer.kind) {
      case 'pending':
        return waitThenPoll(f);
      case 'slow':
        f.interval += 5;
        return waitThenPoll(f);
      case 'expired':
        return endFlow(f, 'That code ran out. Click Sign in for a new one.');
      case 'denied':
        return endFlow(f, 'Sign-in was cancelled on Twitch.');
      case 'error':
        return endFlow(f, `Twitch said no: ${answer.message.slice(0, 120)}`);
      case 'success':
        return finishSignIn(f, answer.tokens);
    }
  }

  async function finishSignIn(f, tokens) {
    try {
      const who = await validate(tokens.accessToken);
      if (!who) throw new Error('rejected');
      const next = { clientId: data.clientId, ...tokens, userId: who.user_id, login: who.login, displayName: who.login };
      data = next;
      lastValidated = now();
      data.displayName = (await displayNameOf(who.user_id, tokens.accessToken)) || who.login;
      await save();
    } catch {
      return endFlow(f, 'Signed in, but Twitch wouldn’t say who you are. Try again.');
    }
    flow = null;
    lastError = '';
    await announce();
    if (leases.size) startPolling();
  }

  async function validate(token) {
    const res = await fetchImpl(`${ID_URL}/validate`, { headers: { Authorization: `OAuth ${token}` }, signal: AbortSignal.timeout(15_000) });
    return res.ok ? res.json() : null;
  }

  async function displayNameOf(userId, token) {
    try {
      const res = await fetchImpl(`${HELIX}/users?id=${userId}`, {
        headers: { Authorization: `Bearer ${token}`, 'Client-Id': data.clientId },
        signal: AbortSignal.timeout(15_000),
      });
      return res.ok ? (await res.json()).data?.[0]?.display_name : '';
    } catch {
      return '';
    }
  }

  // ---- tokens ----

  let refreshing = null;
  /** One refresh at a time: refresh tokens work once, so two at once would lose the second. */
  const refresh = () => (refreshing ??= doRefresh().finally(() => (refreshing = null)));

  async function doRefresh() {
    await load();
    let res;
    try {
      res = await form(`${ID_URL}/token`, { grant_type: 'refresh_token', refresh_token: data.refreshToken, client_id: data.clientId });
    } catch {
      throw fail(502, 'Couldn’t reach Twitch. Check your internet connection.');
    }
    if (res.status === 200 && res.body.access_token && res.body.refresh_token) {
      // A new refresh token every time; the old one no longer works.
      data = { ...data, ...tokensFrom(res.body, now()) };
      await save();
      return data.accessToken;
    }
    if (res.status === 400 || res.status === 401) {
      await dropTokens('Twitch signed you out. Sign in again.');
      throw fail(401, 'Twitch signed you out. Sign in again.');
    }
    throw fail(502, problem(res.status, res.body.message));
  }

  /** Forget the sign-in (not the client ID). */
  async function dropTokens(message = '') {
    data = { clientId: data.clientId };
    lastError = message;
    snapshot = null;
    samples = [];
    stopPolling();
    await save();
    await announce();
  }

  async function accessToken() {
    await load();
    if (!signedIn()) throw fail(401, 'Sign in to Twitch first.');
    return data.expiresAt - now() > REFRESH_EARLY_MS ? data.accessToken : refresh();
  }

  async function helix(pathAndQuery, init = {}, retried = false) {
    const token = await accessToken();
    const res = await fetchImpl(`${HELIX}${pathAndQuery}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Client-Id': data.clientId, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 && !retried) {
      // The token died early (revoked, or the clock is off): one fresh one, then give up.
      data = { ...data, expiresAt: 0 };
      await refresh();
      return helix(pathAndQuery, init, true);
    }
    return res;
  }

  /** The answer's JSON, or null when Twitch said no (a missing scope or not being an affiliate is fine). */
  async function helixJson(pathAndQuery, { required = false } = {}) {
    const res = await helix(pathAndQuery);
    if (res.ok) return res.json();
    if (required) throw fail(502, problem(res.status, (await res.json().catch(() => ({}))).message));
    return null;
  }

  /** Twitch wants a token checked every hour while a session lasts; this rides along with the polling. */
  async function checkToken() {
    if (now() - lastValidated < VALIDATE_EVERY_MS) return;
    const token = await accessToken();
    let who;
    try {
      who = await validate(token);
    } catch {
      return; // Offline; check again next time.
    }
    if (who) {
      lastValidated = now();
      return;
    }
    data = { ...data, expiresAt: 0 };
    await refresh(); // Signs us out if the refresh token is no good either.
    lastValidated = now();
  }

  // ---- the live stream ----

  let snapshot = null;
  let samples = [];
  let sampleStart = 0;
  let inflight = null;
  const leases = new Map(); // widget id → when it last checked in
  let timer = null;

  function addSample(reduced) {
    if (!reduced.live) {
      samples = [];
      sampleStart = 0;
      return;
    }
    if (reduced.startedAt !== sampleStart) {
      samples = [];
      sampleStart = reduced.startedAt;
    }
    samples.push(reduced.viewers);
    if (samples.length > MAX_SAMPLES) samples.shift();
  }

  async function readStream() {
    const id = encodeURIComponent(data.userId);
    const [stream, channel, followers, subs] = await Promise.all([
      helixJson(`/streams?user_id=${id}`, { required: true }),
      helixJson(`/channels?broadcaster_id=${id}`),
      helixJson(`/channels/followers?broadcaster_id=${id}&first=5`),
      helixJson(`/subscriptions?broadcaster_id=${id}&first=1`),
    ]);
    const reduced = reduceSnapshot({ stream, channel, followers, subs });
    addSample(reduced);
    return { ...reduced, samples: [...samples], updatedAt: now() };
  }

  /** Reads the stream once now (sharing a read already under way) and pushes it. */
  function poll() {
    inflight ??= (async () => {
      try {
        await checkToken();
        snapshot = await readStream();
        broadcastEvent('twitchstream', snapshot);
      } catch (err) {
        if (err.status !== 401) console.warn('Uncbox: reading Twitch failed:', err.message);
      }
    })().finally(() => (inflight = null));
    return inflight;
  }

  function startPolling() {
    if (timer || !signedIn()) return;
    timer = setInterval(() => {
      for (const [id, seen] of leases) if (now() - seen > LEASE_MS) leases.delete(id);
      if (!leases.size) return stopPolling();
      void poll();
    }, POLL_MS);
    timer.unref?.();
    void poll();
  }

  function stopPolling() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** A widget says it is showing (and again every ~30 s). Returns the latest snapshot. */
  async function watch(id) {
    await load();
    leases.set(String(id), now());
    startPolling();
    return snapshot;
  }

  function unwatch(id) {
    leases.delete(String(id));
    if (!leases.size) stopPolling();
  }

  // ---- changing the stream ----

  async function updateChannel({ title, gameId } = {}) {
    const body = {};
    if (title !== undefined) {
      const v = validateTitle(title);
      if (!v.ok) throw fail(400, v.error);
      body.title = v.title;
    }
    if (gameId !== undefined) {
      if (!/^\d{1,12}$/.test(String(gameId))) throw fail(400, 'Pick a category from the list.');
      body.game_id = String(gameId);
    }
    if (!Object.keys(body).length) throw fail(400, 'There’s nothing to save.');
    await load();
    if (!signedIn()) throw fail(401, 'Sign in to Twitch first.');
    let res;
    try {
      res = await helix(`/channels?broadcaster_id=${encodeURIComponent(data.userId)}`, { method: 'PATCH', body: JSON.stringify(body) });
    } catch (err) {
      throw err.status ? err : fail(502, 'Couldn’t reach Twitch. Check your internet connection.');
    }
    if (!res.ok) throw fail(res.status === 400 ? 400 : 502, problem(res.status, (await res.json().catch(() => ({}))).message));
    await poll();
    return snapshot;
  }

  async function categories(query) {
    const q = String(query ?? '').trim().slice(0, 100);
    if (!q) return [];
    const res = await helix(`/search/categories?query=${encodeURIComponent(q)}&first=8`);
    if (!res.ok) throw fail(502, problem(res.status, (await res.json().catch(() => ({}))).message));
    const found = await res.json();
    return (found.data ?? []).map((g) => ({ id: String(g.id), name: String(g.name), boxArt: boxArt(g.box_art_url) }));
  }

  // ---- the stream key (for streaming from Uncbox, server/stream.mjs) ----

  /**
   * The channel's stream key. Sign-ins made before the scope existed can't read it: Twitch answers
   * with a missing scope, which is reported as code 'needs-signin'. The key itself is only ever
   * returned to the caller, never kept here.
   */
  async function streamKey() {
    await load();
    if (!signedIn()) throw Object.assign(fail(401, 'Sign in to Twitch first.'), { code: 'not-signed-in' });
    let res;
    try {
      res = await helix(`/streams/key?broadcaster_id=${encodeURIComponent(data.userId)}`);
    } catch (err) {
      throw err.status ? err : fail(502, 'Couldn’t reach Twitch. Check your internet connection.');
    }
    if (res.status === 401 || res.status === 403) throw Object.assign(fail(409, 'Sign in to Twitch again so Uncbox can read your stream key.'), { code: 'needs-signin' });
    if (!res.ok) throw fail(502, problem(res.status, (await res.json().catch(() => ({}))).message));
    const key = (await res.json().catch(() => ({}))).data?.[0]?.stream_key;
    if (typeof key !== 'string' || !key) throw fail(502, 'Twitch didn’t give a stream key.');
    return key;
  }

  // ---- signing out and the client ID ----

  async function signOut() {
    await load();
    cancelFlow();
    if (data.accessToken && data.clientId) {
      // Best effort: if Twitch can't be reached the tokens are dropped here regardless.
      await form(`${ID_URL}/revoke`, { client_id: data.clientId, token: data.accessToken }).catch(() => {});
    }
    await dropTokens();
  }

  async function setClientId(raw) {
    await load();
    const clientId = String(raw ?? '').trim();
    if (clientId && !CLIENT_ID.test(clientId)) throw fail(400, 'That doesn’t look like a client ID. It’s about 30 letters and numbers.');
    if (clientId === data.clientId) return;
    if (data.accessToken) await signOut();
    cancelFlow();
    data = { clientId };
    lastError = '';
    await save();
    await announce();
  }

  /** Stops every timer; only the tests need this. */
  function close() {
    stopPolling();
    cancelFlow();
    leases.clear();
  }

  // ---- routes ----

  async function handle(req, res, url) {
    if (!isLocal(req)) return sendJson(res, 403, { error: 'This PC only' });
    try {
      const route = url.pathname.slice('/api/twitch'.length);
      if (req.method === 'GET') {
        if (route === '/status') return sendJson(res, 200, await status());
        if (route === '/categories') return sendJson(res, 200, { categories: await categories(url.searchParams.get('q')) });
        return sendJson(res, 404, { error: 'Not found' });
      }
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      const body = await readJson(req);
      if (route === '/client') {
        await setClientId(body.clientId);
        return sendJson(res, 200, await status());
      }
      if (route === '/signin') return sendJson(res, 200, await startSignIn());
      if (route === '/signout') {
        await signOut();
        return sendJson(res, 200, await status());
      }
      if (route === '/watch') return sendJson(res, 200, { snapshot: await watch(body.id) });
      if (route === '/unwatch') {
        unwatch(body.id);
        return sendJson(res, 200, { ok: true });
      }
      if (route === '/channel') return sendJson(res, 200, { snapshot: await updateChannel(body) });
      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.status ? err.message : 'Twitch error' });
    }
  }

  return { handle, status, startSignIn, signOut, setClientId, watch, unwatch, updateChannel, categories, streamKey, close };
}
