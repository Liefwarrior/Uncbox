// Google sign-in: PKCE and the consent address, the redirect handling (state checks, what is
// saved and what the page may see), and renewing the access token. Nothing here reaches Google:
// every call goes through a fake fetch.

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GOOGLE_SCOPES, buildAuthUrl, createGoogle, createPkce, emailFromIdToken, redirectUriFor, tokenMayGoTo } from './google.mjs';

const CLIENT_ID = '1234567890-abcdefghijklmnop.apps.googleusercontent.com';
const SECRET = 'GOCSPX-super-secret-value';
const DRIVE = GOOGLE_SCOPES.drive;

const idToken = (email) => `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`;

describe('createPkce', () => {
  it('makes an S256 challenge of the verifier', () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(challenge).not.toContain('=');
  });

  it('matches the example in RFC 7636', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const pkce = createPkce(Buffer.from(verifier, 'base64url'));
    expect(pkce.verifier).toBe(verifier);
    expect(pkce.challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('makes a new verifier each time', () => {
    expect(createPkce().verifier).not.toBe(createPkce().verifier);
  });
});

describe('buildAuthUrl', () => {
  const url = new URL(
    buildAuthUrl({
      clientId: CLIENT_ID,
      redirectUri: redirectUriFor(5170),
      state: 'st',
      challenge: 'ch',
      scopes: ['openid', 'email', ...DRIVE],
    }),
  );
  const q = (k) => url.searchParams.get(k);

  it('goes to Google’s consent page', () => {
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  });

  it('asks for a code with PKCE, a refresh token and incremental scopes', () => {
    expect(q('response_type')).toBe('code');
    expect(q('client_id')).toBe(CLIENT_ID);
    expect(q('state')).toBe('st');
    expect(q('code_challenge')).toBe('ch');
    expect(q('code_challenge_method')).toBe('S256');
    expect(q('access_type')).toBe('offline');
    expect(q('include_granted_scopes')).toBe('true');
    expect(q('scope').split(' ')).toEqual(['openid', 'email', ...DRIVE]);
  });

  it('redirects to plain http on loopback, on the server’s port', () => {
    expect(q('redirect_uri')).toBe('http://127.0.0.1:5170/api/google/callback');
    expect(redirectUriFor(8080)).toBe('http://127.0.0.1:8080/api/google/callback');
  });

  it('never carries the client secret, and only adds a hint when given one', () => {
    expect(url.href).not.toContain(SECRET);
    expect(q('login_hint')).toBeNull();
    const hinted = new URL(buildAuthUrl({ clientId: CLIENT_ID, redirectUri: 'x', state: 's', challenge: 'c', scopes: ['openid'], loginHint: 'a@b.c' }));
    expect(hinted.searchParams.get('login_hint')).toBe('a@b.c');
  });
});

describe('helpers', () => {
  it('reads the email out of an id_token', () => {
    expect(emailFromIdToken(idToken('eli@example.com'))).toBe('eli@example.com');
    expect(emailFromIdToken('nonsense')).toBe('');
    expect(emailFromIdToken(undefined)).toBe('');
  });

  it('only lets the token go to Google’s own hosts over https', () => {
    expect(tokenMayGoTo('https://www.googleapis.com/drive/v3/files')).toBe(true);
    expect(tokenMayGoTo('https://lh3.googleusercontent.com/abc=s220')).toBe(true);
    expect(tokenMayGoTo('http://www.googleapis.com/drive/v3/files')).toBe(false);
    expect(tokenMayGoTo('https://googleapis.com.evil.example/x')).toBe(false);
    expect(tokenMayGoTo('https://evil.example/googleapis.com')).toBe(false);
    expect(tokenMayGoTo('not a url')).toBe(false);
  });
});

// ---- the module, against a fake Google ----

const dirs = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop(), { recursive: true, force: true });
});

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A Google whose answers come from `script`, recording every call. */
async function setup({ script = () => json(200, {}), local = true } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'uncbox-google-'));
  dirs.push(dataDir);
  const calls = [];
  let clock = 1_000_000;
  const fetchImpl = async (url, init = {}) => {
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body;
    calls.push({ url: String(url), body, headers: Object.fromEntries(new Headers(init.headers)) });
    return script(String(url), body, calls);
  };
  const opened = [];
  const events = [];
  const google = createGoogle({
    broadcastEvent: (name, data) => events.push([name, data]),
    sendJson: (res, status, body) => (res.out = { status, body }),
    isLocal: () => local,
    readJson: async (req) => req.body,
    dataDir,
    port: 5170,
    fetchImpl,
    openUrl: (u) => opened.push(u),
    now: () => clock,
  });
  google.requireScopes(DRIVE);
  const call = async (method, pathname, body) => {
    const res = {
      writeHead(status) {
        this.status = status;
      },
      end(html) {
        this.html = html;
      },
    };
    await google.handle({ method, body }, res, new URL(pathname, 'http://127.0.0.1:5170'));
    return res.out ?? { status: res.status, html: res.html };
  };
  return {
    google,
    call,
    calls,
    opened,
    events,
    dataDir,
    tick: (ms) => (clock += ms),
    saved: async () => JSON.parse(await readFile(path.join(dataDir, 'google.json'), 'utf8')),
  };
}

