// The preset gallery server: which index entries are kept, which paths may be fetched, how long the
// index is kept and what happens offline, and reading from a folder on this PC. Nothing here touches
// the network: files come from a fake fetch or from a temporary folder.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanEntry,
  createGallery,
  createSource,
  DEFAULT_GALLERY_URL,
  FILE_PATTERN,
  GALLERY_BASES,
  GalleryError,
  localRoot,
  MAX_PRESET_BYTES,
  validateIndex,
} from './gallery.mjs';

const entry = (over = {}) => ({
  id: 'cozy-desk',
  name: 'Cozy desk',
  author: 'Uncbox',
  description: 'A calm desk.',
  base: 'desk',
  tags: ['desk', 'relax'],
  file: 'presets/cozy-desk.uncbox',
  preview: '',
  updated: '2026-10-20',
  ...over,
});
const index = (...presets) => ({ version: 1, presets });

describe('cleanEntry', () => {
  it('keeps a good entry as it is', () => {
    expect(cleanEntry(entry())).toEqual(entry());
  });

  it('drops what cannot be used', () => {
    for (const bad of [
      null,
      'text',
      [],
      entry({ id: '' }),
      entry({ id: 'Has Capitals' }),
      entry({ id: '../x' }),
      entry({ id: 'x'.repeat(60) }),
      entry({ name: '   ' }),
      entry({ author: undefined }),
      entry({ base: 'minecraft' }),
      entry({ file: undefined }),
    ]) {
      expect(cleanEntry(bad)).toBeNull();
    }
  });

  it('tidies the words and tags', () => {
    const e = cleanEntry(entry({ name: '  Cozy \n desk ', tags: ['Desk', 'desk', ' RELAX ', '', 7, ...Array.from({ length: 12 }, (_, i) => `t${i}`)] }));
    expect(e.name).toBe('Cozy desk');
    expect(e.tags.slice(0, 2)).toEqual(['desk', 'relax']);
    expect(e.tags).toHaveLength(8);
  });

  it('leaves out a preview or date that does not look right, but keeps the preset', () => {
    const e = cleanEntry(entry({ preview: '../secret.webp', updated: 'yesterday' }));
    expect(e.preview).toBe('');
    expect(e.updated).toBe('');
    expect(cleanEntry(entry({ preview: 'previews/cozy-desk.webp' })).preview).toBe('previews/cozy-desk.webp');
  });

  it('only takes file paths of the form presets/<name>.uncbox', () => {
    for (const bad of [
      '../presets/x.uncbox',
      'presets/../x.uncbox',
      'presets/../../etc/passwd',
      'presets/sub/x.uncbox',
      '/presets/x.uncbox',
      'presets\\x.uncbox',
      'presets/x.json',
      'presets/X.uncbox',
      'presets/.uncbox',
      'index.json',
      'https://evil.example/x.uncbox',
      'presets/x.uncbox\n',
    ]) {
      expect(FILE_PATTERN.test(bad), bad).toBe(false);
      expect(cleanEntry(entry({ file: bad })), bad).toBeNull();
    }
    expect(FILE_PATTERN.test('presets/nuzlocke-run.uncbox')).toBe(true);
  });
});

describe('validateIndex', () => {
  it('returns the good entries and counts the dropped ones', () => {
    const result = validateIndex(index(entry(), { nonsense: true }, entry({ id: 'second', name: 'Second', file: 'presets/second.uncbox' }), entry({ base: 'nope' })));
    expect(result.presets.map((p) => p.id)).toEqual(['cozy-desk', 'second']);
    expect(result.dropped).toBe(2);
    expect(result.version).toBe(1);
  });

  it('keeps the first of a repeated id', () => {
    const result = validateIndex(index(entry(), entry({ name: 'Imposter' })));
    expect(result.presets).toHaveLength(1);
    expect(result.presets[0].name).toBe('Cozy desk');
    expect(result.dropped).toBe(1);
  });

  it('is not an index when the shape is wrong', () => {
    for (const bad of [null, [], 'x', {}, { version: 1 }, { presets: [] }, { version: 'one', presets: [] }, { version: 0, presets: [] }]) {
      expect(() => validateIndex(bad)).toThrow(GalleryError);
    }
  });

  it('asks for a newer Uncbox when the index is from the future', () => {
    expect(() => validateIndex({ version: 2, presets: [] })).toThrow(/newer Uncbox/);
  });

  it('accepts an empty gallery', () => {
    expect(validateIndex(index())).toEqual({ version: 1, presets: [], dropped: 0 });
  });

  it('knows the same base presets as the page', async () => {
    const { PRESET_IDS } = await import('../src/state/model.ts');
    expect([...GALLERY_BASES]).toEqual([...PRESET_IDS]);
  });
});

