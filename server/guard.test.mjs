import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { checkRequest, createGuardConfig, guardApi, hostNameOf } from './guard.mjs';
import { createLauncher } from './launcher.mjs';

const config = createGuardConfig({ domains: ['unc.box'], hostname: 'EliPC', interfaces: () => ({}) });
const JSON_TYPE = 'application/json';

/** A request as the guard sees it. */
const req = (headers = {}, method = 'GET', url = '/api/state') => ({ method, url, headers: { host: 'localhost:5170', ...headers } });
const check = (...args) => checkRequest(req(...args), config);

describe('the Host check', () => {
  it('turns away a name that is not ours (DNS rebinding)', () => {
    for (const host of ['evil.example', 'evil.example:5170', 'localhost.evil.example', '127.0.0.1.evil.example:5170', 'unc.box.evil.example']) {
      expect(check({ host })?.status, host).toBe(421);
    }
  });

  it('turns away a missing or odd Host', () => {
    expect(check({ host: undefined })?.status).toBe(421);
    expect(check({ host: '' })?.status).toBe(421);
    expect(check({ host: 'localhost:5170/@evil.example' })?.status).toBe(421);
    expect(check({ host: 'a b' })?.status).toBe(421);
  });

  it('answers at localhost, 127.0.0.1 and ::1, with or without a port', () => {
    for (const host of ['localhost', 'localhost:5170', 'LOCALHOST:5170', '127.0.0.1', '127.0.0.1:5170', '[::1]', '[::1]:5170', 'localhost.:5170']) {
      expect(check({ host }), host).toBeNull();
    }
  });

  it('answers at this PC’s own name and at unc.box', () => {
    for (const host of ['elipc', 'ELIPC:5170', 'elipc.local:5170', 'unc.box', 'unc.box:8443']) {
      expect(check({ host }), host).toBeNull();
    }
  });

  it('only knows the LAN addresses when HOST opens the server to the LAN', () => {
    const interfaces = () => ({ Ethernet: [{ address: '192.168.1.20', family: 'IPv4' }, { address: 'fe80::1%12', family: 'IPv6' }, { address: 'fd00::5', family: 'IPv6' }] });
    const loopbackOnly = createGuardConfig({ bindHost: '127.0.0.1', hostname: 'elipc', interfaces });
    const lan = createGuardConfig({ bindHost: '0.0.0.0', hostname: 'elipc', interfaces });
    expect(checkRequest(req({ host: '192.168.1.20:5170' }), loopbackOnly)?.status).toBe(421);
    expect(checkRequest(req({ host: '192.168.1.20:5170' }), lan)).toBeNull();
    expect(checkRequest(req({ host: '[fd00::5]:5170' }), lan)).toBeNull();
    expect(checkRequest(req({ host: '192.168.1.21:5170' }), lan)?.status).toBe(421);
    expect(checkRequest(req({ host: 'evil.example' }), lan)?.status).toBe(421);
  });

  it('takes extra names from the config', () => {
    const custom = createGuardConfig({ hostname: 'elipc', extra: 'uncbox.home, proxy.example' });
    expect(checkRequest(req({ host: 'uncbox.home' }), custom)).toBeNull();
    expect(checkRequest(req({ host: 'proxy.example' }), custom)).toBeNull();
  });

  it('reads a Host header', () => {
    expect(hostNameOf('[::1]:5170')).toBe('[::1]');
    expect(hostNameOf('Unc.Box')).toBe('unc.box');
    expect(hostNameOf('x/y')).toBeNull();
    expect(hostNameOf(undefined)).toBeNull();
  });
});

