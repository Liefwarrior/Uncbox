// Ping and frame rate for the "Ping & FPS" widget.
//
//   GET /api/netstats?target=host[:port]&router=1   this PC only
//
// Each ask is a short lease: while any widget keeps asking (every few seconds) the server measures
// the connection every 2 seconds and pushes a "netstats" event once a second. When the last lease
// runs out, every timer stops, so nothing runs when no widget is showing.
//
// Ping is how long a TCP connection to host:443 takes to open: it needs no admin rights and works
// on networks that block ICMP. A refused connection still answers, so it counts too (that is what
// most routers do on 443). While a game that writes a performance log is running, its own ping and
// frame rate are sent along as "game".

import net from 'node:net';
import { execFile } from 'node:child_process';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { noHelpers, offline } from './switches.mjs';

export const DEFAULT_TARGET = '1.1.1.1:443';
/** How many pings the history keeps. */
export const HISTORY = 60;
/** A ping that takes longer than this counts as lost. */
export const TIMEOUT_MS = 1000;
const PING_EVERY_MS = 2000;
const PUSH_EVERY_MS = 1000;
/** A widget that stops asking is dropped after this long. */
const LEASE_MS = 8000;
/** A game's log counts as live when it changed this recently. */
const GAME_FRESH_MS = 10_000;

// ---- pure helpers ----

/** "host" or "host:port" (or "[::1]:443") → { host, port }, or null for anything else. */
export function parseTarget(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return parseTarget(DEFAULT_TARGET);
  let host = raw;
  let port = 443;
  const bracketed = raw.match(/^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i);
  if (bracketed) {
    host = bracketed[1];
    if (bracketed[2]) port = Number(bracketed[2]);
    if (net.isIPv6(host)) return { host, port, key: `[${host}]:${port}` };
    return null;
  }
  const colon = raw.match(/^([^:]+):(\d{1,5})$/);
  if (colon) {
    host = colon[1];
    port = Number(colon[2]);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const labels = host.split('.');
  const nameOk = host.length <= 253 && labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(l));
  if (!nameOk) return null;
  return { host, port, key: `${host.toLowerCase()}:${port}` };
}

const round1 = (n) => Math.round(n * 10) / 10;

/** Last, average, jitter and loss over pings in ms, where null is a lost one. */
export function summarize(history) {
  const got = history.filter((v) => v !== null);
  let diffs = 0;
  for (let i = 1; i < got.length; i++) diffs += Math.abs(got[i] - got[i - 1]);
  return {
    last: history.length ? history[history.length - 1] : null,
    avg: got.length ? round1(got.reduce((a, b) => a + b, 0) / got.length) : null,
    // The mean change between one ping and the next; lost pings are skipped over.
    jitter: got.length > 1 ? round1(diffs / (got.length - 1)) : 0,
    loss: history.length ? round1((100 * (history.length - got.length)) / history.length) : 0,
  };
}

/** The 1% low: the average of the slowest 1% of frame rates (at least one reading). */
export function lowPercentFps(fpsList, percent = 1) {
  if (!fpsList.length) return null;
  const worst = [...fpsList].sort((a, b) => a - b).slice(0, Math.max(1, Math.ceil((fpsList.length * percent) / 100)));
  return round1(worst.reduce((a, b) => a + b, 0) / worst.length);
}

/**
 * Rows of a game's performance CSV → { fps, gpuMs, ping } per second. Rows the game flags as
 * loading (IgnoredForSummary) and rows without a usable frame time are left out. DeltaTime is the
 * real time between frames, so it gives the frame rate the game's own counter shows; FrameTime
 * (the work done per frame) is used when a log has no DeltaTime.
 */
export function parsePexRows(headerLine, rowLines) {
  const cols = headerLine.trim().split(',');
  const at = (name) => cols.indexOf(name);
  const iIgnore = at('IgnoredForSummary');
  const iFrame = at('FrameTime');
  const iDelta = at('DeltaTime');
  const iGpu = at('GPUTime');
  const iPing = at('Ping');
  if (iFrame < 0 && iDelta < 0) return [];
  const rows = [];
  for (const line of rowLines) {
    const f = line.trim().split(',');
    if (f.length < cols.length) continue; // a row still being written
    if (iIgnore >= 0 && Number(f[iIgnore]) === 1) continue;
    const frameMs = Number(iDelta >= 0 && Number(f[iDelta]) > 0 ? f[iDelta] : f[iFrame]);
    if (!(frameMs > 0)) continue;
    const gpu = iGpu >= 0 ? Number(f[iGpu]) : NaN;
    const ping = iPing >= 0 ? Number(f[iPing]) : NaN;
    rows.push({
      fps: round1(1000 / frameMs),
      gpuMs: Number.isFinite(gpu) ? round1(gpu) : null,
      // The game writes 0 when it has no server connection, which is not a real ping.
      ping: ping > 0 ? Math.round(ping) : null,
    });
  }
  return rows;
}

