// Data for the widgets that need this PC: system load, what's playing, and Windows notifications.
// Each starts only when a widget first asks, so none of it runs for people who don't use them. The
// music helper also stops again once no widget has asked for a minute (see media.mjs); system
// load and notifications are one-shot reads with nothing left running between asks.
//
//   GET /api/system          { cpu, memory: { used, total }, gpu: { name, load, temp, used, total } | null }
//   /api/media, /api/media/art, /api/media/control   what's playing and its controls (server/media.mjs)
//   GET /api/notifications   the latest Windows notifications ({ after } for newer ones); this PC only

import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createMedia } from './media.mjs';
import { noHelpers } from './switches.mjs';

// ---- system ----

let lastCpu = os.cpus();
function cpuPercent() {
  const now = os.cpus();
  let idle = 0;
  let total = 0;
  now.forEach((c, i) => {
    const before = lastCpu[i]?.times;
    if (!before) return;
    for (const key of Object.keys(c.times)) total += c.times[key] - before[key];
    idle += c.times.idle - before.idle;
  });
  lastCpu = now;
  return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
}

/** NVIDIA cards report through nvidia-smi; other cards just don't show a GPU line. */
let gpuMissing = false;
function gpuStats() {
  if (gpuMissing || noHelpers()) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: 4000 },
      (err, out) => {
        if (err) {
          gpuMissing = err.code === 'ENOENT';
          return resolve(null);
        }
        const [name, load, temp, used, total] = out.split('\n')[0].split(',').map((s) => s.trim());
        resolve({ name, load: Number(load), temp: Number(temp), used: Number(used) * 1024 * 1024, total: Number(total) * 1024 * 1024 });
      },
    );
  });
}

let systemCache = null;
let systemAt = 0;
async function system() {
  // Several widgets or windows asking at once share one reading.
  if (systemCache && Date.now() - systemAt < 1500) return systemCache;
  systemAt = Date.now();
  systemCache = {
    cpu: cpuPercent(),
    memory: { used: os.totalmem() - os.freemem(), total: os.totalmem() },
    gpu: await gpuStats(),
  };
  return systemCache;
}

/** "Spotify.exe" or "308046B0AF4A39CB" → a readable app name where Windows gives one. */
function appName(id) {
  if (!id) return '';
  const base = id.split('!')[0].replace(/\.exe$/i, '');
  const parts = base.split(/[._]/).filter((p) => p && !/^[0-9a-z]{13}$/.test(p));
  return parts.at(-1) ?? base;
}

// ---- notifications: read from Windows' own notification list ----

const NOTIFICATIONS_DB = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db');
const FILETIME_EPOCH_MS = 11644473600000n;

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/** A toast's texts: the first is its title, the rest its message. Exported for tests. */
export function toastTexts(xml) {
  return [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) => decodeXml(m[1]).trim()).filter(Boolean);
}

export { appName };

let sqlite;
async function openNotifications() {
  sqlite ??= await import('node:sqlite').catch(() => null);
  if (!sqlite) throw Object.assign(new Error('Notifications need Node.js 22.5 or newer.'), { status: 501 });
  return new sqlite.DatabaseSync(NOTIFICATIONS_DB, { readOnly: true });
}

async function notifications(after) {
  if (process.platform !== 'win32' || noHelpers()) throw Object.assign(new Error('Notifications are read from Windows.'), { status: 501 });
  const db = await openNotifications();
  try {
    const q = db.prepare(`
      SELECT n."Order" AS id, n.Payload AS payload, n.ArrivalTime AS at, h.PrimaryId AS app
      FROM Notification n JOIN NotificationHandler h ON h.RecordId = n.HandlerId
      WHERE n.Type = 'toast' AND n."Order" > ?
      ORDER BY n."Order" DESC LIMIT 20`);
    q.setReadBigInts(true);
    return q.all(BigInt(after)).map((r) => {
      const [title = '', ...body] = toastTexts(Buffer.from(r.payload).toString('utf8'));
      return {
        id: Number(r.id),
        app: appName(String(r.app)),
        title,
        body: body.join(' '),
        at: Number(BigInt(r.at) / 10000n - FILETIME_EPOCH_MS),
      };
    });
  } finally {
    db.close();
  }
}

// ---- routes ----

export function createWidgets({ broadcastEvent, isLocal, sendJson, readJson }) {
  const media = createMedia({ broadcastEvent, isLocal, sendJson, readJson, appName });

  async function handle(req, res, url) {
    try {
      if (url.pathname === '/api/system') return sendJson(res, 200, await system());
      if (url.pathname.startsWith('/api/media')) return media(req, res, url);
      if (url.pathname === '/api/notifications') {
        // Notifications can be private, so never to another device, even when HOST opens Uncbox to the LAN.
        if (!isLocal(req)) return sendJson(res, 403, { error: 'This PC only' });
        const after = Number(url.searchParams.get('after')) || 0;
        return sendJson(res, 200, { notifications: await notifications(after) });
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message || 'Widget error' });
    }
  }

  /** Stops the helpers (the server is shutting down). */
  handle.close = media.close;
  return handle;
}
