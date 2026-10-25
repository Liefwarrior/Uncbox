// Saving clips to Google Drive: the resumable upload (pieces, 308 answers, retries, resuming from
// what Google reports), finding or making the "Uncbox Clips" folder, which names are accepted, and
// cancelling. All of it runs against a fake Drive; nothing reaches Google.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FOLDER_NAME, clipPath, createDriveUpload, receivedFrom } from './driveupload.mjs';

const CLIP = 'Uncbox 2026-10-18 21-30-05.mp4';
const OTHER = 'Uncbox 2026-10-18 21-31-00 vertical.mp4';
const CONTENT = Buffer.from('0123456789abcdefghijklmno'); // 25 bytes: three pieces of 10

/** A stand-in for the bits of Google Drive the upload talks to. */
function fakeDrive() {
  const d = {
    folders: [], // { id, name, trashed }
    uploads: [], // { metadata, session }
    sessions: new Map(), // session address -> { metadata, data: Buffer, complete }
    permissions: [],
    calls: [], // 'METHOD url' in order
    ranges: [], // Content-Range of each PUT
    /** What the next piece PUTs do instead of working: { status, keep? } or { drop: true }. */
    failures: [],
    /** Held PUTs wait for this before answering (for the cancel test). */
    gate: null,
    nextId: 1,
    lastShareStatus: 200,
  };

  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

  d.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    d.calls.push(`${method} ${u.pathname}${u.search.includes('uploadType') ? '?resumable' : ''}`);
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { status: 502 });

    if (u.pathname.startsWith('/upload/session/')) return d.session(url, init, method);

    if (u.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const metadata = JSON.parse(init.body);
      if (!d.folders.some((f) => f.id === metadata.parents[0] && !f.trashed)) return json(404, { error: { message: 'File not found' } });
      const session = `https://www.googleapis.com/upload/session/${d.nextId++}`;
      d.sessions.set(session, { metadata, data: Buffer.alloc(0), complete: false, headers: init.headers });
      d.uploads.push({ metadata, session, headers: init.headers });
      return new Response(null, { status: 200, headers: { Location: session } });
    }

    if (u.pathname === '/drive/v3/files' && method === 'GET') {
      const q = u.searchParams.get('q');
      const match = d.folders.filter((f) => !f.trashed && q.includes(`name = '${f.name}'`));
      return json(200, { files: match.slice(0, 1).map((f) => ({ id: f.id })) });
    }
    if (u.pathname === '/drive/v3/files' && method === 'POST') {
      const body = JSON.parse(init.body);
      const folder = { id: `folder${d.nextId++}`, name: body.name, trashed: false, mimeType: body.mimeType };
      d.folders.push(folder);
      return json(200, { id: folder.id });
    }
    const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (one && method === 'GET') {
      const f = d.folders.find((x) => x.id === one[1]);
      return f ? json(200, { id: f.id, trashed: f.trashed }) : json(404, { error: { message: 'File not found' } });
    }
    const perm = /^\/drive\/v3\/files\/([^/]+)\/permissions$/.exec(u.pathname);
    if (perm && method === 'POST') {
      d.permissions.push({ id: perm[1], ...JSON.parse(init.body) });
      return d.lastShareStatus === 200 ? json(200, { id: 'p' }) : json(d.lastShareStatus, { error: { message: 'nope' } });
    }
    throw new Error(`unexpected call ${method} ${url}`);
  };

  d.session = async (url, init, method) => {
    const s = d.sessions.get(url);
    if (!s) return json(404, {});
    if (method === 'DELETE') {
      d.sessions.delete(url);
      return new Response(null, { status: 499 });
    }
    const range = init.headers['Content-Range'];
    d.ranges.push(range);
    const ask = /^bytes \*\/(\d+)$/.exec(range);
    const piece = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    const total = Number((ask ?? piece)[ask ? 1 : 3]);
    const reply = () =>
      s.data.length >= total
        ? ((s.complete = true), json(200, { id: 'file1', name: s.metadata.name, webViewLink: 'https://drive.google.com/file/d/file1/view' }))
        : new Response(null, { status: 308, headers: s.data.length ? { Range: `bytes=0-${s.data.length - 1}` } : {} });
    if (ask) return reply();

    if (d.gate) {
      await new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')), { once: true });
        d.gate.then(resolve);
      });
    }
    const failure = d.failures.shift();
    const start = Number(piece[1]);
    const body = Buffer.from(init.body ?? []);
    // Google only takes a piece that starts exactly where it is up to.
    if (start !== s.data.length) throw new Error(`piece starts at ${start} but Drive has ${s.data.length}`);
    if (failure?.drop) throw Object.assign(new Error('Couldn’t reach Google.'), { status: 502 });
    if (failure) {
      if (failure.keep) s.data = Buffer.concat([s.data, body.subarray(0, failure.keep)]);
      return json(failure.status, { error: { message: 'backend error' } });
    }
    s.data = Buffer.concat([s.data, body]);
    return reply();
  };

  return d;
}

