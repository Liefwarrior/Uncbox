// Streaming from Uncbox: FFmpeg captures a screen with ddagrab, encodes it with NVENC and sends it
// to Twitch. The sound comes from the Uncbox app (desktop sound and mic mixed into a named pipe,
// see docs/streaming-with-uncbox.md); in a plain browser the stream gets silent audio instead. The
// page decides when to start and stop and restarts a stream that dropped (src/stream); this file
// only runs FFmpeg and reports on it.
//
//   GET  /api/stream             the status, also pushed as a "stream" event (at most once a second while live)
//   POST /api/stream/key         { key } saves a pasted stream key ('' forgets it); this PC only
//   POST /api/stream/key/twitch  reads the key from the Twitch sign-in; this PC only
//   POST /api/stream/check       { force? } looks for FFmpeg and NVENC (the answer is kept); this PC only
//   POST /api/stream/start       { audioPipe?, test?, settings } starts FFmpeg; this PC only
//   POST /api/stream/stop        ends the stream; this PC only
//
// The stream key lives only in data/stream.json. The page is told whether one is set and its last
// four characters, nothing more, and every line FFmpeg prints is run through redact() before it is
// kept or sent, because FFmpeg repeats the address (which holds the key) in some errors.

import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { readJsonSafe, writeJsonAtomic } from './datafile.mjs';
import { noHelpers } from './switches.mjs';
import { findTool } from './ytdlp.mjs';

/** What Twitch's stream keys look like: live_<channel number>_<letters and digits>. */
export const KEY_SHAPE = /^live_\d+_[A-Za-z0-9]{10,}$/;
/** The only audio source the shell makes (see the contract with native/UncboxShell). */
export const PIPE_SHAPE = /^\\\\\.\\pipe\\uncbox-stream-audio-[0-9a-f]{8,32}$/;

export const DEFAULT_SETTINGS = { screen: 0, fps: 60, height: 1080, kbps: 6000 };
const STOP_GRACE_MS = 5000;
const EMIT_MS = 1000;
/** How long a probe may take before it is given up on. */
const PROBE_MS = 15_000;

// ---- pure pieces, exported for the tests ----

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const whole = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback);

/** Settings from the page, held to what Uncbox offers: screen 0 to 7, 30 or 60 fps, 720, 1080 or the screen's own height (0), 2500 to 8000 kbps. */
export function clampSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    screen: clamp(whole(s.screen, DEFAULT_SETTINGS.screen), 0, 7),
    fps: s.fps === 30 ? 30 : 60,
    height: [0, 720, 1080].includes(s.height) ? s.height : DEFAULT_SETTINGS.height,
    kbps: clamp(whole(s.kbps, DEFAULT_SETTINGS.kbps), 2500, 8000),
  };
}

/** Where the video goes. A test stream is taken by Twitch but not shown to anyone. */
export function ingestUrl(key, test = false) {
  return `rtmps://live.twitch.tv:443/app/${key}${test ? '?bandwidthtest=true' : ''}`;
}

/** The text with the stream key (and anything shaped like one) blanked out. */
export function redact(text, key = '') {
  let out = String(text);
  for (const secret of [key, key && encodeURIComponent(key)]) {
    if (secret) out = out.split(secret).join('****');
  }
  return out.replace(/live_\d+_[A-Za-z0-9]+/g, 'live_****');
}

/** Scaling on the graphics card (scale_d3d11), to the height and the width that keeps the shape. */
export const gpuScale = (height) => `scale_d3d11=width=trunc(iw*${height}/ih/2)*2:height=${height}:format=nv12`;

/** Scaling on the processor: the frames come off the card, are scaled, and go back as NV12, which NVENC takes. */
export const cpuScale = (height) => `hwdownload,format=bgra,scale=-2:${height},format=nv12`;

/**
 * The FFmpeg arguments for one stream. `scaler` is 'gpu' or 'cpu' (what the check found works);
 * `screenHeight` is the screen's own height when known, so a screen already at the chosen height
 * isn't scaled at all.
 */
