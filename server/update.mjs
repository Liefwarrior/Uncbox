// Is a newer Uncbox out? Asks GitHub for the latest release at most once a day and remembers the
// answer in data/update.json. It never downloads anything: the page shows a quiet notice with a
// link to the release page, and the person decides.
//
//   GET /api/update   { current: "0.2.0", update: null | { version: "0.3.0", url } }
//
// Any trouble (offline, rate limited, no releases yet) just means "no update" and stays quiet.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from './datafile.mjs';

const REPO = 'Liefwarrior/Uncbox';
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

const DAY = 24 * 60 * 60 * 1000;
/** After a failed check (offline, rate limited) it tries again sooner than a day, but not constantly. */
const RETRY = 60 * 60 * 1000;

/** [major, minor, patch] from "v1.2.3", "1.2" or "1.2.3-beta.1", or null when it isn't a version. */
export function parseVersion(text) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text ?? '').trim());
  if (!m) return null;
  return { parts: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: Boolean(m[4]) };
}

/** True when `latest` is a newer version than `current`. A beta of 1.2.3 is older than 1.2.3 itself. */
export function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] > b.parts[i];
  }
  return b.pre && !a.pre;
}

/** The release page to open: GitHub's own link for it, or the releases page if that looks wrong. */
function releaseUrl(release) {
  const url = typeof release?.html_url === 'string' ? release.html_url : '';
  return url.startsWith(`https://github.com/${REPO}/`) ? url : RELEASES_PAGE;
}

/**
 * Asks GitHub for the latest release: { ok: true, latest: { version, url } | null } (null when
 * there are none yet, a 404), or { ok: false } when it couldn't tell. `fetchImpl` is only swapped
 * out by the tests.
 */
export async function fetchLatest(current, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(LATEST, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Uncbox/${current}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { ok: false };
  }
  if (res.status === 404) return { ok: true, latest: null };
  if (!res.ok) return { ok: false };
  let release;
  try {
    release = await res.json();
  } catch {
    return { ok: false };
  }
  if (!parseVersion(release?.tag_name) || release.draft || release.prerelease) return { ok: true, latest: null };
  return { ok: true, latest: { version: String(release.tag_name).replace(/^v/, ''), url: releaseUrl(release) } };
}

/**
 * The update check for a server running `version`. `fetchImpl` and `now` are only swapped out by
 * the tests.
 */
export function createUpdate({ dataDir, version, fetchImpl = fetch, now = Date.now }) {
  const file = path.join(dataDir, 'update.json');
  let inFlight = null;

  async function readCache() {
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      if (typeof saved?.checkedAt !== 'number') return null;
      const latest =
        saved.latest && typeof saved.latest.version === 'string' && typeof saved.latest.url === 'string'
          ? { version: saved.latest.version, url: saved.latest.url }
          : null;
      return { checkedAt: saved.checkedAt, ok: saved.ok !== false, latest };
    } catch {
      return null;
    }
  }

  async function writeCache(cache) {
    try {
      await writeJsonAtomic(file, cache);
    } catch {
      // Not being able to remember it only means asking again next time.
    }
  }

  async function refresh() {
    const before = await readCache();
    const result = await fetchLatest(version, fetchImpl);
    // A failed check keeps what was known before.
    const cache = { checkedAt: now(), ok: result.ok, latest: result.ok ? result.latest : (before?.latest ?? null) };
    await writeCache(cache);
    return cache;
  }

  /** The latest known answer, asking GitHub only if the saved one is more than a day old. */
  async function check() {
    const cached = await readCache();
    if (cached) {
      const age = now() - cached.checkedAt;
      // A clock set backwards makes age negative: ask again rather than trust it.
      if (age >= 0 && age < (cached.ok ? DAY : RETRY)) return cached;
    }
    inFlight ??= refresh().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  /** What the page gets: the update to offer, or null. */
  async function status() {
    const { latest } = await check();
    return { current: version, update: latest && isNewer(latest.version, version) ? latest : null };
  }

  return { check, status };
}
