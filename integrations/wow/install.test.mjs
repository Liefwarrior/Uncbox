import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findInstalls, install } from './install.mjs';

let dir;
let roots;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'uncbox-wow-'));
  roots = [path.join(dir, 'World of Warcraft'), path.join(dir, 'missing')];
  await mkdir(path.join(roots[0], '_classic_era_'), { recursive: true });
  await mkdir(path.join(roots[0], 'Data'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('WoW addon install', () => {
  it('finds each flavor and copies the addon into it', async () => {
    const found = await findInstalls(roots);
    expect(found).toEqual([{ flavor: '_classic_era_', path: path.join(roots[0], '_classic_era_', 'Interface', 'AddOns') }]);
    await install(found[0].path, roots);
    const toc = await readFile(path.join(found[0].path, 'Uncbox', 'Uncbox.toc'), 'utf8');
    expect(toc).toContain('Codec.lua');
  });

  it('refuses any other folder', async () => {
    await expect(install(path.join(dir, 'elsewhere'), roots)).rejects.toThrow(/found/);
  });
});