describe('localRoot', () => {
  it('is null for a web address', () => {
    expect(localRoot('https://raw.githubusercontent.com/x/y/main/gallery/')).toBeNull();
    expect(localRoot('HTTP://localhost:5000/')).toBeNull();
  });

  it('is a folder for a plain path or a file: address', () => {
    expect(localRoot(os.tmpdir())).toBe(path.resolve(os.tmpdir()));
    expect(localRoot(pathToFileURL(os.tmpdir()).href)).toBe(path.resolve(os.tmpdir()));
  });
});

describe('the default gallery', () => {
  it('is the Uncbox repo’s gallery folder on main', () => {
    expect(DEFAULT_GALLERY_URL).toBe('https://raw.githubusercontent.com/Liefwarrior/Uncbox/main/gallery/');
  });
});

// ---- helpers for the rest ----

let tmp;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'uncbox-gallery-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** A gallery folder on disk with the given index and files ({ 'presets/x.uncbox': 'text' }). */
async function makeFolder(idx, files = {}) {
  const folder = path.join(tmp, 'gallery');
  await mkdir(path.join(folder, 'presets'), { recursive: true });
  await mkdir(path.join(folder, 'previews'), { recursive: true });
  await writeFile(path.join(folder, 'index.json'), typeof idx === 'string' ? idx : JSON.stringify(idx));
  for (const [rel, body] of Object.entries(files)) await writeFile(path.join(folder, rel), body);
  return folder;
}

