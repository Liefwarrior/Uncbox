// The Gmail glance widget's server side. It uses the Google sign-in (server/google.mjs) with the
// metadata scope: headers and labels only, never the text of a message. That is the least Gmail
// lets an app see, and enough for "12 unread" and a list of who wrote about what.
//
//   GET  /api/gmail/summary?label=INBOX&unread=0|1
//          { label: { id, name }, unread, threadsUnread, messages: [{ id, threadId, from, subject,
//            date, unread, snippet?, link }] }   the latest 8 conversations in the label
//   GET  /api/gmail/labels   { labels: [{ id, name, system }] } for the widget's label picker
//   POST /api/gmail/open     { url } opens a message in Gmail in the browser
//
// What the metadata scope can't do: Google refuses the `q` search parameter with it (that would
// let an app search message text). So "only unread" is the UNREAD label added to the label
// filter, not a search. `snippet` is passed on only if Google sends one with the headers.
// The count is `messagesUnread` of the label, as asked; `threadsUnread` (what Gmail's own
// tab shows) comes along too.

import { GOOGLE_SCOPES, apiProblem } from './google.mjs';
import { openInBrowser } from './open.mjs';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CACHE_MS = 60_000;
const SHOWN = 8;
const LABEL_ID = /^[A-Za-z0-9_-]{1,100}$/;

// ---- reading headers ----

const QUOTED_WORD = /=\?([^?\s*]+)(?:\*[^?\s]*)?\?([bBqQ])\?([^?\s]*)\?=/g;

/** The bytes of a Q-encoded word: "=C3=A9" is one byte, "_" is a space. */
function qBytes(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '_') out.push(0x20);
    else if (c === '=' && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(c.charCodeAt(0) & 0xff);
  }
  return Buffer.from(out);
}

function decodeBytes(charset, bytes) {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    // A character set this doesn't know: UTF-8 is by far the likeliest.
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * Turns RFC 2047 encoded words ("=?UTF-8?B?...?=" and "=?ISO-8859-1?Q?...?=") in a header into
 * text. Words next to each other with only spaces between are one run (the spaces are not part
 * of the text), and a letter split across two of them is put back together before decoding.
 */
export function decodeEncodedWords(text) {
  const source = String(text ?? '');
  /** @type {({ text: string } | { charset: string, bytes: Buffer })[]} */
  const parts = [];
  let last = 0;
  for (const m of source.matchAll(QUOTED_WORD)) {
    if (m.index > last) parts.push({ text: source.slice(last, m.index) });
    const bytes = m[2].toLowerCase() === 'b' ? Buffer.from(m[3], 'base64') : qBytes(m[3]);
    parts.push({ charset: m[1].toLowerCase(), bytes });
    last = m.index + m[0].length;
  }
  if (last < source.length) parts.push({ text: source.slice(last) });

  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if ('text' in part) {
      const between = i > 0 && i < parts.length - 1 && 'charset' in parts[i - 1] && 'charset' in parts[i + 1];
      if (!(between && !part.text.trim())) out += part.text;
      continue;
    }
    let bytes = part.bytes;
    // Following words in the same character set carry on the same run of bytes.
    while (i + 1 < parts.length) {
      const next = parts[i + 1];
      const after = parts[i + 2];
      if ('charset' in next && next.charset === part.charset) {
        bytes = Buffer.concat([bytes, next.bytes]);
        i += 1;
      } else if ('text' in next && !next.text.trim() && after && 'charset' in after && after.charset === part.charset) {
        bytes = Buffer.concat([bytes, after.bytes]);
        i += 2;
      } else break;
    }
    out += decodeBytes(part.charset, bytes);
  }
  return out;
}

/** The first mailbox of an address header, split into its name and address. */
export function parseMailbox(header) {
  const text = String(header ?? '').trim();
  // Only the first of "A <a@x>, B <b@x>": stop at a comma that isn't in quotes or <>.
  let end = text.length;
  let quoted = false;
  let angle = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted && c === '\\') i++;
    else if (c === '"') quoted = !quoted;
    else if (!quoted && c === '<') angle = true;
    else if (!quoted && c === '>') angle = false;
    else if (!quoted && !angle && c === ',') {
      end = i;
      break;
    }
  }
  const first = text.slice(0, end).trim();
  let name = '';
  let address = first;
  const angled = /<([^<>]*)>\s*$/.exec(first);
  const commented = /^([^\s()<>]+@[^\s()<>]+)\s*\((.*)\)\s*$/.exec(first);
  if (angled) {
    address = angled[1].trim();
    name = first.slice(0, angled.index).trim();
  } else if (commented) {
    address = commented[1];
    name = commented[2];
  }
  if (name.length > 1 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
  return { name: decodeEncodedWords(name).replace(/\s+/g, ' ').trim(), address };
}