let dir;
let drive;
let events;
let sleeps;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'uncbox-driveupload-'));
  await writeFile(path.join(dir, CLIP), CONTENT);
  await writeFile(path.join(dir, OTHER), CONTENT);
  drive = fakeDrive();
  events = [];
  sleeps = [];
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function make({ signedIn = true, local = true, scoped = true } = {}) {
  const google = {
    fetch: (url, init) => drive.fetch(url, init),
    requireScopes() {},
    snapshot: async () => ({ signedIn }),
    hasScopes: async () => scoped,
  };
  const up = createDriveUpload({
    google,
    dir: Promise.resolve(dir),
    dataDir: dir,
    broadcastEvent: (name, data) => events.push([name, data]),
    isLocal: () => local,
    sendJson: (res, status, body) => (res.out = { status, body }),
    readJson: async (req) => req.body,
    chunk: 10,
    sleep: async (ms) => void sleeps.push(ms),
  });
  const call = async (pathname, body) => {
    const res = {};
    await up.handle({ method: 'POST', body }, res, new URL(`http://x${pathname}`));
    return res.out;
  };
  return { up, call };
}

const uploadEvents = () => events.filter(([n]) => n === 'driveupload').map(([, d]) => d);
const received = () => [...drive.sessions.values()][0]?.data;

describe('receivedFrom', () => {
  it('reads the next byte to send from a Range header', () => {
    expect(receivedFrom('bytes=0-9')).toBe(10);
    expect(receivedFrom('bytes=0-8388607')).toBe(8388608);
  });
  it('is 0 when Google has nothing yet', () => {
    expect(receivedFrom(null)).toBe(0);
    expect(receivedFrom('')).toBe(0);
  });
});

describe('clipPath', () => {
  it('accepts the names clips are saved under', () => {
    expect(clipPath('C:/clips', CLIP)).toBe(path.join('C:/clips', CLIP));
    expect(clipPath('C:/clips', OTHER)).toBeTruthy();
    expect(clipPath('C:/clips', 'Uncbox 2026-10-18 21-30-05 2.mp4')).toBeTruthy();
  });
  it('turns away anything that could leave the folder or isn’t a clip', () => {
    for (const bad of [
      '../Uncbox 2026-10-18 21-30-05.mp4',
      '..\\Uncbox 2026-10-18 21-30-05.mp4',
      'sub/Uncbox 2026-10-18 21-30-05.mp4',
      'C:\\Windows\\system.ini',
      '/etc/passwd',
      'Uncbox 2026-10-18 21-30-05.mp4/../../x',
      'Uncbox 2026-10-18 21-30-05.mp4.part',
      'notes.txt',
      '',
      null,
      42,
    ]) {
      expect(clipPath('C:/clips', bad)).toBeNull();
    }
  });
});

