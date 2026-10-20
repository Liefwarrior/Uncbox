import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as realFs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_EVERY_MS, RESTORED_NOTICE, createStateStore, isUsableState } from './statestore.mjs';

let dir;
let clock;
let logged;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'uncbox-state-'));
  clock = 1_700_000_000_000;
  logged = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const make = (extra = {}) => createStateStore({ dataDir: dir, now: () => clock, log: (l) => logged.push(l), ...extra });
const read = async (name) => JSON.parse(await readFile(path.join(dir, name), 'utf8'));
const files = async () => (await readdir(dir)).sort();
const good = (n) => ({ version: 2, preset: 'pokemon', presets: {}, n });

describe('isUsableState', () => {
  it('wants a non-empty object', () => {
    expect(isUsableState({ a: 1 })).toBe(true);
    expect([null, undefined, [], {}, 'x', 3].map(isUsableState)).toEqual([false, false, false, false, false, false]);
  });
});

describe('load and save', () => {
  it('has nothing on a fresh install, and no notice', async () => {
    const store = make();
    expect(await store.load()).toBeNull();
    expect(store.takeNotice()).toBeNull();
    expect(await files()).toEqual([]);
  });

  it('round-trips a saved state', async () => {
    const store = make();
    await store.save(good(1));
    expect(await make().load()).toEqual(good(1));
  });

  it('makes a backup of a good state.json it finds at startup if there is none', async () => {
    await writeFile(path.join(dir, 'state.json'), JSON.stringify(good(7)));
    const store = make();
    expect(await store.load()).toEqual(good(7));
    expect(await read('state.json.bak')).toEqual(good(7));
    expect(store.takeNotice()).toBeNull();
  });
});

describe('backup', () => {
  it('keeps the last saved state, refreshed at most once a minute', async () => {
    const store = make();
    await store.save(good(1));
    expect(await read('state.json.bak')).toEqual(good(1));

    clock += 10_000;
    await store.save(good(2));
    clock += BACKUP_EVERY_MS - 20_000;
    await store.save(good(3));
    expect(await read('state.json')).toEqual(good(3));
    expect(await read('state.json.bak')).toEqual(good(1));

    clock += 20_000;
    await store.save(good(4));
    expect(await read('state.json.bak')).toEqual(good(4));
  });

  it('does not back up something that is not state', async () => {
    const store = make();
    await store.save(good(1));
    clock += BACKUP_EVERY_MS * 2;
    await store.save({});
    expect(await read('state.json.bak')).toEqual(good(1));
  });
});

