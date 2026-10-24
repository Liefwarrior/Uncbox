// Installs, updates and removes the Uncbox addon for the Quest log's addon buttons. It only ever
// touches an Uncbox folder inside an AddOns folder it found itself in a usual WoW install location.

import { spawn } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ADDON_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'addon');

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

/** AddOns folders of every WoW flavor installed (_retail_, _classic_era_…), as { flavor, path }. */
export async function findInstalls(roots = defaultRoots()) {
  const found = [];
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory() && /^_.+_$/.test(e.name)) {
        found.push({ flavor: e.name, path: path.join(root, e.name, 'Interface', 'AddOns') });
      }
    }
  }
  return found;
}

/** The "## Version:" in an addon's .toc, or null if it isn't there. */
async function versionIn(addonDir) {
  const toc = await readFile(path.join(addonDir, 'Uncbox.toc'), 'utf8').catch(() => null);
  return toc === null ? null : (/^## Version:\s*(\S+)/m.exec(toc)?.[1] ?? '');
}

/** The version Uncbox ships, and each WoW install's copy: { bundled, installs: [{ flavor, path, version }] }. */
export async function status(roots = defaultRoots()) {
  const installs = await findInstalls(roots);
  return {
    bundled: await versionIn(path.join(ADDON_DIR, 'Uncbox')),
    installs: await Promise.all(installs.map(async (i) => ({ ...i, version: await versionIn(path.join(i.path, 'Uncbox')) }))),
  };
}

/** The AddOns folders to act on: target (which must be one Uncbox found), or every one found. */
async function targets(target, roots) {
  const installs = await findInstalls(roots);
  if (target === undefined) return installs.map((i) => i.path);
  if (typeof target !== 'string' || !installs.some((i) => i.path === target)) {
    throw Object.assign(new Error('That isn’t a WoW AddOns folder Uncbox found.'), { status: 400 });
  }
  return [target];
}

/**
 * Copies the addon into target, or into every WoW install found when target is left out. An
 * older copy is replaced whole, so files a newer version dropped don't linger. Returns the folders.
 */
export async function install(target, roots = defaultRoots()) {
  const done = await targets(target, roots);
  const addons = await addonFolders();
  for (const dir of done) {
    await mkdir(dir, { recursive: true });
    for (const name of addons) {
      await rm(path.join(dir, name), { recursive: true, force: true });
      await cp(path.join(ADDON_DIR, name), path.join(dir, name), { recursive: true });
    }
  }
  return done;
}

/** The addons Uncbox ships: every folder under addon/ (Uncbox, UncboxAH…). */
async function addonFolders() {
  const entries = await readdir(ADDON_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/** Removes the addon from target, or from every WoW install found. Its saved settings stay in WTF. */
export async function uninstall(target, roots = defaultRoots()) {
  const done = await targets(target, roots);
  const addons = await addonFolders();
  for (const dir of done) for (const name of addons) await rm(path.join(dir, name), { recursive: true, force: true });
  return done;
}

/** Opens the folder holding the addon, for copying it by hand. */
export function reveal() {
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(cmd, [ADDON_DIR], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