/** What the widget shows for a game, from its parsed rows (the last 60 seconds). */
export function summarizeGame(name, rows) {
  const recent = rows.slice(-HISTORY);
  if (!recent.length) return null;
  const last = recent[recent.length - 1];
  const fpsList = recent.map((r) => r.fps);
  return {
    name,
    fps: Math.round(last.fps),
    fpsLow: lowPercentFps(fpsList) === null ? null : Math.round(lowPercentFps(fpsList)),
    fpsHistory: fpsList,
    gpuMs: last.gpuMs,
    ping: last.ping,
    pingHistory: recent.map((r) => r.ping),
  };
}

// ---- measuring ----

/** Milliseconds to open a TCP connection, or null when it takes over a second or fails. */
export function tcpPing({ host, port }, { connect = net.connect, now = () => performance.now() } = {}) {
  if (offline()) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    let socket;
    let timer;
    const finish = (ms) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        // Already closed.
      }
      resolve(ms === null ? null : round1(Math.min(ms, TIMEOUT_MS)));
    };
    const start = now();
    timer = setTimeout(() => finish(null), TIMEOUT_MS);
    try {
      socket = connect({ host, port });
    } catch {
      return finish(null);
    }
    socket.on('connect', () => finish(now() - start));
    // A closed port answers at once, which is just as good a measure of the trip.
    socket.on('error', (err) => finish(err?.code === 'ECONNREFUSED' ? now() - start : null));
  });
}

/** This PC's default gateway (the router), or null. Asked of Windows once. */
export function findGateway() {
  if (process.platform !== 'win32' || noHelpers()) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Where-Object { $_.NextHop -ne '0.0.0.0' } | Sort-Object { $_.RouteMetric + $_.InterfaceMetric } | Select-Object -First 1).NextHop",
      ],
      { windowsHide: true, timeout: 8000 },
      (err, out) => {
        const ip = String(out ?? '').trim();
        resolve(!err && net.isIPv4(ip) ? ip : null);
      },
    );
  });
}

// ---- games ----

const GAMES = [
  {
    name: 'SMITE 2',
    dir: () => (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'SMITE2Alpha', 'Saved', 'Logs') : null),
    file: /^PEX_Timeline_.*\.csv$/i,
  },
];

/** The newest matching file in a folder that changed within `freshMs`, or null. */
async function newestFresh(dir, pattern, nowMs, freshMs) {
  let best = null;
  for (const name of await readdir(dir).catch(() => [])) {
    if (!pattern.test(name)) continue;
    const info = await stat(path.join(dir, name)).catch(() => null);
    if (info && nowMs - info.mtimeMs <= freshMs && (!best || info.mtimeMs > best.mtimeMs)) best = { file: path.join(dir, name), mtimeMs: info.mtimeMs };
  }
  return best;
}

/** A file's first line and the lines in its last 16 KB. Only the end is read, as logs grow. */
async function readHeadAndTail(file) {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(Math.min(size, 4096));
    await handle.read(head, 0, head.length, 0);
    const header = head.toString('utf8').split(/\r?\n/)[0];
    const tailSize = Math.min(size, 16 * 1024);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, size - tailSize);
    const lines = tail.toString('utf8').split(/\r?\n/).filter(Boolean);
    // The first line is the header when the whole file was read, and half a row when it was not.
    return { header, rows: lines.slice(1) };
  } finally {
    await handle.close();
  }
}

/** The running game's numbers, or null when no game has written to its log in the last 10 seconds. */
export async function readGame({ games = GAMES, now = Date.now } = {}) {
  for (const game of games) {
    const dir = game.dir();
    if (!dir) continue;
    const found = await newestFresh(dir, game.file, now(), GAME_FRESH_MS);
    if (!found) continue;
    try {
      const { header, rows } = await readHeadAndTail(found.file);
      const summary = summarizeGame(game.name, parsePexRows(header, rows));
      if (summary) return summary;
    } catch {
      // The game is writing to it right now; the next second reads it.
    }
  }
  return null;
}

