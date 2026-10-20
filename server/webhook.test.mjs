// The Discord webhook: which URLs are accepted, how Discord's answers read, and what is posted.
// Nothing here touches the network: sending goes through a fake fetch.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWebhookStore, discordProblem, parseWebhook, sendToWebhook } from './webhook.mjs';

const ID = '123456789012345678';
const TOKEN = 'abcDEF_123-ghiJKL456mnoPQR789stuVWX';
const URL_OK = `https://discord.com/api/webhooks/${ID}/${TOKEN}`;

describe('parseWebhook', () => {
  it('accepts what Discord hands out', () => {
    expect(parseWebhook(URL_OK)).toEqual({ url: URL_OK, hint: `…${TOKEN.slice(-4)}` });
    expect(parseWebhook(`https://discordapp.com/api/webhooks/${ID}/${TOKEN}`)?.url).toContain('discordapp.com');
    expect(parseWebhook(`https://discord.com/api/v10/webhooks/${ID}/${TOKEN}`)).not.toBeNull();
  });

  it('ignores spaces around a pasted URL', () => {
    expect(parseWebhook(`  ${URL_OK}\n`)?.url).toBe(URL_OK);
  });

  it('only ever says the last four characters of the token', () => {
    const hint = parseWebhook(URL_OK)?.hint ?? '';
    expect(hint).toBe(`…${TOKEN.slice(-4)}`);
    expect(hint).not.toContain(ID);
  });

  it.each([
    ['', 'nothing'],
    ['not a url', 'text'],
    [`http://discord.com/api/webhooks/${ID}/${TOKEN}`, 'plain http'],
    [`https://evil.example/api/webhooks/${ID}/${TOKEN}`, 'another host'],
    [`https://discord.com.evil.example/api/webhooks/${ID}/${TOKEN}`, 'a look-alike host'],
    [`https://evil.example/discord.com/api/webhooks/${ID}/${TOKEN}`, 'discord.com in the path'],
    [`https://user:pw@discord.com/api/webhooks/${ID}/${TOKEN}`, 'credentials in the URL'],
    [`https://discord.com:8443/api/webhooks/${ID}/${TOKEN}`, 'a port'],
    [`https://cdn.discord.com/api/webhooks/${ID}/${TOKEN}`, 'another discord.com host'],
    [`${URL_OK}?wait=true`, 'a query'],
    [`${URL_OK}/extra`, 'extra path'],
    [`https://discord.com/api/webhooks/${ID}`, 'no token'],
    [`https://discord.com/api/webhooks/abc/${TOKEN}`, 'a non-numeric id'],
    [`https://discord.com/api/webhooks/${ID}/short`, 'a short token'],
    [`https://discord.com/api/webhooks/${ID}/${TOKEN}\nhttps://evil.example`, 'a second line'],
  ])('rejects %s (%s)', (input) => {
    expect(parseWebhook(input)).toBeNull();
  });

  it('rejects anything that is not text', () => {
    expect(parseWebhook(undefined)).toBeNull();
    expect(parseWebhook({ url: URL_OK })).toBeNull();
  });
});

describe('discordProblem', () => {
  it('explains a webhook Discord no longer knows', () => {
    for (const status of [401, 403, 404]) expect(discordProblem(status)).toMatch(/webhook/);
  });

  it('says how long to wait when Discord asks to slow down', () => {
    expect(discordProblem(429, '', 2.2)).toBe('Discord asks you to slow down. Try again in 3 seconds.');
    expect(discordProblem(429, '', 0)).toBe('Discord asks you to slow down. Try again in 1 second.');
  });

  it('passes on what Discord said for other refusals, and copes with silence', () => {
    expect(discordProblem(400, 'Cannot send an empty message')).toBe('Discord said no: Cannot send an empty message');
    expect(discordProblem(400)).toBe('Discord said no (400).');
    expect(discordProblem(503)).toMatch(/trouble/);
    expect(discordProblem(413)).toMatch(/too big/);
  });
});

describe('sendToWebhook', () => {
  const bytes = Buffer.from('not really a video');

  it('posts the file and a short message as multipart', async () => {
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url, init };
      return new Response(null, { status: 204 });
    };
    expect(await sendToWebhook(URL_OK, bytes, 'Uncbox 2026-10-18 21-30-05.mp4', fetchImpl)).toEqual({ ok: true });
    expect(seen.url).toBe(URL_OK);
    expect(seen.init.method).toBe('POST');
    expect(seen.init.redirect).toBe('error');
    const form = seen.init.body;
    expect(JSON.parse(form.get('payload_json'))).toEqual({ content: 'Clip from Uncbox' });
    const file = form.get('files[0]');
    expect(file.name).toBe('Uncbox 2026-10-18 21-30-05.mp4');
    expect(file.type).toBe('video/mp4');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
  });

  it('turns Discord’s refusal into words', async () => {
    const fetchImpl = async () => Response.json({ message: 'Unknown Webhook', code: 10015 }, { status: 404 });
    const result = await sendToWebhook(URL_OK, bytes, 'a.mp4', fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/webhook/);
  });

  it('never repeats the URL when the connection fails', async () => {
    const fetchImpl = async (url) => {
      throw new TypeError(`fetch failed for ${url}`);
    };
    const result = await sendToWebhook(URL_OK, bytes, 'a.mp4', fetchImpl);
    expect(result).toEqual({ ok: false, status: 502, error: 'Couldn’t reach Discord. Check your internet connection.' });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe('createWebhookStore', () => {
  let dir = '';
  afterEach(() => dir && rm(dir, { recursive: true, force: true }));

  it('keeps the URL in its own file and forgets it on request', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'uncbox-webhook-'));
    const store = createWebhookStore(dir);
    expect(await store.get()).toBe('');
    await store.set(URL_OK);
    expect(await store.get()).toBe(URL_OK);
    expect(JSON.parse(await readFile(path.join(dir, 'clips-discord.json'), 'utf8'))).toEqual({ url: URL_OK });
    await store.clear();
    expect(await store.get()).toBe('');
    await store.clear();
  });

  it('does not trust a file that was edited into something else', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'uncbox-webhook-'));
    const store = createWebhookStore(dir);
    await store.set('https://evil.example/hook');
    expect(await store.get()).toBe('');
  });
});
