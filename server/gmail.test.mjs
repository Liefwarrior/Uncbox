// The Gmail widget's server side: reading From and Subject headers (including RFC 2047 encoded
// words), picking labels, and the routes with a fake Google. Nothing here reaches Google.

import { describe, expect, it } from 'vitest';
import { GOOGLE_SCOPES } from './google.mjs';
import { cleanLabel, cleanSubject, createGmail, decodeEncodedWords, onePerThread, parseMailbox, pickLabels, safeMailUrl, senderName, threadLink, toMessage } from './gmail.mjs';

const b64 = (text, charset = 'utf8') => Buffer.from(text, charset).toString('base64');

describe('decodeEncodedWords', () => {
  it('leaves plain text alone', () => {
    expect(decodeEncodedWords('Hello, world')).toBe('Hello, world');
    expect(decodeEncodedWords('')).toBe('');
    expect(decodeEncodedWords(undefined)).toBe('');
  });

  it('decodes base64 (B) words', () => {
    expect(decodeEncodedWords(`=?UTF-8?B?${b64('José Núñez')}?=`)).toBe('José Núñez');
    expect(decodeEncodedWords(`=?utf-8?b?${b64('日本語のメール')}?=`)).toBe('日本語のメール');
  });

  it('decodes quoted-printable (Q) words: =XX bytes and _ for a space', () => {
    expect(decodeEncodedWords('=?UTF-8?Q?Andr=C3=A9_Dupont?=')).toBe('André Dupont');
    expect(decodeEncodedWords('=?ISO-8859-1?Q?Fran=E7ois_M=FCller?=')).toBe('François Müller');
  });

  it('decodes other character sets', () => {
    expect(decodeEncodedWords(`=?windows-1252?B?${b64('Caf\u00e9', 'latin1')}?=`)).toBe('Café');
    expect(decodeEncodedWords(`=?Shift_JIS?B?${Buffer.from([0x93, 0xfa, 0x96, 0x7b]).toString('base64')}?=`)).toBe('日本');
  });

  it('runs adjacent words together and drops the spaces between them', () => {
    expect(decodeEncodedWords('=?UTF-8?Q?Hello?= =?UTF-8?Q?_World?=')).toBe('Hello World');
    expect(decodeEncodedWords('=?UTF-8?Q?Hello?=\r\n =?UTF-8?Q?World?=')).toBe('HelloWorld');
  });

  it('keeps a character that is split across two words in one piece', () => {
    // "é" is C3 A9; one word ends after C3 and the next starts with A9.
    expect(decodeEncodedWords('=?UTF-8?Q?Andr=C3?= =?UTF-8?Q?=A9?=')).toBe('André');
    const bytes = Buffer.from('日本', 'utf8');
    expect(decodeEncodedWords(`=?UTF-8?B?${bytes.subarray(0, 4).toString('base64')}?= =?UTF-8?B?${bytes.subarray(4).toString('base64')}?=`)).toBe('日本');
  });

  it('keeps ordinary text next to a word', () => {
    expect(decodeEncodedWords('Re: =?UTF-8?Q?caf=C3=A9?= menu')).toBe('Re: café menu');
  });

  it('copes with a language tag, an unknown character set and broken words', () => {
    expect(decodeEncodedWords('=?UTF-8*en?Q?Hi?=')).toBe('Hi');
    expect(decodeEncodedWords('=?x-made-up?Q?caf=C3=A9?=')).toBe('café');
    expect(decodeEncodedWords('=?UTF-8?Q?no end')).toBe('=?UTF-8?Q?no end');
  });
});

