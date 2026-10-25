// How the server reads and writes the small JSON files in the data folder (settings, tokens,
// caches). A write goes to a temp file next to the target, is flushed to disk, then renamed over
// it, so a crash, a power cut or a full disk leaves either the old file or the new one, never half
// of one. Reads never throw: a missing or damaged file gives the caller's fallback.

import * as fsp from 'node:fs/promises';
import path from 'node:path';

let counter = 0;

/** Errors a rename gets when antivirus, a search indexer or a backup tool holds the target for a moment. */
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_TRIES = 6;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Replaces `file` with `data` (a string or Buffer) in one step. `mode` is for files holding
 * secrets (0o600). `fs` and `sleep` are what the tests swap out.
 */
export async function writeFileAtomic(file, data, { mode, fs = fsp, sleep = pause } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${++counter}`;
  try {
    const handle = await fs.open(tmp, 'w', mode);
    try {
      await handle.writeFile(data);
      // Without this, the rename can reach the disk before the data does.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(fs, tmp, file, sleep);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

async function renameWithRetry(fs, from, to, sleep) {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      if (!BUSY.has(err?.code) || attempt >= RENAME_TRIES) throw err;
      await sleep(25 * 2 ** (attempt - 1));
    }
  }
}

/** `value` as JSON in `file`, atomically. `pretty` indents it for files people may open. */
export function writeJsonAtomic(file, value, { mode, pretty = false, ...rest } = {}) {
  const text = JSON.stringify(value, null, pretty ? 2 : undefined);
  if (text === undefined) return Promise.reject(new TypeError('That value has no JSON form'));
  return writeFileAtomic(file, text, { mode, ...rest });
}

/** The JSON in `file`, or `fallback` when it is missing, empty or damaged. Never throws. */
export async function readJsonSafe(file, fallback = null, { fs = fsp } = {}) {
  try {
    const text = await fs.readFile(file, 'utf8');
    if (!text.trim()) return fallback;
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Removes temp files an earlier run left behind by crashing mid-write (older than a minute). */
export async function cleanStaleTemps(dir, { fs = fsp, now = Date.now() } = {}) {
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!/\.tmp(-\d+-\d+)?$/.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const info = await fs.stat(full);
      if (!info.isFile() || now - info.mtimeMs < 60_000) continue;
      await fs.unlink(full);
      removed++;
    } catch {
      // Gone already, or in use: leave it.
    }
  }
  return removed;
}
