import { cp, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bundledAddons,
  configLua,
  ensure,
  findInstalls,
  install,
  normalizeSettings,
  parseBuildInfo,
  parseRegistryPaths,
  preferred,
  status,
  uninstall,
  writeConfig,
} from './install.mjs';
import { parseSavedVariables } from './savedvars.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

let dir;
let root;
let roots;
const touch = async (...parts) => {
  await mkdir(path.dirname(path.join(...parts)), { recursive: true });
  await writeFile(path.join(...parts), '');
};
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'uncbox-wow-'));
  root = path.join(dir, 'World of Warcraft');
  roots = [root, path.join(dir, 'missing')];
  await touch(root, '_classic_era_', 'WowClassic.exe');
  await mkdir(path.join(root, 'Data'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const addOns = (flavor) => path.join(root, flavor, 'Interface', 'AddOns');
const versionOf = async (flavor, name = 'Uncbox') => /^## Version:\s*(\S+)/m.exec(await readFile(path.join(addOns(flavor), name, `${name}.toc`), 'utf8').catch(() => ''))?.[1] ?? null;

describe('finding WoW', () => {
  it('finds every flavor folder that has a game program, an AddOns folder or settings', async () => {
    await touch(root, '_classic_beta_', 'WowB.exe');
    await mkdir(addOns('_retail_'), { recursive: true });
    await mkdir(path.join(root, '_ptr_', 'WTF'), { recursive: true });
    // A flavor Blizzard adds later is found by what's inside, not its name.
    await touch(root, '_forever_', 'WowForever.exe');
    // Leftovers and other folders are not WoW.
    await mkdir(path.join(root, '_xptr_'));
    await mkdir(path.join(root, '_retail_beta'));
    await touch(root, '_notadir_');
    const found = await findInstalls(roots);
    expect(found.map((i) => i.flavor).sort()).toEqual(['_classic_beta_', '_classic_era_', '_forever_', '_ptr_', '_retail_']);
    const era = found.find((i) => i.flavor === '_classic_era_');
    expect(era).toMatchObject({ label: 'Classic Era', path: addOns('_classic_era_'), dir: path.join(root, '_classic_era_'), exes: ['WowClassic.exe'] });
    expect(found.find((i) => i.flavor === '_classic_beta_')).toMatchObject({ label: 'WoW Forever (beta)', exes: ['WowB.exe'] });
    expect(found.find((i) => i.flavor === '_forever_')).toMatchObject({ label: 'forever', exes: ['WowForever.exe'] });
  });

  it('tells flavors apart with Battle.net’s .build.info', async () => {
    const header = 'Branch!STRING:0|Active!DEC:1|Version!STRING:0|Product!STRING:0';
    await writeFile(path.join(root, '.build.info'), `${header}\nus|1|1.15.9.70003|wow_classic_era\nus|1|2.0.0.1|wow_classic_beta\n`);
    await touch(root, '_classic_beta_', 'WowB.exe');
    const found = await findInstalls(roots);
    expect(found.find((i) => i.flavor === '_classic_era_')).toMatchObject({ product: 'wow_classic_era', build: '1.15.9.70003', branch: 'us' });
    expect(found.find((i) => i.flavor === '_classic_beta_')).toMatchObject({ product: 'wow_classic_beta', build: '2.0.0.1' });
    expect(parseBuildInfo('')).toEqual([]);
    expect(parseBuildInfo(`${header}\n`)).toEqual([]);
  });

  it('reads Battle.net’s install path from the registry output', () => {
    const out = [
      '',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Blizzard Entertainment\\World of Warcraft',
      '    InstallPath    REG_SZ    D:\\Games\\World of Warcraft\\_retail_\\',
      '',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Blizzard Entertainment\\World of Warcraft\\Beta',
      '    InstallPath    REG_SZ    D:\\Games\\World of Warcraft\\',
      '    Other    REG_SZ    nothing',
      '',
    ].join('\r\n');
    expect(parseRegistryPaths(out)).toEqual(['D:\\Games\\World of Warcraft']);
    expect(parseRegistryPaths('ERROR: The system was unable to find the specified registry key or value.')).toEqual([]);
  });

  it('prefers WoW Forever over Classic Era, and the player’s own choice over both', async () => {
    expect(preferred([])).toBeNull();
    await touch(root, '_classic_beta_', 'WowB.exe');
    await touch(root, '_retail_', 'Wow.exe');
    const found = await findInstalls(roots);
    expect(preferred(found).flavor).toBe('_classic_beta_');
    expect(preferred(found, addOns('_retail_')).flavor).toBe('_retail_');
    // A path that isn't one of the installs is no choice.
    expect(preferred(found, path.join(dir, 'elsewhere')).flavor).toBe('_classic_beta_');
    // Without the beta, Classic Era beats retail.
    expect(preferred(found.filter((i) => i.flavor !== '_classic_beta_')).flavor).toBe('_classic_era_');
    // Anything marked forever wins, wherever it is.
    expect(preferred([...found, { flavor: '_x_', product: 'wow_forever', branch: '', path: 'p' }]).flavor).toBe('_x_');
  });
});

describe('installing the addon', () => {
  it('copies the addon into a flavor, with its files', async () => {
    const [report] = await install(addOns('_classic_era_'), roots);
    expect(report).toMatchObject({ flavor: '_classic_era_' });
    expect(report.addons.map((a) => [a.name, a.action])).toEqual(expect.arrayContaining([['Uncbox', 'installed']]));
    const toc = await readFile(path.join(addOns('_classic_era_'), 'Uncbox', 'Uncbox.toc'), 'utf8');
    for (const file of toc.split(/\r?\n/).filter((l) => l && !l.startsWith('#'))) {
      expect((await stat(path.join(addOns('_classic_era_'), 'Uncbox', file))).isFile(), file).toBe(true);
    }
  });

  it('installs everywhere in one go, replaces an old copy whole, and removes it', async () => {
    await touch(root, '_classic_beta_', 'WowB.exe');
    const before = await status(roots);
    expect(before.bundled).toMatch(/^\d+\.\d+\.\d+$/);
    expect(before.addons).toMatchObject({ Uncbox: before.bundled });
    expect(before.installs.map((i) => i.version)).toEqual([null, null]);
    expect(before.preferred).toBe(addOns('_classic_beta_'));

    // An old copy with a file the new version no longer has.
    const era = addOns('_classic_era_');
    await mkdir(path.join(era, 'Uncbox'), { recursive: true });
    await writeFile(path.join(era, 'Uncbox', 'Old.lua'), '-- gone in the new version');
    await writeFile(path.join(era, 'Uncbox', 'Uncbox.toc'), '## Version: 0.9.0\n');
    expect((await status(roots)).installs.find((i) => i.path === era).version).toBe('0.9.0');

    const reports = await install(undefined, roots);
    expect(reports).toHaveLength(2);
    expect(reports.find((r) => r.path === era).addons.find((a) => a.name === 'Uncbox')).toMatchObject({ action: 'updated', from: '0.9.0', to: before.bundled });
    const after = await status(roots);
    expect(after.installs.every((i) => i.version === after.bundled)).toBe(true);
    await expect(stat(path.join(era, 'Uncbox', 'Old.lua'))).rejects.toThrow();

    const removed = await uninstall(undefined, roots);
    expect(removed.flatMap((r) => r.addons.filter((a) => a.name === 'Uncbox').map((a) => a.action))).toEqual(['removed', 'removed']);
    expect((await status(roots)).installs.map((i) => i.version)).toEqual([null, null]);
  });

  it('refuses any other folder, and leaves unfound AddOns folders alone', async () => {
    await expect(install(path.join(dir, 'elsewhere'), roots)).rejects.toThrow(/found/);
    await expect(uninstall(path.join(dir, 'elsewhere'), roots)).rejects.toThrow(/found/);
    await expect(install(path.join(addOns('_classic_era_'), '..'), roots)).rejects.toThrow(/found/);
    await expect(install(42, roots)).rejects.toThrow(/found/);

    // An Uncbox folder in a place Uncbox never found is not touched, whatever is asked.
    const stranger = path.join(dir, 'Other Game', 'Interface', 'AddOns', 'Uncbox');
    await mkdir(stranger, { recursive: true });
    await writeFile(path.join(stranger, 'Uncbox.toc'), '## Version: 0.0.1\n');
    await install(undefined, roots);
    await uninstall(undefined, roots);
    expect(await readFile(path.join(stranger, 'Uncbox.toc'), 'utf8')).toBe('## Version: 0.0.1\n');
    // Neither is anything else in a found AddOns folder.
    await mkdir(path.join(addOns('_classic_era_'), 'Details'), { recursive: true });
    await install(undefined, roots);
    await uninstall(undefined, roots);
    await expect(stat(path.join(addOns('_classic_era_'), 'Details'))).resolves.toBeTruthy();
  });
});

describe('the automatic install', () => {
  it('installs into the preferred flavor only, and leaves the rest for the picker', async () => {
    await touch(root, '_classic_beta_', 'WowB.exe');
    const done = await ensure({ roots });
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ flavor: '_classic_beta_' });
    expect(done[0].addons.find((a) => a.name === 'Uncbox')).toMatchObject({ action: 'installed' });
    expect(await versionOf('_classic_beta_')).toBe((await status(roots)).bundled);
    expect(await versionOf('_classic_era_')).toBeNull();
  });

  it('does nothing when the version is the same, and updates when it differs', async () => {
    await ensure({ roots });
    expect((await ensure({ roots }))[0].addons.map((a) => a.action)).toEqual(['current', 'current']);
    // A different version, older or newer, is replaced.
    await writeFile(path.join(addOns('_classic_era_'), 'Uncbox', 'Uncbox.toc'), '## Version: 99.0.0\n');
    expect((await ensure({ roots }))[0].addons.find((a) => a.name === 'Uncbox')).toMatchObject({ action: 'updated', from: '99.0.0' });
    expect(await versionOf('_classic_era_')).toBe((await status(roots)).bundled);
  });

  it('keeps a copy in another flavor current, but does not add one there', async () => {
    await touch(root, '_classic_beta_', 'WowB.exe');
    await install(addOns('_classic_era_'), roots);
    await writeFile(path.join(addOns('_classic_era_'), 'Uncbox', 'Uncbox.toc'), '## Version: 0.1.0\n');
    const done = await ensure({ roots });
    expect(done.map((r) => [r.flavor, r.addons.find((a) => a.name === 'Uncbox').action]).sort()).toEqual([
      ['_classic_beta_', 'installed'],
      ['_classic_era_', 'updated'],
    ]);
    await touch(root, '_retail_', 'Wow.exe');
    expect((await ensure({ roots })).map((r) => r.flavor).sort()).toEqual(['_classic_beta_', '_classic_era_']);
    expect(await versionOf('_retail_')).toBeNull();
  });

  it('installs into the install the player picked', async () => {
    await touch(root, '_classic_beta_', 'WowB.exe');
    const done = await ensure({ roots, chosenPath: addOns('_classic_era_') });
    expect(done.map((r) => r.flavor)).toEqual(['_classic_era_']);
    // Or into one named outright, which has to be one that was found.
    expect((await ensure({ roots, target: addOns('_classic_beta_') }))[0].flavor).toBe('_classic_beta_');
    await expect(ensure({ roots, target: path.join(dir, 'elsewhere') })).rejects.toThrow(/found/);
  });

  it('finds nothing to do without WoW', async () => {
    expect(await ensure({ roots: [path.join(dir, 'missing')] })).toEqual([]);
  });

  it('writes the player’s settings, and keeps them when the addon updates', async () => {
    const settings = { strip: { enabled: false, corner: 'TOPRIGHT' }, modules: { loot: false } };
    await ensure({ roots, settings });
    const file = path.join(addOns('_classic_era_'), 'Uncbox', 'UncboxConfig.lua');
    expect(parseSavedVariables(await readFile(file, 'utf8')).UncboxConfig).toMatchObject({ strip: { enabled: false, corner: 'TOPRIGHT' }, modules: { loot: false, guild: true } });
    await writeFile(path.join(addOns('_classic_era_'), 'Uncbox', 'Uncbox.toc'), '## Version: 0.1.0\n');
    await ensure({ roots, settings });
    expect(parseSavedVariables(await readFile(file, 'utf8')).UncboxConfig.strip.corner).toBe('TOPRIGHT');
    // A changed setting is written even though the addon is current.
    await ensure({ roots, settings: { ...settings, strip: { enabled: true, corner: 'TOPLEFT' } } });
    expect(parseSavedVariables(await readFile(file, 'utf8')).UncboxConfig.strip).toEqual({ enabled: true, corner: 'TOPLEFT' });
  });
});