describe('parseMailbox and senderName', () => {
  it('uses the display name', () => {
    expect(senderName('Ada Lovelace <ada@example.com>')).toBe('Ada Lovelace');
    expect(senderName('"Lovelace, Ada" <ada@example.com>')).toBe('Lovelace, Ada');
    expect(senderName('"Ada \\"Countess\\" Lovelace" <ada@example.com>')).toBe('Ada "Countess" Lovelace');
  });

  it('falls back to the address when there is no name', () => {
    expect(senderName('ada@example.com')).toBe('ada@example.com');
    expect(senderName('<ada@example.com>')).toBe('ada@example.com');
    expect(senderName('"" <ada@example.com>')).toBe('ada@example.com');
    expect(senderName('')).toBe('');
    expect(senderName(undefined)).toBe('');
  });

  it('decodes an encoded display name, bare or quoted', () => {
    expect(senderName('=?UTF-8?B?Sm9zw6kgTsO6w7Flego=?= <jose@example.com>')).toBe('José Núñez');
    expect(senderName(`"=?UTF-8?Q?Andr=C3=A9?=" <andre@example.com>`)).toBe('André');
    expect(senderName('=?ISO-8859-1?Q?Fran=E7ois?= =?ISO-8859-1?Q?_M=FCller?= <f@example.com>')).toBe('François Müller');
  });

  it('takes the first of several senders, and ignores commas in quotes', () => {
    expect(senderName('Ada <ada@example.com>, Bob <bob@example.com>')).toBe('Ada');
    expect(senderName('"Lovelace, Ada" <ada@example.com>, Bob <bob@example.com>')).toBe('Lovelace, Ada');
  });

  it('reads the older address (Name) form', () => {
    expect(senderName('ada@example.com (Ada Lovelace)')).toBe('Ada Lovelace');
  });

  it('gives name and address apart', () => {
    expect(parseMailbox('Ada <ada@example.com>')).toEqual({ name: 'Ada', address: 'ada@example.com' });
  });

  it('cleans up spacing in a name', () => {
    expect(senderName('  Ada    Lovelace  <ada@example.com>')).toBe('Ada Lovelace');
  });
});

describe('cleanSubject', () => {
  it('decodes, joins lines and trims', () => {
    expect(cleanSubject('=?UTF-8?Q?Lunch_=F0=9F=8D=95?=')).toBe('Lunch 🍕');
    expect(cleanSubject('Long subject\r\n that wrapped')).toBe('Long subject that wrapped');
  });

  it('says so when there is none', () => {
    expect(cleanSubject('')).toBe('(no subject)');
    expect(cleanSubject('   ')).toBe('(no subject)');
    expect(cleanSubject(undefined)).toBe('(no subject)');
  });
});

describe('toMessage', () => {
  const raw = {
    id: 'm1',
    threadId: 't1',
    labelIds: ['INBOX', 'UNREAD'],
    internalDate: String(Date.UTC(2026, 9, 20, 12, 0)),
    snippet: 'See you at noon',
    payload: { headers: [{ name: 'From', value: '=?UTF-8?Q?Andr=C3=A9?= <a@example.com>' }, { name: 'subject', value: 'Lunch' }] },
  };

  it('keeps who, what, when, whether it is unread and where to open it', () => {
    expect(toMessage(raw)).toEqual({
      id: 'm1',
      threadId: 't1',
      from: 'André',
      subject: 'Lunch',
      date: '2026-10-20T12:00:00.000Z',
      unread: true,
      snippet: 'See you at noon',
      link: 'https://mail.google.com/mail/u/0/#inbox/t1',
    });
  });

  it('leaves the snippet out when Google did not send one', () => {
    const { snippet, ...without } = raw;
    expect('snippet' in toMessage(without)).toBe(false);
    expect('snippet' in toMessage({ ...raw, snippet: '  ' })).toBe(false);
  });

  it('is read when it has no UNREAD label, and survives missing headers', () => {
    expect(toMessage({ ...raw, labelIds: ['INBOX'] }).unread).toBe(false);
    expect(toMessage({ id: 'm', threadId: 't' })).toMatchObject({ from: '', subject: '(no subject)', date: '', unread: false });
  });

  it('links to the conversation', () => {
    expect(threadLink('18c0ffee')).toBe('https://mail.google.com/mail/u/0/#inbox/18c0ffee');
  });
});

describe('labels and lists', () => {
  it('shows one row per conversation, newest first, up to eight', () => {
    const list = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, threadId: `t${Math.floor(i / 2)}` }));
    const picked = onePerThread(list);
    expect(picked.map((m) => m.id)).toEqual(['m0', 'm2', 'm4', 'm6', 'm8', 'm10']);
    expect(onePerThread(Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, threadId: `t${i}` })))).toHaveLength(8);
    expect(onePerThread(undefined)).toEqual([]);
  });

  it('offers the main system labels first, then yours by name', () => {
    const labels = pickLabels([
      { id: 'SENT', name: 'SENT', type: 'system' },
      { id: 'Label_2', name: 'zebra', type: 'user' },
      { id: 'CATEGORY_SOCIAL', name: 'CATEGORY_SOCIAL', type: 'system' },
      { id: 'INBOX', name: 'INBOX', type: 'system' },
      { id: 'Label_1', name: 'Alpha', type: 'user' },
      { id: 'bad id!', name: 'Nope', type: 'user' },
    ]);
    expect(labels).toEqual([
      { id: 'INBOX', name: 'Inbox', system: true },
      { id: 'CATEGORY_SOCIAL', name: 'Social', system: true },
      { id: 'Label_1', name: 'Alpha', system: false },
      { id: 'Label_2', name: 'zebra', system: false },
    ]);
  });

  it('only takes a label that looks like an id', () => {
    expect(cleanLabel('Label_12')).toBe('Label_12');
    expect(cleanLabel('../threads')).toBe('INBOX');
    expect(cleanLabel('a/b')).toBe('INBOX');
    expect(cleanLabel(undefined)).toBe('INBOX');
  });

  it('opens only mail.google.com', () => {
    expect(safeMailUrl('https://mail.google.com/mail/u/0/#inbox/t1')).toBeTruthy();
    expect(safeMailUrl('https://evil.example/')).toBe('');
    expect(safeMailUrl('http://mail.google.com/')).toBe('');
    expect(safeMailUrl('https://mail.google.com.evil.example/')).toBe('');
  });
});

