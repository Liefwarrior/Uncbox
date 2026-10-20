// Saving clips to Google Drive. A saved clip is uploaded to a folder called "Uncbox Clips" in the
// signed-in person's Drive (server/google.mjs), using Drive's resumable upload: the file goes up in
// 8 MB pieces, a piece that fails is tried again, and if the connection drops the upload carries on
// from however much Google says it has.
//
//   POST /api/drive/upload         { name, share? }: uploads that saved clip. Answers when it is done
//                                  with { id, name, link, shared }. With share, anyone with the link
//                                  can view it. Progress goes out as the "driveupload" event:
//                                  { name, sent, total, done, error, link }
//   POST /api/drive/upload/cancel  { name }: stops that upload
//
// Only the drive.file scope is used, which sees just the files and folders this app made. One file
// goes up at a time; clips saved while one is going wait their turn. Local PC only. The folder's id
// is kept in data/google-drive-upload.json, and found again by name if it was deleted.

import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NAME } from './clipnames.mjs';
import { driveProblem } from './drive.mjs';
import { GOOGLE_SCOPES } from './google.mjs';

const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
export const FOLDER_NAME = 'Uncbox Clips';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
/** Drive wants pieces in multiples of 256 KiB (except the last). 8 MB is 32 of those. */
export const CHUNK = 8 * 1024 * 1024;
const TRIES = 5;
const BACKOFF_MS = 1000;
/** A piece of a clip has this long to get there before it counts as failed. */
const CHUNK_TIMEOUT_MS = 5 * 60_000;

const problem = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A call that stops when the upload is cancelled, or when Google takes too long to answer. */
const limited = (signal, ms = 30_000) => AbortSignal.any([signal, AbortSignal.timeout(ms)]);

