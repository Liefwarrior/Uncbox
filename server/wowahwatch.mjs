// Finds the UncboxAH SavedVariables files and calls back whenever one has changed. WoW writes them
// when you /reload or log out, by writing the whole file again, so this watches the folders (a
// rewrite can show up as a rename), waits for the writing to settle, and polls as well in case
// fs.watch misses something (network drives, antivirus, sleeping laptops).

import { createHash } from 'node:crypto';
import { watch as fsWatch } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** Which WoW flavors Uncbox prefers: WoW Forever (the classic beta) first, then Classic Era. */
export const FLAVOR_ORDER = ['_classic_beta_', '_classic_era_', '_classic_ptr_', '_classic_', '_anniversary_'];

const rank = (flavor) => {
  const i = FLAVOR_ORDER.indexOf(flavor);
  return i < 0 ? FLAVOR_ORDER.length : i;
};

/**
 * The flavor to use out of the installs findInstalls() found ([{ flavor, path }]). One that
 * already has saved data wins, then one with the addon installed, then the preferred flavor.
 * `has(install)` → { saved: bool, addon: bool }.
 */
export function chooseInstall(installs, has) {
  const sorted = [...installs].sort((a, b) => rank(a.flavor) - rank(b.flavor));
  return sorted.find((i) => has(i).saved) ?? sorted.find((i) => has(i).addon) ?? sorted[0] ?? null;
}

/** Every WTF\Account\*\SavedVariables\UncboxAH.lua that exists in a flavor, and the SavedVariables folders to watch. */
export async function savedVariablesIn(addOnsPath) {
  const wtfAccounts = path.join(path.dirname(path.dirname(addOnsPath)), 'WTF', 'Account');
  const accounts = await readdir(wtfAccounts, { withFileTypes: true }).catch(() => []);
  const dirs = [];
  const files = [];
  for (const a of accounts) {
    if (!a.isDirectory()) continue;
    const dir = path.join(wtfAccounts, a.name, 'SavedVariables');
    dirs.push(dir);
    const file = path.join(dir, 'UncboxAH.lua');
    if (await stat(file).then((s) => s.isFile(), () => false)) files.push(file);
  }
  return { dirs, files };
}

/** Whether the addon folder is installed in an AddOns folder. */
export const addonInstalled = (addOnsPath) => stat(path.join(addOnsPath, 'UncboxAH', 'UncboxAH.toc')).then((s) => s.isFile(), () => false);

/**
 * Watches the chosen flavor. `onFile(file, text)` runs for each new or changed file (return a
 * promise; a throw means "try again later"). `known(file)` returns the hash of what was last
 * ingested, so unchanged files are skipped even after a restart.
 */
export function createWatcher({ findInstalls, onFile, known, intervalMs = 30_000, settleMs = 1500, onError = () => {} }) {
  let timer = null;
  let poll = null;
  let watchers = [];
  let current = null; // { install, dirs, files }
  let closed = false;
  const stamps = new Map(); // file → "mtime:size" last looked at
  const retry = new Map(); // file → retry timer

  async function discover() {
    const installs = await findInstalls();
    const info = new Map();
    for (const i of installs) info.set(i.path, { ...(await savedVariablesIn(i.path)), addon: await addonInstalled(i.path) });
    const install = chooseInstall(installs, (i) => ({ saved: info.get(i.path).files.length > 0, addon: info.get(i.path).addon }));
    if (!install) return null;
    const { dirs, files, addon } = info.get(install.path);
    return { install, dirs, files, addon };
  }

  function watchDirs(dirs) {
    for (const w of watchers) w.close();
    watchers = [];
    for (const dir of dirs) {
      try {
        const w = fsWatch(dir, { persistent: false }, (_event, name) => {
          if (!name || /^UncboxAH\.lua(\.bak)?$/i.test(String(name))) schedule();
        });
        w.on('error', () => {});
        watchers.push(w);
      } catch (err) {
        onError(err);
      }
    }
  }

  function schedule() {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => void check(), settleMs);
    timer.unref?.();
  }

  async function check() {
    if (closed) return;
    try {
      const found = await discover();
      const dirsChanged = !current || current.dirs.join('|') !== (found?.dirs ?? []).join('|');
      current = found;
      if (found && dirsChanged) watchDirs(found.dirs);
      for (const file of found?.files ?? []) await consider(file);
    } catch (err) {
      onError(err);
    }
  }

  async function consider(file) {
    const s = await stat(file).catch(() => null);
    if (!s) return;
    const stamp = `${s.mtimeMs}:${s.size}`;
    if (stamps.get(file) === stamp) return;
    try {
      const text = await readFile(file, 'utf8');
      const hash = createHash('sha1').update(text).digest('hex');
      if (hash !== (await known(file))) await onFile(file, text, hash);
      stamps.set(file, stamp);
    } catch (err) {
      // Probably WoW is still writing it, or it is locked: look again soon.
      onError(err);
      clearTimeout(retry.get(file));
      const t = setTimeout(() => void check(), settleMs * 2);
      t.unref?.();
      retry.set(file, t);
    }
  }

  return {
    /** Looks now, then keeps watching. Resolves when the first look is done. */
    async start() {
      closed = false;
      await check();
      poll = setInterval(() => void check(), intervalMs);
      poll.unref?.();
    },
    /** Looks again now (after an install, say). */
    check,
    /** What is being watched: { install, dirs, files, addon } or null. */
    current: () => current,
    discover,
    stop() {
      closed = true;
      clearTimeout(timer);
      clearInterval(poll);
      for (const t of retry.values()) clearTimeout(t);
      for (const w of watchers) w.close();
      watchers = [];
    },
  };
}