/** Walks through sign-in: saves the client, starts it, and lets Google "redirect back". */
async function signIn(t) {
  await t.call('POST', '/api/google/client', { clientId: CLIENT_ID, clientSecret: SECRET });
  const { body } = await t.call('POST', '/api/google/signin');
  const url = new URL(body.url);
  const out = await t.call('GET', `/api/google/callback?code=abc&state=${url.searchParams.get('state')}`);
  return { url, out };
}

const goodTokens = (extra = {}) => ({
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_in: 3600,
  scope: ['openid', 'email', ...DRIVE].join(' '),
  id_token: idToken('eli@example.com'),
  ...extra,
});

/** Google answering token requests: a renewal gets access-2, anything else the first sign-in. */
const tokenServer = (other = () => json(200, {})) => (url, body) =>
  url.includes('/token') ? json(200, body.grant_type === 'refresh_token' ? { access_token: 'access-2', expires_in: 3600 } : goodTokens()) : other(url, body);

describe('client and status', () => {
  it('starts unconfigured', async () => {
    const t = await setup();
    expect((await t.call('GET', '/api/google/status')).body).toEqual({ configured: false, signedIn: false, email: '', scopes: [], needsConsent: false });
  });

  it('keeps the client in data/google.json and never sends the secret to the page', async () => {
    const t = await setup();
    const { body } = await t.call('POST', '/api/google/client', { clientId: CLIENT_ID, clientSecret: SECRET });
    expect(body.configured).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(JSON.stringify(body)).not.toContain(CLIENT_ID);
    expect(await t.saved()).toEqual({ clientId: CLIENT_ID, clientSecret: SECRET });
    expect(t.events.at(-1)[0]).toBe('google');
  });

  it('refuses a client ID or secret that is clearly wrong', async () => {
    const t = await setup();
    expect((await t.call('POST', '/api/google/client', { clientId: 'nope', clientSecret: SECRET })).status).toBe(400);
    expect((await t.call('POST', '/api/google/client', { clientId: CLIENT_ID, clientSecret: 'a b' })).status).toBe(400);
    expect((await t.call('POST', '/api/google/client', { clientId: CLIENT_ID })).status).toBe(400);
  });

  it('forgets the client when sent nothing', async () => {
    const t = await setup();
    await t.call('POST', '/api/google/client', { clientId: CLIENT_ID, clientSecret: SECRET });
    const { body } = await t.call('POST', '/api/google/client', { clientId: '', clientSecret: '' });
    expect(body.configured).toBe(false);
    await expect(stat(path.join(t.dataDir, 'google.json'))).rejects.toThrow();
  });

  it('only answers this PC', async () => {
    const t = await setup({ local: false });
    expect((await t.call('GET', '/api/google/status')).status).toBe(403);
    expect((await t.call('GET', '/api/google/callback?code=a&state=b')).status).toBe(403);
  });
});