// ---- the routes, with a fake Google ----

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: new Headers() });

function fake({ scopes = GOOGLE_SCOPES.gmail, signedIn = true, answer, local = true } = {}) {
  const calls = [];
  const required = [];
  const google = {
    requireScopes: (list) => required.push(...list),
    hasScopes: async (list) => signedIn && list.every((s) => scopes.includes(s)),
    snapshot: async () => ({ signedIn, email: 'me@example.com', scopes }),
    fetch: async (url) => {
      calls.push(String(url));
      return answer(String(url));
    },
  };
  let clock = 1_000_000;
  const opened = [];
  const handle = createGmail({ google, isLocal: () => local, sendJson: (res, status, body) => (res.out = { status, body }), readJson: async (req) => req.body, open: (t) => opened.push(t), now: () => clock });
  return {
    calls,
    required,
    opened,
    tick: (ms) => (clock += ms),
    async route(pathname, { method = 'GET', body } = {}) {
      const res = {};
      await handle({ method, body }, res, new URL(pathname, 'http://127.0.0.1:5170'));
      return res.out;
    },
  };
}

const message = (id, threadId, from, subject, labelIds = ['INBOX'], extra = {}) => ({
  id,
  threadId,
  labelIds,
  internalDate: String(Date.UTC(2026, 9, 20, 12, 0)),
  payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }] },
  ...extra,
});
const gmail = (url) => {
  if (/\/labels\/INBOX\?/.test(url)) return json(200, { id: 'INBOX', name: 'INBOX', messagesUnread: 12, threadsUnread: 9 });
  if (/\/labels\/Label_9\?/.test(url)) return json(404, { error: { message: 'Not Found' } });
  if (/\/messages\?/.test(url)) return json(200, { messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't1' }, { id: 'm3', threadId: 't3' }] });
  if (/\/messages\/m1\?/.test(url)) return json(200, message('m1', 't1', 'Ada <ada@example.com>', 'Hello', ['INBOX', 'UNREAD']));
  if (/\/messages\/m3\?/.test(url)) return json(200, message('m3', 't3', '=?UTF-8?Q?Andr=C3=A9?= <a@example.com>', '=?UTF-8?B?44GT44KT44Gr44Gh44Gv?=', ['INBOX'], { snippet: 'hi' }));
  if (/\/labels\?/.test(url)) return json(200, { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'Label_1', name: 'Work', type: 'user' }] });
  return json(404, {});
};