/** A value inside a Drive search query's quotes. */
const quote = (text) => `'${String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * The saved clip's path, or null. Only names the clips folder itself can hold (see
 * server/clipnames.mjs) pass, so a name can't reach outside the folder.
 */
export function clipPath(folder, name) {
  return typeof name === 'string' && NAME.test(name) ? path.join(folder, name) : null;
}

/** How far Google says it got, from a 308's Range header ("bytes=0-8388607"): the next byte to send. */
export function receivedFrom(rangeHeader) {
  const m = /^bytes=0-(\d+)$/.exec(rangeHeader ?? '');
  return m ? Number(m[1]) + 1 : 0;
}

/**
 * @param {object} o
 * @param {ReturnType<import('./google.mjs').createGoogle>} o.google
 * @param {Promise<string>} o.dir  the clips folder
 * @param {string} o.dataDir
 * @param {number} [o.chunk]  piece size; the tests use a tiny one
 * @param {(ms: number) => Promise<void>} [o.sleep]  swapped out by the tests
 */
export function createDriveUpload({ google, dir, dataDir, broadcastEvent = () => {}, isLocal, sendJson, readJson, chunk = CHUNK, sleep = wait }) {
  google.requireScopes([GOOGLE_SCOPES.drive[1]]);
  const file = path.join(dataDir, 'google-drive-upload.json');
  /** The upload going now: { name, controller }. */
  let active = null;
  /** Clips waiting for it, from auto-upload. */
  const waiting = [];

  async function cachedFolder() {
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      return typeof saved?.folderId === 'string' ? saved.folderId : '';
    } catch {
      return '';
    }
  }

  async function rememberFolder(folderId) {
    await mkdir(dataDir, { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify({ folderId }, null, 2));
    await rename(tmp, file);
  }

  /** A Drive API call, as JSON. Throws a problem in plain words when Google refuses. */
  async function api(url, init, signal) {
    const res = await google.fetch(url, { ...init, signal: limited(signal) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const { status, error, code } = driveProblem(res.status, body);
      throw problem(error, status, { code });
    }
    return body;
  }

  /** The "Uncbox Clips" folder's id: the remembered one if it is still there, else found by name, else made. */
  async function ensureFolder(signal) {
    const remembered = await cachedFolder();
    if (remembered) {
      const res = await google.fetch(`${FILES}/${encodeURIComponent(remembered)}?fields=id,trashed`, { signal: limited(signal) });
      if (res.ok) {
        const f = await res.json().catch(() => ({}));
        if (f.id && !f.trashed) return f.id;
      } else if (res.status !== 404) {
        const { status, error, code } = driveProblem(res.status, await res.json().catch(() => ({})));
        throw problem(error, status, { code });
      }
    }
    const q = `name = ${quote(FOLDER_NAME)} and mimeType = ${quote(FOLDER_MIME)} and trashed = false`;
    const found = await api(`${FILES}?${new URLSearchParams({ q, fields: 'files(id)', pageSize: '1' })}`, {}, signal);
    let id = found.files?.[0]?.id;
    if (!id) {
      const made = await api(
        `${FILES}?fields=id`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }) },
        signal,
      );
      id = made.id;
    }
    await rememberFolder(id);
    return id;
  }

  /** Starts a resumable upload; the address to send the pieces to. */
  async function startSession({ name, total, folderId, signal }) {
    const params = new URLSearchParams({ uploadType: 'resumable', fields: 'id,name,webViewLink' });
    const res = await google.fetch(`${UPLOAD}?${params}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(total),
      },
      body: JSON.stringify({ name, mimeType: 'video/mp4', parents: [folderId] }),
      signal: limited(signal),
    });
    // The folder is gone (deleted since it was looked up).
    if (res.status === 404) throw problem('The Uncbox Clips folder is gone.', 404, { gone: true });
    if (!res.ok) {
      const { status, error, code } = driveProblem(res.status, await res.json().catch(() => ({})));
      throw problem(error, status, { code });
    }
    const session = res.headers.get('location');
    if (!session) throw problem('Google Drive didn’t start the upload.', 502);
    return session;
  }

  /**
   * Sends bytes [start, end) and says what Google made of it: { done, body } when the file is
   * complete, { next } with the offset Google reports otherwise, or { retry } for a 5xx or a dropped
   * connection. `end` of null asks where things stand without sending anything.
   */
  async function putPiece({ session, handle, start, end, total, signal }) {
    const ask = end === null;
    const bytes = ask ? Buffer.alloc(0) : Buffer.alloc(end - start);
    if (!ask) await handle.read(bytes, 0, bytes.length, start);
    let res;
    try {
      res = await google.fetch(session, {
        method: 'PUT',
        headers: {
          'Content-Length': String(bytes.length),
          'Content-Range': ask ? `bytes */${total}` : `bytes ${start}-${end - 1}/${total}`,
        },
        body: ask ? undefined : bytes,
        redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(CHUNK_TIMEOUT_MS)]),
      });
    } catch (err) {
      if (signal.aborted) throw err;
      // 401 (signed out meanwhile) is no use retrying; a dropped connection or timeout is.
      if (err.status && err.status !== 502) throw err;
      return { retry: true };
    }
    if (res.status === 200 || res.status === 201) return { done: true, body: await res.json().catch(() => ({})) };
    if (res.status === 308) return { next: receivedFrom(res.headers.get('range')) };
    if (res.status >= 500 || res.status === 429) return { retry: true };
    if (res.status === 404 || res.status === 410) throw problem('Google Drive lost track of this upload. Try saving it again.', 502);
    const { status, error, code } = driveProblem(res.status, await res.json().catch(() => ({})));
    throw problem(error, status, { code });
  }

  /** Sends the whole file, a piece at a time, resuming from what Google has after any hiccup. */
  async function sendFile({ session, path: filePath, total, signal, progress }) {
    const handle = await open(filePath, 'r');
    try {
      let offset = 0;
      let failures = 0;
      /** Whether the last answer was a failure, so the next try asks where Google is up to first. */
      let lost = false;
      for (;;) {
        if (signal.aborted) throw signal.reason ?? problem('Cancelled', 499);
        // Everything is there but Google hasn't said it's complete: ask rather than send nothing.
        const ask = lost || offset >= total;
        const step = await putPiece({
          session,
          handle,
          start: offset,
          end: ask ? null : Math.min(offset + chunk, total),
          total,
          signal,
        });
        if (step.done) return step.body;
        if (step.retry) {
          if (++failures >= TRIES) throw problem('Couldn’t reach Google Drive. Check your internet connection and try again.', 502);
          lost = true;
          await sleep(BACKOFF_MS * 2 ** (failures - 1));
          continue;
        }
        const next = Math.min(step.next, total);
        // Only getting further counts as things working; asking where Google is up to doesn't.
        if (next > offset) failures = 0;
        lost = false;
        // Google's word on how much it has is the truth, even if it is less than what was sent.
        offset = next;
        progress(offset);
      }
    } finally {
      await handle.close();
    }
  }

  /** Uploads one saved clip. Resolves with { id, name, link, shared }. */
  async function run(name, { share = false } = {}, controller) {
    const { signal } = controller;
    const filePath = clipPath(await dir, name);
    if (!filePath) throw problem('Pick a clip to save.');
    const info = await stat(filePath).catch(() => null);
    if (!info) throw problem('That clip is gone.', 404);
    if (!info.size) throw problem('That clip is empty.');
    const total = info.size;

    const progress = (sent) => broadcastEvent('driveupload', { name, sent, total, done: false, error: '', link: '' });
    progress(0);
    const folderId = await ensureFolder(signal);
    let session;
    try {
      session = await startSession({ name, total, folderId, signal });
    } catch (err) {
      // The folder went missing after the check (deleted just now): make it again, once.
      if (!err.gone) throw err;
      await rememberFolder('');
      session = await startSession({ name, total, folderId: await ensureFolder(signal), signal });
    }
    let made;
    try {
      made = await sendFile({ session, path: filePath, total, signal, progress });
    } catch (err) {
      // Tell Google to drop the half-sent file; it would otherwise keep the session around.
      void google.fetch(session, { method: 'DELETE', headers: { 'Content-Length': '0' }, signal: AbortSignal.timeout(8000) }).catch(() => {});
      throw err;
    }
    if (!made.id) throw problem('Google Drive didn’t say where the clip went.', 502);

    let shared = false;
    let link = made.webViewLink ?? '';
    if (share) {
      try {
        await api(
          `${FILES}/${encodeURIComponent(made.id)}/permissions`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'reader', type: 'anyone' }) },
          signal,
        );
        shared = true;
      } catch (err) {
        // The clip is on Drive; only the sharing didn't take.
        if (signal.aborted) throw err;
      }
    }
    return { id: made.id, name, link, shared };
  }

  /** Who may upload right now: the page learns why not in words. */
  async function signedInOrThrow() {
    const status = await google.snapshot();
    if (!status.signedIn) throw problem('Sign in to Google in a Drive widget first.', 401, { code: 'signin' });
    if (!(await google.hasScopes([GOOGLE_SCOPES.drive[1]]))) {
      throw problem('Uncbox wasn’t allowed to save to your Drive. Sign in again and allow access to Drive.', 403, { code: 'scope' });
    }
  }

  /** Runs one upload to the end, telling the page how it went. Never rejects. */
  async function runAndReport(name, options) {
    const controller = new AbortController();
    active = { name, controller };
    try {
      const result = await run(name, options, controller);
      broadcastEvent('driveupload', { name, sent: 0, total: 0, done: true, error: '', link: result.link, shared: result.shared });
      return { ok: true, ...result };
    } catch (err) {
      const cancelled = controller.signal.aborted;
      const error = cancelled ? '' : err.message || 'Couldn’t save to Google Drive.';
      broadcastEvent('driveupload', { name, sent: 0, total: 0, done: true, error, link: '', cancelled });
      return { ok: false, cancelled, error, status: err.status || 502, code: err.code };
    } finally {
      active = null;
      const next = waiting.shift();
      if (next) void runAndReport(next.name, next.options);
    }
  }

  /** From the clip hotkey's auto-upload: uploads when it is this clip's turn. Not signed in is reported as the clip's own error. */
  async function queue(name, options) {
    try {
      await signedInOrThrow();
    } catch (err) {
      broadcastEvent('driveupload', { name, sent: 0, total: 0, done: true, error: err.message, link: '' });
      return;
    }
    if (active) waiting.push({ name, options });
    else void runAndReport(name, options);
  }

  async function handle(req, res, url) {
    if (!isLocal(req)) return sendJson(res, 403, { error: 'Run this on the PC Uncbox is on.' });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    const action = url.pathname.slice('/api/drive/upload'.length);
    try {
      if (action !== '' && action !== '/cancel') return sendJson(res, 404, { error: 'Not found' });
      const body = await readJson(req);
      const name = typeof body.name === 'string' ? body.name : '';
      if (action === '/cancel') {
        const index = waiting.findIndex((w) => w.name === name);
        if (index >= 0) {
          waiting.splice(index, 1);
          broadcastEvent('driveupload', { name, sent: 0, total: 0, done: true, error: '', link: '', cancelled: true });
        } else if (active?.name === name) {
          active.controller.abort(problem('Cancelled', 499));
        }
        return sendJson(res, 200, { ok: true });
      }
      if (!clipPath('', name)) return sendJson(res, 400, { error: 'Pick a clip to save.' });
      await signedInOrThrow();
      if (active || waiting.length) {
        return sendJson(res, 409, { code: 'busy', error: 'Another clip is going to Google Drive. Wait for it to finish.' });
      }
      const result = await runAndReport(name, { share: body.share === true });
      if (result.ok) return sendJson(res, 200, { id: result.id, name: result.name, link: result.link, shared: result.shared });
      return sendJson(res, result.cancelled ? 499 : result.status, { error: result.error, code: result.code, cancelled: result.cancelled });
    } catch (err) {
      return sendJson(res, err.status || 500, { code: err.code, error: err.status ? err.message : 'Couldn’t save to Google Drive.' });
    }
  }

  return { handle, queue, upload: (name, options) => runAndReport(name, options) };
}
