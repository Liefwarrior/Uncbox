import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import * as realFs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanStaleTemps, readJsonSafe, writeFileAtomic, writeJsonAtomic } from './datafile.mjs';

let dir;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'uncbox-datafile-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const names = () => readdir(dir);
const busy = (code) => Object.assign(new Error(code), { code });

describe('writeJsonAtomic', () => {
  it('writes the file, makes the folder, and leaves no temp file behind', async () => {
    const file = path.join(dir, 'nested', 'a.json');
    await writeJsonAtomic(file, { a: 1 });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ a: 1 });
    expect(await readdir(path.dirname(file))).toEqual(['a.json']);
  });

  it('indents when asked and replaces an existing file', async () => {
    const file = path.join(dir, 'a.json');
    await writeJsonAtomic(file, { a: 1 });
    await writeJsonAtomic(file, { b: [2] }, { pretty: true });
    expect(await readFile(file, 'utf8')).toBe('{\n  "b": [\n    2\n  ]\n}');
  });

  it('asks for the file mode of secrets and flushes to disk before the rename', async () => {
    const calls = [];
    const fs = {
      ...realFs,
      open: async (p, flags, mode) => {
        calls.push(['open', flags, mode]);
        const handle = await realFs.open(p, flags, mode);
        return {
          writeFile: (d) => handle.writeFile(d),
          sync: async () => {
            calls.push(['sync']);
            await handle.sync();
          },
          close: () => handle.close(),
        };
      },
      rename: async (a, b) => {
        calls.push(['rename']);
        return realFs.rename(a, b);
      },
    };
    await writeJsonAtomic(path.join(dir, 's.json'), { token: 'x' }, { mode: 0o600, fs });
    expect(calls).toEqual([['open', 'w', 0o600], ['sync'], ['rename']]);
  });

  it('never leaves the target half written when the write is interrupted before the rename', async () => {
    const file = path.join(dir, 'a.json');
    await writeJsonAtomic(file, { version: 'old' });
    const failing = {
      ...realFs,
      open: async (p, flags, mode) => {
        const handle = await realFs.open(p, flags, mode);
        return {
          // Half the data lands in the temp file, then the disk "fills up".
          writeFile: async (d) => {
            await handle.writeFile(String(d).slice(0, 5));
            throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    };
    await expect(writeJsonAtomic(file, { version: 'new', big: 'x'.repeat(100) }, { fs: failing })).rejects.toThrow('disk full');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 'old' });
    expect(await names()).toEqual(['a.json']);
  });

  it('keeps the old file when the rename itself fails, and cleans up the temp file', async () => {
    const file = path.join(dir, 'a.json');
    await writeJsonAtomic(file, { version: 'old' });
    const fs = { ...realFs, rename: async () => Promise.reject(busy('EXDEV')) };
    await expect(writeJsonAtomic(file, { version: 'new' }, { fs })).rejects.toThrow('EXDEV');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 'old' });
    expect(await names()).toEqual(['a.json']);
  });

  it('retries the rename on EPERM and EBUSY, which antivirus and indexers cause', async () => {
    const file = path.join(dir, 'a.json');
    const errors = [busy('EPERM'), busy('EBUSY'), busy('EPERM')];
    const rename = vi.fn(async (a, b) => {
      const err = errors.shift();
      if (err) throw err;
      return realFs.rename(a, b);
    });
    const sleep = vi.fn(async () => {});
    await writeJsonAtomic(file, { ok: true }, { fs: { ...realFs, rename }, sleep });
    expect(rename).toHaveBeenCalledTimes(4);
    // A little longer each time.
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([25, 50, 100]);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ok: true });
    expect(await names()).toEqual(['a.json']);
  });

  it('gives up after a few tries and removes the temp file', async () => {
    const file = path.join(dir, 'a.json');
    const rename = vi.fn(async () => Promise.reject(busy('EPERM')));
    await expect(writeJsonAtomic(file, { ok: true }, { fs: { ...realFs, rename }, sleep: async () => {} })).rejects.toThrow('EPERM');
    expect(rename).toHaveBeenCalledTimes(6);
    expect(await names()).toEqual([]);
  });

  it('gives each write its own temp name, so two at once cannot collide', async () => {
    const file = path.join(dir, 'a.json');
    const seen = new Set();
    const fs = {
      ...realFs,
      rename: async (a, b) => {
        seen.add(a);
        return realFs.rename(a, b);
      },
    };
    await Promise.all([1, 2, 3, 4].map((n) => writeJsonAtomic(file, { n }, { fs })));
    expect(seen.size).toBe(4);
    expect(await names()).toEqual(['a.json']);
  });

  it('refuses a value with no JSON form', async () => {
    await expect(writeJsonAtomic(path.join(dir, 'a.json'), undefined)).rejects.toThrow();
    expect(await names()).toEqual([]);
  });
});

describe('writeFileAtomic', () => {
  it('writes text as given', async () => {
    const file = path.join(dir, 'a.txt');
    await writeFileAtomic(file, 'hello');
    expect(await readFile(file, 'utf8')).toBe('hello');
  });
});

describe('readJsonSafe', () => {
  it('reads valid JSON', async () => {
    const file = path.join(dir, 'a.json');
    await writeFile(file, '{"a":1}');
    expect(await readJsonSafe(file, null)).toEqual({ a: 1 });
  });

  it('gives the fallback for a missing, empty or damaged file, and never throws', async () => {
    const empty = path.join(dir, 'empty.json');
    const bad = path.join(dir, 'bad.json');
    await writeFile(empty, '  \n');
    await writeFile(bad, '{"a":');
    expect(await readJsonSafe(path.join(dir, 'missing.json'), 'fb')).toBe('fb');
    expect(await readJsonSafe(empty, 'fb')).toBe('fb');
    expect(await readJsonSafe(bad, 'fb')).toBe('fb');
    // A folder where a file should be.
    expect(await readJsonSafe(dir, 'fb')).toBe('fb');
  });

  it('defaults the fallback to null', async () => {
    expect(await readJsonSafe(path.join(dir, 'nope.json'))).toBeNull();
  });
});

describe('cleanStaleTemps', () => {
  it('removes old temp files from a crashed write and nothing else', async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    for (const name of ['state.json.tmp-123-4', 'obs.json.tmp']) {
      await writeFile(path.join(dir, name), 'x');
      await utimes(path.join(dir, name), old, old);
    }
    await writeFile(path.join(dir, 'fresh.json.tmp-1-1'), 'x');
    await writeFile(path.join(dir, 'state.json'), '{}');
    expect(await cleanStaleTemps(dir)).toBe(2);
    expect((await names()).sort()).toEqual(['fresh.json.tmp-1-1', 'state.json']);
    expect((await stat(path.join(dir, 'state.json'))).isFile()).toBe(true);
  });

  it('copes with a folder that is not there', async () => {
    expect(await cleanStaleTemps(path.join(dir, 'nope'))).toBe(0);
  });
});