/** Who a message is from: the display name, decoded, or the address when there is no name. */
export function senderName(fromHeader) {
  const { name, address } = parseMailbox(fromHeader);
  return name || address;
}

/** A subject, decoded, on one line. */
export function cleanSubject(subject) {
  return decodeEncodedWords(subject).replace(/\s+/g, ' ').trim() || '(no subject)';
}

const header = (headers, name) => (headers ?? []).find((h) => h?.name?.toLowerCase() === name)?.value ?? '';

/** The link that opens a conversation in Gmail. */
export const threadLink = (threadId) => `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(threadId)}`;

/** What the page gets for one Gmail API message (headers and labels only). */
export function toMessage(m) {
  const headers = m.payload?.headers;
  const ms = Number(m.internalDate);
  const item = {
    id: m.id,
    threadId: m.threadId,
    from: senderName(header(headers, 'from')),
    subject: cleanSubject(header(headers, 'subject')),
    date: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '',
    unread: (m.labelIds ?? []).includes('UNREAD'),
    link: threadLink(m.threadId),
  };
  // Not every scope gets one; with only metadata it may be missing, and then it is left out.
  if (typeof m.snippet === 'string' && m.snippet.trim()) item.snippet = m.snippet.trim();
  return item;
}

/** One conversation once: the newest message of each, in the order given. */
export function onePerThread(messages, limit = SHOWN) {
  const seen = new Set();
  const out = [];
  for (const m of messages ?? []) {
    if (!m?.id || !m.threadId || seen.has(m.threadId)) continue;
    seen.add(m.threadId);
    out.push(m);
    if (out.length >= limit) break;
  }
  return out;
}

// ---- labels ----

const SYSTEM_LABELS = [
  ['INBOX', 'Inbox'],
  ['IMPORTANT', 'Important'],
  ['STARRED', 'Starred'],
  ['CATEGORY_PRIMARY', 'Primary'],
  ['CATEGORY_SOCIAL', 'Social'],
  ['CATEGORY_PROMOTIONS', 'Promotions'],
  ['CATEGORY_UPDATES', 'Updates'],
  ['CATEGORY_FORUMS', 'Forums'],
];

/** The labels worth watching: the main system ones first, then yours by name. */
export function pickLabels(items) {
  const byId = new Map((items ?? []).filter((l) => l?.id && LABEL_ID.test(l.id)).map((l) => [l.id, l]));
  const system = SYSTEM_LABELS.filter(([id]) => byId.has(id)).map(([id, name]) => ({ id, name, system: true }));
  const mine = [...byId.values()]
    .filter((l) => l.type === 'user')
    .map((l) => ({ id: l.id, name: String(l.name ?? l.id), system: false }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...system, ...mine];
}

/** The label to read, or INBOX if what was asked for can't be a label id. */
export const cleanLabel = (value) => (typeof value === 'string' && LABEL_ID.test(value) ? value : 'INBOX');

const labelName = (label) => SYSTEM_LABELS.find(([id]) => id === label.id)?.[1] ?? label.name ?? label.id;

/** Only mail.google.com messages open from the widget. */
export function safeMailUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'mail.google.com' && !u.username && !u.password ? u.href : '';
  } catch {
    return '';
  }
}

/**
 * @param {object} o
 * @param {ReturnType<import('./google.mjs').createGoogle>} o.google
 * @param {(target: string) => void} [o.open]  opens a page in the browser; swapped out by the tests
 * @param {() => number} [o.now]
 */
