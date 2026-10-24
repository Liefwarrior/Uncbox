// Sign in with Google, for the widgets that read your Google data (Drive, Calendar and Gmail).
// It is Google's "installed app" flow: the browser goes to Google, and Google
// sends the answer back to a plain-http address on this PC (127.0.0.1) with a one-time code. The
// code is exchanged for tokens using PKCE (S256), so a snooped code alone is useless.
//
// You bring your own OAuth client (a "Desktop app" client from Google Cloud Console). The client
// ID, client secret, refresh token and access token all live in data/google.json on this PC. None
// of it is ever sent to the page, which only learns { configured, signedIn, email, scopes }.
//
//   GET  /api/google/status          the page's view of it (also pushed as a "google" event)
//   POST /api/google/client          { clientId, clientSecret } saves (or, empty, forgets) the client
//   POST /api/google/signin          starts sign-in: { url, opened }; the browser is opened for you.
//                                    Optional { scopes: [...] } asks for just those (plus what was granted before)
//   GET  /api/google/callback        Google's redirect lands here, on this server's own port
//   POST /api/google/signout         revokes the token at Google and deletes it here
//
// The redirect is always http://127.0.0.1:<port>/api/google/callback. This server's plain-http
// port is always listening (https://unc.box is a second, extra address), so signing in works
// whether the page is open at localhost or at unc.box. If HOST is set to one LAN address instead
// of loopback, 127.0.0.1 would not reach the server and sign-in can't complete.
//
// Other modules call `google.fetch(url, init)`, which adds the token and refreshes it when it has
// run out, and `google.requireScopes([...])` to say what they need. With no scopes named, sign-in
// asks for the union of everything required; a widget can name its own so that, say, Drive doesn't
// also ask for Gmail. include_granted_scopes means adding a scope later only asks for the new one
// (incremental consent).

import { createHash, randomBytes } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { openInBrowser } from './open.mjs';
import { writeJsonAtomic } from './datafile.mjs';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/** Scopes by feature, so each widget asks only for what it uses. */
export const GOOGLE_SCOPES = {
  base: ['openid', 'email'],
  drive: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file'],
  calendar: ['https://www.googleapis.com/auth/calendar.readonly'],
  // Headers and labels only, never the text of a message.
  gmail: ['https://www.googleapis.com/auth/gmail.metadata'],
};

/** The access token is renewed this long before it runs out. */
const EXPIRY_SLACK_MS = 60_000;
/** A sign-in that isn't finished within this long is forgotten. */
const PENDING_MS = 10 * 60_000;
const CLIENT_ID = /^[A-Za-z0-9._-]{8,200}\.apps\.googleusercontent\.com$/;
/** The token is only ever sent to Google's own API and content hosts. */
const TOKEN_HOSTS = [/(^|\.)googleapis\.com$/, /(^|\.)googleusercontent\.com$/];

const b64url = (buf) => buf.toString('base64url');

/** A PKCE pair: the random verifier and its S256 challenge (RFC 7636). */
export function createPkce(bytes = randomBytes(64)) {
  const verifier = b64url(bytes);
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

/** The Google consent-page address for one sign-in. */
export function buildAuthUrl({ clientId, redirectUri, state, challenge, scopes, loginHint }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    // Adds to what was granted before instead of starting over.
    include_granted_scopes: 'true',
    // Always hands back a refresh token, even when this PC signed in before.
    prompt: 'consent',
  });
  if (loginHint) q.set('login_hint', loginHint);
  return `${AUTH_URL}?${q}`;
}

/** The redirect address Google sends the code to: plain http on loopback, on this server's port. */
export const redirectUriFor = (port) => `http://127.0.0.1:${port}/api/google/callback`;

/** The email in a Google id_token (it came straight from Google over TLS, so it isn't re-verified). */
export function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email : '';
  } catch {
    return '';
  }
}

const hasScopes = (granted, wanted) => wanted.every((s) => granted.includes(s));

