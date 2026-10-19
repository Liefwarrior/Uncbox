import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadTls } from './tls.mjs';

let dir;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'uncbox-tls-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('loadTls', () => {
  it('returns null until setup-domain has run', async () => {
    expect(await loadTls(dir)).toBeNull();
  });

  it('reads the certificate and its password, even with a byte order mark', async () => {
    await mkdir(path.join(dir, 'tls'));
    await writeFile(path.join(dir, 'tls', 'unc.box.pfx'), Buffer.from([1, 2, 3]));
    await writeFile(path.join(dir, 'tls', 'unc.box.json'), '﻿{"passphrase":"abc"}');
    expect(await loadTls(dir)).toEqual({ pfx: Buffer.from([1, 2, 3]), passphrase: 'abc' });
  });
});