describe('POST /api/drive/upload: the resumable upload', () => {
  it('sends the clip in pieces and answers with the link', async () => {
    const { call } = make();
    const out = await call('/api/drive/upload', { name: CLIP });
    expect(out).toEqual({ status: 200, body: { id: 'file1', name: CLIP, link: 'https://drive.google.com/file/d/file1/view', shared: false } });
    expect(received()).toEqual(CONTENT);
    expect(drive.ranges).toEqual(['bytes 0-9/25', 'bytes 10-19/25', 'bytes 20-24/25']);
  });

  it('starts the session with the clip’s name, type, size and the folder', async () => {
    const { call } = make();
    await call('/api/drive/upload', { name: CLIP });
    const [started] = drive.uploads;
    expect(started.metadata).toMatchObject({ name: CLIP, mimeType: 'video/mp4', parents: [drive.folders[0].id] });
    expect(started.headers['X-Upload-Content-Length']).toBe('25');
    expect(started.headers['X-Upload-Content-Type']).toBe('video/mp4');
  });

  it('reports progress as driveupload events, ending with done and the link', async () => {
    const { call } = make();
    await call('/api/drive/upload', { name: CLIP });
    const seen = uploadEvents();
    expect(seen.map((e) => e.sent).slice(0, 3)).toEqual([0, 10, 20]);
    expect(seen[0]).toMatchObject({ name: CLIP, total: 25, done: false, error: '', link: '' });
    expect(seen.at(-1)).toMatchObject({ name: CLIP, done: true, error: '', link: 'https://drive.google.com/file/d/file1/view' });
  });

  it('tries a piece again after a 5xx, after asking Google where it is up to', async () => {
    const { call } = make();
    drive.failures.push(undefined, { status: 503 });
    const out = await call('/api/drive/upload', { name: CLIP });
    expect(out.status).toBe(200);
    expect(received()).toEqual(CONTENT);
    expect(sleeps).toEqual([1000]);
    expect(drive.ranges).toEqual(['bytes 0-9/25', 'bytes 10-19/25', 'bytes */25', 'bytes 10-19/25', 'bytes 20-24/25']);
  });

  it('tries again after the connection drops', async () => {
    const { call } = make();
    drive.failures.push({ drop: true });
    expect((await call('/api/drive/upload', { name: CLIP })).status).toBe(200);
    expect(received()).toEqual(CONTENT);
    expect(sleeps).toEqual([1000]);
  });

  it('resumes from the offset Google reports, not the one it sent', async () => {
    const { call } = make();
    // Google kept 4 bytes of the second piece before failing.
    drive.failures.push(undefined, { status: 500, keep: 4 });
    const out = await call('/api/drive/upload', { name: CLIP });
    expect(out.status).toBe(200);
    expect(received()).toEqual(CONTENT);
    expect(drive.ranges).toEqual(['bytes 0-9/25', 'bytes 10-19/25', 'bytes */25', 'bytes 14-23/25', 'bytes 24-24/25']);
  });

  it('starts over from the beginning when a 308 has no Range (Google has nothing)', async () => {
    const { call } = make();
    drive.failures.push({ status: 502 });
    const out = await call('/api/drive/upload', { name: CLIP });
    expect(out.status).toBe(200);
    expect(drive.ranges.slice(0, 3)).toEqual(['bytes 0-9/25', 'bytes */25', 'bytes 0-9/25']);
  });

  it('backs off longer each time, then gives up with a plain message', async () => {
    const { call } = make();
    drive.failures.push(...Array.from({ length: 10 }, () => ({ status: 503 })));
    const out = await call('/api/drive/upload', { name: CLIP });
    expect(out.status).toBe(502);
    expect(out.body.error).toMatch(/Couldn’t reach Google Drive/);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000]);
    expect(uploadEvents().at(-1)).toMatchObject({ done: true, error: expect.stringMatching(/Couldn’t reach/) });
  });

  it('a good answer resets the count of failures', async () => {
    const { call } = make();
    // Each of the three pieces fails 3 times before it works: never five in a row.
    drive.failures.push(
      { status: 503 }, { status: 503 }, { status: 503 }, // piece 1
      undefined,
      { status: 503 }, { status: 503 }, { status: 503 }, // piece 2
    );
    expect((await call('/api/drive/upload', { name: CLIP })).status).toBe(200);
  });

  it('stops at a real refusal instead of retrying', async () => {
    const { call } = make();
    drive.failures.push({ status: 403 });
    const out = await call('/api/drive/upload', { name: CLIP });
    expect(out.status).toBe(502);
    expect(sleeps).toEqual([]);
  });

  it('sets "anyone with the link can view" only when asked', async () => {
    const { call } = make();
    expect((await call('/api/drive/upload', { name: CLIP })).body.shared).toBe(false);
    expect(drive.permissions).toEqual([]);
    const shared = await call('/api/drive/upload', { name: OTHER, share: true });
    expect(shared.body).toMatchObject({ shared: true, link: 'https://drive.google.com/file/d/file1/view' });
    expect(drive.permissions).toEqual([{ id: 'file1', role: 'reader', type: 'anyone' }]);
  });

  it('still counts as saved when only the sharing is refused', async () => {
    const { call } = make();
    drive.lastShareStatus = 403;
    const out = await call('/api/drive/upload', { name: CLIP, share: true });
    expect(out.status).toBe(200);
    expect(out.body.shared).toBe(false);
  });

  it('says so when the clip is gone or empty', async () => {
    const { call } = make();
    await rm(path.join(dir, CLIP));
    expect((await call('/api/drive/upload', { name: CLIP })).status).toBe(404);
    await writeFile(path.join(dir, OTHER), '');
    expect((await call('/api/drive/upload', { name: OTHER })).body.error).toMatch(/empty/);
  });
});

