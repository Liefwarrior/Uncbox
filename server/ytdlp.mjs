// Video downloads with yt-dlp, at the quality the source itself has: the best video stream and the
// best audio stream it offers, sorted by resolution and then frame rate, so nothing is scaled
// down and 60 fps stays 60 fps. Files go to the clips folder's Downloads subfolder, where the
// clip list and player pick them up (see server/clipnames.mjs), so Make vertical, Send to Discord
// and Save to Drive work on them. Everything here only answers the PC Uncbox runs on.
//
//   GET  /api/ytdlp            { tools, install, queue, history }: where yt-dlp and ffmpeg were found
//                              (and their versions), the install in progress, the downloads running
//                              or waiting, and the last 50 finished (kept in data/ytdlp.json)
//   POST /api/ytdlp/download   { url, audioOnly?, playlist? }: adds a download (one runs at a time)
//   POST /api/ytdlp/cancel     { id }: stops one, killing yt-dlp and ffmpeg with it, and tidies .part files
//   POST /api/ytdlp/install    { tool: 'yt-dlp'|'ffmpeg'|'both', upgrade? }: winget install (or upgrade)
//   POST /api/ytdlp/reveal     { id }: shows the finished file in Explorer
//   POST /api/ytdlp/clear      forgets the finished downloads in the list (the files stay)
//
// Live pushes: "ytdlp" ({ queue, history }, at most 4 a second) and "ytdlp-install" (each line winget
// prints). The URL is passed to yt-dlp after "--" and winget only ever gets fixed arguments, and
// neither is run through a shell.

import { spawn as nodeSpawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { DOWNLOADS, DOWNLOAD_NAME } from './clipnames.mjs';
import { readJsonSafe, writeJsonAtomic } from './datafile.mjs';
import { noHelpers, offline } from './switches.mjs';

export const HELP_URL = 'https://github.com/yt-dlp/yt-dlp/wiki/Installation';
/** The winget package ids; the only text that ever reaches winget's command line besides fixed flags. */
export const PACKAGES = { 'yt-dlp': 'yt-dlp.yt-dlp', ffmpeg: 'Gyan.FFmpeg' };

const HISTORY_KEPT = 50;
const QUEUE_MAX = 30;
const PLAYLIST_MAX = 25;
const URL_MAX = 2048;
const TOOLS_CACHE_MS = 60_000;
const EMIT_MS = 250;
const INSTALL_LINES = 40;
/** winget says these when there was nothing to do; for Uncbox that is a success. */
const WINGET_NOTHING_TO_DO = new Set([0x8a15002b, 0x8a150061, 0x8a15010b]);

// ---- pieces the tests check on their own ----

/** The URL as a clean http(s) string, or null. A leading "-" could be read as an option, so it never passes. */
export function validateUrl(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text || text.length > URL_MAX || text.startsWith('-') || /[\s\u0000-\u001f\u007f]/.test(text)) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname ? text : null;
}

/** What yt-dlp prints on its own lines, each starting with a marker and holding one JSON object. */
const PROGRESS_TEMPLATE =
  'download:UBXD {"s":%(progress.status)j,"d":%(progress.downloaded_bytes)j,"t":%(progress.total_bytes)j,' +
  '"e":%(progress.total_bytes_estimate)j,"v":%(progress.speed)j,"eta":%(progress.eta)j,"f":%(progress.filename)j,"p":%(progress.tmpfilename)j}';
const POST_TEMPLATE = 'postprocess:UBXP {"s":%(progress.status)j,"pp":%(progress.postprocessor)j}';
/** Printed once the format is chosen, before the download: the quality the UI shows ("1080p60"). */
const INFO_PRINT =
  'before_dl:UBXI {"h":%(height)j,"fps":%(fps)j,"vc":%(vcodec)j,"ac":%(acodec)j,"id":%(id)j,"title":%(title)j,"n":%(requested_formats.:.format_id)j}';
const FILE_PRINT = 'after_move:UBXF {"f":%(filepath)j}';

/**
 * yt-dlp's arguments for one download. No flag here caps the resolution or the frame rate: the
 * format is the best video plus the best audio, sorted by resolution, then fps, and among
 * equals the ones that go into an MP4 cleanly (h264, then av1/vp9; m4a/aac sound).
 */