describe('every addon Uncbox ships', () => {
  // A copy of the installer with a second addon next to Uncbox, the way UncboxAH arrives.
  let copy;
  beforeEach(async () => {
    const base = path.join(dir, 'app', 'integrations', 'wow');
    await mkdir(path.join(base, 'addon'), { recursive: true });
    for (const f of ['install.mjs', 'savedvars.mjs']) await cp(path.join(here, f), path.join(base, f));
    await cp(path.join(here, 'addon', 'Uncbox'), path.join(base, 'addon', 'Uncbox'), { recursive: true });
    await mkdir(path.join(base, 'addon', 'UncboxAH'));
    await writeFile(path.join(base, 'addon', 'UncboxAH', 'UncboxAH.toc'), '## Version: 0.3.0\n\nAH.lua\n');
    await writeFile(path.join(base, 'addon', 'UncboxAH', 'AH.lua'), '-- ah');
    // A folder without a .toc is not an addon.
    await mkdir(path.join(base, 'addon', 'notes'));
    copy = await import(pathToFileURL(path.join(base, 'install.mjs')).href);
  });

  it('lists, installs, reports and removes each one', async () => {
    expect((await copy.bundledAddons()).map((a) => a.name)).toEqual(['Uncbox', 'UncboxAH']);
    const st = await copy.status(roots);
    expect(st.addons).toMatchObject({ UncboxAH: '0.3.0' });
    expect(st.installs[0].addons).toEqual({ Uncbox: null, UncboxAH: null });

    const [report] = await copy.install(undefined, roots);
    expect(report.addons.map((a) => [a.name, a.action])).toEqual([['Uncbox', 'installed'], ['UncboxAH', 'installed']]);
    expect(await versionOf('_classic_era_', 'UncboxAH')).toBe('0.3.0');
    expect((await copy.status(roots)).installs[0].addons).toMatchObject({ UncboxAH: '0.3.0' });

    // Only the stale one is replaced.
    await writeFile(path.join(addOns('_classic_era_'), 'UncboxAH', 'UncboxAH.toc'), '## Version: 0.1.0\n');
    const [again] = await copy.ensure({ roots });
    expect(again.addons.map((a) => [a.name, a.action])).toEqual([['Uncbox', 'current'], ['UncboxAH', 'updated']]);

    const [gone] = await copy.uninstall(undefined, roots);
    expect(gone.addons.map((a) => [a.name, a.action])).toEqual([['Uncbox', 'removed'], ['UncboxAH', 'removed']]);
    expect(await versionOf('_classic_era_', 'UncboxAH')).toBeNull();
  });

  it('the real addon folder has only addons with a .toc of their own name', async () => {
    for (const a of await bundledAddons()) expect((await stat(path.join(here, 'addon', a.name, `${a.name}.toc`))).isFile()).toBe(true);
  });
});