export function createGmail({ google, isLocal, sendJson, readJson, open = openInBrowser, now = Date.now }) {
  google.requireScopes(GOOGLE_SCOPES.gmail);
  /** "account|label|unread" → { at, data } */
  const cache = new Map();

  const signInFirst = async (res) => {
    const status = await google.snapshot();
    return sendJson(
      res,
      401,
      status.signedIn
        ? { code: 'scope', error: 'Allow Gmail access to see your inbox. Sign in again and tick the Gmail box.' }
        : { code: 'signin', error: 'Sign in with Google first.' },
    );
  };

  /** A cached answer, or the result of `make` (kept for a minute). A problem is sent, not kept. */
  async function cached(res, key, make) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return sendJson(res, 200, hit.data);
    const got = await make();
    if (got.problem) {
      const { status, ...rest } = got.problem;
      return sendJson(res, status, rest);
    }
    cache.set(key, { at: now(), data: got.data });
    while (cache.size > 24) cache.delete(cache.keys().next().value);
    return sendJson(res, 200, got.data);
  }

  const call = async (path) => {
    const r = await google.fetch(`${API}/${path}`);
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
  };

  async function summary(res, url) {
    if (!(await google.hasScopes(GOOGLE_SCOPES.gmail))) return signInFirst(res);
    const label = cleanLabel(url.searchParams.get('label'));
    const onlyUnread = url.searchParams.get('unread') === '1';
    const key = `${(await google.snapshot()).email}|summary|${label}|${onlyUnread}`;
    return cached(res, key, async () => {
      const info = await call(`labels/${encodeURIComponent(label)}?fields=id,name,messagesUnread,threadsUnread`);
      if (!info.ok) {
        if (info.status === 404) return { problem: { status: 404, code: 'label', error: 'That Gmail label isn’t there any more. Pick another in the widget’s settings.' } };
        return { problem: apiProblem(info.status, info.body, 'Gmail') };
      }
      const ids = new URLSearchParams({ maxResults: '20', fields: 'messages(id,threadId)' });
      ids.append('labelIds', label);
      if (onlyUnread) ids.append('labelIds', 'UNREAD');
      const list = await call(`messages?${ids}`);
      if (!list.ok) return { problem: apiProblem(list.status, list.body, 'Gmail') };

      const get = new URLSearchParams({ format: 'metadata', fields: 'id,threadId,labelIds,internalDate,snippet,payload/headers' });
      get.append('metadataHeaders', 'From');
      get.append('metadataHeaders', 'Subject');
      const found = await Promise.all(onePerThread(list.body.messages).map((m) => call(`messages/${encodeURIComponent(m.id)}?${get}`)));
      // A message deleted since the list was made just isn't shown.
      const good = found.filter((f) => f.ok);
      if (found.length && !good.length) return { problem: apiProblem(found[0].status, found[0].body, 'Gmail') };
      return {
        data: {
          label: { id: info.body.id ?? label, name: labelName(info.body) },
          unread: Number(info.body.messagesUnread) || 0,
          threadsUnread: Number(info.body.threadsUnread) || 0,
          messages: good.map((f) => toMessage(f.body)),
        },
      };
    });
  }

  async function labels(res) {
    if (!(await google.hasScopes(GOOGLE_SCOPES.gmail))) return signInFirst(res);
    const key = `${(await google.snapshot()).email}|labels`;
    return cached(res, key, async () => {
      const r = await call('labels?fields=labels(id,name,type)');
      return r.ok ? { data: { labels: pickLabels(r.body.labels) } } : { problem: apiProblem(r.status, r.body, 'Gmail') };
    });
  }

  async function openIt(res, body) {
    const target = typeof body?.url === 'string' ? safeMailUrl(body.url) : '';
    if (!target) return sendJson(res, 400, { error: 'That isn’t a Gmail link.' });
    open(target);
    return sendJson(res, 200, { ok: true });
  }

  return async function handle(req, res, url) {
    if (!isLocal(req)) return sendJson(res, 403, { error: 'Run this on the PC Uncbox is on.' });
    const action = url.pathname.slice('/api/gmail'.length);
    try {
      if (req.method === 'GET' && action === '/summary') return await summary(res, url);
      if (req.method === 'GET' && action === '/labels') return await labels(res);
      if (req.method === 'POST' && action === '/open') return await openIt(res, await readJson(req));
      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      return sendJson(res, err.status || 500, {
        code: err.status === 401 ? 'signin' : 'other',
        error: err.status ? err.message : 'Couldn’t read Gmail.',
      });
    }
  };
}