export function buildDownloadArgs({ url, audioOnly = false, playlist = false, dir, ffmpeg }) {
  return [
    '--ignore-config',
    '--newline',
    '--progress',
    '--progress-template', PROGRESS_TEMPLATE,
    '--progress-template', POST_TEMPLATE,
    '--print', INFO_PRINT,
    '--print', FILE_PRINT,
    '--no-simulate',
    ...(playlist ? ['--yes-playlist', '--playlist-items', `1:${PLAYLIST_MAX}`] : ['--no-playlist']),
    '--windows-filenames',
    '--trim-filenames', '180',
    '-N', '4',
    '-P', dir,
    '-o', '%(title).120s [%(id)s].%(ext)s',
    '--ffmpeg-location', ffmpeg,
    ...(audioOnly
      ? ['-f', 'ba/b', '-x']
      : ['-f', 'bv*+ba/b', '-S', 'res,fps,vcodec:h264,acodec:m4a', '--merge-output-format', 'mp4']),
    '--',
    url,
  ];
}

/** winget's arguments to install or upgrade one tool. Fixed text only. */
export function buildWingetArgs(tool, upgrade = false) {
  if (!Object.hasOwn(PACKAGES, tool)) return null;
  return [
    upgrade ? 'upgrade' : 'install',
    '--id', PACKAGES[tool],
    '-e',
    '--silent',
    '--accept-source-agreements',
    '--accept-package-agreements',
  ];
}

/** The tools an install request covers, in order. */
export function toolsFor(tool) {
  if (tool === 'both') return ['yt-dlp', 'ffmpeg'];
  return Object.hasOwn(PACKAGES, tool) ? [tool] : [];
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v) => (typeof v === 'string' && v !== 'NA' ? v : '');

/**
 * One line of yt-dlp's output as { type, ... }, or null for anything else (its other chatter).
 * type: 'info' (chosen quality, title), 'progress', 'post' (merging started/finished), 'file'.
 */
export function parseLine(line) {
  const m = /^UBX([IDPF]) (\{.*\})\s*$/.exec(line);
  if (!m) return null;
  let o;
  try {
    o = JSON.parse(m[2]);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  if (m[1] === 'I') {
    const ids = Array.isArray(o.n) ? o.n : typeof o.n === 'string' && o.n !== 'NA' ? [o.n] : [];
    return {
      type: 'info',
      height: num(o.h),
      fps: num(o.fps),
      vcodec: text(o.vc),
      acodec: text(o.ac),
      id: text(o.id),
      title: text(o.title),
      streams: Math.max(1, ids.length),
    };
  }
  if (m[1] === 'D') {
    const total = num(o.t) ?? num(o.e);
    const done = num(o.d);
    return {
      type: 'progress',
      status: text(o.s),
      fraction: total && done !== null ? Math.min(1, Math.max(0, done / total)) : null,
      speed: num(o.v),
      eta: num(o.eta),
      file: text(o.f),
      temp: text(o.p),
    };
  }
  if (m[1] === 'P') return { type: 'post', status: text(o.s), processor: text(o.pp) };
  return typeof o.f === 'string' && o.f !== 'NA' && o.f ? { type: 'file', file: o.f } : null;
}

/** The text after "ERROR:" in yt-dlp's last complaint, without the "[site] id:" prefix, or ''. */
export function errorFrom(stderr) {
  const lines = String(stderr).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^ERROR:\s*(?:\[[^\]]+\]\s*[^:]*:\s*)?(.+)$/.exec(lines[i]);
    if (m) return m[1].trim().slice(0, 300);
  }
  return '';
}

/** The clip name ("Downloads/<file>.mp4") a finished file can be played under, or '' when it can't. */
export function clipNameFor(file, downloadsDir) {
  if (!file || path.dirname(path.resolve(file)) !== path.resolve(downloadsDir)) return '';
  const name = `${DOWNLOADS}/${path.basename(file)}`;
  return DOWNLOAD_NAME.test(name) ? name : '';
}

// ---- finding yt-dlp, ffmpeg and winget ----

/**
 * Where `tool` is installed, or ''. PATH first, then the shims winget leaves in WinGet\Links, then
 * the package folders themselves. A server started before an install has an old PATH, so the
 * last two are what find a tool installed a minute ago. `fs` is what the tests swap out.
 */
