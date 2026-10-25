import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { savedVariablesIn } from './wowahwatch.mjs';

let temp;
beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'uncbox-ahwatch-'));
});
afterEach(() => rm(temp, { recursive: true, force: true }));

describe('savedVariablesIn', () => {
  it('only watches account folders that have a SavedVariables folder', async () => {
    const flavor = path.join(temp, '_classic_beta_');
    const accounts = path.join(flavor, 'WTF', 'Account');
    // WoW keeps its own SavedVariables folder beside the accounts; it is not an account.
    await mkdir(path.join(accounts, 'SavedVariables'), { recursive: true });
    await mkdir(path.join(accounts, 'ACCOUNT1', 'SavedVariables'), { recursive: true });
    await mkdir(path.join(accounts, 'ACCOUNT2'), { recursive: true });
    await writeFile(path.join(accounts, 'ACCOUNT1', 'SavedVariables', 'UncboxAH.lua'), 'UncboxAHDB = {}');

    const { dirs, files } = await savedVariablesIn(path.join(flavor, 'Interface', 'AddOns'));
    expect(dirs).toEqual([path.join(accounts, 'ACCOUNT1', 'SavedVariables')]);
    expect(files).toEqual([path.join(accounts, 'ACCOUNT1', 'SavedVariables', 'UncboxAH.lua')]);
  });

  it('finds nothing when WoW has no WTF folder yet', async () => {
    expect(await savedVariablesIn(path.join(temp, 'Interface', 'AddOns'))).toEqual({ dirs: [], files: [] });
  });
});
