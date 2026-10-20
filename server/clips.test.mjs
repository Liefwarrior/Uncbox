// Clip names, and the clip routes against a real server on a temporary folder. Sending to Discord
// itself is covered with a fake fetch in webhook.test.mjs; nothing here can reach a real webhook.

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NAME, clipName } from './clipnames.mjs';
import { createClips } from './clips.mjs';

describe('clip names', () => {
  const at = new Date(2026, 9, 18, 21, 5, 9);

  it('names a clip by when it was saved', () => {
    expect(clipName(at)).toBe('Uncbox 2026-10-18 21-05-09.mp4');
  });

  it('marks a vertical one, and numbers clips made in the same second', () => {
    expect(clipName(at, 'vertical')).toBe('Uncbox 2026-10-18 21-05-09 vertical.mp4');
    expect(clipName(at, 'clip', 2)).toBe('Uncbox 2026-10-18 21-05-09 2.mp4');
    expect(clipName(at, 'vertical', 3)).toBe('Uncbox 2026-10-18 21-05-09 vertical 3.mp4');
  });

  it('only recognises names it made', () => {
    for (const kind of ['clip', 'vertical']) for (const n of [1, 2, 10]) expect(NAME.test(clipName(at, kind, n))).toBe(true);
    for (const bad of [
      '../Uncbox 2026-10-18 21-05-09.mp4',
      'Uncbox 2026-10-18 21-05-09.mp4.part',
      'Uncbox 2026-10-18 21-05-09 horizontal.mp4',
      'Uncbox 2026-10-18 21-05-09 vertical vertical.mp4',
      'Uncbox 2026-10-18 21-05-09.mp4\n',
      'Uncbox  .mp4',
      'Uncbox 2026-10-18/21-05-09.mp4',
      'Uncbox 1-2-3 4-5-6.mp4',
    ]) {
      expect(NAME.test(bad)).toBe(false);
    }
  });
});

describe('clip routes', () => {
  let tmp = '';
  let server;
  let clips;
  let base = '';
  let local = true;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'uncbox-clips-'));
    local = true;
    const sendJson = (res, status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const readJson = async (req) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    };
    clips = createClips({
      clipsDir: path.join(tmp, 'clips'),
      dataDir: path.join(tmp, 'data'),
      broadcastEvent: () => {},
      isLocal: () => local,
      sendJson,
      readJson,
    });
    server = http.createServer((req, res) => void clips.handle(req, res, new URL(req.url, 'http://x')));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/clips`;
  });

  afterEach(async () => {
    clips.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  });

  const post = (url, body, type = 'application/json') =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': type }, body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) });

  it('saves a vertical clip under its own name and lists it', async () => {
    const res = await post(`${base}?kind=vertical`, new Uint8Array([1, 2, 3]), 'video/mp4');
    const { name } = await res.json();
    expect(name).toMatch(/^Uncbox \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2} vertical\.mp4$/);
    expect(await readdir(path.join(tmp, 'clips'))).toEqual([name]);
    const list = await (await fetch(base)).json();
    expect(list.clips.map((c) => c.name)).toEqual([name]);
  });

  it('keeps an unlabelled upload a normal clip, and turns away unknown kinds', async () => {
    const { name } = await (await post(base, new Uint8Array([1]), 'video/mp4')).json();
    expect(name).not.toContain('vertical');
    const bad = await post(`${base}?kind=../x`, new Uint8Array([1]), 'video/mp4');
    expect(bad.status).toBe(400);
  });

  it('keeps the webhook to itself: set, replace and remove, never read back', async () => {
    const url = 'https://discord.com/api/webhooks/123456789012345678/abcDEF_123-ghiJKL456mnoPQR789stuVWX';
    expect(await (await fetch(`${base}/discord`)).json()).toEqual({ set: false, hint: '' });

    const bad = await post(`${base}/discord`, { url: 'https://example.com/hook' });
    expect(bad.status).toBe(400);

    const set = await post(`${base}/discord`, { url });
    const body = await set.text();
    expect(JSON.parse(body)).toEqual({ set: true, hint: `…${url.slice(-4)}` });
    expect(body).not.toContain('abcDEF');
    expect(await (await fetch(`${base}/discord`)).text()).not.toContain('abcDEF');
    // The clip listing, which anyone on the network can read, says nothing about it either.
    expect(await (await fetch(base)).text()).not.toContain('abcDEF');

    expect(await (await post(`${base}/discord/remove`, {})).json()).toEqual({ set: false, hint: '' });
  });

  it('asks for a webhook before sending anything', async () => {
    const res = await post(`${base}/discord/send`, { name: clipName() });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/webhook/);
  });

  it('refuses every Discord route from another PC', async () => {
    local = false;
    for (const [method, route] of [
      ['GET', '/discord'],
      ['POST', '/discord'],
      ['POST', '/discord/remove'],
      ['POST', '/discord/send'],
    ]) {
      const res = await fetch(base + route, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
      expect(res.status, `${method} ${route}`).toBe(403);
    }
  });

  it('hands each new clip to the Drive upload only while "upload new clips" is on', async () => {
    const handed = [];
    clips.onSaved((name, options) => handed.push([name, options]));
    // Off to start with, and after settings with no Drive keys.
    clips.configure(null);
    await post(base, new Uint8Array([1]), 'video/mp4');
    clips.configure({ enabled: false, key: 'Equal' });
    await post(base, new Uint8Array([1]), 'video/mp4');
    expect(handed).toEqual([]);

    clips.configure({ enabled: false, key: 'Equal', driveAuto: true, driveShare: true });
    const { name } = await (await post(base, new Uint8Array([1]), 'video/mp4')).json();
    expect(handed).toEqual([[name, { share: true }]]);

    // Vertical shorts are made by hand, so they don't go up on their own.
    await post(`${base}?kind=vertical`, new Uint8Array([1]), 'video/mp4');
    expect(handed).toHaveLength(1);
  });
});
