// The Web widget's framing check: how x-frame-options and CSP frame-ancestors read, and the probe
// route. Nothing here touches the network: the site is a fake fetch.

import { describe, expect, it } from 'vitest';
import { createWeb, parseFrameHeaders, webUrl } from './web.mjs';

const UNCBOX = 'http://localhost:5170';
const SITE = 'https://example.com';
const check = (headers, from = UNCBOX, target = SITE) => parseFrameHeaders(headers, from, target);

describe('parseFrameHeaders: x-frame-options', () => {
  it('frames when the site says nothing', () => {
    expect(check({})).toEqual({ frameable: true });
    expect(check({ xFrameOptions: null, csp: null })).toEqual({ frameable: true });
  });

  it('refuses DENY, in any case', () => {
    expect(check({ xFrameOptions: 'DENY' })).toEqual({ frameable: false, reason: 'x-frame-options' });
    expect(check({ xFrameOptions: 'deny' }).frameable).toBe(false);
  });

  it('refuses SAMEORIGIN unless the site is Uncbox itself', () => {
    expect(check({ xFrameOptions: 'SAMEORIGIN' }).frameable).toBe(false);
    expect(check({ xFrameOptions: 'SAMEORIGIN' }, UNCBOX, UNCBOX).frameable).toBe(true);
  });

  it('reads a repeated header (joined with a comma)', () => {
    expect(check({ xFrameOptions: 'SAMEORIGIN, DENY' }, UNCBOX, UNCBOX).frameable).toBe(false);
  });

  it('ignores ALLOW-FROM, as browsers do', () => {
    expect(check({ xFrameOptions: 'ALLOW-FROM https://other.example' }).frameable).toBe(true);
  });
});

describe('parseFrameHeaders: CSP frame-ancestors', () => {
  const csp = (value) => check({ csp: value });

  it('refuses none', () => {
    expect(csp("default-src 'self'; frame-ancestors 'none'")).toEqual({ frameable: false, reason: 'csp' });
  });

  it("refuses 'self' for another site, allows it for Uncbox's own", () => {
    expect(csp("frame-ancestors 'self'").frameable).toBe(false);
    expect(check({ csp: "frame-ancestors 'self'" }, UNCBOX, UNCBOX).frameable).toBe(true);
  });

  it('allows a list that names Uncbox, in all the usual spellings', () => {
    expect(csp('frame-ancestors https://other.example http://localhost:5170').frameable).toBe(true);
    expect(csp('frame-ancestors http://localhost:*').frameable).toBe(true);
    expect(csp('frame-ancestors http:').frameable).toBe(true);
    expect(csp('frame-ancestors *').frameable).toBe(true);
    expect(check({ csp: 'frame-ancestors *.example.org' }, 'https://app.example.org', SITE).frameable).toBe(true);
  });

  it('refuses a list that leaves Uncbox out', () => {
    expect(csp('frame-ancestors https://other.example https://*.google.com').frameable).toBe(false);
    expect(csp('frame-ancestors https:').frameable).toBe(false);
    expect(csp('frame-ancestors http://localhost:3000').frameable).toBe(false);
    expect(csp('frame-ancestors localhost').frameable).toBe(false);
  });

  it('wins over x-frame-options, as in browsers', () => {
    expect(check({ xFrameOptions: 'DENY', csp: 'frame-ancestors *' }).frameable).toBe(true);
    expect(check({ xFrameOptions: 'SAMEORIGIN', csp: "frame-ancestors 'none'" }).frameable).toBe(false);
  });

  it('ignores a CSP without frame-ancestors', () => {
    expect(csp("default-src 'self'; script-src 'self'").frameable).toBe(true);
    expect(check({ xFrameOptions: 'DENY', csp: "default-src 'self'" }).frameable).toBe(false);
  });

  it('needs every policy of a comma-joined header to allow it', () => {
    expect(csp('frame-ancestors *, frame-ancestors \'none\'').frameable).toBe(false);
    expect(csp('frame-ancestors *, frame-ancestors http://localhost:5170').frameable).toBe(true);
  });
});

describe('webUrl', () => {
  it('takes web addresses only', () => {
    expect(webUrl('https://example.com/a?b=1')?.hostname).toBe('example.com');
    expect(webUrl('http://localhost:3000')).not.toBeNull();
    for (const bad of ['', 'example.com', 'file:///C:/x', 'javascript:alert(1)', 'ftp://example.com', 'data:text/html,hi']) {
      expect(webUrl(bad)).toBeNull();
    }
  });
});

describe('the probe route', () => {
  const local = { socket: { remoteAddress: '127.0.0.1' }, method: 'GET' };
  const lan = { socket: { remoteAddress: '192.168.1.20' }, method: 'GET' };

  function run(req, query, fetchImpl) {
    let sent;
    const handle = createWeb({ isLocal: (r) => r.socket.remoteAddress === '127.0.0.1', sendJson: (_res, status, body) => (sent = { status, body }), fetchImpl });
    return handle(req, {}, new URL(`http://localhost:5170/api/web/frameable?${new URLSearchParams(query)}`)).then(() => sent);
  }
  const reply = (status, headers = {}, url = SITE + '/') => async () => ({
    status,
    url,
    headers: new Headers(headers),
    body: { cancel: async () => {} },
  });

  it('reports a site that forbids framing', async () => {
    const out = await run(local, { url: SITE, from: UNCBOX }, reply(200, { 'x-frame-options': 'DENY' }));
    expect(out).toEqual({ status: 200, body: { frameable: false, reason: 'x-frame-options' } });
  });

  it('reports a site that allows it', async () => {
    const out = await run(local, { url: SITE, from: UNCBOX }, reply(200, { 'content-security-policy': 'frame-ancestors *' }));
    expect(out.body).toEqual({ frameable: true });
  });

  it('judges the page it ended up on after redirects', async () => {
    const out = await run(local, { url: 'https://short.example/x', from: UNCBOX }, reply(200, { 'x-frame-options': 'SAMEORIGIN' }, 'http://localhost:5170/'));
    expect(out.body.frameable).toBe(true);
  });

  it('tries GET when HEAD is refused', async () => {
    const methods = [];
    const out = await run(local, { url: SITE, from: UNCBOX }, async (_url, init) => {
      methods.push(init.method);
      return reply(init.method === 'HEAD' ? 405 : 200, { 'x-frame-options': 'DENY' })();
    });
    expect(methods).toEqual(['HEAD', 'GET']);
    expect(out.body.frameable).toBe(false);
  });

  it('lets the frame try when the site cannot be reached', async () => {
    const out = await run(local, { url: SITE, from: UNCBOX }, async () => {
      throw new Error('offline');
    });
    expect(out.body).toEqual({ frameable: true, unknown: true });
  });

  it('refuses other kinds of address, and other PCs', async () => {
    const never = async () => {
      throw new Error('should not be called');
    };
    expect((await run(local, { url: 'file:///C:/secret.txt' }, never)).status).toBe(400);
    expect((await run(local, { url: '' }, never)).status).toBe(400);
    expect((await run(lan, { url: SITE }, never)).status).toBe(403);
  });
});
