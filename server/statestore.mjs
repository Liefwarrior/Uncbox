// data/state.json: everything the person has set up. This is the one file that must never be lost,
// so it gets three protections on top of the atomic write in datafile.mjs:
//
//   - Saves are serialized and coalesced. The page saves on every edit; a save that arrives while
//     another is being written replaces any save still waiting, so the last one always wins and two
//     writes never interleave.
//   - state.json.bak is the last state that was saved, refreshed at most once a minute, so a bad
//     write (or a hand edit gone wrong) costs at most a minute of changes.
//   - On startup, a state.json that is missing (with a backup beside it), empty or unreadable is
//     replaced by the backup. The damaged file is kept aside as state.json.corrupt-<time>, and the
//     page is told once, so it can say so.

import { readdir, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { readJsonSafe, writeJsonAtomic } from './datafile.mjs';

export const BACKUP_EVERY_MS = 60_000;
/** How many set-aside damaged copies are kept. */
const KEEP_CORRUPT = 3;
export const RESTORED_NOTICE = 'Uncbox restored your last good settings.';

/** Whether a parsed file looks like saved state (a JSON object with something in it). */
export function isUsableState(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {() => number} [o.now]
 * @param {(line: string) => void} [o.log]
 * @param {number} [o.backupEveryMs]
 * @param {object} [o.fs]  swapped out by the tests (passed on to datafile.mjs)
 */
export function createStateStore({ dataDir, now = Date.now, log = (line) => console.log(line), backupEveryMs = BACKUP_EVERY_MS, fs }) {
  const file = path.join(dataDir, 'state.json');
  const backup = `${file}.bak`;
  const io = fs ? { fs } : {};

  let lastBackupAt = -Infinity;
  /** The save waiting its turn: { state, waiters }. A newer save replaces its state. */
  let pending = null;
  let draining = null;
  let notice = null;

  async function readText() {
    try {
      return await readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      // Locked for a moment, say: failing the read is safer than treating the file as damaged.
      throw err;
    }
  }

  /** Keeps a damaged state.json for a look later instead of overwriting it. */
  async function setAside() {
    const name = `${file}.corrupt-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`;
    await rename(file, name).catch(() => {});
    try {
      const old = (await readdir(dataDir)).filter((n) => n.startsWith('state.json.corrupt-')).sort();
      for (const n of old.slice(0, Math.max(0, old.length - KEEP_CORRUPT))) await unlink(path.join(dataDir, n)).catch(() => {});
    } catch {
      // Nothing to tidy.
    }
  }

  async function writeBackup(state) {
    lastBackupAt = now();
    try {
      await writeJsonAtomic(backup, state, { pretty: true, ...io });
    } catch (err) {
      log(`Uncbox: couldn't update the settings backup: ${err.message}`);
    }
  }

  return {
    file,
    backup,

    /** The saved state; null when nothing is saved yet. Falls back to the backup when the file is damaged. */
    async load() {
      const text = await readText();
      let state = null;
      if (text !== null && text.trim()) {
        try {
          state = JSON.parse(text);
        } catch {
          // Damaged: handled below.
        }
        if (isUsableState(state)) {
          if (lastBackupAt === -Infinity) {
            // Make sure a backup exists from the first start on.
            const have = await readJsonSafe(backup, null, io);
            if (isUsableState(have)) lastBackupAt = now();
            else await writeBackup(state);
          }
          return state;
        }
      }
      const good = await readJsonSafe(backup, null, io);
      const hadFile = text !== null && text.trim() !== '';
      if (!isUsableState(good)) {
        if (hadFile) {
          log('Uncbox: data/state.json is damaged and there is no backup to restore. Starting fresh; the damaged file was kept next to it.');
          await setAside();
        }
        return null;
      }
      if (hadFile) await setAside();
      log(
        text === null
          ? 'Uncbox: data/state.json is missing. Restored your last good settings from state.json.bak.'
          : 'Uncbox: data/state.json was empty or damaged. Restored your last good settings from state.json.bak.',
      );
      await writeJsonAtomic(file, good, { pretty: true, ...io });
      lastBackupAt = now();
      notice = { message: RESTORED_NOTICE };
      return good;
    },

    /**
     * Saves `state`. Resolves once it, or a newer state that replaced it while it waited, is on
     * disk. Rejects if that write failed.
     */
    save(state) {
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        if (pending) {
          pending.state = state;
          pending.waiters.push(waiter);
        } else {
          pending = { state, waiters: [waiter] };
        }
        draining ??= drain();
      });
    },

    /** Resolves when every save made so far is on disk (for shutting down). */
    async flush() {
      while (draining) await draining;
    },

    /** The "restored" notice, once; null after that or when nothing was restored. */
    takeNotice() {
      const n = notice;
      notice = null;
      return n;
    },
  };

  async function drain() {
    try {
      while (pending) {
        const job = pending;
        pending = null;
        try {
          await writeJsonAtomic(file, job.state, { pretty: true, ...io });
          if (now() - lastBackupAt >= backupEveryMs && isUsableState(job.state)) await writeBackup(job.state);
          for (const w of job.waiters) w.resolve();
        } catch (err) {
          for (const w of job.waiters) w.reject(err);
        }
      }
    } finally {
      // Cleared in the same step the queue is found empty, so a save can't slip in between.
      draining = null;
    }
  }
}