// ---- the sampler ----

/**
 * The sampler. `subscribe` starts measuring and returns the function that stops; the timers run
 * only while at least one subscription is open. Everything outside this module is injectable so
 * tests need no network, clock or game.
 */
export function createSampler({ broadcast, connect = net.connect, now, gateway = findGateway, game = () => readGame() } = {}) {
  const targets = new Map(); // key → { target, subs, history }
  let routerSubs = 0;
  const router = { host: null, history: [], looked: false };
  let pingTimer = null;
  let pushTimer = null;
  let gameNow = null;
  let reading = false;
  let sampling = false;

  const push = (history, value) => {
    history.push(value);
    if (history.length > HISTORY) history.shift();
  };

  async function sample() {
    if (sampling) return; // The last round is still waiting on a slow answer.
    sampling = true;
    try {
      const jobs = [...targets.values()].map(async (t) => push(t.history, await tcpPing(t.target, { connect, now })));
      if (routerSubs > 0) {
        if (!router.looked) {
          router.looked = true;
          router.host = await gateway();
        }
        if (router.host) jobs.push(tcpPing({ host: router.host, port: 443 }, { connect, now }).then((ms) => push(router.history, ms)));
      }
      await Promise.all(jobs);
    } finally {
      sampling = false;
    }
  }

  async function refreshGame() {
    if (reading) return;
    reading = true;
    try {
      gameNow = await game();
    } catch {
      gameNow = null;
    } finally {
      reading = false;
    }
  }

  function snapshot() {
    const out = {};
    for (const [key, t] of targets) out[key] = { host: key, ...summarize(t.history), history: [...t.history] };
    return {
      at: Date.now(),
      targets: out,
      router: routerSubs > 0 && router.host ? { host: router.host, ...summarize(router.history), history: [...router.history] } : null,
      game: gameNow,
    };
  }

  function start() {
    if (pingTimer) return;
    void sample();
    pingTimer = setInterval(() => void sample(), PING_EVERY_MS);
    void refreshGame();
    pushTimer = setInterval(() => {
      void refreshGame().then(() => broadcast?.(snapshot()));
    }, PUSH_EVERY_MS);
  }

  function stop() {
    clearInterval(pingTimer);
    clearInterval(pushTimer);
    pingTimer = pushTimer = null;
    gameNow = null;
  }

  return {
    snapshot,
    /** Starts measuring `target` (a parsed target) and the router if asked; returns the stop function. */
    subscribe(target, { withRouter = false } = {}) {
      let t = targets.get(target.key);
      if (!t) targets.set(target.key, (t = { target, subs: 0, history: [] }));
      t.subs++;
      if (withRouter) routerSubs++;
      start();
      let open = true;
      return () => {
        if (!open) return;
        open = false;
        if (--t.subs === 0) targets.delete(target.key);
        if (withRouter && --routerSubs === 0) router.history = [];
        if (!targets.size) stop();
      };
    },
    /** Whether the timers are running (for tests). */
    get running() {
      return pingTimer !== null;
    },
  };
}

// ---- routes ----

export function createNetstats({ broadcastEvent, isLocal, sendJson, sampler }) {
  const s = sampler ?? createSampler({ broadcast: (snap) => broadcastEvent('netstats', snap) });
  // One lease per widget setup: asking again keeps it alive, going quiet lets it lapse.
  const leases = new Map(); // "key|router" → { stop, timer }

  return function handle(req, res, url) {
    // This opens connections to whatever is typed in, so only the person at this PC may ask.
    if (!isLocal(req)) return sendJson(res, 403, { error: 'This PC only' });
    const target = parseTarget(url.searchParams.get('target'));
    if (!target) return sendJson(res, 400, { error: 'Use a host like example.com or example.com:443.' });
    const withRouter = url.searchParams.get('router') === '1';
    const id = `${target.key}|${withRouter}`;
    const lease = leases.get(id);
    if (lease) clearTimeout(lease.timer);
    const stop = lease?.stop ?? s.subscribe(target, { withRouter });
    leases.set(id, {
      stop,
      timer: setTimeout(() => {
        leases.delete(id);
        stop();
      }, LEASE_MS),
    });
    return sendJson(res, 200, { key: target.key, ...s.snapshot() });
  };
}
