// A local end-to-end run of the streaming engine, and the same run with the FFmpeg command line
// Uncbox's FFmpeg path uses, so the two can be compared. Nothing leaves this PC: FFmpeg listens on
// 127.0.0.1 as a stand-in for Twitch, writes what it receives to a file, and that file is then
// inspected with ffprobe. Never point this at a real service; the stream key here is a made-up word.
//
//   node engine/scripts/e2e.mjs --engine native --seconds 30 --height 1080 --fps 60 --kbps 6000
//   node engine/scripts/e2e.mjs --engine ffmpeg --seconds 30 --height 1080 --fps 60 --kbps 6000
//   node engine/scripts/e2e.mjs --suite                 the three settings below, checked, engine only
//   node engine/scripts/e2e.mjs --suite --both --runs 2 the same for the engine and FFmpeg, twice each
//
// Options: --screen 0
//          --tone    sends a 440 Hz tone through a named pipe, like the Uncbox app does
//          --pipe <name>   uses a sound pipe somebody else made, by its name after \\.\pipe\
//          --motion  puts a moving 720p60 test picture on screen while it runs, so the encoder has
//                    something to do (without it an idle desktop is streamed)
//          --quality 0-100   the engine's speed-or-looks setting
//          --backend nvenc|mf   which encoder the engine uses (default: its own choice)
//          --out <folder>    where the received file goes
//
// A single run prints one JSON object: what the engine reported, CPU used by the engine's process,
// GPU load while it ran (nvidia-smi), and what ffprobe found in the file that arrived. `--suite` runs
// 1080p60 at 6000 kbit/s, the screen's own size at 60 fps and 6000, and 720p30 at 3000, each with sound,
// and checks every file: H.264 High, B-frames where the encoder has them, keyframes at most 2 s apart (exactly 2 s on a steady picture),
// decode times that only go up, AAC at 48 kHz in stereo, and about as many pictures as the time
// asked for. The exit code says whether every check held.

