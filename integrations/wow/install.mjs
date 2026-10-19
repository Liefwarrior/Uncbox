// Puts the Uncbox addon into WoW's AddOns folder for the "Install addon" button. It only ever
// copies into an AddOns folder it found itself in a usual WoW install location.

import { spawn } from 'node:child_process';
import { cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ADDON_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'addon');

/** Where WoW usually lives: each drive's Program Files folders, its root and a Games folder. */
export function defaultRoots() {
  const roots = [];
  for (const drive of 'CDEFGH') {
    for (const dir of ['Program Files (x86)', 'Program Files', '', 'Games']) {
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

/** Copies the addon into target, which must be one of the folders findInstalls() returns. */
export async function install(target, roots = defaultRoots()) {
  const installs = await findInstalls(roots);
  if (typeof target !== 'string' || !installs.some((i) => i.path === target)) {
    throw Object.assign(new Error('That isn’t a WoW AddOns folder Uncbox found.'), { status: 400 });
  }
  await mkdir(target, { recursive: true });
  await cp(path.join(ADDON_DIR, 'Uncbox'), path.join(target, 'Uncbox'), { recursive: true, force: true });
  return target;
}

/** Opens the folder holding the addon, for copying it by hand. */
export function reveal() {
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(cmd, [ADDON_DIR], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