describe('restoring from the backup', () => {
  async function withBackup() {
    const store = make();
    await store.save(good(1));
    await store.flush();
  }

  it('brings the backup back when state.json will not parse, says so once, and keeps the damaged file', async () => {
    await withBackup();
    await writeFile(path.join(dir, 'state.json'), '{"presets": {"a": ');
    const store = make();
    expect(await store.load()).toEqual(good(1));
    expect(await read('state.json')).toEqual(good(1));
    expect(store.takeNotice()).toEqual({ message: RESTORED_NOTICE });
    expect(store.takeNotice()).toBeNull();
    expect(logged.join('\n')).toMatch(/damaged\. Restored your last good settings/);
    const aside = (await files()).filter((n) => n.startsWith('state.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(await readFile(path.join(dir, aside[0]), 'utf8')).toBe('{"presets": {"a": ');
  });

  it('handles an empty state.json', async () => {
    await withBackup();
    await writeFile(path.join(dir, 'state.json'), '');
    const store = make();
    expect(await store.load()).toEqual(good(1));
    expect(store.takeNotice()).not.toBeNull();
    expect((await files()).some((n) => n.includes('corrupt'))).toBe(false);
  });

  it('handles a state.json that is valid JSON but not an object', async () => {
    await withBackup();
    await writeFile(path.join(dir, 'state.json'), '[1,2]');
    expect(await make().load()).toEqual(good(1));
  });

  it('handles a missing state.json', async () => {
    await withBackup();
    await rm(path.join(dir, 'state.json'));
    const store = make();
    expect(await store.load()).toEqual(good(1));
    expect(logged.join('\n')).toMatch(/missing/);
    expect(store.takeNotice()).not.toBeNull();
  });

  it('starts fresh, keeping the damaged file, when there is no backup', async () => {
    await writeFile(path.join(dir, 'state.json'), 'garbage');
    const store = make();
    expect(await store.load()).toBeNull();
    expect(store.takeNotice()).toBeNull();
    expect(logged.join('\n')).toMatch(/no backup/);
    expect((await files()).filter((n) => n.startsWith('state.json.corrupt-'))).toHaveLength(1);
  });

  it('keeps only the newest few damaged copies', async () => {
    await withBackup();
    for (let i = 0; i < 5; i++) {
      await writeFile(path.join(dir, 'state.json'), `bad ${i}`);
      clock += 1000;
      await make().load();
    }
    expect((await files()).filter((n) => n.startsWith('state.json.corrupt-'))).toHaveLength(3);
  });

  it('does not treat a file it could not read as damaged', async () => {
    await withBackup();
    // A directory where the file should be cannot be read as text: that must fail loudly, not restore.
    await rm(path.join(dir, 'state.json'));
    await realFs.mkdir(path.join(dir, 'state.json'));
    await expect(make().load()).rejects.toThrow();
  });
});

describe('serialised writes', () => {
  /** A file system whose writes take a moment, and which notes how many are going at once. */
  function slowFs() {
    const stats = { inFlight: 0, max: 0, order: [] };
    const fs = {
      ...realFs,
      open: async (p, flags, mode) => {
        const handle = await realFs.open(p, flags, mode);
        return {
          writeFile: async (data) => {
            stats.inFlight++;
            stats.max = Math.max(stats.max, stats.inFlight);
            await new Promise((r) => setTimeout(r, 5));
            await handle.writeFile(data);
            stats.inFlight--;
            if (!p.includes('.bak')) stats.order.push(JSON.parse(data).n);
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    };
    return { fs, stats };
  }

  it('never writes two at once, and the last save wins', async () => {
    const { fs, stats } = slowFs();
    const store = make({ fs });
    const saves = Array.from({ length: 40 }, (_, n) => store.save(good(n)));
    await Promise.all(saves);
    expect(stats.max).toBe(1);
    expect((await read('state.json')).n).toBe(39);
    // Saves that were overtaken are skipped, and the ones that do reach disk go in order.
    expect(stats.order.length).toBeLessThan(40);
    expect(stats.order).toEqual([...stats.order].sort((a, b) => a - b));
    expect(stats.order.at(-1)).toBe(39);
    expect((await files()).filter((n) => n.includes('.tmp'))).toEqual([]);
  });

  it('leaves a whole file on disk at every moment', async () => {
    const { fs } = slowFs();
    const store = make({ fs });
    const saves = Array.from({ length: 15 }, (_, n) => store.save(good(n)));
    const seen = [];
    const watcher = setInterval(async () => {
      try {
        seen.push(JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')).n);
      } catch (err) {
        if (err.code !== 'ENOENT') seen.push(`bad: ${err.message}`);
      }
    }, 10);
    await Promise.all(saves);
    clearInterval(watcher);
    expect(seen.filter((s) => typeof s === 'string')).toEqual([]);
  });

  it('rejects a save whose write failed, and recovers on the next', async () => {
    let fail = true;
    const fs = {
      ...realFs,
      rename: async (a, b) => {
        if (fail) throw Object.assign(new Error('nope'), { code: 'EXDEV' });
        return realFs.rename(a, b);
      },
    };
    const store = make({ fs });
    await expect(store.save(good(1))).rejects.toThrow('nope');
    fail = false;
    await store.save(good(2));
    expect((await read('state.json')).n).toBe(2);
  });

  it('flush waits for saves already accepted', async () => {
    const { fs } = slowFs();
    const store = make({ fs });
    void store.save(good(1));
    void store.save(good(2));
    await store.flush();
    expect((await read('state.json')).n).toBe(2);
    await store.flush();
  });
});