import { execFile, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFfmpegArgs, createProgressParser } from '../../server/stream.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith('--') ? [[a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : [])),
);
const PORT = 19350;
const KEY = 'testkey';
const URL_LOCAL = `rtmp://127.0.0.1:${PORT}/app/${KEY}`;
const enginePath = path.join(root, 'engine', 'target', 'release', 'uncbox-stream.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = args.out ? path.resolve(String(args.out)) : mkdtempSync(path.join(os.tmpdir(), 'uncbox-e2e-'));
mkdirSync(dir, { recursive: true });

/** Total processor time of a process, in seconds (0 if it can't be read). Asynchronous, so the sound pipe's writer here isn't held up. */
function cpuSeconds(pid) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).TotalProcessorTime.TotalSeconds`], { encoding: 'utf8' }, (_err, stdout) => resolve(Number.parseFloat(stdout) || 0));
  });
}

/**
 * The FFmpeg command Uncbox's FFmpeg path runs (server/stream.mjs `buildFfmpegArgs`: ddagrab, CUDA
 * scaling, NVENC with the quality settings), with the address swapped for the local receiver.
 */
function currentFfmpegArgs({ screen, fps, height, kbps }, audioPipe, url) {
  const built = buildFfmpegArgs({ settings: { screen, fps, height, kbps }, key: KEY, audioPipe, encoder: 'nvenc', tuning: 'quality', scaler: 'cuda', screenHeight: Number(args.screenHeight ?? 1440) });
  built[built.length - 1] = url;
  return built;
}

/** A named pipe the engine can read sound from, written in real time like the Uncbox app does. */
function startTonePipe() {
  const name = `\\\\.\\pipe\\uncbox-stream-audio-${Math.random().toString(16).slice(2, 18).padEnd(16, '0')}`;
  const server = net.createServer((socket) => {
    const started = process.hrtime.bigint();
    let written = 0;
    let phase = 0;
    const timer = setInterval(() => {
      const due = Math.floor(Number(process.hrtime.bigint() - started) / 1e7);
      while (written < due) {
        const block = Buffer.alloc(480 * 2 * 4);
        for (let i = 0; i < 480; i++) {
          const v = Math.sin(phase) * 0.1;
          phase += (2 * Math.PI * 440) / 48000;
          block.writeFloatLE(v, i * 8);
          block.writeFloatLE(v, i * 8 + 4);
        }
        if (!socket.write(block)) break;
        written++;
      }
    }, 5);
    socket.on('close', () => clearInterval(timer));
    socket.on('error', () => clearInterval(timer));
  });
  server.listen(name);
  return { name, close: () => server.close() };
}

const pipeName = (name) => (name.startsWith('\\') ? name : `\\\\.\\pipe\\${name}`);
const monotonic = (list) => list.every((v, i) => i === 0 || v >= list[i - 1]);
const round = (n, places = 1) => Math.round(n * 10 ** places) / 10 ** places;

/** One run: the engine (or FFmpeg) streams the screen to the local receiver for `seconds`, then it is stopped and the file is read. */
async function runCase(options) {
  const { engine, seconds, motion, tone: withTone, backend } = options;
  const settings = { screen: options.screen, fps: options.fps, height: options.height, kbps: options.kbps };
  const received = path.join(dir, `${engine}-${settings.height}p${settings.fps}-${options.label ?? 'run'}.flv`);
  if (existsSync(received)) rmSync(received);

  // -- the stand-in server --
  const sink = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-y', '-listen', '1', '-i', URL_LOCAL, '-c', 'copy', '-f', 'flv', received], { stdio: ['pipe', 'ignore', 'pipe'] });
  let sinkErr = '';
  sink.stderr.on('data', (d) => (sinkErr += d));
  await sleep(1200);

  // --pipe <name> uses a pipe someone else made (for trying the real .NET pipe the Uncbox app makes).
  const tone = typeof args.pipe === 'string' ? { name: pipeName(args.pipe), close() {} } : withTone ? startTonePipe() : null;
  // A window of moving test pattern (ffplay is part of the FFmpeg download).
  const window = motion
    ? spawn('ffplay', ['-hide_banner', '-loglevel', 'quiet', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=60', '-x', '1280', '-y', '720', '-left', '200', '-top', '200', '-noborder', '-alwaysontop'], { stdio: 'ignore' })
    : null;
  if (window) await sleep(1500);

  // -- GPU load, sampled once a second for the whole run --
  const gpuRows = [];
  const dmon = spawn('nvidia-smi', ['dmon', '-s', 'u', '-d', '1'], { stdio: ['ignore', 'pipe', 'ignore'] });
  dmon.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(line);
      if (m) gpuRows.push({ gpu: Number(m[2]), mem: Number(m[3]), enc: Number(m[4]), dec: Number(m[5]) });
    }
  });

  // -- the program under test --
  let child;
  const reports = [];
  const stderrLines = [];
  const progress = createProgressParser();
  const started = Date.now();
  if (engine === 'native') {
    child = spawn(enginePath, ['run'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const config = { url: URL_LOCAL, ...settings, ...(tone ? { audioPipe: tone.name } : {}), ...(options.quality !== undefined ? { quality: options.quality } : {}), ...(backend ? { backend } : {}) };
    child.stdin.write(JSON.stringify(config) + '\n');
  } else {
    child = spawn('ffmpeg', currentFfmpegArgs(settings, tone ? tone.name : '', URL_LOCAL), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  }
  const report = { backend: null, tuning: null, bframes: null, name: null };
  child.stdout.on('data', (d) => {
    const text = String(d);
    for (const key of ['encoder_backend', 'encoder_tuning', 'encoder_bframes', 'encoder_name']) {
      const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
      if (m) report[key.replace('encoder_', '')] = m[1].trim();
    }
    const stats = progress.push(d);
    if (stats) reports.push({ at: Date.now() - started, ...stats });
  });
  child.stderr.on('data', (d) => stderrLines.push(...String(d).split(/\r?\n/).filter(Boolean)));
  let exited = null;
  child.on('close', (code) => (exited = { code, at: Date.now() }));

  // Warm up, then measure the processor time over the rest of the run.
  const WARM = 5000;
  await sleep(WARM);
  const cpu0 = await cpuSeconds(child.pid);
  const t0 = Date.now();
  const gpuFrom = gpuRows.length;
  await sleep(Math.max(1000, seconds * 1000 - WARM));
  const cpu1 = await cpuSeconds(child.pid);
  const t1 = Date.now();
  const gpuTo = gpuRows.length;

  // -- stop it the way the server does --
  const stopAt = Date.now();
  child.stdin.write('q\n');
  for (let i = 0; i < 100 && !exited; i++) await sleep(100);
  const stopMs = exited ? exited.at - stopAt : null;
  if (!exited) child.kill();
  await sleep(500);
  dmon.kill();
  window?.kill();
  tone?.close();
  sink.stdin.write('q');
  await sleep(800);
  sink.kill();

  // -- what arrived --
  const probe = (extra) => spawnSync('ffprobe', ['-v', 'error', '-of', 'json', ...extra, received], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const have = existsSync(received);
  const streams = have
    ? JSON.parse(probe(['-count_frames', '-show_entries', 'stream=codec_type,codec_name,profile,width,height,avg_frame_rate,r_frame_rate,nb_read_frames,sample_rate,channels,duration']).stdout || '{}').streams
    : null;
  const packets = have ? JSON.parse(probe(['-select_streams', 'v', '-show_entries', 'packet=dts_time,pts_time,flags']).stdout || '{}').packets ?? [] : [];
  const audioPackets = have ? JSON.parse(probe(['-select_streams', 'a', '-show_entries', 'packet=dts_time']).stdout || '{}').packets ?? [] : [];
  const frames = have ? JSON.parse(probe(['-select_streams', 'v', '-show_entries', 'frame=pict_type']).stdout || '{}').frames ?? [] : [];
  const pictureTypes = {};
  for (const f of frames) pictureTypes[f.pict_type] = (pictureTypes[f.pict_type] ?? 0) + 1;
  const dts = packets.map((p) => Number(p.dts_time));
  const keyTimes = packets.filter((p) => String(p.flags).includes('K')).map((p) => Number(p.dts_time));
  const gaps = keyTimes.slice(1).map((t, i) => round(t - keyTimes[i], 3));

  const gpuWindow = gpuRows.slice(gpuFrom, gpuTo);
  const avg = (list, key) => (list.length ? round(list.reduce((s, r) => s + r[key], 0) / list.length) : null);
  const last = reports.at(-1) ?? null;
  // The last block (progress=end) has no rate in it: leave it out of the averages.
  const midReports = reports.filter((r) => r.at > WARM && r.fps > 0);
  const video = streams?.find((s) => s.codec_type === 'video');
  const audio = streams?.find((s) => s.codec_type === 'audio');
  return {
    engine,
    backend: report.backend,
    tuning: report.tuning,
    encoder: report.name,
    settings,
    motion: Boolean(motion),
    seconds,
    stopMs,
    exitCode: exited?.code ?? null,
    cpuPercentOfOneCore: cpu1 > cpu0 ? round(((cpu1 - cpu0) / ((t1 - t0) / 1000)) * 100) : null,
    gpu: { samples: gpuWindow.length, gpuPercent: avg(gpuWindow, 'gpu'), encoderPercent: avg(gpuWindow, 'enc'), memPercent: avg(gpuWindow, 'mem') },
    reported: { fps: midReports.length ? round(midReports.reduce((s, r) => s + r.fps, 0) / midReports.length) : null, kbps: avg(midReports, 'kbps'), dropped: last?.dropped ?? null, frames: last?.frames ?? null, speed: last?.speed ?? null },
    received: {
      video: video ? { codec: video.codec_name, profile: video.profile, width: video.width, height: video.height } : null,
      audio: audio ? { codec: audio.codec_name, profile: audio.profile, sampleRate: Number(audio.sample_rate), channels: audio.channels } : null,
      videoPackets: packets.length,
      audioPackets: audioPackets.length,
      pictureTypes,
      videoDtsMonotonic: monotonic(dts),
      audioDtsMonotonic: monotonic(audioPackets.map((p) => Number(p.dts_time))),
      keyframeGapsSeconds: gaps.length ? { min: Math.min(...gaps), max: Math.max(...gaps), count: gaps.length + 1 } : null,
      firstVideoDts: dts[0] ?? null,
      firstAudioDts: Number(audioPackets[0]?.dts_time ?? NaN),
      lastVideoDts: dts.at(-1) ?? null,
      lastAudioDts: Number(audioPackets.at(-1)?.dts_time ?? NaN),
      // Pictures that arrived divided by the stream time they cover: the frame rate actually delivered.
      effectiveFps: dts.length > 1 ? round((dts.length - 1) / (dts.at(-1) - dts[0])) : null,
    },
    engineStderr: stderrLines.slice(-40),
    sinkStderr: sinkErr.split(/\r?\n/).filter(Boolean).slice(-4),
    file: received,
  };
}

/** What a stream to Twitch needs of the file that arrives. Returns the problems found (none means it passed). */
function check(result, { expectBFrames }) {
  const problems = [];
  const r = result.received;
  const { fps, height } = result.settings;
  const want = (cond, text) => cond || problems.push(text);
  want(result.exitCode === 0, `exit code ${result.exitCode}`);
  want(r.video?.codec === 'h264' && r.video?.profile === 'High', `video is ${r.video?.codec} ${r.video?.profile}, not H.264 High`);
  if (height > 0) want(r.video?.height === height, `height is ${r.video?.height}, not ${height}`);
  want(r.audio?.codec === 'aac' && r.audio?.sampleRate === 48000 && r.audio?.channels === 2, `sound is ${JSON.stringify(r.audio)}, not AAC 48 kHz stereo`);
  want(r.videoDtsMonotonic && r.audioDtsMonotonic, 'decode times go backwards');
  if (expectBFrames) want((r.pictureTypes.B ?? 0) > 0, 'no B-frames');
  const gaps = r.keyframeGapsSeconds;
  // Never more than 2 s apart. NVENC with look-ahead also starts a keyframe at a scene change (FFmpeg does the same with the same settings), so a gap can be shorter; on a steady picture every gap is exactly 2 s.
  want(gaps && gaps.min >= 0.25 && gaps.max <= 2.01, `keyframes are ${gaps ? `${gaps.min} to ${gaps.max}` : "not found"} seconds apart, more than 2 allowed`);
  // About fps x the time it streamed for: the time asked for plus the few seconds of start-up and stop.
  want(r.videoPackets >= fps * (result.seconds - 1) && r.videoPackets <= fps * (result.seconds + 4), `${r.videoPackets} pictures for ${result.seconds} s at ${fps} fps`);
  want(r.effectiveFps !== null && Math.abs(r.effectiveFps - fps) <= 1, `${r.effectiveFps} fps delivered, not ${fps}`);
  return problems;
}

const base = { screen: Number(args.screen ?? 0), seconds: Number(args.seconds ?? 30), motion: Boolean(args.motion), tone: Boolean(args.tone), quality: args.quality !== undefined ? Number(args.quality) : undefined, backend: typeof args.backend === 'string' ? args.backend : undefined };

if (args.suite) {
  const cases = [
    { fps: 60, height: 1080, kbps: 6000 },
    { fps: 60, height: 0, kbps: 6000 },
    { fps: 30, height: 720, kbps: 3000 },
  ];
  const engines = args.both ? ['native', 'ffmpeg'] : [args.engine === 'ffmpeg' ? 'ffmpeg' : 'native'];
  const runs = Number(args.runs ?? 1);
  const seconds = Number(args.seconds ?? 20);
  const all = [];
  let failed = false;
  for (const c of cases) {
    for (const engine of engines) {
      for (let run = 1; run <= runs; run++) {
        const result = await runCase({ ...base, ...c, seconds, engine, tone: true, label: `r${run}` });
        // B-frames: the engine's NVENC backend and FFmpeg's NVENC have them; Media Foundation's NVIDIA encoder doesn't.
        const problems = check(result, { expectBFrames: engine === 'ffmpeg' || result.backend === 'nvenc' });
        failed ||= problems.length > 0;
        all.push({ ...result, problems });
        const line = [engine.padEnd(6), `${c.height || 'screen'}p${c.fps}`.padEnd(9), String(c.kbps).padEnd(5), `cpu ${result.cpuPercentOfOneCore}%`.padEnd(10), `enc ${result.gpu.encoderPercent}%`.padEnd(9), `${result.received.effectiveFps} fps`.padEnd(10), `B ${result.received.pictureTypes.B ?? 0}`.padEnd(7), problems.length ? `FAILED: ${problems.join('; ')}` : 'ok'];
        console.error(line.join(' '));
      }
    }
  }
  console.log(JSON.stringify(all, null, 2));
  process.exit(failed ? 1 : 0);
} else {
  const engine = args.engine === 'ffmpeg' ? 'ffmpeg' : 'native';
  const result = await runCase({ ...base, engine, fps: Number(args.fps ?? 60), height: Number(args.height ?? 1080), kbps: Number(args.kbps ?? 6000), label: 'single' });
  console.log(JSON.stringify(result, null, 2));
}