describe('the Uncbox Clips folder', () => {
  const cache = () => readFile(path.join(dir, 'google-drive-upload.json'), 'utf8').then(JSON.parse);

  it('is made once and remembered', async () => {
    const { call } = make();
    await call('/api/drive/upload', { name: CLIP });
    expect(drive.folders).toHaveLength(1);
    expect(drive.folders[0].name).toBe(FOLDER_NAME);
    expect(drive.folders[0].mimeType).toBe('application/vnd.google-apps.folder');
    expect(await cache()).toEqual({ folderId: drive.folders[0].id });

    drive.calls.length = 0;
    await call('/api/drive/upload', { name: OTHER });
    expect(drive.folders).toHaveLength(1);
    // The second time it only checks the remembered folder is still there.
    expect(drive.calls.filter((c) => c.startsWith('POST /drive/v3/files'))).toEqual([]);
    expect(drive.calls.filter((c) => c === 'GET /drive/v3/files')).toEqual([]);
  });

  it('uses a folder of that name that is already there instead of making another', async () => {
    drive.folders.push({ id: 'existing', name: FOLDER_NAME, trashed: false });
    const { call } = make();
    await call('/api/drive/upload', { name: CLIP });
    expect(drive.folders).toHaveLength(1);
    expect(drive.uploads[0].metadata.parents).toEqual(['existing']);
    expect(await cache()).toEqual({ folderId: 'existing' });
  });

  it('is found again by name when the remembered one was deleted', async () => {
    drive.folders.push({ id: 'other-copy', name: FOLDER_NAME, trashed: false });
    await writeFile(path.join(dir, 'google-drive-upload.json'), JSON.stringify({ folderId: 'deleted' }));
    const { call } = make();
    await call('/api/drive/upload', { name: CLIP });
    expect(drive.uploads[0].metadata.parents).toEqual(['other-copy']);
    expect(await cache()).toEqual({ folderId: 'other-copy' });
  });

  it('is made again when the remembered one was deleted and none is left', async () => {
    await writeFile(path.join(dir, 'google-drive-upload.json'), JSON.stringify({ folderId: 'deleted' }));
    const { call } = make();
    await call('/api/drive/upload', { name: CLIP });
    expect(drive.folders).toHaveLength(1);
    expect((await cache()).folderId).toBe(drive.folders[0].id);
  });

  it('is not used when it is in the trash', async () => {
    drive.folders.push({ id: 'trashed', name: FOLDER_NAME, trashed: true });
    await writeFile(path.join(dir, 'google-drive-upload.json'), JSON.stringify({ folderId: 'trashed' }));
    const { call } = make();
    await call('/api/drive/upload', { name: CLIP });
    expect(drive.uploads[0].metadata.parents).not.toEqual(['trashed']);
    expect(drive.folders.filter((f) => !f.trashed)).toHaveLength(1);
  });

  it('is made again if it vanishes between the check and the upload', async () => {
    drive.folders.push({ id: 'f0', name: FOLDER_NAME, trashed: false });
    const { call } = make();
    // The check passes, then the folder is deleted before the upload starts.
    const real = drive.fetch;
    let armed = true;
    drive.fetch = async (url, init) => {
      if (armed && init?.method === 'POST' && url.includes('/upload/drive/v3/files')) {
        armed = false;
        drive.folders.length = 0;
      }
      return real(url, init);
    };
    const out = await call('/api/drive/upload', { name: CLIP });
    expect(out.status).toBe(200);
    expect(drive.folders).toHaveLength(1);
  });
});

describe('which requests are taken', () => {
  it('only from the PC Uncbox runs on', async () => {
    const { call } = make({ local: false });
    expect((await call('/api/drive/upload', { name: CLIP })).status).toBe(403);
    expect((await call('/api/drive/upload/cancel', { name: CLIP })).status).toBe(403);
    expect(drive.calls).toEqual([]);
  });

  it('refuses names that aren’t saved clips, before touching Drive', async () => {
    const { call } = make();
    for (const name of ['../secret.mp4', 'C:\\x.mp4', 'Uncbox 2026-10-18 21-30-05.mp4/../../x.mp4', '', undefined, 7]) {
      const out = await call('/api/drive/upload', { name });
      expect(out.status).toBe(400);
    }
    expect(drive.calls).toEqual([]);
  });

  it('asks to sign in when not signed in', async () => {
    const { call } = make({ signedIn: false });
    const out = await call('/api/drive/upload', { name: CLIP });
    expect(out.status).toBe(401);
    expect(out.body).toMatchObject({ code: 'signin', error: expect.stringMatching(/Sign in to Google/) });
    expect(drive.calls).toEqual([]);
  });

  it('asks to sign in again when the sign-in lacks the Drive permission', async () => {
    const { call } = make({ scoped: false });
    const out = await call('/api/drive/upload', { name: CLIP });
    expect(out.status).toBe(403);
    expect(out.body.code).toBe('scope');
  });

  it('knows nothing else under /api/drive/upload', async () => {
    const { call } = make();
    expect((await call('/api/drive/upload/other', {})).status).toBe(404);
  });
});

