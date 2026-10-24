// The update check: version comparison, what GitHub's answers mean, and the once-a-day cache.
// Nothing here touches the network: GitHub is a fake fetch.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUpdate, fetchLatest, isNewer, parseVersion } from './update.mjs';

const release = (tag, extra = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({ tag_name: tag, html_url: `https://github.com/Liefwarrior/Uncbox/releases/tag/${tag}`, ...extra }),
});
const notFound = { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
const offline = async () => {
  throw new TypeError('fetch failed');
};

describe('parseVersion', () => {
  it('reads plain and v-prefixed versions', () => {
    expect(parseVersion('1.2.3')?.parts).toEqual([1, 2, 3]);
    expect(parseVersion('v0.10.0')?.parts).toEqual([0, 10, 0]);
    expect(parseVersion('2')?.parts).toEqual([2, 0, 0]);
    expect(parseVersion('1.4')?.parts).toEqual([1, 4, 0]);
  });

  it('knows a pre-release, and ignores build info', () => {
    expect(parseVersion('1.2.3-beta.1')?.pre).toBe(true);
    expect(parseVersion('1.2.3+abc123')?.pre).toBe(false);
  });

  it('turns away anything else', () => {
    for (const bad of ['', 'latest', 'v', '1.2.3.4', '1..2', null, undefined]) expect(parseVersion(bad)).toBeNull();
  });
});

describe('isNewer', () => {
  it('compares numbers, not text', () => {
    expect(isNewer('0.10.0', '0.9.0')).toBe(true);
    expect(isNewer('0.9.0', '0.10.0')).toBe(false);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('v0.3.1', '0.3.0')).toBe(true);
  });

  it('is not fooled by the same version', () => {
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('v0.2.0', '0.2.0')).toBe(false);
  });

  it('puts a pre-release before its release', () => {
    expect(isNewer('1.0.0', '1.0.0-beta.1')).toBe(true);
    expect(isNewer('1.0.0-beta.1', '1.0.0')).toBe(false);
  });

  it('says no when either side is not a version', () => {
    expect(isNewer('nightly', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0', 'dev')).toBe(false);
  });
});

describe('fetchLatest', () => {
  it('reads the tag and the release page', async () => {
    const fetchImpl = vi.fn(async () => release('v0.3.0'));
    const got = await fetchLatest('0.2.0', fetchImpl);
    expect(got).toEqual({ ok: true, latest: { version: '0.3.0', url: 'https://github.com/Liefwarrior/Uncbox/releases/tag/v0.3.0' } });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.github.com/repos/Liefwarrior/Uncbox/releases/latest');
  });

  it('treats a 404 (no releases yet) as no update, not as trouble', async () => {
    expect(await fetchLatest('0.2.0', async () => notFound)).toEqual({ ok: true, latest: null });
  });

  it('only opens github.com/Liefwarrior/Uncbox pages', async () => {
    const got = await fetchLatest('0.2.0', async () => release('v0.3.0', { html_url: 'https://evil.example/download' }));
    expect(got.latest.url).toBe('https://github.com/Liefwarrior/Uncbox/releases/latest');
  });

  it('ignores drafts, pre-releases and tags that are not versions', async () => {
    expect((await fetchLatest('0.2.0', async () => release('v0.3.0', { draft: true }))).latest).toBeNull();
    expect((await fetchLatest('0.2.0', async () => release('v0.3.0', { prerelease: true }))).latest).toBeNull();
    expect((await fetchLatest('0.2.0', async () => release('nightly'))).latest).toBeNull();
  });

  it('reports an unreachable GitHub, a rate limit and junk as not ok', async () => {
    expect(await fetchLatest('0.2.0', offline)).toEqual({ ok: false });
    expect(await fetchLatest('0.2.0', async () => ({ ok: false, status: 403, json: async () => ({}) }))).toEqual({ ok: false });
    const junk = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('bad');
      },
    });
    expect(await fetchLatest('0.2.0', junk)).toEqual({ ok: false });
  });
});

describe('createUpdate', () => {
  const HOUR = 60 * 60 * 1000;
  let dir;
  let clock;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'uncbox-update-'));
    clock = 1_700_000_000_000;
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));
  const make = (fetchImpl, version = '0.2.0') => createUpdate({ dataDir: dir, version, fetchImpl, now: () => clock });

  it('offers a newer release and remembers it in update.json', async () => {
    const status = await make(async () => release('v0.3.0')).status();
    expect(status).toEqual({
      current: '0.2.0',
      update: { version: '0.3.0', url: 'https://github.com/Liefwarrior/Uncbox/releases/tag/v0.3.0' },
    });
    const saved = JSON.parse(await readFile(path.join(dir, 'update.json'), 'utf8'));
    expect(saved).toMatchObject({ checkedAt: clock, ok: true, latest: { version: '0.3.0' } });
  });

  it('offers nothing when it is up to date, or when there are no releases', async () => {
    expect((await make(async () => release('v0.2.0')).status()).update).toBeNull();
    await rm(path.join(dir, 'update.json'));
    expect((await make(async () => notFound).status()).update).toBeNull();
  });

  it('asks GitHub once a day at most', async () => {
    const fetchImpl = vi.fn(async () => release('v0.3.0'));
    const update = make(fetchImpl);
    await update.status();
    clock += 23 * HOUR;
    await update.status();
    // Even a fresh server (a restart) uses the saved answer.
    await make(fetchImpl).status();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock += 2 * HOUR;
    await update.status();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('answers many page loads with one request', async () => {
    const fetchImpl = vi.fn(async () => release('v0.3.0'));
    const update = make(fetchImpl);
    await Promise.all([update.status(), update.status(), update.check()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when offline, and tries again within the hour rather than the day', async () => {
    const fetchImpl = vi.fn(offline);
    const update = make(fetchImpl);
    expect(await update.status()).toEqual({ current: '0.2.0', update: null });
    clock += 10 * 60 * 1000;
    await update.status();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock += HOUR;
    await update.status();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps the last known release through a failed check', async () => {
    let answer = async () => release('v0.3.0');
    const update = make((...args) => answer(...args));
    await update.status();
    answer = offline;
    clock += 25 * HOUR;
    expect((await update.status()).update?.version).toBe('0.3.0');
  });

  it('stops offering the release once the app has been updated to it', async () => {
    await make(async () => release('v0.3.0')).status();
    expect((await make(async () => release('v0.3.0'), '0.3.0').status()).update).toBeNull();
  });

  it('copes with a damaged or hand-edited update.json', async () => {
    const fetchImpl = vi.fn(async () => release('v0.3.0'));
    await writeFile(path.join(dir, 'update.json'), '{ not json');
    expect((await make(fetchImpl).status()).update?.version).toBe('0.3.0');
    await writeFile(path.join(dir, 'update.json'), JSON.stringify({ checkedAt: clock, ok: true, latest: { version: 3, url: {} } }));
    expect((await make(fetchImpl).status()).update).toBeNull();
  });

  it('asks again if the clock went backwards', async () => {
    const fetchImpl = vi.fn(async () => release('v0.3.0'));
    const update = make(fetchImpl);
    await update.status();
    clock -= 5 * HOUR;
    await update.status();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