describe('GET /api/gmail/summary', () => {
  it('asks for the metadata scope when it is made', () => {
    expect(fake({ answer: gmail }).required).toEqual(['https://www.googleapis.com/auth/gmail.metadata']);
  });

  it('gives the unread count and the latest conversations, headers only', async () => {
    const t = fake({ answer: gmail });
    const { status, body } = await t.route('/api/gmail/summary');
    expect(status).toBe(200);
    expect(body.unread).toBe(12);
    expect(body.label).toEqual({ id: 'INBOX', name: 'Inbox' });
    expect(body.messages.map((m) => [m.from, m.subject, m.unread, m.link])).toEqual([
      ['Ada', 'Hello', true, 'https://mail.google.com/mail/u/0/#inbox/t1'],
      ['André', 'こんにちは', false, 'https://mail.google.com/mail/u/0/#inbox/t3'],
    ]);
    expect(body.messages[0]).not.toHaveProperty('snippet');
    expect(body.messages[1].snippet).toBe('hi');
    // One message per conversation was fetched, and only as metadata with just the headers needed.
    const gets = t.calls.filter((c) => /\/messages\/m\d/.test(c));
    expect(gets).toHaveLength(2);
    for (const url of gets) {
      expect(url).toContain('format=metadata');
      expect(url).not.toContain('format=full');
      expect(url).not.toContain('format=raw');
    }
  });

  it('never uses the search query, which the metadata scope refuses', async () => {
    const t = fake({ answer: gmail });
    await t.route('/api/gmail/summary?unread=1');
    const list = t.calls.find((c) => /\/messages\?/.test(c));
    expect(new URL(list).searchParams.get('q')).toBeNull();
    expect(new URL(list).searchParams.getAll('labelIds')).toEqual(['INBOX', 'UNREAD']);
  });

  it('lists a label’s mail without the unread filter by default', async () => {
    const t = fake({ answer: gmail });
    await t.route('/api/gmail/summary?label=INBOX&unread=0');
    expect(new URL(t.calls.find((c) => /\/messages\?/.test(c))).searchParams.getAll('labelIds')).toEqual(['INBOX']);
  });

  it('keeps an answer for 60 seconds, per label and filter', async () => {
    const t = fake({ answer: gmail });
    await t.route('/api/gmail/summary');
    const first = t.calls.length;
    t.tick(59_000);
    await t.route('/api/gmail/summary');
    expect(t.calls.length).toBe(first);
    await t.route('/api/gmail/summary?unread=1');
    expect(t.calls.length).toBe(first * 2);
    t.tick(2_000);
    await t.route('/api/gmail/summary');
    expect(t.calls.length).toBe(first * 3);
  });

  it('says so when the watched label has gone', async () => {
    const t = fake({ answer: gmail });
    expect(await t.route('/api/gmail/summary?label=Label_9')).toMatchObject({ status: 404, body: { code: 'label' } });
  });

  it('does not let a label change the path it asks for', async () => {
    const t = fake({ answer: gmail });
    await t.route('/api/gmail/summary?label=..%2Fthreads');
    expect(t.calls.some((c) => c.includes('/threads') || c.includes('..'))).toBe(false);
    expect(t.calls.some((c) => /\/labels\/INBOX\?/.test(c))).toBe(true);
  });

  it('asks for Gmail access when the sign-in is only for Drive, without calling Google', async () => {
    const t = fake({ scopes: ['openid', 'email', ...GOOGLE_SCOPES.drive], answer: gmail });
    expect(await t.route('/api/gmail/summary')).toMatchObject({ status: 401, body: { code: 'scope' } });
    expect(await t.route('/api/gmail/labels')).toMatchObject({ status: 401, body: { code: 'scope' } });
    expect(t.calls).toEqual([]);
  });

  it('says to sign in first when not signed in', async () => {
    const t = fake({ signedIn: false, scopes: [], answer: gmail });
    expect(await t.route('/api/gmail/summary')).toMatchObject({ status: 401, body: { code: 'signin' } });
  });

  it('explains a Gmail API that is not turned on', async () => {
    const t = fake({ answer: () => json(403, { error: { message: 'Gmail API has not been used in project 1 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } }) });
    const { status, body } = await t.route('/api/gmail/summary');
    expect(status).toBe(403);
    expect(body.code).toBe('api');
  });

  it('is for this PC only', async () => {
    const t = fake({ answer: gmail, local: false });
    expect((await t.route('/api/gmail/summary')).status).toBe(403);
    expect(t.calls).toEqual([]);
  });
});

describe('GET /api/gmail/labels and POST /api/gmail/open', () => {
  it('lists the labels to pick from', async () => {
    const t = fake({ answer: gmail });
    expect((await t.route('/api/gmail/labels')).body.labels).toEqual([
      { id: 'INBOX', name: 'Inbox', system: true },
      { id: 'Label_1', name: 'Work', system: false },
    ]);
  });

  it('opens a Gmail link, and nothing else', async () => {
    const t = fake({ answer: gmail });
    expect((await t.route('/api/gmail/open', { method: 'POST', body: { url: 'https://mail.google.com/mail/u/0/#inbox/t1' } })).status).toBe(200);
    for (const body of [{ url: 'https://evil.example/' }, { url: 'file:///C:/x' }, {}]) {
      expect((await t.route('/api/gmail/open', { method: 'POST', body })).status).toBe(400);
    }
    expect(t.opened).toEqual(['https://mail.google.com/mail/u/0/#inbox/t1']);
  });
});