describe('one at a time, and cancelling', () => {
  /** Lets the first piece wait in Drive until `release()`. */
  function hold() {
    let release;
    drive.gate = new Promise((resolve) => (release = resolve));
    return () => release();
  }
  const until = async (fn) => {
    for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
  };

  it('turns a second upload away while one is going', async () => {
    const { call } = make();
    const release = hold();
    const first = call('/api/drive/upload', { name: CLIP });
    await until(() => drive.ranges.length > 0);
    const second = await call('/api/drive/upload', { name: OTHER });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('busy');
    drive.gate = null;
    release();
    expect((await first).status).toBe(200);
  });

  it('cancel stops the upload, tells Drive to drop it, and says so', async () => {
    const { call } = make();
    hold();
    const going = call('/api/drive/upload', { name: CLIP });
    await until(() => drive.ranges.length > 0);
    expect(await call('/api/drive/upload/cancel', { name: CLIP })).toEqual({ status: 200, body: { ok: true } });
    const out = await going;
    expect(out.status).toBe(499);
    expect(out.body.cancelled).toBe(true);
    expect(uploadEvents().at(-1)).toMatchObject({ name: CLIP, done: true, error: '', cancelled: true });
    await until(() => drive.calls.some((c) => c.startsWith('DELETE')));
    expect(drive.calls.some((c) => c.startsWith('DELETE /upload/session/'))).toBe(true);
    // The next upload is free to start.
    drive.gate = null;
    expect((await call('/api/drive/upload', { name: CLIP })).status).toBe(200);
  });

  it('cancel for a clip that isn’t uploading does nothing', async () => {
    const { call } = make();
    hold();
    const going = call('/api/drive/upload', { name: CLIP });
    await until(() => drive.ranges.length > 0);
    await call('/api/drive/upload/cancel', { name: OTHER });
    await call('/api/drive/upload/cancel', { name: '../nope' });
    expect(uploadEvents().some((e) => e.cancelled)).toBe(false);
    await call('/api/drive/upload/cancel', { name: CLIP });
    await going;
  });

  it('auto-upload queues clips and sends them one after another', async () => {
    const { up } = make();
    const release = hold();
    await up.queue(CLIP, { share: false });
    await until(() => drive.ranges.length > 0);
    await up.queue(OTHER, { share: false });
    drive.gate = null;
    release();
    await until(() => uploadEvents().filter((e) => e.done).length === 2);
    const done = uploadEvents().filter((e) => e.done);
    expect(done.map((e) => e.name)).toEqual([CLIP, OTHER]);
    expect(done.every((e) => !e.error)).toBe(true);
    expect(drive.uploads.map((u) => u.metadata.name)).toEqual([CLIP, OTHER]);
  });

  it('auto-upload when not signed in reports it on the clip rather than throwing', async () => {
    const { up } = make({ signedIn: false });
    await up.queue(CLIP, {});
    expect(uploadEvents()).toEqual([expect.objectContaining({ name: CLIP, done: true, error: expect.stringMatching(/Sign in to Google/) })]);
    expect(drive.calls).toEqual([]);
  });

  it('a waiting clip can be cancelled before its turn', async () => {
    const { up, call } = make();
    const release = hold();
    await up.queue(CLIP, {});
    await until(() => drive.ranges.length > 0);
    await up.queue(OTHER, {});
    await call('/api/drive/upload/cancel', { name: OTHER });
    drive.gate = null;
    release();
    await until(() => uploadEvents().some((e) => e.name === CLIP && e.done));
    await new Promise((r) => setTimeout(r, 30));
    expect(drive.uploads.map((u) => u.metadata.name)).toEqual([CLIP]);
    expect(uploadEvents().find((e) => e.name === OTHER && e.done)).toMatchObject({ cancelled: true });
  });
});
