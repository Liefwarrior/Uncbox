// The guard in front of every /api/* route. The server only listens on this PC, but every web page
// open in the user's browser connects from this PC too, so "the request came from loopback" does
// not mean "Uncbox sent it". This checks the request really comes from Uncbox's own page:
//
//   1. Host         has to be a name this server answers to (stops DNS rebinding, where a page on
//                   evil.example is pointed at 127.0.0.1 and can then read the answers)
//   2. Origin       when the browser sends one, it has to be this very server (stops other sites
//                   posting to it); Sec-Fetch-Site: cross-site is turned away too
//   3. Content-Type changing requests carry JSON (or a clip's video bytes). Anything else is a
//                   "simple" request a page on another site can send without asking first
//
// Requests with no Origin (the Windows app, curl, the browser loading a plain GET) are fine.
// The server never sends CORS headers, so no other site can read an answer or pass a preflight.

import os from 'node:os';

const CHANGES_STATE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SEC_FETCH_OK = new Set(['same-origin', 'same-site', 'none']);
const LOOPBACK_BINDS = new Set(['127.0.0.1', '::1', 'localhost']);
// A hostname or IPv4 or [IPv6] with an optional port, and nothing else.
const HOST_SHAPE = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(:\d{1,5})?$/i;

/** The routes that take something other than JSON, and what they take: clips are video bytes. */
const OTHER_BODIES = [
  { method: 'POST', path: '/api/clips', types: ['video/mp4'] },
  { method: 'POST', path: '/api/clips/discord/send', types: ['video/mp4'] },
];

/** "LOCALHOST:5170" becomes "localhost", "[::1]:5170" becomes "[::1]", junk becomes null. */
export function hostNameOf(hostHeader) {
  const text = String(hostHeader ?? '').trim();
  if (!HOST_SHAPE.test(text)) return null;
  const name = text.startsWith('[') ? text.slice(0, text.indexOf(']') + 1) : text.replace(/:\d+$/, '');
  return name.toLowerCase().replace(/\.$/, '');
}

/**
 * The names this server answers to: this PC under its usual names, the unc.box address and, only
 * when HOST opens the server to the LAN, this PC's own LAN addresses. Never an arbitrary name.
 * `hosts()` is looked up for each request, since a laptop's addresses change.
 */
export function createGuardConfig({
  bindHost = '127.0.0.1',
  domains = [],
  hostname = os.hostname(),
  interfaces = () => os.networkInterfaces(),
  extra = '',
} = {}) {
  const fixed = ['localhost', '127.0.0.1', '[::1]', ...domains, ...String(extra ?? '').split(',')];
  if (hostname) fixed.push(hostname, `${hostname}.local`);
  const lan = !LOOPBACK_BINDS.has(bindHost);
  if (lan && /^[0-9.]+$/.test(bindHost) && bindHost !== '0.0.0.0') fixed.push(bindHost);
  return {
    hosts() {
      const names = [...fixed];
      if (lan) {
        for (const list of Object.values(interfaces() ?? {})) {
          for (const a of list ?? []) {
            if (a.address.includes('%')) continue;
            names.push(a.family === 'IPv6' || a.family === 6 ? `[${a.address}]` : a.address);
          }
        }
      }
      return names.map((n) => String(n).trim().toLowerCase().replace(/\.$/, '')).filter(Boolean);
    },
  };
}

const refuse = (status, error) => ({ status, error });

/**
 * Checks one request. Returns null to let it through, or { status, error } to turn it away.
 * `req` only needs method, url and headers; `config` is from createGuardConfig (or { hosts: [...] }).
 */
export function checkRequest(req, config) {
  const headers = req.headers ?? {};
  const allowed = new Set(typeof config.hosts === 'function' ? config.hosts() : config.hosts);
  const method = String(req.method ?? 'GET').toUpperCase();
  const pathname = String(req.url ?? '').split('?')[0];

  const name = hostNameOf(headers.host);
  if (!name || !allowed.has(name)) {
    return refuse(421, 'Uncbox only answers at its own address (localhost or unc.box), not at that name.');
  }

  const origin = headers.origin;
  if (origin !== undefined) {
    let from = null;
    let self = null;
    try {
      from = new URL(origin);
      self = new URL(`${from.protocol}//${headers.host}`).host;
    } catch {
      from = null;
    }
    const ok = from && (from.protocol === 'http:' || from.protocol === 'https:') && allowed.has(hostNameOf(from.host)) && from.host === self;
    if (!ok) return refuse(403, 'Another website asked for this. Uncbox only answers its own page.');
  }

  // The Google sign-in comes back as a plain visit from Google's page, and has its own state check.
  const googleReturn = method === 'GET' && pathname === '/api/google/callback';
  const site = headers['sec-fetch-site'];
  if (site !== undefined && !SEC_FETCH_OK.has(String(site).toLowerCase()) && !googleReturn) {
    return refuse(403, 'Another website asked for this. Uncbox only answers its own page.');
  }

  if (CHANGES_STATE.has(method)) {
    const type = String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const other = OTHER_BODIES.find((o) => o.method === method && o.path === pathname);
    const accepted = ['application/json', ...(other?.types ?? [])];
    const hasBody = Number(headers['content-length']) > 0 || headers['transfer-encoding'] !== undefined;
    if (type ? !accepted.includes(type) : hasBody) {
      return refuse(415, 'Send this as JSON (Content-Type: application/json).');
    }
  }

  return null;
}

/** Runs the guard on a live request; true means it already answered with a refusal. */
export function guardApi(req, res, config, sendJson) {
  const refused = checkRequest(req, config);
  if (!refused) return false;
  sendJson(res, refused.status, { error: refused.error });
  return true;
}