export async function findTool(tool, { env = process.env, platform = process.platform, fs = fsp } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const exe = platform === 'win32' ? `${tool}.exe` : tool;
  const isFile = async (p) => Boolean((await fs.stat(p).catch(() => null))?.isFile());
  const dirsOf = (p) => fs.readdir(p).catch(() => []);

  const local = env.LOCALAPPDATA ?? env.localappdata ?? '';
  const pathDirs = String(env.PATH ?? env.Path ?? '')
    .split(P.delimiter)
    .map((d) => d.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  const dirs = [...pathDirs];
  if (local) dirs.push(P.join(local, 'Microsoft', 'WinGet', 'Links'), P.join(local, 'Microsoft', 'WindowsApps'));
  for (const d of dirs) {
    const candidate = P.join(d, exe);
    if (await isFile(candidate)) return candidate;
  }

  const prefix = { 'yt-dlp': 'yt-dlp.yt-dlp_', ffmpeg: 'gyan.ffmpeg_' }[tool];
  if (!local || !prefix) return '';
  const packages = P.join(local, 'Microsoft', 'WinGet', 'Packages');
  for (const pkg of (await dirsOf(packages)).filter((n) => n.toLowerCase().startsWith(prefix))) {
    const root = P.join(packages, pkg);
    for (const sub of ['', 'bin']) {
      const candidate = P.join(root, sub, exe);
      if (await isFile(candidate)) return candidate;
    }
    // Gyan.FFmpeg unpacks into ffmpeg-<version>-full_build\bin.
    for (const inner of await dirsOf(root)) {
      for (const sub of ['bin', '']) {
        const candidate = P.join(root, inner, sub, exe);
        if (await isFile(candidate)) return candidate;
      }
    }
  }
  return '';
}

/** "2026.07.04" from `yt-dlp --version`, "7.1-full_build-www.gyan.dev" from `ffmpeg -version`'s first line. */
export function parseVersion(tool, output) {
  const first = String(output).split(/\r?\n/).find((l) => l.trim()) ?? '';
  if (tool === 'ffmpeg') return /ffmpeg version (\S+)/.exec(first)?.[1] ?? '';
  return /^\S+$/.test(first.trim()) ? first.trim() : '';
}

function runOnce(spawn, file, args, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve('');
    }
    const timer = setTimeout(() => child.kill?.(), timeoutMs);
    child.stdout?.on('data', (d) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

/** Removes what a stopped download leaves behind: .part and .ytdl files, fragments, half-merged streams. */
export async function cleanPartials(files, { fs = fsp } = {}) {
  const removed = [];
  for (const file of new Set(files.filter(Boolean))) {
    const dir = path.dirname(file);
    const base = file.replace(/\.part$/, '');
    const stem = path.basename(base);
    const targets = [`${base}.part`, `${base}.ytdl`];
    // A video or audio stream of a merge (x.f137.mp4) is no use alone.
    if (/\.f[\w-]+\.[a-z0-9]+$/i.test(stem)) targets.push(base);
    for (const n of await fs.readdir(dir).catch(() => [])) {
      if (n.startsWith(`${stem}.part-Frag`)) targets.push(path.join(dir, n));
    }
    for (const t of targets) {
      if (await fs.unlink(t).then(() => true, () => false)) removed.push(t);
    }
  }
  return removed;
}

// ---- the module ----

/**
 * `clipsFolder()` is the clips folder (a promise is fine); downloads go into its Downloads folder.
 * `onFinished` runs after each download ends, so the clip list can be refreshed.
 * `spawn`, `fs`, `env`, `platform` and `now` are what the tests swap out.
 */
export function createYtdlp({
  broadcastEvent,
  sendJson,
  isLocal,
  readJson,
  dataDir,
  clipsFolder,
  onFinished = () => {},
  spawn = nodeSpawn,
  fs = fsp,
  env = process.env,
  platform = process.platform,
  now = Date.now,
  emitMs = EMIT_MS,
}) {
  const historyFile = path.join(dataDir, 'ytdlp.json');
  const downloadsDir = async () => path.join(await clipsFolder(), DOWNLOADS);

  let nextId = 1;
  /** Waiting downloads, then the running one first when there is one. */
  let queue = [];
  let history = null;
  let active = null;
  /** True from the moment a download is picked until it ends, including while tools are looked up. */
  let busy = false;
  let closing = false;
  let tools = null;
  let toolsAt = 0;
  let install = { running: false, action: '', tool: '', lines: [], error: '', help: '' };
  let installChild = null;
  let saving = Promise.resolve();

  async function loadHistory() {
    history ??= (async () => {
      const saved = await readJsonSafe(historyFile, { history: [] }, { fs });
      const list = Array.isArray(saved?.history) ? saved.history : [];
      return list.filter((i) => i && typeof i.id === 'string' && typeof i.url === 'string').slice(0, HISTORY_KEPT);
    })();
    return history;
  }

  function persist() {
    saving = saving
      .then(async () => writeJsonAtomic(historyFile, { history: await loadHistory() }, { fs }))
      .catch(() => {});
    return saving;
  }

  // ---- what the page sees ----

  const publicItem = (i) => ({ ...i, file: i.file ? path.basename(i.file) : '' });
  async function snapshot() {
    return { queue: queue.map(publicItem), history: (await loadHistory()).map(publicItem) };
  }

  let timer = null;
  let dirty = false;
  let lastSent = 0;
  /** Progress is pushed at most four times a second; a change of state goes out at once. */
  function emit(urgent = false) {
    if (closing) return;
    const send = async () => {
      timer = null;
      dirty = false;
      lastSent = now();
      broadcastEvent('ytdlp', await snapshot());
    };
    if (urgent) {
      clearTimeout(timer);
      void send();
      return;
    }
    if (timer) {
      dirty = true;
      return;
    }
    if (now() - lastSent >= emitMs) void send();
    else timer = setTimeout(send, emitMs);
    timer?.unref?.();
  }

  // ---- tools ----

  async function detect() {
    const none = { found: false, path: '', version: '' };
    if (noHelpers()) return { ytdlp: none, ffmpeg: none, winget: false };
    const opts = { env, platform, fs };
    const [ytdlpPath, ffmpegPath, wingetPath] = await Promise.all(['yt-dlp', 'ffmpeg', 'winget'].map((t) => findTool(t, opts)));
    const [ytdlpOut, ffmpegOut] = await Promise.all([
      ytdlpPath ? runOnce(spawn, ytdlpPath, ['--version']) : '',
      ffmpegPath ? runOnce(spawn, ffmpegPath, ['-version']) : '',
    ]);
    return {
      ytdlp: { found: Boolean(ytdlpPath), path: ytdlpPath, version: parseVersion('yt-dlp', ytdlpOut) },
      ffmpeg: { found: Boolean(ffmpegPath), path: ffmpegPath, version: parseVersion('ffmpeg', ffmpegOut) },
      winget: Boolean(wingetPath) && platform === 'win32',
      wingetPath,
    };
  }

  /** Where the tools are, looked up again at most every minute (or at once with `force`). */
  async function status({ force = false } = {}) {
    if (force || !tools || now() - toolsAt > TOOLS_CACHE_MS) {
      tools = await detect();
      toolsAt = now();
    }
    return tools;
  }
  const publicTools = (t) => ({ ytdlp: t.ytdlp, ffmpeg: t.ffmpeg, winget: t.winget, helpUrl: HELP_URL });

  // ---- install and update ----

  function pushInstall(patch) {
    install = { ...install, ...patch };
    broadcastEvent('ytdlp-install', { ...install, lines: install.lines.slice(-INSTALL_LINES) });
  }

  /** The text winget prints, minus its spinner and progress bars. */
  function wingetLines(chunk) {
    return String(chunk)
      .split(/[\r\n]+/)
      .map((l) => l.trim())
      .filter((l) => l && /[A-Za-z]/.test(l) && !/[█▒░]/.test(l));
  }

  function runWinget(wingetPath, args) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(wingetPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        return resolve({ ok: false, error: err.message });
      }
      installChild = child;
      const onData = (d) => {
        for (const line of wingetLines(d)) {
          install.lines = [...install.lines, line].slice(-INSTALL_LINES);
          broadcastEvent('ytdlp-install', { ...install, line });
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (err) => resolve({ ok: false, error: err.message }));
      child.on('close', (code) => {
        installChild = null;
        resolve(code === 0 || WINGET_NOTHING_TO_DO.has(code >>> 0) ? { ok: true } : { ok: false, error: `winget stopped with code ${code}.` });
      });
    });
  }

  async function runInstall(list, upgrade, wingetPath) {
    let error = '';
    for (const tool of list) {
      pushInstall({ tool, lines: [...install.lines, `${upgrade ? 'Updating' : 'Installing'} ${tool}…`] });
      const result = await runWinget(wingetPath, buildWingetArgs(tool, upgrade));
      if (!result.ok) {
        error = `Couldn’t ${upgrade ? 'update' : 'install'} ${tool}. ${result.error}`;
        break;
      }
    }
    if (closing) return;
    await status({ force: true });
    pushInstall({ running: false, error, tool: '' });
    broadcastEvent('ytdlp', await snapshot());
  }

  async function startInstall(req, res) {
    const body = await readJson(req);
    const list = toolsFor(body.tool);
    if (!list.length) return sendJson(res, 400, { error: 'Pick yt-dlp, ffmpeg or both.' });
    if (offline() || noHelpers()) return sendJson(res, 503, { error: 'Installing needs the internet, and this copy of Uncbox is set to stay offline.' });
    if (install.running) return sendJson(res, 409, { error: 'An install is already running.' });
    const found = await status({ force: true });
    if (!found.winget) {
      return sendJson(res, 400, { code: 'no-winget', error: 'Windows Package Manager (winget) isn’t installed here. Install yt-dlp by hand instead.', helpUrl: HELP_URL });
    }
    const upgrade = body.upgrade === true;
    install = { running: true, action: upgrade ? 'upgrade' : 'install', tool: list[0], lines: [], error: '', help: '' };
    pushInstall({});
    void runInstall(list, upgrade, found.wingetPath);
    return sendJson(res, 200, { ok: true });
  }

  // ---- downloads ----

  function killTree(child) {
    if (!child?.pid) return;
    if (platform === 'win32') {
      try {
        const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        k.on?.('error', () => child.kill?.());
        k.unref?.();
      } catch {
        child.kill?.();
      }
    } else child.kill?.('SIGKILL');
  }

  async function finish(item, patch) {
    Object.assign(item, patch, { speed: null, eta: null });
    queue = queue.filter((i) => i !== item);
    const list = await loadHistory();
    list.unshift(item);
    list.length = Math.min(list.length, HISTORY_KEPT);
    emit(true);
    await persist();
    onFinished(item);
  }

  /** Runs yt-dlp for the item and resolves when it has ended, however it ended. */
  async function run(item) {
    let found = await status();
    if (!found.ytdlp.found || !found.ffmpeg.found) found = await status({ force: true });
    if (!found.ytdlp.found) return finish(item, { state: 'error', error: 'yt-dlp isn’t installed. Use “Install yt-dlp” above.' });
    if (!found.ffmpeg.found) return finish(item, { state: 'error', error: 'ffmpeg isn’t installed, and downloads need it to join video and sound. Use “Install ffmpeg” above.' });

    const dir = await downloadsDir();
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      return finish(item, { state: 'error', error: `Couldn’t make the Downloads folder: ${err.message}` });
    }
    const args = buildDownloadArgs({ url: item.url, audioOnly: item.audioOnly, playlist: item.playlist, dir, ffmpeg: found.ffmpeg.path });

    const job = { item, child: null, cancelled: false, touched: [], stream: 0, streams: item.audioOnly ? 1 : 2, last: '', stderr: '' };
    active = job;
    item.state = 'downloading';
    emit(true);

    const outcome = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(found.ytdlp.path, args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        });
      } catch (err) {
        return resolve({ spawnError: err.message });
      }
      job.child = child;
      let buffer = '';
      child.stdout?.on('data', (d) => {
        buffer += d;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) handleLine(job, line);
      });
      child.stderr?.on('data', (d) => (job.stderr = (job.stderr + d).slice(-4000)));
      child.on('error', (err) => resolve({ spawnError: err.message }));
      child.on('close', (code) => {
        if (buffer) handleLine(job, buffer);
        resolve({ code });
      });
    });
    active = null;

    if (job.cancelled) {
      await cleanPartials(job.touched, { fs }).catch(() => {});
      return finish(item, { state: 'cancelled', error: '' });
    }
    if (outcome.spawnError) return finish(item, { state: 'error', error: `Couldn’t start yt-dlp: ${outcome.spawnError}` });
    if (outcome.code === 0) {
      const file = item.file;
      return finish(item, { state: 'done', percent: 100, name: clipNameFor(file, dir), error: '' });
    }
    await cleanPartials(job.touched, { fs }).catch(() => {});
    return finish(item, { state: 'error', error: errorFrom(job.stderr) || `yt-dlp stopped with code ${outcome.code}.` });
  }

  function handleLine(job, line) {
    const item = job.item;
    const msg = parseLine(line);
    if (!msg) return;
    if (msg.type === 'info') {
      // A playlist prints this for each video; start the bar over for it.
      Object.assign(item, { height: msg.height, fps: msg.fps, vcodec: msg.vcodec, percent: 0, state: 'downloading' });
      if (msg.title) item.title = msg.title;
      job.streams = item.audioOnly ? 1 : msg.streams;
      job.stream = 0;
      job.last = '';
    } else if (msg.type === 'progress') {
      if (msg.file && msg.file !== job.last) {
        if (job.last) job.stream++;
        job.last = msg.file;
      }
      job.touched.push(msg.temp || msg.file);
      if (msg.fraction !== null) {
        const overall = (Math.min(job.stream, job.streams - 1) + msg.fraction) / job.streams;
        item.percent = Math.min(99.9, Math.round(overall * 1000) / 10);
      }
      item.speed = msg.speed;
      item.eta = msg.eta;
      if (msg.status === 'finished') item.state = 'downloading';
    } else if (msg.type === 'post') {
      if (msg.status === 'started') Object.assign(item, { state: 'merging', percent: 99.9, speed: null, eta: null });
    } else if (msg.type === 'file') {
      item.file = msg.file;
    }
    emit();
  }

  /** Starts the next waiting download if none is running. */
  async function pump() {
    if (busy || closing) return;
    const next = queue.find((i) => i.state === 'queued');
    if (!next) return;
    busy = true;
    try {
      await run(next);
    } catch (err) {
      await finish(next, { state: 'error', error: err.message || 'The download failed.' });
    }
    busy = false;
    void pump();
  }

  async function startDownload(req, res) {
    const body = await readJson(req);
    const url = validateUrl(body.url);
    if (!url) return sendJson(res, 400, { error: 'Paste a web address that starts with http:// or https://.' });
    if (offline() || noHelpers()) return sendJson(res, 503, { error: 'Downloads need the internet, and this copy of Uncbox is set to stay offline.' });
    if (queue.some((i) => i.url === url && i.audioOnly === (body.audioOnly === true))) {
      return sendJson(res, 409, { error: 'That one is already in the list.' });
    }
    if (queue.length >= QUEUE_MAX) return sendJson(res, 429, { error: 'Too many downloads waiting. Let some finish first.' });
    const item = {
      id: `dl${now().toString(36)}${nextId++}`,
      url,
      title: '',
      percent: 0,
      speed: null,
      eta: null,
      height: null,
      fps: null,
      vcodec: '',
      state: 'queued',
      file: '',
      name: '',
      error: '',
      audioOnly: body.audioOnly === true,
      playlist: body.playlist === true,
      at: now(),
    };
    queue.push(item);
    emit(true);
    void pump();
    return sendJson(res, 200, { id: item.id });
  }

  async function cancel(req, res) {
    const { id } = await readJson(req);
    const item = queue.find((i) => i.id === id);
    if (!item) return sendJson(res, 404, { error: 'That download isn’t running any more.' });
    if (active?.item === item) {
      active.cancelled = true;
      killTree(active.child);
    } else void finish(item, { state: 'cancelled' });
    return sendJson(res, 200, { ok: true });
  }

  async function reveal(req, res) {
    const { id } = await readJson(req);
    const item = [...queue, ...(await loadHistory())].find((i) => i.id === id);
    if (!item) return sendJson(res, 404, { error: 'Not found' });
    const file = item.file && (await fs.stat(item.file).catch(() => null)) ? item.file : '';
    const folder = await downloadsDir();
    const [cmd, args] =
      platform === 'win32'
        ? ['explorer.exe', file ? [`/select,${file}`] : [folder]]
        : [platform === 'darwin' ? 'open' : 'xdg-open', [file ? path.dirname(file) : folder]];
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on?.('error', () => {});
      child.unref?.();
    } catch {
      // No file manager here: nothing to show.
    }
    return sendJson(res, 200, { ok: true });
  }

  async function handle(req, res, url) {
    if (!isLocal(req)) return sendJson(res, 403, { error: 'Local only' });
    const action = url.pathname.slice('/api/ytdlp'.length);
    try {
      if (action === '' && req.method === 'GET') {
        return sendJson(res, 200, { tools: publicTools(await status()), install: { ...install, lines: install.lines.slice(-INSTALL_LINES) }, ...(await snapshot()) });
      }
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      if (action === '/download') return await startDownload(req, res);
      if (action === '/cancel') return await cancel(req, res);
      if (action === '/install') return await startInstall(req, res);
      if (action === '/reveal') return await reveal(req, res);
      if (action === '/clear') {
        const list = await loadHistory();
        list.length = 0;
        await persist();
        emit(true);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message || 'Download error' });
    }
  }

  return {
    handle,
    snapshot,
    status,
    /** Stops a running download and install along with their helper programs (the server is closing). */
    close() {
      closing = true;
      clearTimeout(timer);
      queue = [];
      if (active) {
        active.cancelled = true;
        killTree(active.child);
      }
      killTree(installChild);
    },
  };
}
