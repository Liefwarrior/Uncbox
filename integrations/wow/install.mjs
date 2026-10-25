// Finds WoW on this PC, and installs, updates and removes the Uncbox addons in it. It only ever
// touches the Uncbox addon folders inside an AddOns folder it found itself in a WoW install.
//
// Every folder under addon/ with a matching .toc (Uncbox, and others added later, like UncboxAH)
// is an addon Uncbox ships; install, uninstall and status work on all of them and report per addon.

import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toLuaFile } from './savedvars.mjs';

export const ADDON_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'addon');

// ---- finding WoW ----

/** What each flavor folder is, in plain words. */
const FLAVOR_NAMES = {
  _retail_: 'Retail',
  _classic_era_: 'Classic Era',
  _classic_era_ptr_: 'Classic Era PTR',
  _classic_beta_: 'WoW Forever (beta)',
  _classic_: 'Classic',
  _classic_ptr_: 'Classic PTR',
  _ptr_: 'Retail PTR',
  _xptr_: 'Retail PTR 2',
  _beta_: 'Retail beta',
};

/** Which flavor folder Battle.net's .build.info "Product" belongs in. */
const PRODUCT_FLAVOR = {
  wow: '_retail_',
  wowt: '_ptr_',
  wowxptr: '_xptr_',
  wow_beta: '_beta_',
  wow_classic: '_classic_',
  wow_classic_ptr: '_classic_ptr_',
  wow_classic_beta: '_classic_beta_',
  wow_classic_era: '_classic_era_',
  wow_classic_era_ptr: '_classic_era_ptr_',
};

/**
 * How much Uncbox prefers a flavor: WoW Forever first (anything marked forever, then the beta
 * folder it installs under), then Classic Era, then the rest.
 */
const PREFERENCE = {
  _classic_beta_: 90,
  _classic_era_: 70,
  _classic_era_ptr_: 65,
  _classic_: 60,
  _classic_ptr_: 55,
  _retail_: 40,
  _ptr_: 30,
  _xptr_: 20,
  _beta_: 15,
};

/** Where WoW usually lives: each drive's Program Files folders, its root, and Games and Battle.net folders. */
export function defaultRoots() {
  const roots = [];
  for (const drive of 'CDEFGH') {
    for (const dir of ['Program Files (x86)', 'Program Files', '', 'Games', 'Battle.net']) {
      roots.push(path.win32.join(`${drive}:\\`, dir, 'World of Warcraft'));
    }
  }
  return roots;
}

const REGISTRY_KEYS = [
  'HKLM\\SOFTWARE\\WOW6432Node\\Blizzard Entertainment\\World of Warcraft',
  'HKLM\\SOFTWARE\\Blizzard Entertainment\\World of Warcraft',
];

/** The InstallPath lines in `reg query` output, each as the World of Warcraft folder (not a flavor folder inside it). */
export function parseRegistryPaths(output) {
  const roots = [];
  for (const m of String(output).matchAll(/^\s*InstallPath\s+REG_\w+\s+(.+?)\s*$/gim)) {
    let p = path.win32.normalize(m[1]);
    p = p.replace(/[\\/]+$/, '');
    // Some keys name the flavor folder (...\_retail_\): the root is the folder above it.
    if (/^_.+_$/.test(path.win32.basename(p))) p = path.win32.dirname(p);
    if (p && !roots.includes(p)) roots.push(p);
  }
  return roots;
}