/** A fake fetch serving { 'index.json': body } under a base, recording what was asked for. */
function fakeFetch(files) {
  const asked = [];
  const impl = vi.fn(async (url) => {
    const rel = new URL(String(url)).pathname.replace(/^\/g\//, '');
    asked.push(rel);
    const file = files[rel];
    if (file === undefined) return new Response('nope', { status: 404 });
    if (file instanceof Error) throw file;
    if (typeof file === 'number') return new Response('err', { status: file });
    if (file.headers) return new Response(file.body, { headers: file.headers });
    return new Response(file);
  });
  return { impl, asked, files };
}

const BASE = 'https://gallery.test/g/';
const makeGallery = (over = {}) => {
  const sent = [];
  const gallery = createGallery({
    dataDir: tmp,
    baseUrl: BASE,
    isLocal: () => true,
    sendJson: (res, status, body) => res.sent.push({ status, body }),
    now: () => 1_000_000,
    ...over,
  });
  return { gallery, sent };
};

/** A request and a response that records what was written. */
const exchange = (url) => {
  const res = {
    sent: [],
    head: null,
    chunks: [],
    writeHead(status, headers) {
      this.head = { status, headers };
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(chunk);
    },
  };
  return { req: { method: 'GET' }, res, url: new URL(url, 'http://localhost') };
};

// ---- the folder on this PC ----

describe('a folder on this PC', () => {
  it('reads files from it', async () => {
    const folder = await makeFolder(index(entry()), { 'presets/cozy-desk.uncbox': '{"a":1}' });
    const source = createSource(folder);
    expect(source.local).toBe(true);
    expect((await source.read('presets/cozy-desk.uncbox', 100)).toString()).toBe('{"a":1}');
  });

  it('works with a file: address too', async () => {
    const folder = await makeFolder(index(entry()));
    const source = createSource(pathToFileURL(folder).href);
    expect(JSON.parse((await source.read('index.json', 1000)).toString()).version).toBe(1);
  });

  it('says missing for a file that is not there, and refuses to leave the folder', async () => {
    const folder = await makeFolder(index());
    await writeFile(path.join(tmp, 'outside.txt'), 'secret');
    const source = createSource(folder);
    await expect(source.read('presets/nope.uncbox', 100)).rejects.toMatchObject({ reason: 'missing' });
    await expect(source.read('../outside.txt', 100)).rejects.toMatchObject({ status: 400 });
    await expect(source.read('presets/../../outside.txt', 100)).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a file over the cap', async () => {
    const folder = await makeFolder(index(), { 'presets/big.uncbox': 'x'.repeat(50) });
    await expect(createSource(folder).read('presets/big.uncbox', 10)).rejects.toMatchObject({ reason: 'toobig' });
  });

  it('serves the index and a preset, reading again each time', async () => {
    const folder = await makeFolder(index(entry()), { 'presets/cozy-desk.uncbox': '{"uncbox":"preset"}' });
    const { gallery } = makeGallery({ baseUrl: folder });
    expect((await gallery.getIndex()).presets.map((p) => p.id)).toEqual(['cozy-desk']);
    expect(await gallery.presetText('cozy-desk')).toBe('{"uncbox":"preset"}');
    // Edited on disk: the next look sees it (nothing is kept for a folder).
    await writeFile(path.join(folder, 'index.json'), JSON.stringify(index(entry(), entry({ id: 'two', name: 'Two', file: 'presets/two.uncbox' }))));
    expect((await gallery.getIndex()).presets).toHaveLength(2);
  });

  it('says missing for a folder with no index', async () => {
    const { gallery } = makeGallery({ baseUrl: path.join(tmp, 'nothing-here') });
    await expect(gallery.getIndex()).rejects.toMatchObject({ reason: 'missing' });
  });
});

// ---- the path allowlist ----

describe('which files can be fetched', () => {
  it('only a preset the index lists, at the path the index gives', async () => {
    const f = fakeFetch({ 'index.json': JSON.stringify(index(entry())), 'presets/cozy-desk.uncbox': '{"ok":true}', 'presets/other.uncbox': 'not listed' });
    const { gallery } = makeGallery({ fetchImpl: f.impl });
    expect(await gallery.presetText('cozy-desk')).toBe('{"ok":true}');
    expect(f.asked).toEqual(['index.json', 'presets/cozy-desk.uncbox']);
    await expect(gallery.presetText('other')).rejects.toMatchObject({ status: 404 });
    expect(f.asked).not.toContain('presets/other.uncbox');
  });

  it('never fetches a path with .. in it, by id or by an index entry', async () => {
    const evil = { id: 'sneaky', name: 'Sneaky', author: 'x', base: 'desk', file: 'presets/../index.json' };
    const f = fakeFetch({ 'index.json': JSON.stringify(index(entry(), evil)), 'presets/cozy-desk.uncbox': '{}' });
    const { gallery } = makeGallery({ fetchImpl: f.impl });
    for (const id of ['sneaky', '..', '../index', '..%2Findex', 'Cozy-Desk', '', 'cozy desk', 'cozy-desk/../x']) {
      await expect(gallery.presetText(id), id).rejects.toMatchObject({ status: 404 });
    }
    expect(f.asked.every((rel) => rel === 'index.json' || rel === 'presets/cozy-desk.uncbox')).toBe(true);
  });

  it('refuses a preset over 1 MB, before reading it all', async () => {
    const f = fakeFetch({
      'index.json': JSON.stringify(index(entry())),
      'presets/cozy-desk.uncbox': { body: 'x', headers: { 'content-length': String(MAX_PRESET_BYTES + 1) } },
    });
    const { gallery } = makeGallery({ fetchImpl: f.impl });
    await expect(gallery.presetText('cozy-desk')).rejects.toMatchObject({ reason: 'toobig' });
  });

  it('refuses a body that grows past 1 MB with no length given', async () => {
    const f = fakeFetch({ 'index.json': JSON.stringify(index(entry())), 'presets/cozy-desk.uncbox': 'x'.repeat(MAX_PRESET_BYTES + 5) });
    const { gallery } = makeGallery({ fetchImpl: f.impl });
    await expect(gallery.presetText('cozy-desk')).rejects.toMatchObject({ reason: 'toobig' });
  });
});

// ---- keeping the index ----

describe('keeping the index', () => {
  const body = JSON.stringify(index(entry()));

  it('asks once and keeps the answer for 30 minutes', async () => {
    let t = 1_000_000;
    const f = fakeFetch({ 'index.json': body });
    const { gallery } = makeGallery({ fetchImpl: f.impl, now: () => t });
    const first = await gallery.getIndex();
    expect(first).toMatchObject({ stale: false, fetchedAt: 1_000_000 });
    t += 29 * 60_000;
    await gallery.getIndex();
    expect(f.impl).toHaveBeenCalledTimes(1);
    t += 2 * 60_000;
    await gallery.getIndex();
    expect(f.impl).toHaveBeenCalledTimes(2);
  });

  it('asks only once for requests made together', async () => {
    const f = fakeFetch({ 'index.json': body });
    const { gallery } = makeGallery({ fetchImpl: f.impl });
    await Promise.all([gallery.getIndex(), gallery.getIndex(), gallery.getIndex()]);
    expect(f.impl).toHaveBeenCalledTimes(1);
  });

  it('writes the copy to data/gallery-cache.json', async () => {
    const f = fakeFetch({ 'index.json': body });
    await makeGallery({ fetchImpl: f.impl }).gallery.getIndex();
    const saved = JSON.parse(await readFile(path.join(tmp, 'gallery-cache.json'), 'utf8'));
    expect(saved).toMatchObject({ source: BASE, fetchedAt: 1_000_000 });
    expect(saved.index.presets[0].id).toBe('cozy-desk');
  });

  it('serves the last copy as stale when the gallery cannot be reached', async () => {
    let t = 1_000_000;
    const files = { 'index.json': body };
    const f = fakeFetch(files);
    const { gallery } = makeGallery({ fetchImpl: f.impl, now: () => t });
    await gallery.getIndex();
    files['index.json'] = new TypeError('fetch failed');
    t += 31 * 60_000;
    const again = await gallery.getIndex();
    expect(again.stale).toBe(true);
    expect(again.presets).toHaveLength(1);
    expect(again.fetchedAt).toBe(1_000_000);
  });

  it('uses the copy on disk after a restart, offline', async () => {
    const f = fakeFetch({ 'index.json': body });
    await makeGallery({ fetchImpl: f.impl }).gallery.getIndex();
    const offline = fakeFetch({ 'index.json': new TypeError('fetch failed') });
    const { gallery } = makeGallery({ fetchImpl: offline.impl, now: () => 1_000_000 + 5 * 3_600_000 });
    const result = await gallery.getIndex();
    expect(result.stale).toBe(true);
    expect(result.presets[0].id).toBe('cozy-desk');
  });

  it('does not use a copy kept for another gallery address', async () => {
    await makeGallery({ fetchImpl: fakeFetch({ 'index.json': body }).impl }).gallery.getIndex();
    const offline = fakeFetch({ 'index.json': new TypeError('fetch failed') });
    const { gallery } = makeGallery({ fetchImpl: offline.impl, baseUrl: 'https://other.test/g/' });
    await expect(gallery.getIndex()).rejects.toMatchObject({ reason: 'offline' });
  });

  it('says missing when there is no gallery yet and nothing kept', async () => {
    const f = fakeFetch({});
    const { gallery } = makeGallery({ fetchImpl: f.impl });
    await expect(gallery.getIndex()).rejects.toMatchObject({ reason: 'missing', message: expect.stringMatching(/isn’t published yet/) });
  });

  it('says offline when it cannot be reached and nothing kept', async () => {
    const f = fakeFetch({ 'index.json': new TypeError('fetch failed') });
    const { gallery } = makeGallery({ fetchImpl: f.impl });
    await expect(gallery.getIndex()).rejects.toMatchObject({ reason: 'offline' });
  });

  it('treats a server error like being offline, and a damaged list as bad', async () => {
    await expect(makeGallery({ fetchImpl: fakeFetch({ 'index.json': 503 }).impl }).gallery.getIndex()).rejects.toMatchObject({ reason: 'offline' });
    await expect(makeGallery({ fetchImpl: fakeFetch({ 'index.json': '{not json' }).impl }).gallery.getIndex()).rejects.toMatchObject({ reason: 'bad' });
    await expect(makeGallery({ fetchImpl: fakeFetch({ 'index.json': '{"version":1}' }).impl }).gallery.getIndex()).rejects.toMatchObject({ reason: 'bad' });
  });

  it('trusts a bad clock no more than an old copy', async () => {
    let t = 1_000_000;
    const f = fakeFetch({ 'index.json': body });
    const { gallery } = makeGallery({ fetchImpl: f.impl, now: () => t });
    await gallery.getIndex();
    t = 500_000;
    await gallery.getIndex();
    expect(f.impl).toHaveBeenCalledTimes(2);
  });
});

// ---- the endpoints ----

describe('the endpoints', () => {
  const idx = JSON.stringify(index(entry(), entry({ id: 'pictured', name: 'Pictured', file: 'presets/pictured.uncbox', preview: 'previews/pictured.webp' })));
  const files = () => ({ 'index.json': idx, 'presets/cozy-desk.uncbox': '{"uncbox":"preset"}', 'presets/pictured.uncbox': '{}', 'previews/pictured.webp': 'RIFFwebp' });

  it('answers the index', async () => {
    const { gallery } = makeGallery({ fetchImpl: fakeFetch(files()).impl });
    const x = exchange('/api/gallery');
    await gallery.handle(x.req, x.res, x.url);
    expect(x.res.sent[0].status).toBe(200);
    expect(x.res.sent[0].body).toMatchObject({ version: 1, stale: false });
    expect(x.res.sent[0].body.presets.map((p) => p.id)).toEqual(['cozy-desk', 'pictured']);
  });

  it('answers 503 with a reason when there is no gallery', async () => {
    const { gallery } = makeGallery({ fetchImpl: fakeFetch({}).impl });
    const x = exchange('/api/gallery');
    await gallery.handle(x.req, x.res, x.url);
    expect(x.res.sent[0]).toMatchObject({ status: 503, body: { reason: 'missing' } });
  });

  it('sends a preset file as the text itself', async () => {
    const { gallery } = makeGallery({ fetchImpl: fakeFetch(files()).impl });
    const x = exchange('/api/gallery/preset/cozy-desk');
    await gallery.handle(x.req, x.res, x.url);
    expect(x.res.head.status).toBe(200);
    expect(x.res.chunks.join('')).toBe('{"uncbox":"preset"}');
  });

  it('answers 404 for an id that is not in the gallery, and for a path it does not serve', async () => {
    const { gallery } = makeGallery({ fetchImpl: fakeFetch(files()).impl });
    for (const url of ['/api/gallery/preset/nope', '/api/gallery/preset/..%2Findex', '/api/gallery/preset/a/b', '/api/gallery/other', '/api/gallery/preview/nope']) {
      const x = exchange(url);
      await gallery.handle(x.req, x.res, x.url);
      expect(x.res.sent[0].status, url).toBe(404);
    }
  });

  it('proxies a preview with its type, and keeps it', async () => {
    const f = fakeFetch(files());
    const { gallery } = makeGallery({ fetchImpl: f.impl });
    for (let i = 0; i < 2; i++) {
      const x = exchange('/api/gallery/preview/pictured');
      await gallery.handle(x.req, x.res, x.url);
      expect(x.res.head.status).toBe(200);
      expect(x.res.head.headers['Content-Type']).toBe('image/webp');
      expect(x.res.chunks[0].toString()).toBe('RIFFwebp');
    }
    expect(f.asked.filter((rel) => rel === 'previews/pictured.webp')).toHaveLength(1);
  });

  it('answers 404 for a preset with no preview', async () => {
    const { gallery } = makeGallery({ fetchImpl: fakeFetch(files()).impl });
    const x = exchange('/api/gallery/preview/cozy-desk');
    await gallery.handle(x.req, x.res, x.url);
    expect(x.res.sent[0].status).toBe(404);
  });

  it('only answers the PC Uncbox runs on, and only GET', async () => {
    const f = fakeFetch(files());
    const remote = makeGallery({ fetchImpl: f.impl, isLocal: () => false }).gallery;
    const x = exchange('/api/gallery');
    await remote.handle(x.req, x.res, x.url);
    expect(x.res.sent[0].status).toBe(403);
    expect(f.impl).not.toHaveBeenCalled();
    const local = makeGallery({ fetchImpl: f.impl }).gallery;
    const y = exchange('/api/gallery');
    y.req.method = 'POST';
    await local.handle(y.req, y.res, y.url);
    expect(y.res.sent[0].status).toBe(405);
  });
});