export function buildFfmpegArgs({ settings, key, test = false, audioPipe = '', scaler = 'cpu', screenHeight = 0 }) {
  const { screen, fps, height, kbps } = clampSettings(settings);
  const scale = height > 0 && height !== screenHeight ? [scaler === 'gpu' ? gpuScale(height) : cpuScale(height)] : [];
  const video = [`ddagrab=output_idx=${screen}:framerate=${fps}:draw_mouse=1`, ...scale].join(',');
  const audio = audioPipe
    ? ['-thread_queue_size', '1024', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', audioPipe]
    : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'];
  return [
    ...['-hide_banner', '-loglevel', 'warning', '-nostats', '-progress', 'pipe:1'],
    ...['-f', 'lavfi', '-i', video],
    ...audio,
    ...['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'cbr', '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`],
    ...['-g', String(fps * 2), '-bf', '2', '-profile:v', 'high'],
    ...['-af', 'aresample=async=1000', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000'],
    ...['-map', '0:v', '-map', '1:a'],
    ...['-flvflags', 'no_duration_filesize', '-f', 'flv', ingestUrl(key, test)],
  ];
}

const number = (v) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/** What `-progress` printed for one block, as the numbers the page shows ("N/A" counts as 0). */
function statsFrom(block) {
  return {
    fps: Math.round(number(block.fps) * 10) / 10,
    kbps: Math.round(number(block.bitrate)),
    dropped: Math.round(number(block.drop_frames)),
    frames: Math.round(number(block.frame)),
    speed: Math.round(number(block.speed) * 100) / 100,
  };
}

/**
 * Reads FFmpeg's `-progress pipe:1` output, which comes in blocks of key=value lines that each end
 * with `progress=continue` (or `end`). Chunks can split a line or a block anywhere; push() returns
 * the stats of the latest block that was completed by this chunk, or null.
 */
export function createProgressParser() {
  let rest = '';
  let block = {};
  return {
    push(chunk) {
      rest += String(chunk);
      const lines = rest.split(/\r?\n/);
      rest = lines.pop() ?? '';
      let latest = null;
      for (const line of lines) {
        const at = line.indexOf('=');
        if (at < 1) continue;
        const name = line.slice(0, at).trim();
        block[name] = line.slice(at + 1).trim();
        if (name === 'progress') {
          latest = statsFrom(block);
          block = {};
        }
      }
      return latest;
    },
  };
}

/** The stats of the last complete block in `chunk`, or null (see createProgressParser for chunks that arrive in pieces). */
export const parseProgress = (chunk) => createProgressParser().push(chunk);

/** The screen's size from FFmpeg's description of the ddagrab input ("… 1920x1080 [SAR 1:1 …"), or null. */
export function parseScreenSize(output) {
  const m = /Stream #\d+:\d+[^\n]*?: Video:[^\n]*?\b(\d{3,5})x(\d{3,5})\b/.exec(String(output));
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/** Whether `name` is in the list `ffmpeg -encoders` or `-filters` printed. */
export const listsName = (output, name) => new RegExp(`^\\s*[A-Z.]{2,}\\s+${name}\\s`, 'm').test(String(output));

// ---- the feature ----

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status }, extra);

/** The tools as far as anyone knows before a check. */
const unchecked = () => ({ ffmpeg: false, version: '', nvenc: null, ddagrab: null });

/**
 * `spawn`, `findFfmpeg`, `now`, `setTimer` and `clearTimer` are only swapped out by the tests.
 * `twitch` is the Twitch module (its streamKey()).
 */
export function createStream({
  broadcastEvent,
  sendJson,
  isLocal,
  readJson,
  dataDir,
  twitch,
  spawn = nodeSpawn,
  findFfmpeg = () => findTool('ffmpeg'),
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  stopGraceMs = STOP_GRACE_MS,
  emitMs = EMIT_MS,
}) {
  const keyFile = path.join(dataDir, 'stream.json');

  let saved = null; // { key, source }, read from the file the first time it is needed
  let tools = unchecked();
  let scaler = 'cpu';
  let ffmpegPath = '';
  let checking = null;
  let checked = false;

  let state = 'off';
  let test = false;
  let startedAt = null;
  let stats = null;
  let error = '';
  let child = null;
  let launching = false;
  let stopTimer = null;
  let lastSent = 0;
  let closing = false;

  async function loadKey() {
    if (!saved) {
      const file = await readJsonSafe(keyFile, {});
      const key = typeof file?.key === 'string' && KEY_SHAPE.test(file.key) ? file.key : '';
      saved = { key, source: key && ['pasted', 'twitch'].includes(file.source) ? file.source : key ? 'pasted' : null };
    }
    return saved;
  }

  async function snapshot() {
    const { key, source } = await loadKey();
    return {
      state,
      test,
      startedAt,
      stats,
      error,
      key: { set: Boolean(key), hint: key.slice(-4), source },
      tools,
    };
  }

  async function emit(force = true) {
    if (closing) return;
    if (!force && now() - lastSent < emitMs) return;
    lastSent = now();
    broadcastEvent('stream', await snapshot());
  }

  // ---- looking for FFmpeg ----

  /** Runs a program, resolving to what it printed and how it ended; never rejects. */
  function run(file, args, timeoutMs = PROBE_MS) {
    return new Promise((resolve) => {
      let out = '';
      let err = '';
      let done = false;
      let proc;
      const finish = (code) => {
        if (done) return;
        done = true;
        clearTimer(timer);
        resolve({ code, out, err });
      };
      let timer = null;
      try {
        proc = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        return resolve({ code: -1, out, err });
      }
      timer = setTimer(() => {
        proc.kill?.();
        finish(-1);
      }, timeoutMs);
      timer?.unref?.();
      proc.stdout?.on('data', (d) => (out += d));
      proc.stderr?.on('data', (d) => (err += d));
      proc.on('error', () => finish(-1));
      proc.on('close', (code) => finish(code ?? -1));
    });
  }

  async function doCheck() {
    scaler = 'cpu';
    ffmpegPath = noHelpers() ? '' : await findFfmpeg().catch(() => '');
    if (!ffmpegPath) {
      tools = unchecked();
      return;
    }
    const [version, encoders, filters] = await Promise.all([run(ffmpegPath, ['-version']), run(ffmpegPath, ['-hide_banner', '-encoders']), run(ffmpegPath, ['-hide_banner', '-filters'])]);
    const hasNvenc = listsName(encoders.out, 'h264_nvenc');
    // The encoder being compiled in doesn't mean there is a card to use it: encode one frame.
    const nvenc = hasNvenc && (await run(ffmpegPath, ['-hide_banner', '-f', 'lavfi', '-i', 'color=black:s=256x256', '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-'])).code === 0;
    tools = {
      ffmpeg: true,
      version: /ffmpeg version (\S+)/.exec(version.out)?.[1] ?? '',
      nvenc,
      ddagrab: listsName(filters.out, 'ddagrab'),
    };
    // Scaling on the graphics card is quicker, but it doesn't work with every driver and FFmpeg
    // build, so it is only used once it has been seen to work here.
    if (nvenc && tools.ddagrab && listsName(filters.out, 'scale_d3d11')) {
      const probe = await run(ffmpegPath, ['-hide_banner', '-f', 'lavfi', '-i', `ddagrab=output_idx=0:framerate=30,${gpuScale(720)}`, '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-']);
      if (probe.code === 0) scaler = 'gpu';
    }
  }

  /**
   * Looks for FFmpeg and what it can do. The answer is kept, except that not finding FFmpeg is
   * looked into again each time (it may have been installed since); `force` looks again anyway.
   */
  function check({ force = false } = {}) {
    if (force || (checked && !tools.ffmpeg)) checking = null;
    checking ??= doCheck()
      .then(() => void (checked = true))
      .finally(() => void emit());
    return checking;
  }

  // ---- running FFmpeg ----

  function lines(onLine) {
    let rest = '';
    return (chunk) => {
      rest += chunk;
      const parts = rest.split(/\r?\n/);
      rest = parts.pop() ?? '';
      parts.forEach(onLine);
    };
  }

  function launch({ args, key }) {
    const mine = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child = mine;
    state = 'starting';
    error = '';
    stats = null;
    startedAt = null;
    mine.stdin?.on('error', () => {});

    const progress = createProgressParser();
    mine.stdout?.on('data', (chunk) => {
      if (child !== mine) return;
      const next = progress.push(chunk);
      if (!next) return;
      stats = next;
      if (state === 'starting' && next.frames > 0) {
        state = 'live';
        startedAt = now();
        void emit();
      } else void emit(false);
    });
    mine.stderr?.on(
      'data',
      lines((line) => {
        const clean = redact(line, key).trim();
        if (clean && child === mine) error = clean;
      }),
    );
    mine.on('error', () => {
      if (child !== mine) return;
      child = null;
      clearTimer(stopTimer);
      state = 'error';
      error = 'Couldn’t start FFmpeg.';
      void emit();
    });
    mine.on('close', (code) => {
      if (child !== mine) return;
      child = null;
      clearTimer(stopTimer);
      stopTimer = null;
      if (state === 'stopping') {
        state = 'off';
        error = '';
        stats = null;
        startedAt = null;
      } else {
        // The page starts it again (the audio pipe went with it), so this only says what happened.
        state = 'dropped';
        error ||= `FFmpeg stopped (code ${code}).`;
      }
      void emit();
    });
    void emit();
  }

  /** How tall the screen is, so a screen already at the chosen height isn't scaled (0 when it can't be told). */
  async function screenHeightOf(screen) {
    const probe = await run(ffmpegPath, ['-hide_banner', '-loglevel', 'info', '-f', 'lavfi', '-i', `ddagrab=output_idx=${screen}:framerate=30`, '-frames:v', '1', '-f', 'null', '-']);
    return parseScreenSize(probe.err)?.height ?? 0;
  }

  async function start(body) {
    if (child || launching || ['starting', 'live', 'stopping'].includes(state)) throw fail(409, 'A stream is already running.');
    const { key } = await loadKey();
    if (!key) throw fail(400, 'Add your Twitch stream key first.');
    const audioPipe = body?.audioPipe === undefined || body.audioPipe === null || body.audioPipe === '' ? '' : String(body.audioPipe);
    if (audioPipe && !PIPE_SHAPE.test(audioPipe)) throw fail(400, 'That isn’t a sound pipe made by the Uncbox app.');
    const settings = clampSettings(body?.settings);
    launching = true;
    try {
      await check();
      if (!tools.ffmpeg) throw fail(400, 'FFmpeg isn’t installed. Install it from the Downloads widget.');
      if (tools.ddagrab === false) throw fail(400, 'This FFmpeg can’t capture the screen. Install the latest FFmpeg from the Downloads widget.');
      if (tools.nvenc === false) throw fail(400, 'Uncbox streams with NVENC, which needs an NVIDIA graphics card, and this PC can’t start it.');
      const screenHeight = settings.height > 0 ? await screenHeightOf(settings.screen) : 0;
      test = Boolean(body?.test);
      launch({ args: buildFfmpegArgs({ settings, key, test, audioPipe, scaler, screenHeight }), key });
    } finally {
      launching = false;
    }
  }

  function stop() {
    if (!child) {
      // A stream that dropped or never started has nothing to end; this just clears the notice.
      if (state === 'dropped' || state === 'error') {
        state = 'off';
        error = '';
        stats = null;
        startedAt = null;
        test = false;
        void emit();
      }
      return;
    }
    if (state === 'stopping') return;
    state = 'stopping';
    const mine = child;
    // "q" is how FFmpeg is asked to finish: it flushes and closes the connection properly.
    try {
      mine.stdin?.write('q\n');
    } catch {
      // The kill below covers it.
    }
    clearTimer(stopTimer);
    stopTimer = setTimer(() => mine.kill?.(), stopGraceMs);
    stopTimer?.unref?.();
    void emit();
  }

  // ---- the key ----

  async function saveKey(key, source) {
    saved = { key, source: key ? source : null };
    if (key) await writeJsonAtomic(keyFile, { key, source }, { mode: 0o600 });
    else await writeJsonAtomic(keyFile, {}, { mode: 0o600 });
    await emit();
  }

  const busy = () => child || launching || ['starting', 'live', 'stopping'].includes(state);

  async function setKey(raw) {
    const key = String(raw ?? '').trim();
    if (key && !KEY_SHAPE.test(key)) throw fail(400, 'That doesn’t look like a Twitch stream key. It starts with “live_”.');
    if (busy()) throw fail(409, 'End the stream before changing the key.');
    await saveKey(key, 'pasted');
  }

  async function keyFromTwitch() {
    if (busy()) throw fail(409, 'End the stream before changing the key.');
    const key = await twitch.streamKey();
    if (!KEY_SHAPE.test(key)) throw fail(502, 'Twitch gave a key in a shape Uncbox doesn’t know.');
    await saveKey(key, 'twitch');
  }

  // ---- routes ----

  async function handle(req, res, url) {
    const route = url.pathname.slice('/api/stream'.length);
    try {
      if (route === '' && req.method === 'GET') return sendJson(res, 200, await snapshot());
      if (!isLocal(req)) return sendJson(res, 403, { error: 'This PC only' });
      if (req.method !== 'POST') return sendJson(res, route === '' ? 405 : 404, { error: route === '' ? 'Method not allowed' : 'Not found' });
      if (route === '/key') await setKey((await readJson(req)).key);
      else if (route === '/key/twitch') await keyFromTwitch();
      else if (route === '/check') await check({ force: (await readJson(req)).force === true });
      else if (route === '/start') await start(await readJson(req));
      else if (route === '/stop') stop();
      else return sendJson(res, 404, { error: 'Not found' });
      return sendJson(res, 200, await snapshot());
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.status ? err.message : 'Streaming error', ...(err.code ? { code: err.code } : {}) });
    }
  }

  /** Ends FFmpeg now (the server is shutting down). */
  handle.close = () => {
    closing = true;
    clearTimer(stopTimer);
    const mine = child;
    child = null;
    try {
      mine?.kill?.();
    } catch {
      // Already gone.
    }
  };
  // For the tests.
  handle.snapshot = snapshot;
  handle.check = check;
  handle.start = start;
  handle.stop = stop;
  return handle;
}