/** Whether the token may go to this address: https, and Google's own API or content host. */
export function tokenMayGoTo(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && TOKEN_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width">` +
  `<body style="font:16px system-ui,sans-serif;background:#101219;color:#eef1f6;display:grid;place-items:center;height:100vh;margin:0">` +
  `<main style="text-align:center;max-width:32em;padding:1em"><h1 style="font-size:22px">${title}</h1><p style="color:#949cad">${body}</p></main>`;

const problem = (message, status = 400) => Object.assign(new Error(message), { status });

/**
 * Google's refusal from an API (Calendar, Gmail…) in plain words, with a code the page can act on:
 * signin, api (not turned on in the project), scope (not allowed yet), busy, down or other.
 * `name` is what the person calls it, like "Google Calendar".
 */
export function apiProblem(status, body = {}, name = 'Google') {
  const err = body.error ?? {};
  const reason = err.errors?.[0]?.reason || err.details?.[0]?.reason || '';
  if (status === 401) return { status: 401, code: 'signin', error: 'Google needs you to sign in again.' };
  if (reason === 'accessNotConfigured' || reason === 'SERVICE_DISABLED' || /has not been used|is disabled/i.test(err.message ?? '')) {
    return { status: 403, code: 'api', error: `The ${name} API isn’t turned on for your Google project. Turn it on in Google Cloud Console, then try again.` };
  }
  if (reason === 'insufficientPermissions' || reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') {
    return { status: 403, code: 'scope', error: `Uncbox wasn’t allowed to see your ${name}. Sign in again and allow access.` };
  }
  if (status === 429 || (status === 403 && /rate|quota/i.test(`${reason} ${err.message ?? ''}`))) {
    return { status: 429, code: 'busy', error: 'Google says that’s too many requests. Try again in a minute.' };
  }
  if (status >= 500) return { status: 502, code: 'down', error: `${name} is having trouble right now. Try again in a minute.` };
  const said = String(err.message ?? '').trim().slice(0, 200);
  return { status: status === 400 ? 400 : 502, code: 'other', error: said ? `${name} said: ${said}` : `${name} said no (${status}).` };
}

/**
 * @param {object} o
 * @param {number} o.port  the server's own (plain http) port, for the redirect
 * @param {typeof fetch} [o.fetchImpl]  swapped out by the tests
 * @param {(url: string) => void} [o.openUrl]  opens a page in the browser; swapped out by the tests
 * @param {() => number} [o.now]
 */
export function createGoogle({ broadcastEvent, sendJson, isLocal, readJson, dataDir, port, fetchImpl = fetch, openUrl = openInBrowser, now = Date.now }) {
  const file = path.join(dataDir, 'google.json');
  /** @type {{ clientId?: string, clientSecret?: string, refreshToken?: string, accessToken?: string, expiresAt?: number, scopes?: string[], email?: string } | null} */
  let saved = null;
  /** state → { verifier, at } for sign-ins in progress. */
  const pending = new Map();
  const required = new Set(GOOGLE_SCOPES.base);
  let refreshing = null;

  async function load() {
    if (saved) return saved;
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      saved = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
      saved = {};
    }
    return saved;
  }

  async function store(next) {
    saved = next;
    if (!Object.keys(next).length) {
      await unlink(file).catch((err) => {
        if (err.code !== 'ENOENT') throw err;
      });
      return;
    }
    await writeJsonAtomic(file, next, { mode: 0o600, pretty: true });
  }

  /** What the page may know. Never the client secret or any token. */
  async function snapshot() {
    const d = await load();
    const signedIn = Boolean(d.refreshToken);
    const granted = signedIn ? (d.scopes ?? []) : [];
    return {
      configured: Boolean(d.clientId && d.clientSecret),
      signedIn,
      email: signedIn ? (d.email ?? '') : '',
      scopes: granted,
      // Signed in, but a widget added since needs something that wasn't asked for yet.
      needsConsent: signedIn && !hasScopes(granted, [...required]),
    };
  }

  const announce = async () => broadcastEvent('google', await snapshot());

  /** Posts a form to Google's token endpoint; the answer, or a problem with Google's own words. */
  async function tokenCall(params) {
    let res;
    try {
      res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw problem('Couldn’t reach Google. Check your internet connection.', 502);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = problem(body.error_description || body.error || `Google said no (${res.status}).`, res.status === 400 || res.status === 401 ? 401 : 502);
      err.code = body.error;
      throw err;
    }
    return body;
  }

  /** Keeps what a token response carries: the access token and when it runs out. */
  const tokensFrom = (body) => ({ accessToken: body.access_token, expiresAt: now() + (Number(body.expires_in) || 3600) * 1000 });

  async function refresh() {
    const d = await load();
    if (!d.refreshToken || !d.clientId || !d.clientSecret) throw problem('Sign in with Google first.', 401);
    try {
      const body = await tokenCall({
        grant_type: 'refresh_token',
        refresh_token: d.refreshToken,
        client_id: d.clientId,
        client_secret: d.clientSecret,
      });
      // Google leaves the refresh token out of a refresh; the one we have stays good.
      await store({ ...d, ...tokensFrom(body), scopes: body.scope ? body.scope.split(' ') : d.scopes });
    } catch (err) {
      if (err.code === 'invalid_grant') {
        // Revoked, or a "Testing" app's week ran out: the saved sign-in is dead.
        const { refreshToken, accessToken, expiresAt, scopes, email, ...client } = d;
        await store(client);
        void announce();
        throw problem('Google ended this sign-in. Sign in again.', 401);
      }
      throw err;
    }
  }

  /** A usable access token, renewed if it has (nearly) run out. One renewal at a time. */
  async function accessToken(force = false) {
    const d = await load();
    if (!d.refreshToken) throw problem('Sign in with Google first.', 401);
    if (force || !d.accessToken || (d.expiresAt ?? 0) - EXPIRY_SLACK_MS <= now()) {
      refreshing ??= refresh().finally(() => (refreshing = null));
      await refreshing;
    }
    return (await load()).accessToken;
  }

  /**
   * fetch() for Google's APIs with the signed-in token added. Renews an expired token first, and
   * once more if Google answers 401. Throws (with .status) when not signed in.
   */
  async function googleFetch(url, init = {}) {
    if (!tokenMayGoTo(url)) throw problem('That isn’t a Google address.', 400);
    const send = async (force) => {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${await accessToken(force)}`);
      return fetchImpl(url, { signal: AbortSignal.timeout(20_000), ...init, headers });
    };
    let res;
    try {
      res = await send(false);
      if (res.status === 401) res = await send(true);
    } catch (err) {
      if (err.status) throw err;
      throw problem('Couldn’t reach Google. Check your internet connection.', 502);
    }
    return res;
  }

  async function saveClient(body) {
    const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
    const clientSecret = typeof body.clientSecret === 'string' ? body.clientSecret.trim() : '';
    const forget = !clientId && !clientSecret;
    if (!forget && !CLIENT_ID.test(clientId)) throw problem('That doesn’t look like a client ID. It ends in .apps.googleusercontent.com.');
    if (!forget && !/^\S{8,200}$/.test(clientSecret)) throw problem('That doesn’t look like a client secret.');
    // A different client's tokens are no use (and Google would refuse them), so they go.
    await signOutQuietly(await load());
    await store(forget ? {} : { clientId, clientSecret });
    void announce();
    return snapshot();
  }

  async function signOutQuietly(d) {
    const token = d.refreshToken || d.accessToken;
    if (!token) return;
    // Best effort: signing out here must work even when Google can't be reached.
    await fetchImpl(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(8_000),
    }).catch(() => {});
  }

  async function signOut() {
    const d = await load();
    await signOutQuietly(d);
    const { refreshToken, accessToken, expiresAt, scopes, email, ...client } = d;
    await store(client);
    void announce();
    return snapshot();
  }

  /** The scopes sign-in asks for: everything required, or just the ones a widget named (and what it has). */
  function scopesToAsk(d, wanted) {
    const asked = Array.isArray(wanted) ? wanted.filter((s) => required.has(s)) : [];
    if (!asked.length) return [...required];
    const base = [...GOOGLE_SCOPES.base];
    return [...new Set([...base, ...(d.refreshToken ? (d.scopes ?? []).filter((s) => required.has(s)) : []), ...asked])];
  }

  /**
   * Starts a sign-in. A widget names the scopes it wants (`wanted`) so that signing in for Drive
   * doesn't also ask for Calendar and Gmail; what was granted before is kept (incremental consent).
   */
  async function startSignIn({ open = true, wanted } = {}) {
    const d = await load();
    if (!d.clientId || !d.clientSecret) throw problem('Add your Google client first.');
    for (const [state, p] of pending) if (now() - p.at > PENDING_MS) pending.delete(state);
    const state = b64url(randomBytes(24));
    const { verifier, challenge } = createPkce();
    pending.set(state, { verifier, at: now() });
    const url = buildAuthUrl({
      clientId: d.clientId,
      redirectUri: redirectUriFor(port),
      state,
      challenge,
      scopes: scopesToAsk(d, wanted),
      loginHint: d.email,
    });
    let opened = false;
    if (open) {
      try {
        openUrl(url);
        opened = true;
      } catch {
        // The page opens it itself.
      }
    }
    return { url, opened };
  }

  /** Google's redirect: swaps the code for tokens and tells the person, in their browser tab. */
  async function callback(res, url) {
    const html = (status, title, body) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(page(title, body));
    };
    const state = url.searchParams.get('state') ?? '';
    const p = pending.get(state);
    // A state we didn't make, or an old one: not a sign-in this server started.
    if (!p || now() - p.at > PENDING_MS) return html(400, 'That sign-in link has expired', 'Go back to Uncbox and choose Sign in with Google again.');
    pending.delete(state);
    const failure = url.searchParams.get('error');
    if (failure) {
      const said = failure === 'access_denied' ? 'You chose not to allow access.' : 'Google didn’t finish the sign-in.';
      return html(400, 'Not signed in', `${said} You can close this tab and try again in Uncbox.`);
    }
    const code = url.searchParams.get('code');
    if (!code) return html(400, 'Not signed in', 'Google didn’t send a code. Try again from Uncbox.');
    try {
      const d = await load();
      const body = await tokenCall({
        grant_type: 'authorization_code',
        code,
        code_verifier: p.verifier,
        client_id: d.clientId,
        client_secret: d.clientSecret,
        redirect_uri: redirectUriFor(port),
      });
      const next = {
        ...d,
        ...tokensFrom(body),
        refreshToken: body.refresh_token || d.refreshToken,
        scopes: String(body.scope || '').split(' ').filter(Boolean),
        email: emailFromIdToken(body.id_token) || d.email || '',
      };
      if (!next.refreshToken) throw problem('Google didn’t give a lasting sign-in. Try again.');
      await store(next);
      void announce();
      return html(200, 'You’re signed in', 'You can close this tab and go back to Uncbox.');
    } catch (err) {
      return html(500, 'Couldn’t sign in', `${String(err.message).replace(/[<>&]/g, '')} You can close this tab and try again in Uncbox.`);
    }
  }

  async function handle(req, res, url) {
    if (!isLocal(req)) return sendJson(res, 403, { error: 'Run this on the PC Uncbox is on.' });
    const action = url.pathname.slice('/api/google'.length);
    try {
      if (req.method === 'GET' && action === '/status') return sendJson(res, 200, await snapshot());
      if (req.method === 'GET' && action === '/callback') return await callback(res, url);
      if (req.method !== 'POST') return sendJson(res, action === '/status' || action === '/callback' ? 405 : 404, { error: 'Not found' });
      if (action === '/client') return sendJson(res, 200, await saveClient(await readJson(req)));
      if (action === '/signin') {
        // The widget says which scopes it wants; no body (or none that make sense) asks for all.
        const asked = await readJson(req).catch(() => null);
        return sendJson(res, 200, await startSignIn({ wanted: asked?.scopes }));
      }
      if (action === '/signout') return sendJson(res, 200, await signOut());
      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message || 'Google error' });
    }
  }

  return {
    handle,
    snapshot,
    fetch: googleFetch,
    /** Adds scopes sign-in must ask for. Call before anyone signs in. */
    requireScopes(list) {
      for (const s of list) required.add(s);
    },
    /** Whether the saved sign-in covers these scopes. */
    async hasScopes(list) {
      return hasScopes((await load()).scopes ?? [], list);
    },
  };
}