describe('signing in', () => {
  it('needs a client first', async () => {
    const t = await setup();
    expect((await t.call('POST', '/api/google/signin')).status).toBe(400);
  });

  it('opens Google’s page and hands the same address back to the page', async () => {
    const t = await setup();
    await t.call('POST', '/api/google/client', { clientId: CLIENT_ID, clientSecret: SECRET });
    const { body } = await t.call('POST', '/api/google/signin');
    expect(body.opened).toBe(true);
    expect(t.opened).toEqual([body.url]);
    const url = new URL(body.url);
    expect(url.searchParams.get('scope').split(' ')).toEqual(['openid', 'email', ...DRIVE]);
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5170/api/google/callback');
  });

  it('exchanges the code (with the PKCE verifier), saves the tokens and says so', async () => {
    const t = await setup({ script: tokenServer() });
    const { url, out } = await signIn(t);
    expect(out.status).toBe(200);
    expect(out.html).toMatch(/signed in/);
    const [exchange] = t.calls;
    expect(exchange.url).toBe('https://oauth2.googleapis.com/token');
    expect(exchange.body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'abc',
      client_id: CLIENT_ID,
      client_secret: SECRET,
      redirect_uri: 'http://127.0.0.1:5170/api/google/callback',
    });
    // The verifier hashes to the challenge that went to Google.
    expect(createHash('sha256').update(exchange.body.code_verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
    expect(await t.saved()).toMatchObject({ refreshToken: 'refresh-1', accessToken: 'access-1', email: 'eli@example.com', scopes: ['openid', 'email', ...DRIVE] });
    const status = (await t.call('GET', '/api/google/status')).body;
    expect(status).toMatchObject({ configured: true, signedIn: true, email: 'eli@example.com', needsConsent: false });
    expect(JSON.stringify(status)).not.toMatch(/refresh-1|access-1|GOCSPX/);
    expect(t.events.at(-1)).toEqual(['google', status]);
  });

  it('rejects a redirect whose state it did not make', async () => {
    const t = await setup({ script: tokenServer() });
    await t.call('POST', '/api/google/client', { clientId: CLIENT_ID, clientSecret: SECRET });
    await t.call('POST', '/api/google/signin');
    const out = await t.call('GET', '/api/google/callback?code=abc&state=forged');
    expect(out.status).toBe(400);
    expect(t.calls).toHaveLength(0);
    expect((await t.call('GET', '/api/google/status')).body.signedIn).toBe(false);
  });

  it('accepts each state only once', async () => {
    const t = await setup({ script: tokenServer() });
    const { url } = await signIn(t);
    const again = await t.call('GET', `/api/google/callback?code=abc&state=${url.searchParams.get('state')}`);
    expect(again.status).toBe(400);
    expect(t.calls).toHaveLength(1);
  });

  it('forgets a sign-in that was never finished', async () => {
    const t = await setup({ script: tokenServer() });
    await t.call('POST', '/api/google/client', { clientId: CLIENT_ID, clientSecret: SECRET });
    const { body } = await t.call('POST', '/api/google/signin');
    t.tick(11 * 60_000);
    const out = await t.call('GET', `/api/google/callback?code=abc&state=${new URL(body.url).searchParams.get('state')}`);
    expect(out.status).toBe(400);
  });

  it('says plainly when the person chose not to allow access', async () => {
    const t = await setup();
    await t.call('POST', '/api/google/client', { clientId: CLIENT_ID, clientSecret: SECRET });
    const { body } = await t.call('POST', '/api/google/signin');
    const out = await t.call('GET', `/api/google/callback?error=access_denied&state=${new URL(body.url).searchParams.get('state')}`);
    expect(out.status).toBe(400);
    expect(out.html).toMatch(/chose not to allow/);
  });

  it('shows Google’s refusal of the code without echoing markup', async () => {
    const t = await setup({ script: () => json(400, { error: 'invalid_client', error_description: '<b>The OAuth client was not found.</b>' }) });
    const { out } = await signIn(t);
    expect(out.status).toBe(500);
    expect(out.html).toContain('The OAuth client was not found.');
    expect(out.html).not.toContain('<b>');
  });

  it('flags a sign-in that is missing a scope a widget needs', async () => {
    const t = await setup({ script: () => json(200, goodTokens({ scope: 'openid email' })) });
    await signIn(t);
    expect((await t.call('GET', '/api/google/status')).body.needsConsent).toBe(true);
    expect(await t.google.hasScopes(DRIVE)).toBe(false);
  });

  it('asks for new scopes alongside the old ones', async () => {
    const t = await setup();
    t.google.requireScopes(['https://www.googleapis.com/auth/calendar.readonly']);
    await t.call('POST', '/api/google/client', { clientId: CLIENT_ID, clientSecret: SECRET });
    const { body } = await t.call('POST', '/api/google/signin');
    const url = new URL(body.url);
    expect(url.searchParams.get('scope')).toContain('calendar.readonly');
    expect(url.searchParams.get('scope')).toContain('drive.readonly');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
  });
});

describe('googleFetch', () => {
  const API_URL = 'https://www.googleapis.com/drive/v3/files';
  const bearer = (t) => t.calls.at(-1).headers.authorization;

  it('adds the token', async () => {
    const t = await setup({ script: tokenServer() });
    await signIn(t);
    const res = await t.google.fetch(API_URL);
    expect(res.ok).toBe(true);
    expect(bearer(t)).toBe('Bearer access-1');
  });

  it('refuses when not signed in', async () => {
    const t = await setup();
    await expect(t.google.fetch(API_URL)).rejects.toMatchObject({ status: 401 });
    expect(t.calls).toHaveLength(0);
  });

  it('does not send the token anywhere but Google', async () => {
    const t = await setup({ script: tokenServer() });
    await signIn(t);
    await expect(t.google.fetch('https://evil.example/steal')).rejects.toMatchObject({ status: 400 });
    expect(t.calls).toHaveLength(1);
  });

  it('renews the token once it has expired, keeping the refresh token', async () => {
    const t = await setup({ script: tokenServer() });
    await signIn(t);
    t.tick(30 * 60_000);
    await t.google.fetch(API_URL);
    expect(t.calls.filter((c) => c.body?.grant_type === 'refresh_token')).toHaveLength(0);
    t.tick(31 * 60_000);
    await t.google.fetch(API_URL);
    const renewal = t.calls.find((c) => c.body?.grant_type === 'refresh_token');
    expect(renewal.body).toMatchObject({ refresh_token: 'refresh-1', client_id: CLIENT_ID, client_secret: SECRET });
    expect(bearer(t)).toBe('Bearer access-2');
    expect(await t.saved()).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-1', scopes: ['openid', 'email', ...DRIVE] });
  });

  it('renews a token that is about to run out, not only one that has', async () => {
    const t = await setup({ script: tokenServer() });
    await signIn(t);
    t.tick(3600 * 1000 - 30_000);
    await t.google.fetch(API_URL);
    expect(bearer(t)).toBe('Bearer access-2');
  });

  it('shares one renewal between calls made together', async () => {
    const t = await setup({ script: tokenServer() });
    await signIn(t);
    t.tick(2 * 3600 * 1000);
    await Promise.all([t.google.fetch(API_URL), t.google.fetch(API_URL), t.google.fetch(API_URL)]);
    expect(t.calls.filter((c) => c.body?.grant_type === 'refresh_token')).toHaveLength(1);
  });

  it('renews and retries once when Google answers 401 early', async () => {
    let apiCalls = 0;
    const t = await setup({ script: tokenServer(() => (++apiCalls === 1 ? json(401, {}) : json(200, { ok: true }))) });
    await signIn(t);
    const res = await t.google.fetch(API_URL);
    expect(res.ok).toBe(true);
    expect(bearer(t)).toBe('Bearer access-2');
  });

  it('drops a sign-in Google has ended, but keeps the client', async () => {
    const t = await setup({ script: (url, body) => (body?.grant_type === 'refresh_token' ? json(400, { error: 'invalid_grant' }) : json(200, goodTokens())) });
    await signIn(t);
    t.tick(2 * 3600 * 1000);
    await expect(t.google.fetch(API_URL)).rejects.toMatchObject({ status: 401, message: expect.stringMatching(/sign in again/i) });
    expect(await t.saved()).toEqual({ clientId: CLIENT_ID, clientSecret: SECRET });
    expect((await t.call('GET', '/api/google/status')).body).toMatchObject({ configured: true, signedIn: false });
  });

  it('reports an unreachable Google as such', async () => {
    const t = await setup({ script: tokenServer(() => Promise.reject(new TypeError('fetch failed'))) });
    await signIn(t);
    await expect(t.google.fetch(API_URL)).rejects.toMatchObject({ status: 502 });
  });
});

describe('signing out and replacing the client', () => {
  it('revokes the token at Google and deletes the tokens, keeping the client', async () => {
    const t = await setup({ script: tokenServer() });
    await signIn(t);
    const { body } = await t.call('POST', '/api/google/signout');
    expect(body).toMatchObject({ configured: true, signedIn: false });
    const revoke = t.calls.at(-1);
    expect(revoke.url).toBe('https://oauth2.googleapis.com/revoke');
    expect(revoke.body.token).toBe('refresh-1');
    expect(await t.saved()).toEqual({ clientId: CLIENT_ID, clientSecret: SECRET });
  });

  it('signs out even when Google can’t be reached', async () => {
    let up = true;
    const t = await setup({ script: () => (up ? json(200, goodTokens()) : Promise.reject(new TypeError('offline'))) });
    await signIn(t);
    up = false;
    expect((await t.call('POST', '/api/google/signout')).body.signedIn).toBe(false);
    expect((await t.saved()).refreshToken).toBeUndefined();
  });

  it('signs out of the old client when a new one is saved', async () => {
    const t = await setup({ script: tokenServer() });
    await signIn(t);
    const other = '999999999999-zzzzzzzzzzzz.apps.googleusercontent.com';
    const { body } = await t.call('POST', '/api/google/client', { clientId: other, clientSecret: 'another-secret' });
    expect(body).toMatchObject({ configured: true, signedIn: false });
    expect(await t.saved()).toEqual({ clientId: other, clientSecret: 'another-secret' });
    expect(t.calls.at(-1).url).toBe('https://oauth2.googleapis.com/revoke');
  });
});