describe('the settings file', () => {
  it('turns any input into valid settings', () => {
    expect(normalizeSettings(null)).toEqual({
      strip: { enabled: true, corner: 'TOPLEFT' },
      modules: { character: true, quests: true, party: true, guild: true, raid: true, loot: true },
      lootMinQuality: 2,
    });
    expect(normalizeSettings({ strip: { enabled: 'yes', corner: 'BOTTOMLEFT' }, modules: { guild: false, evil: true, raid: 'no' }, lootMinQuality: 9, extra: 1 })).toEqual({
      strip: { enabled: true, corner: 'TOPLEFT' },
      modules: { character: true, quests: true, party: true, guild: false, raid: true, loot: true },
      lootMinQuality: 2,
    });
    expect(normalizeSettings({ lootMinQuality: 4 }).lootMinQuality).toBe(4);
    expect(normalizeSettings({ strip: { corner: 'TOPRIGHT' } }).strip.corner).toBe('TOPRIGHT');
  });

  it('writes UncboxConfig.lua that reads back the same', () => {
    const settings = normalizeSettings({ strip: { enabled: false, corner: 'TOPRIGHT' }, modules: { loot: false, party: false }, lootMinQuality: 3 });
    const text = configLua(settings);
    expect(text).toMatch(/^-- Settings chosen in Uncbox/);
    expect(text).toContain('UncboxConfig = {');
    expect(parseSavedVariables(text).UncboxConfig).toEqual({ version: 1, ...settings });
  });

  it('the file shipped in the addon is the defaults', async () => {
    const shipped = parseSavedVariables(await readFile(path.join(here, 'addon', 'Uncbox', 'UncboxConfig.lua'), 'utf8')).UncboxConfig;
    expect(shipped).toEqual({ version: 1, ...normalizeSettings({}) });
  });

  it('writes into installed addons only, and not again when nothing changed', async () => {
    await touch(root, '_classic_beta_', 'WowB.exe');
    const settings = { modules: { guild: false } };
    // Nothing installed yet: nothing to write to.
    expect(await writeConfig(settings, undefined, roots)).toEqual([]);
    await install(addOns('_classic_era_'), roots);
    const written = await writeConfig(settings, undefined, roots);
    expect(written).toEqual([path.join(addOns('_classic_era_'), 'Uncbox', 'UncboxConfig.lua')]);
    expect(parseSavedVariables(await readFile(written[0], 'utf8')).UncboxConfig.modules.guild).toBe(false);
    const old = new Date(2020, 1, 1);
    await utimes(written[0], old, old);
    expect(await writeConfig(settings, undefined, roots)).toEqual([]);
    expect((await stat(written[0])).mtime.getFullYear()).toBe(2020);
    await expect(writeConfig(settings, path.join(dir, 'elsewhere'), roots)).rejects.toThrow(/found/);
  });
});