describe('the Origin and Sec-Fetch-Site checks', () => {
  it('turns away a page on another site', () => {
    expect(check({ origin: 'https://evil.example' }, 'POST')?.status).toBe(403);
    expect(check({ origin: 'https://evil.example', 'content-type': JSON_TYPE }, 'POST')?.status).toBe(403);
    expect(check({ origin: 'null' }, 'POST')?.status).toBe(403);
    expect(check({ origin: 'not a url' })?.status).toBe(403);
    expect(check({ origin: 'file://' })?.status).toBe(403);
  });

  it('turns away another page on this PC, such as another port', () => {
    expect(check({ origin: 'http://localhost:3000', 'content-type': JSON_TYPE }, 'POST')?.status).toBe(403);
    expect(check({ origin: 'http://127.0.0.1:5170', 'content-type': JSON_TYPE }, 'POST')?.status).toBe(403);
  });

  it('turns away Sec-Fetch-Site: cross-site, even with no Origin', () => {
    expect(check({ 'sec-fetch-site': 'cross-site' })?.status).toBe(403);
    expect(check({ 'sec-fetch-site': 'cross-site' }, 'POST', '/api/google/signout')?.status).toBe(403);
  });

  it('lets the page’s own requests through', () => {
    for (const site of ['same-origin', 'same-site', 'none']) expect(check({ 'sec-fetch-site': site }), site).toBeNull();
    expect(check({ origin: 'http://localhost:5170', 'sec-fetch-site': 'same-origin', 'content-type': JSON_TYPE }, 'PUT')).toBeNull();
    expect(check({ host: '[::1]:5170', origin: 'http://[::1]:5170', 'content-type': JSON_TYPE }, 'POST')).toBeNull();
  });

  it('lets the unc.box page through, over TLS with no port', () => {
    const headers = { host: 'unc.box', origin: 'https://unc.box', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json; charset=utf-8' };
    expect(check(headers, 'POST', '/api/obs/action')).toBeNull();
    expect(check({ ...headers, origin: 'https://unc.box:443' }, 'POST', '/api/obs/action')).toBeNull();
  });

  it('lets the Windows app and curl through: they send no Origin', () => {
    expect(check({ host: 'localhost:5170' }, 'GET', '/api/clips')).toBeNull();
    expect(check({ 'content-type': JSON_TYPE, 'content-length': '12' }, 'POST', '/api/open')).toBeNull();
  });

  it('keeps the Google sign-in return working, for that one GET only', () => {
    const arrival = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' };
    expect(check(arrival, 'GET', '/api/google/callback?code=abc&state=xyz')).toBeNull();
    expect(check(arrival, 'GET', '/api/google/status')?.status).toBe(403);
    expect(check(arrival, 'POST', '/api/google/callback')?.status).toBe(403);
    // It still has to be addressed to this server.
    expect(check({ ...arrival, host: 'evil.example' }, 'GET', '/api/google/callback')?.status).toBe(421);
  });
});

describe('the content type check', () => {
  const body = (type, extra = {}) => ({ 'content-length': '20', ...(type ? { 'content-type': type } : {}), ...extra });

  it('turns away a text/plain body, which a page on another site can send without asking', () => {
    expect(check(body('text/plain'), 'POST', '/api/launcher/launch')?.status).toBe(415);
    expect(check(body('text/plain;charset=UTF-8'), 'POST', '/api/launcher/launch')?.status).toBe(415);
    expect(check(body('application/x-www-form-urlencoded'), 'POST', '/api/obs/action')?.status).toBe(415);
    expect(check(body('multipart/form-data; boundary=x'), 'PUT', '/api/state')?.status).toBe(415);
    expect(check(body(undefined), 'DELETE', '/api/state')?.status).toBe(415);
    expect(check(body(undefined, { 'transfer-encoding': 'chunked', 'content-length': undefined }), 'POST', '/api/state')?.status).toBe(415);
  });

  it('lets a same-origin JSON body through', () => {
    const headers = body(JSON_TYPE, { origin: 'http://localhost:5170', 'sec-fetch-site': 'same-origin' });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(check(headers, method, '/api/launcher/launch'), method).toBeNull();
    expect(check(body('Application/JSON; charset=utf-8'), 'POST', '/api/state')).toBeNull();
  });

  it('lets a request with no body and no type through', () => {
    expect(check({}, 'POST', '/api/clips/discord/remove')).toBeNull();
    expect(check({ 'content-length': '0' }, 'POST', '/api/google/signout')).toBeNull();
  });

  it('keeps the two clip routes that take video bytes', () => {
    expect(check(body('video/mp4'), 'POST', '/api/clips?kind=vertical')).toBeNull();
    expect(check(body('video/mp4'), 'POST', '/api/clips/discord/send')).toBeNull();
    // Nowhere else, and not other file types.
    expect(check(body('video/mp4'), 'POST', '/api/launcher/launch')?.status).toBe(415);
    expect(check(body('video/webm'), 'POST', '/api/clips')?.status).toBe(415);
    // They still have to come from our own page.
    expect(check(body('video/mp4', { origin: 'https://evil.example' }), 'POST', '/api/clips')?.status).toBe(403);
    expect(check(body('video/mp4', { host: 'evil.example' }), 'POST', '/api/clips')?.status).toBe(421);
  });

  it('does not care about the type of a read', () => {
    expect(check({ 'content-type': 'text/plain' }, 'GET', '/api/state')).toBeNull();
  });
});

describe('guardApi', () => {
  it('answers a refusal in plain words and says whether it did', () => {
    const sendJson = vi.fn();
    expect(guardApi(req({ host: 'evil.example' }), {}, config, sendJson)).toBe(true);
    expect(sendJson).toHaveBeenCalledWith({}, 421, { error: expect.stringContaining('Uncbox only answers') });
    sendJson.mockClear();
    expect(guardApi(req(), {}, config, sendJson)).toBe(false);
    expect(sendJson).not.toHaveBeenCalled();
  });
});

describe('a refused request never reaches the routes', () => {
  /** A real HTTP server built the way server/index.mjs builds it: the guard, then the launcher route. */
  async function withServer(run) {
    let reached = 0;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'uncbox-guard-'));
    await writeFile(path.join(dataDir, 'launcher.json'), JSON.stringify({ tiles: [{ id: 'tile-0123456789ab', name: 'Site', type: 'url', target: 'https://example.com/' }] }));
    const sendJson = (res, status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const readJson = (r) =>
      new Promise((resolve) => {
        let text = '';
        r.on('data', (c) => (text += c));
        r.on('end', () => resolve(JSON.parse(text || '{}')));
      });
    const launcher = createLauncher({ sendJson, isLocal: () => true, readJson, dataDir });
    const server = http.createServer((r, res) => {
      if (guardApi(r, res, config, sendJson)) return;
      if (r.method === 'OPTIONS') return sendJson(res, 405, { error: 'Method not allowed' });
      reached++;
      void launcher(r, res, new URL(r.url, 'http://localhost'));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await run(server.address().port, () => reached);
    } finally {
      server.close();
    }
  }

  /** Sends one request. Node's http lets the test set Host and Origin the way a browser would. */
  const send = (port, method, headers, body) =>
    new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: '/api/launcher/tiles', method, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
      });
      r.on('error', reject);
      r.end(body);
    });

  it('refuses a text/plain POST to /api/launcher/launch, and still takes the page’s own JSON one', async () => {
    await withServer(async (port, reached) => {
      const post = (headers, body) =>
        new Promise((resolve, reject) => {
          const r = http.request({ host: '127.0.0.1', port, path: '/api/launcher/launch', method: 'POST', headers: { host: `localhost:${port}`, 'content-length': Buffer.byteLength(body), ...headers } }, (res) => {
            let text = '';
            res.on('data', (c) => (text += c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
          });
          r.on('error', reject);
          r.end(body);
        });
      const body = JSON.stringify({ id: 'tile-0123456789ab' });

      // What a page on another site can send with no preflight.
      const evil = await post({ 'content-type': 'text/plain', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, body);
      expect(evil.status).toBe(403);
      expect(reached()).toBe(0);
      // Even if it somehow carried no Origin, the body type alone is enough to refuse.
      const plain = await post({ 'content-type': 'text/plain' }, body);
      expect(plain.status).toBe(415);
      expect(plain.headers['access-control-allow-origin']).toBeUndefined();
      // DNS rebinding.
      expect((await post({ 'content-type': JSON_TYPE, host: 'evil.example' }, body)).status).toBe(421);
      expect(reached()).toBe(0);

      // The page's own request gets past the guard to the route (it answers about the saved tile).
      const own = await post({ 'content-type': JSON_TYPE, origin: `http://localhost:${port}`, 'sec-fetch-site': 'same-origin' }, '{"id":"tile-ffffffffffff"}');
      expect(own.status).toBe(404);
      expect(JSON.parse(own.body).error).toMatch(/gone/);
      expect(reached()).toBe(1);
    });
  });

  it('fails a preflight and sends no CORS headers', async () => {
    await withServer(async (port) => {
      const pre = await send(port, 'OPTIONS', { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' });
      expect(pre.status).toBe(403);
      expect(Object.keys(pre.headers).filter((h) => h.startsWith('access-control'))).toEqual([]);
      const same = await send(port, 'OPTIONS', {});
      expect(same.status).toBe(405);
      expect(Object.keys(same.headers).filter((h) => h.startsWith('access-control'))).toEqual([]);
      const read = await send(port, 'GET', { origin: 'https://evil.example' });
      expect(read.status).toBe(403);
      expect(read.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
