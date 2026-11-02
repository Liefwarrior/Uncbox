// Streaming from Uncbox: FFmpeg captures a screen with ddagrab, encodes it on the graphics card
// (NVIDIA NVENC, AMD AMF or Intel Quick Sync, whichever this PC has) and sends it to Twitch. The
// sound comes from the Uncbox app (desktop sound and mic mixed into a named pipe, see
// docs/streaming-with-uncbox.md); in a plain browser the stream gets silent audio instead. The
// page decides when to start and stop and restarts a stream that dropped (src/stream); this file
// only runs FFmpeg and reports on it.
//
// Nothing here needs setting up: the check picks the encoder and the quickest way to scale the
// picture that it has seen work on this PC, and a Twitch sign-in that can read the stream key
// stands in for pasting one.
//
//   GET  /api/stream             the status, also pushed as a "stream" event (at most once a second while live)
//   POST /api/stream/key         { key } saves a pasted stream key ('' forgets it); this PC only
//   POST /api/stream/key/twitch  reads the key from the Twitch sign-in; this PC only
//   POST /api/stream/check       { force? } looks for FFmpeg and an encoder (the answer is kept); this PC only
//   POST /api/stream/start       { audioPipe?, test?, settings } starts FFmpeg; this PC only
//   POST /api/stream/stop        ends the stream; this PC only
//
// The stream key lives only in data/stream.json. The page is told whether one is set and its last
// four characters, nothing more, and every line FFmpeg prints is run through redact() before it is
// kept or sent, because FFmpeg repeats the address (which holds the key) in some errors.

import { spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';
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

/** The width that keeps the screen's shape at `height`, rounded down to even (encoders need even sizes). */
const evenWidth = (height) => `trunc(iw*${height}/ih/2)*2`;

/** Scaling on the graphics card with Direct3D 11, frames never leaving it. FFmpeg 8.1 can't do this with ddagrab's frames yet, so the check only picks it once it has seen it work. */
export const gpuScale = (height) => `scale_d3d11=width=${evenWidth(height)}:height=${height}:format=nv12`;

/**
 * Scaling with CUDA on an NVIDIA card. FFmpeg can't hand ddagrab's frames to CUDA directly, so each
 * one is copied out and back in once, but the scaling itself (Lanczos, sharper than the processor's)
 * runs on the card and NVENC takes the result as it is. Measured on an RTX 5090 laptop at 1440p to
 * 1080p60: about 0.4 of the processor time of scaling on the processor.
 */
export const cudaScale = (height) => `hwdownload,format=bgra,hwupload_cuda,scale_cuda=w=${evenWidth(height)}:h=${height}:interp_algo=lanczos`;

/** Scaling on an AMD card with AMF, frames never leaving it. */
export const amfScale = (height) => `vpp_amf=w=${evenWidth(height)}:h=${height}:format=nv12`;

/** Frames handed to Intel Quick Sync, which takes its own kind (mapped, not copied). Only works when the screen is on the Intel chip. */
const QSV_MAP = 'hwmap=derive_device=qsv,format=qsv';
/** Frames copied off the card as NV12, for an encoder that can't take the card's own (Quick Sync when the screen is on another card). */
const DOWNLOAD = 'hwdownload,format=bgra,format=nv12';
/** Scaling on an Intel graphics chip with Quick Sync. */
export const qsvScale = (height) => `${QSV_MAP},scale_qsv=w=${evenWidth(height)}:h=${height}:format=nv12`;

/** Scaling on the processor, the last resort: the frames come off the card, are scaled and handed over as NV12, which every encoder takes. */
export const cpuScale = (height) => `hwdownload,format=bgra,scale=-2:${height},format=nv12`;

/** Each way of scaling, by name, and the FFmpeg filter it needs to be there. */
export const SCALERS = {
  d3d11: { filter: 'scale_d3d11', chain: gpuScale },
  cuda: { filter: 'scale_cuda', chain: cudaScale },
  amf: { filter: 'vpp_amf', chain: amfScale },
  qsv: { filter: 'scale_qsv', chain: qsvScale },
  cpu: { filter: 'scale', chain: cpuScale },
};

/**
 * The graphics card encoders Uncbox streams with, in the order the check tries them, and the ways
 * of scaling each can take, quickest first ('cpu' always works). All of them get CBR at the chosen
 * bitrate with a buffer of two seconds' worth and a keyframe every two seconds, which is what
 * Twitch asks for. `quality` is what the check tries first; `safe` is for an older card or driver
 * that refuses part of it (B-frames as references need an RTX 20 or newer, for one).
 */
export const ENCODERS = [
  {
    id: 'nvenc',
    codec: 'h264_nvenc',
    label: 'NVIDIA NVENC',
    scalers: ['d3d11', 'cuda', 'cpu'],
    // The quality end of NVENC: a quarter-size first pass, adaptive quantisation over time, 10
    // frames of look-ahead and B-frames used as references. Scored with VMAF on SMITE footage at
    // 6000k this beat the old p5/hq by about 1.5 on average and on the worst frames; adaptive
    // quantisation in space was left out, as it made the worst frames worse. The look-ahead adds
    // about 60 ms; the encoder stays around 5-12% busy on an RTX 5090 at 1080p60.
    quality: ['-preset', 'p6', '-tune', 'hq', '-multipass', 'qres', '-rc', 'cbr', '-temporal-aq', '1', '-rc-lookahead', '10', '-bf', '2', '-b_ref_mode', 'middle'],
    safe: ['-preset', 'p5', '-tune', 'hq', '-rc', 'cbr', '-bf', '2'],
  },
  {
    id: 'amf',
    codec: 'h264_amf',
    label: 'AMD AMF',
    scalers: ['amf', 'd3d11', 'cpu'],
    quality: ['-usage', 'transcoding', '-quality', 'quality', '-rc', 'cbr', '-enforce_hrd', '1', '-vbaq', '1', '-preanalysis', '1'],
    safe: ['-usage', 'transcoding', '-rc', 'cbr'],
  },
  {
    id: 'qsv',
    codec: 'h264_qsv',
    label: 'Intel Quick Sync',
    scalers: ['qsv', 'cpu'],
    quality: ['-preset', 'slower', '-bf', '2'],
    safe: ['-preset', 'medium'],
  },
];

export const encoderById = (id) => ENCODERS.find((e) => e.id === id) ?? ENCODERS[0];

/** The video encoder's arguments for a bitrate and frame rate, with its `quality` or `safe` settings. */
export function encoderArgs(id, kbps, fps, tuning = 'quality') {
  const e = encoderById(id);
  return ['-c:v', e.codec, ...(tuning === 'safe' ? e.safe : e.quality), '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`, '-g', String(fps * 2), '-profile:v', 'high'];
}

/**
 * The filters after ddagrab: the scaling, or at the screen's own size nothing (NVENC and AMF take
 * the card's frames as they are), except that Quick Sync needs them mapped to it when the check saw
 * that work, and copied off the card when it didn't (the screen is on another card).
 */
export function videoChain({ encoder = 'nvenc', scaler = 'cpu', height, scale }) {
  if (scale) return [(SCALERS[scaler] ?? SCALERS.cpu).chain(height)];
  if (encoder !== 'qsv') return [];
  return [scaler === 'qsv' ? QSV_MAP : DOWNLOAD];
}

/**
 * The FFmpeg arguments for one stream. `encoder` and `scaler` are what the check found works;
 * `screenHeight` is the screen's own height when known, so a screen already at the chosen height
 * isn't scaled at all.
 */
export function buildFfmpegArgs({ settings, key, test = false, audioPipe = '', encoder = 'nvenc', tuning = 'quality', scaler = 'cpu', screenHeight = 0 }) {
  const { screen, fps, height, kbps } = clampSettings(settings);
  const scale = height > 0 && height !== screenHeight;
  const chain = videoChain({ encoder, scaler, height, scale });
  const audio = audioPipe
    ? ['-thread_queue_size', '1024', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', audioPipe]
    : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'];
  return [
    ...['-hide_banner', '-loglevel', 'warning', '-nostats', '-progress', 'pipe:1'],
    // The capture alone in its input, and the scaling as the output's filter: FFmpeg runs those on
    // separate threads, so a slow copy off the card can't hold up the capture. Scaling inside the
    // capture's own graph lost 3 to 5 frames a second at 1080p60. The queue between them is kept
    // short, since every frame waiting in it is a screen-sized texture.
    ...['-thread_queue_size', '8', '-f', 'lavfi', '-i', `ddagrab=output_idx=${screen}:framerate=${fps}:draw_mouse=1`],
    ...audio,
    ...(chain.length ? ['-vf', chain.join(',')] : []),
    // A steady frame rate out: ddagrab still misses about one frame a second, which this fills by
    // repeating one, so viewers get exactly 60 and keyframes land exactly two seconds apart.
    ...['-fps_mode', 'cfr', '-r', String(fps)],
    ...encoderArgs(encoder, kbps, fps, tuning),
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

const NO_ENCODER = 'Uncbox streams with the encoder on your graphics card (NVIDIA, AMD or Intel), and this PC can’t start one. Update your graphics driver.';

/**
 * The tools as far as anyone knows before a check. `encoder` is the id of the one that works (see
 * ENCODERS), '' when none does, null before the check; `tuning` is whether it took its quality
 * settings or needed the safe ones; `scaler` is how the picture gets scaled.
 */
const unchecked = () => ({ ffmpeg: false, version: '', encoder: null, tuning: null, scaler: null, ddagrab: null });

/** FFmpeg ahead of other programs, so a game that takes every core can't make the stream stutter (OBS does the same). */
const raiseAboveNormal = (pid) => os.setPriority(pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);

/**
 * `spawn`, `findFfmpeg`, `raisePriority`, `now`, `setTimer` and `clearTimer` are only swapped out by
 * the tests. `twitch` is the Twitch module (its streamKey()).
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
  raisePriority = raiseAboveNormal,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  stopGraceMs = STOP_GRACE_MS,
  emitMs = EMIT_MS,
}) {
  const keyFile = path.join(dataDir, 'stream.json');

  let saved = null; // { key, source, forgotten }, read from the file the first time it is needed
  let reading = null; // that first read, shared by everyone who asks while it runs
  let tools = unchecked();
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

  /**
   * The key, read from the file once. Two reads at once used to race: a slow one could finish after
   * a key had been saved and put the empty file's answer back over it, so there is only ever one,
   * and a key saved while it runs wins.
   */
  async function loadKey() {
    if (saved) return saved;
    reading ??= readJsonSafe(keyFile, {}).then((file) => {
      const key = typeof file?.key === 'string' && KEY_SHAPE.test(file.key) ? file.key : '';
      const source = key && ['pasted', 'twitch'].includes(file.source) ? file.source : key ? 'pasted' : null;
      saved ??= { key, source, forgotten: !key && file?.forgotten === true };
      return saved;
    });
    return reading;
  }

  /** The status as it is right now; the key must have been loaded. */
  function current() {
    const { key, source } = saved;
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

  async function snapshot() {
    await loadKey();
    return current();
  }

  async function emit(force = true) {
    if (closing) return;
    if (!force && now() - lastSent < emitMs) return;
    lastSent = now();
    // Read after the wait, in the same breath as it is sent: built before and sent after, a status
    // could go out after a newer one and leave the page showing, say, no key just after one was saved.
    await loadKey();
    if (!closing) broadcastEvent('stream', current());
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

  /**
   * The first encoder in ENCODERS this FFmpeg has and this PC's card can run, and whether it takes
   * the quality settings the stream will use or needs the safe ones; null when there is none.
   */
  async function findEncoder(encoders) {
    const encodes = (args) => run(ffmpegPath, ['-hide_banner', '-f', 'lavfi', '-i', 'color=black:s=256x256:r=30', ...args, '-f', 'null', '-']).then((r) => r.code === 0);
    for (const e of ENCODERS) {
      if (!listsName(encoders, e.codec)) continue;
      // Being compiled in doesn't mean there is a card to use it: encode one frame.
      if (!(await encodes(['-frames:v', '1', '-c:v', e.codec]))) continue;
      // Then a few with the stream's own settings, which an older card can refuse in part.
      const tuning = (await encodes(['-frames:v', '5', ...encoderArgs(e.id, 2500, 30, 'quality')])) ? 'quality' : 'safe';
      return { encoder: e, tuning };
    }
    return null;
  }

  /**
   * The quickest way of scaling that works here with `encoder`: each is tried on a couple of
   * captured frames with the stream's own encoder settings, since a filter being listed doesn't
   * mean it works with this driver (scale_d3d11 doesn't, with FFmpeg 8.1). 'cpu' always does.
   */
  async function findScaler(encoder, tuning, filters) {
    for (const name of encoder.scalers) {
      if (name === 'cpu') break;
      if (!listsName(filters, SCALERS[name].filter)) continue;
      const video = `ddagrab=output_idx=0:framerate=30,${SCALERS[name].chain(720)}`;
      const probe = await run(ffmpegPath, ['-hide_banner', '-f', 'lavfi', '-i', video, '-frames:v', '2', ...encoderArgs(encoder.id, 2500, 30, tuning), '-f', 'null', '-']);
      if (probe.code === 0) return name;
    }
    return 'cpu';
  }

  async function doCheck() {
    ffmpegPath = noHelpers() ? '' : await findFfmpeg().catch(() => '');
    if (!ffmpegPath) {
      tools = unchecked();
      return;
    }
    const [version, encoders, filters] = await Promise.all([run(ffmpegPath, ['-version']), run(ffmpegPath, ['-hide_banner', '-encoders']), run(ffmpegPath, ['-hide_banner', '-filters'])]);
    const found = await findEncoder(encoders.out);
    const ddagrab = listsName(filters.out, 'ddagrab');
    tools = {
      ffmpeg: true,
      version: /ffmpeg version (\S+)/.exec(version.out)?.[1] ?? '',
      encoder: found?.encoder.id ?? '',
      tuning: found?.tuning ?? null,
      scaler: found && ddagrab ? await findScaler(found.encoder, found.tuning, filters.out) : null,
      ddagrab,
    };
  }

  /**
   * Looks for FFmpeg and what it can do. The answer is kept, except that not finding FFmpeg is
   * looked into again each time (it may have been installed since); `force` looks again anyway.
   */
  function check({ force = false } = {}) {
    if (force || (checked && !tools.ffmpeg)) checking = null;
    // Done once the page has been told, so whoever waits on it sees the answer go out first.
    checking ??= doCheck()
      .then(() => void (checked = true))
      .finally(() => emit());
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
    if (mine.pid) {
      try {
        raisePriority(mine.pid);
      } catch {
        // Not allowed or already gone: it streams at normal priority, as before.
      }
    }
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
    const audioPipe = body?.audioPipe === undefined || body.audioPipe === null || body.audioPipe === '' ? '' : String(body.audioPipe);
    if (audioPipe && !PIPE_SHAPE.test(audioPipe)) throw fail(400, 'That isn’t a sound pipe made by the Uncbox app.');
    const settings = clampSettings(body?.settings);
    // Taken before anything is waited on (the key from Twitch, the check), so a second Go live in
    // the meantime is turned away instead of starting a second FFmpeg nobody could stop.
    launching = true;
    try {
      await takeSignInKey();
      const { key } = await loadKey();
      if (!key) throw fail(400, 'Add your Twitch stream key first.');
      await check();
      if (!tools.ffmpeg) throw fail(400, 'FFmpeg isn’t installed. Install it from the Downloads widget.');
      if (tools.ddagrab === false) throw fail(400, 'This FFmpeg can’t capture the screen. Install the latest FFmpeg from the Downloads widget.');
      if (!tools.encoder) throw fail(400, NO_ENCODER);
      const screenHeight = settings.height > 0 ? await screenHeightOf(settings.screen) : 0;
      test = Boolean(body?.test);
      launch({ args: buildFfmpegArgs({ settings, key, test, audioPipe, encoder: tools.encoder, tuning: tools.tuning ?? 'quality', scaler: tools.scaler ?? 'cpu', screenHeight }), key });
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

  /** Saves a key, or forgets it ('' ). A forgotten key is remembered as such, so the sign-in doesn't hand it straight back. */
  async function saveKey(key, source) {
    saved = { key, source: key ? source : null, forgotten: !key };
    if (key) await writeJsonAtomic(keyFile, { key, source }, { mode: 0o600 });
    else await writeJsonAtomic(keyFile, { forgotten: true }, { mode: 0o600 });
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

  /**
   * With no key yet, takes it from the Twitch sign-in when that can read it, so signing in to Twitch
   * is all the setup streaming needs. Never after the key was forgotten on purpose (pasting one or
   * Get it from Twitch undoes that). Quietly does nothing otherwise (not signed in, a sign-in from
   * before the key permission, Twitch not answering): the Streaming section still offers both ways.
   */
  async function takeSignInKey() {
    const { key, forgotten } = await loadKey();
    if (key || forgotten) return;
    try {
      const fresh = await twitch.streamKey();
      const now = await loadKey();
      if (KEY_SHAPE.test(fresh) && !now.key && !now.forgotten) await saveKey(fresh, 'twitch');
    } catch {
      // Left to the buttons.
    }
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
      else if (route === '/check') {
        // The page checks whenever its streaming controls are there (Stream with: Uncbox): a good
        // moment to pick up the key too. Not waited for, so a slow Twitch can't hold up the check;
        // the page hears about a key when it is saved.
        if (!busy()) void takeSignInKey();
        await check({ force: (await readJson(req)).force === true });
      }
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
