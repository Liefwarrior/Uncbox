// What the Web widget needs from the server: whether a site allows being shown in a frame. The
// page can't read another site's headers, so this PC's server looks (this PC only).
//
//   GET /api/web/frameable?url=...&from=http://localhost:5170
//       { frameable: boolean, reason?: 'x-frame-options' | 'csp' }
//
// A site that can't be reached or answers oddly is reported as frameable: the frame itself then
// shows whatever is wrong, which is better than a wrong "this site doesn't allow it".

const PROBE_TIMEOUT_MS = 6000;

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

/** Does one CSP frame-ancestors source allow a page at `from` to frame a page at `target`? */
function sourceAllows(source, from, target) {
  const s = source.trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  if (lower === "'none'") return false;
  if (lower === '*') return true;
  if (lower === "'self'") return from === target;
  let page;
  try {
    page = new URL(from);
  } catch {
    return false;
  }
  // A scheme alone ("https:").
  if (/^[a-z][a-z0-9+.-]*:$/i.test(s)) return page.protocol === lower;
  // [scheme://]host[:port], where the host may start with "*." and the port may be "*".
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^/:*]+)(?::(\d+|\*))?(?:\/.*)?$/i.exec(s);
  if (!m) return false;
  const [, scheme, wild, host, port] = m;
  if (scheme && `${scheme.toLowerCase()}:` !== page.protocol) return false;
  if (!scheme && page.protocol !== 'https:' && page.protocol !== 'http:') return false;
  const pageHost = page.hostname.toLowerCase();
  const want = host.toLowerCase();
  if (wild ? !pageHost.endsWith(`.${want}`) : pageHost !== want) return false;
  if (port && port !== '*' && port !== (page.port || (page.protocol === 'https:' ? '443' : '80'))) return false;
  if (!port && page.port && page.port !== (page.protocol === 'https:' ? '443' : '80')) return false;
  return true;
}

/**
 * Reads x-frame-options and the CSP frame-ancestors from a site's headers. `from` is the origin
 * of the page that would hold the frame (Uncbox), `target` the site's own. A CSP frame-ancestors
 * wins over x-frame-options, as in browsers. Each policy in a comma-joined CSP must allow it.
 */
export function parseFrameHeaders({ xFrameOptions, csp }, from, target) {
  const policies = (csp ?? '')
    .split(',')
    .map((p) => p.split(';').map((d) => d.trim()).find((d) => /^frame-ancestors(\s|$)/i.test(d)))
    .filter(Boolean);
  if (policies.length) {
    for (const policy of policies) {
      const sources = policy.split(/\s+/).slice(1);
      if (!sources.some((src) => sourceAllows(src, from, target))) return { frameable: false, reason: 'csp' };
    }
    return { frameable: true };
  }
  const values = (xFrameOptions ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  for (const v of values) {
    if (v === 'deny') return { frameable: false, reason: 'x-frame-options' };
    if (v === 'sameorigin' && from !== target) return { frameable: false, reason: 'x-frame-options' };
  }
  // Anything else (ALLOW-FROM, which browsers ignore, or nothing) frames.
  return { frameable: true };
}

/** http and https only. */
export function webUrl(text) {
  try {
    const u = new URL(text);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname ? u : null;
  } catch {
    return null;
  }
}

export function createWeb({ sendJson, isLocal, fetchImpl = fetch }) {
  /** HEAD first; some servers refuse it, so those get a GET whose body is dropped unread. */
  async function look(url) {
    const options = { redirect: 'follow', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), headers: { 'User-Agent': 'Mozilla/5.0 Uncbox' } };
    let res = await fetchImpl(url, { ...options, method: 'HEAD' });
    if (res.status >= 400) {
      res = await fetchImpl(url, { ...options, method: 'GET', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      res.body?.cancel().catch(() => {});
    }
    return res;
  }

  return async function handle(req, res, url) {
    if (req.method !== 'GET' || url.pathname !== '/api/web/frameable') return sendJson(res, 404, { error: 'Not found' });
    if (!isLocal(req)) return sendJson(res, 403, { error: 'Run this on the PC Uncbox is on.' });
    const target = webUrl(url.searchParams.get('url') ?? '');
    if (!target) return sendJson(res, 400, { error: 'Only web addresses (http or https) can be opened.' });
    const from = originOf(url.searchParams.get('from') ?? '');
    try {
      const got = await look(target.href);
      const finalOrigin = originOf(got.url || target.href);
      return sendJson(res, 200, parseFrameHeaders({ xFrameOptions: got.headers.get('x-frame-options'), csp: got.headers.get('content-security-policy') }, from, finalOrigin));
    } catch {
      return sendJson(res, 200, { frameable: true, unknown: true });
    }
  };
}
