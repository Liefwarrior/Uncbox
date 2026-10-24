import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findInstalls, install, status, uninstall } from './install.mjs';

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
    // Every folder under addon/ goes in: the auction house addon too.
    expect(await readFile(path.join(found[0].path, 'UncboxAH', 'UncboxAH.toc'), 'utf8')).toContain('SavedVariables: UncboxAHDB');
    await uninstall(found[0].path, roots);
    await expect(stat(path.join(found[0].path, 'UncboxAH'))).rejects.toThrow();
  });

  it('installs everywhere in one go, replaces an old copy whole, and removes it', async () => {
    await mkdir(path.join(roots[0], '_classic_beta_'));
    const before = await status(roots);
    expect(before.bundled).toMatch(/^\d+\.\d+\.\d+$/);
    expect(before.installs.map((i) => i.version)).toEqual([null, null]);

    // An old copy with a file the new version no longer has.
    const era = before.installs.find((i) => i.flavor === '_classic_era_').path;
    await mkdir(path.join(era, 'Uncbox'), { recursive: true });
    await writeFile(path.join(era, 'Uncbox', 'Old.lua'), '-- gone in the new version');
    await writeFile(path.join(era, 'Uncbox', 'Uncbox.toc'), '## Version: 0.9.0\n');
    expect((await status(roots)).installs.find((i) => i.path === era).version).toBe('0.9.0');

    expect(await install(undefined, roots)).toHaveLength(2);
    const after = await status(roots);
    expect(after.installs.every((i) => i.version === after.bundled)).toBe(true);
    await expect(stat(path.join(era, 'Uncbox', 'Old.lua'))).rejects.toThrow();

    await uninstall(undefined, roots);
    expect((await status(roots)).installs.map((i) => i.version)).toEqual([null, null]);
  });

  it('refuses any other folder', async () => {
    await expect(install(path.join(dir, 'elsewhere'), roots)).rejects.toThrow(/found/);
    await expect(uninstall(path.join(dir, 'elsewhere'), roots)).rejects.toThrow(/found/);
  });
});