/** Where Battle.net says WoW is installed. Empty off Windows or when nothing is registered. */
export async function registryRoots(run = execFile) {
  if (process.platform !== 'win32') return [];
  const out = await Promise.all(
    REGISTRY_KEYS.map(
      (key) =>
        new Promise((resolve) => {
          run('reg', ['query', key, '/s', '/v', 'InstallPath'], { windowsHide: true, timeout: 4000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
        }),
    ),
  );
  return parseRegistryPaths(out.join('\n'));
}

/** Every place to look for WoW: what Battle.net registered (unless `registry` is false), then the usual folders. */
export async function resolveRoots({ registry = true } = {}) {
  const roots = [...(registry ? await registryRoots() : []), ...defaultRoots()];
  return [...new Set(roots)];
}

/** The rows of Battle.net's .build.info as { product, version, branch }, or []. */
export function parseBuildInfo(text) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const names = lines[0].split('|').map((h) => h.split('!')[0].trim().toLowerCase());
  const col = (name) => names.indexOf(name);
  return lines.slice(1).map((line) => {
    const f = line.split('|');
    return { product: (f[col('product')] ?? '').trim(), version: (f[col('version')] ?? '').trim(), branch: (f[col('branch')] ?? '').trim() };
  });
}

const isDir = (p) => readdir(p).then(() => true, () => false);

/**
 * AddOns folders of every WoW flavor installed, as { flavor, label, path, dir, root, exes, product,
 * build }: `path` is the AddOns folder, `dir` the flavor folder, `exes` the game programs in it
 * (WowClassic.exe…). A folder named _something_ counts when it has a game program, an Interface\AddOns
 * folder or a WTF folder, so a flavor Blizzard adds later is found too, and a leftover empty one isn't.
 */
export async function findInstalls(roots) {
  roots ??= await resolveRoots();
  const found = [];
  const seen = new Set();
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const rows = parseBuildInfo(await readFile(path.join(root, '.build.info'), 'utf8').catch(() => ''));
    for (const e of entries) {
      if (!e.isDirectory() || !/^_.+_$/.test(e.name)) continue;
      const dir = path.join(root, e.name);
      const key = dir.toLowerCase();
      if (seen.has(key)) continue;
      const inside = await readdir(dir).catch(() => []);
      const exes = inside.filter((n) => /^wow.*\.exe$/i.test(n));
      const hasAddOns = await isDir(path.join(dir, 'Interface', 'AddOns'));
      if (!exes.length && !hasAddOns && !inside.includes('WTF')) continue;
      seen.add(key);
      const row = rows.find((r) => PRODUCT_FLAVOR[r.product] === e.name);
      found.push({
        flavor: e.name,
        label: FLAVOR_NAMES[e.name] ?? e.name.replace(/^_+|_+$/g, '').replace(/_/g, ' '),
        path: path.join(dir, 'Interface', 'AddOns'),
        dir,
        root,
        exes,
        product: row?.product ?? '',
        build: row?.version ?? '',
        branch: row?.branch ?? '',
      });
    }
  }
  return found;
}

/** Higher is more wanted: WoW Forever, then Classic Era, then the others. */
function score(install) {
  if (/forever/i.test(`${install.flavor} ${install.product} ${install.branch}`)) return 100;
  return PREFERENCE[install.flavor] ?? 10;
}

/**
 * The install Uncbox puts the addon in: the one the user chose if it's still there, otherwise
 * WoW Forever, then Classic Era, then the rest. Null when there are none.
 */
export function preferred(installs, chosenPath = '') {
  const chosen = chosenPath && installs.find((i) => i.path === chosenPath);
  if (chosen) return chosen;
  let best = null;
  for (const i of installs) if (!best || score(i) > score(best)) best = i;
  return best;
}

// ---- the addons Uncbox ships ----

/** The "## Version:" in an addon's .toc, or null if it isn't there. */
async function versionIn(addonDir, name) {
  const toc = await readFile(path.join(addonDir, `${name}.toc`), 'utf8').catch(() => null);
  return toc === null ? null : (/^## Version:\s*(\S+)/m.exec(toc)?.[1] ?? '');
}

/** The addons Uncbox ships, as { name, version }: every folder under addon/ with its own .toc. */
export async function bundledAddons() {
  const entries = await readdir(ADDON_DIR, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const version = await versionIn(path.join(ADDON_DIR, e.name), e.name);
    if (version !== null) out.push({ name: e.name, version });
  }
  // Uncbox itself first: it's the one the rest of the app is about.
  return out.sort((a, b) => (b.name === 'Uncbox') - (a.name === 'Uncbox'));
}

/**
 * The version Uncbox ships, and each WoW install's copy: { bundled, addons, preferred, installs }.
 * `addons` is the version of each shipped addon, `bundled` the Uncbox addon's; each install lists
 * its own copies in `addons` (null when not installed) and `version` for the Uncbox addon.
 */
export async function status(roots, chosenPath = '') {
  const [list, installs] = await Promise.all([bundledAddons(), findInstalls(roots)]);
  const best = preferred(installs, chosenPath);
  return {
    bundled: list.find((a) => a.name === 'Uncbox')?.version ?? null,
    addons: Object.fromEntries(list.map((a) => [a.name, a.version])),
    preferred: best?.path ?? null,
    installs: await Promise.all(
      installs.map(async (i) => {
        const copies = Object.fromEntries(await Promise.all(list.map(async (a) => [a.name, await versionIn(path.join(i.path, a.name), a.name)])));
        return { ...i, version: copies.Uncbox ?? null, addons: copies };
      }),
    ),
  };
}

/** The AddOns folders to act on: target (which must be one Uncbox found), or every one found. */
async function targets(target, roots) {
  const installs = await findInstalls(roots);
  if (target === undefined || target === null) return installs;
  if (typeof target !== 'string' || !installs.some((i) => i.path === target)) {
    throw Object.assign(new Error('That isn’t a WoW AddOns folder Uncbox found.'), { status: 400 });
  }
  return installs.filter((i) => i.path === target);
}

// ---- settings: UncboxConfig.lua ----

export const DEFAULT_SETTINGS = {
  strip: { enabled: true, corner: 'TOPLEFT' },
  modules: { character: true, quests: true, party: true, guild: true, raid: true, loot: true },
  lootMinQuality: 2,
};

/** Settings from anyone, cleaned up: unknown keys dropped, bad values replaced by the defaults. */
export function normalizeSettings(input) {
  const s = input && typeof input === 'object' ? input : {};
  const modules = {};
  for (const key of Object.keys(DEFAULT_SETTINGS.modules)) {
    modules[key] = typeof s.modules?.[key] === 'boolean' ? s.modules[key] : DEFAULT_SETTINGS.modules[key];
  }
  const quality = Math.round(Number(s.lootMinQuality));
  return {
    strip: {
      enabled: typeof s.strip?.enabled === 'boolean' ? s.strip.enabled : DEFAULT_SETTINGS.strip.enabled,
      corner: s.strip?.corner === 'TOPRIGHT' ? 'TOPRIGHT' : 'TOPLEFT',
    },
    modules,
    lootMinQuality: Number.isFinite(quality) && quality >= 0 && quality <= 6 ? quality : DEFAULT_SETTINGS.lootMinQuality,
  };
}

/** The text of UncboxConfig.lua: a data file the addon loads on /reload (listed in its .toc). */
export function configLua(settings) {
  const s = normalizeSettings(settings);
  return toLuaFile(
    { UncboxConfig: { version: 1, ...s } },
    'Settings chosen in Uncbox. Uncbox rewrites this file; changes here are lost.\n/reload in WoW picks up a change.',
  );
}

/** Writes the settings into the Uncbox addon of each install given (or found). Returns the files written. */
export async function writeConfig(settings, target, roots) {
  const text = configLua(settings);
  const written = [];
  for (const i of await targets(target, roots)) {
    const file = path.join(i.path, 'Uncbox', 'UncboxConfig.lua');
    if ((await versionIn(path.join(i.path, 'Uncbox'), 'Uncbox')) === null) continue;
    // Not rewritten when it already says this, so WoW's file watcher and backups stay quiet.
    if ((await readFile(file, 'utf8').catch(() => null)) === text) continue;
    await writeFile(file, text);
    written.push(file);
  }
  return written;
}

// ---- installing ----

/**
 * One install's report: { path, flavor, label, addons: [{ name, action, from, to }] }. action is
 * "installed" (it wasn't there), "updated" (another version was), "reinstalled" (same version,
 * asked for) or "removed" / "current" (nothing to do).
 */
async function copyAddons(install, list, { only, settings }) {
  const report = { path: install.path, flavor: install.flavor, label: install.label, addons: [] };
  for (const a of list) {
    const from = await versionIn(path.join(install.path, a.name), a.name);
    if (only === 'stale' && from === a.version) {
      report.addons.push({ name: a.name, action: 'current', from, to: a.version });
      continue;
    }
    await mkdir(install.path, { recursive: true });
    // An older copy is replaced whole, so files a newer version dropped don't linger.
    await rm(path.join(install.path, a.name), { recursive: true, force: true });
    await cp(path.join(ADDON_DIR, a.name), path.join(install.path, a.name), { recursive: true });
    report.addons.push({ name: a.name, action: from === null ? 'installed' : from === a.version ? 'reinstalled' : 'updated', from, to: a.version });
  }
  if (settings && report.addons.some((a) => a.name === 'Uncbox' && a.action !== 'current')) await writeConfig(settings, install.path, [install.root]);
  return report;
}

/**
 * Copies every shipped addon into target (one AddOns folder Uncbox found), or into every WoW
 * install found when target is left out. Returns one report per install. `settings` is written
 * as UncboxConfig.lua afterward.
 */
export async function install(target, roots, { settings } = {}) {
  const list = await bundledAddons();
  const reports = [];
  for (const i of await targets(target, roots)) reports.push(await copyAddons(i, list, { only: 'all', settings }));
  return reports;
}

/**
 * The automatic install: puts the addons in the preferred install when they're missing, and brings
 * any copy that's already there up to this version. Returns what it did, one report per install it
 * touched ("current" addons mean nothing was needed); [] when WoW isn't found. With `target`, only
 * that install (which must be one Uncbox found).
 */
export async function ensure({ target, roots, chosenPath = '', settings } = {}) {
  const [list, installs] = await Promise.all([bundledAddons(), findInstalls(roots)]);
  let picked;
  if (target) {
    picked = (await targets(target, roots)).slice(0, 1);
  } else {
    const best = preferred(installs, chosenPath);
    picked = installs.filter((i) => i === best);
    // Anywhere Uncbox's addon already is, keep it current.
    for (const i of installs) {
      if (picked.includes(i)) continue;
      if ((await versionIn(path.join(i.path, 'Uncbox'), 'Uncbox')) !== null) picked.push(i);
    }
  }
  const reports = [];
  for (const i of picked) reports.push(await copyAddons(i, list, { only: 'stale', settings }));
  // The settings file follows the settings even when the addon itself is current.
  if (settings) {
    for (const i of picked) await writeConfig(settings, i.path, [i.root]);
  }
  return reports;
}

/** Removes every shipped addon from target (an AddOns folder Uncbox found), or from every install found. Its saved settings stay in WTF. */
export async function uninstall(target, roots) {
  const list = await bundledAddons();
  const reports = [];
  for (const i of await targets(target, roots)) {
    const report = { path: i.path, flavor: i.flavor, label: i.label, addons: [] };
    for (const a of list) {
      const from = await versionIn(path.join(i.path, a.name), a.name);
      if (from === null) continue;
      await rm(path.join(i.path, a.name), { recursive: true, force: true });
      report.addons.push({ name: a.name, action: 'removed', from, to: null });
    }
    reports.push(report);
  }
  return reports;
}

/** Opens the folder holding the addon, for copying it by hand. */
export function reveal() {
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(cmd, [ADDON_DIR], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
