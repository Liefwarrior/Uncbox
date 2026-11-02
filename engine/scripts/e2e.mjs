// A local end-to-end run of the streaming engine, and the same run with the FFmpeg command
// line Uncbox's FFmpeg path uses, so the two can be compared. Nothing leaves this PC: FFmpeg listens on 127.0.0.1 as a
// stand-in for Twitch, writes what it receives to a file, and that file is then inspected with
// ffprobe. Never point this at a real service; the stream key here is a made-up word.
//
//   node engine/scripts/e2e.mjs --engine native --seconds 30 --height 1080 --fps 60 --kbps 6000
//   node engine/scripts/e2e.mjs --engine ffmpeg --seconds 30 --height 1080 --fps 60 --kbps 6000
//
// Options: --screen 0
//          --tone    sends a 440 Hz tone through a named pipe, like the Uncbox app does
//          --pipe <name>   uses a sound pipe somebody else made, by its name after \\.\pipe\
//          --motion  puts a moving 720p60 test picture on screen while it runs, so the encoder has
//                    something to do (without it an idle desktop is streamed)
//          --quality 0-100   the engine's speed-or-looks setting
//          --out <folder>    where the received file goes
//
// It prints one JSON object: what the engine reported, CPU used by the engine's process, GPU
// load while it ran (nvidia-smi), and what ffprobe found in the file that arrived.

import { execFile, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProgressParser } from '../../server/stream.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith('--') ? [[a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : [])),
);
const engine = args.engine === 'ffmpeg' ? 'ffmpeg' : 'native';
const seconds = Number(args.seconds ?? 30);
const settings = { screen: Number(args.screen ?? 0), fps: Number(args.fps ?? 60), height: Number(args.height ?? 1080), kbps: Number(args.kbps ?? 6000) };
const PORT = 19350;
const KEY = 'testkey';
const URL_LOCAL = `rtmp://127.0.0.1:${PORT}/app/${KEY}`;
const dir = args.out ? path.resolve(String(args.out)) : mkdtempSync(path.join(os.tmpdir(), 'uncbox-e2e-'));
mkdirSync(dir, { recursive: true });
const received = path.join(dir, `${engine}-${settings.height}p${settings.fps}.flv`);
const enginePath = path.join(root, 'engine', 'target', 'release', 'uncbox-stream.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Total processor time of a process, in seconds (0 if it can't be read). Asynchronous, so the sound pipe's writer here isn't held up. */
function cpuSeconds(pid) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).TotalProcessorTime.TotalSeconds`], { encoding: 'utf8' }, (_err, stdout) => resolve(Number.parseFloat(stdout) || 0));
  });
}

/**
 * The FFmpeg command line Uncbox's FFmpeg path uses now (CUDA scaling with lanczos, NVENC p6 with
 * lookahead and B-frames), pointed at the local receiver. At the screen's own size there is no scaling.
 */
function currentFfmpegArgs({ screen, fps, height, kbps }, audioPipe, url) {
  const scale = height > 0 ? ['-vf', `hwdownload,format=bgra,hwupload_cuda,scale_cuda=w=trunc(iw*${height}/ih/2)*2:h=${height}:interp_algo=lanczos`] : ['-vf', 'hwdownload,format=bgra'];
  const audio = audioPipe ? ['-thread_queue_size', '1024', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', audioPipe] : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'];
  return [
    ...['-hide_banner', '-loglevel', 'warning', '-nostats', '-progress', 'pipe:1', '-thread_queue_size', '8'],
    ...['-f', 'lavfi', '-i', `ddagrab=output_idx=${screen}:framerate=${fps}:draw_mouse=1`],
    ...audio,
    ...scale,
    ...['-fps_mode', 'cfr', '-r', String(fps)],
    ...['-c:v', 'h264_nvenc', '-preset', 'p6', '-tune', 'hq', '-multipass', 'qres', '-rc', 'cbr', '-temporal-aq', '1', '-rc-lookahead', '10', '-bf', '2', '-b_ref_mode', 'middle'],
    ...['-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`, '-g', String(fps * 2), '-profile:v', 'high'],
    ...['-af', 'aresample=async=1000', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000'],
    ...['-map', '0:v', '-map', '1:a'],
    ...['-flvflags', 'no_duration_filesize', '-f', 'flv', url],
  ];
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

async function waitForPort(port, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => (s.destroy(), resolve(true)));
      s.on('error', () => resolve(false));
    });
    if (ok) return true;
    await sleep(100);
  }
  return false;
}

// -- the stand-in server --
if (existsSync(received)) rmSync(received);
const sink = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-y', '-listen', '1', '-i', URL_LOCAL, '-c', 'copy', '-f', 'flv', received], { stdio: ['pipe', 'ignore', 'pipe'] });
let sinkErr = '';
sink.stderr.on('data', (d) => (sinkErr += d));
await sleep(1200);

// --pipe <name> uses a pipe someone else made (for trying the real .NET pipe the Uncbox app makes).
const pipeName = (name) => (name.startsWith('\\') ? name : `\\\\.\\pipe\\${name}`);
const tone = typeof args.pipe === 'string' ? { name: pipeName(args.pipe), close() {} } : args.tone ? startTonePipe() : null;
// A window of moving test pattern (ffplay is part of the FFmpeg download).
const motion = args.motion
  ? spawn('ffplay', ['-hide_banner', '-loglevel', 'quiet', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=60', '-x', '1280', '-y', '720', '-left', '200', '-top', '200', '-noborder', '-alwaysontop'], { stdio: 'ignore' })
  : null;
if (motion) await sleep(1500);

// -- GPU load, sampled once a second for the whole run --
const gpuRows = [];
const dmon = spawn('nvidia-smi', ['dmon', '-s', 'u', '-d', '1'], { stdio: ['ignore', 'pipe', 'ignore'] });
dmon.stdout.on('data', (chunk) => {
  for (const line of String(chunk).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(line);
    if (m) gpuRows.push({ gpu: Number(m[2]), mem: Number(m[3]), enc: Number(m[4]), dec: Number(m[5]) });
  }
});

// -- the engine under test --
let child;
const reports = [];
const stderrLines = [];
const progress = createProgressParser();
const started = Date.now();
if (engine === 'native') {
  child = spawn(enginePath, ['run'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdin.write(JSON.stringify({ url: URL_LOCAL, ...settings, ...(tone ? { audioPipe: tone.name } : {}) }) + '\n');
} else {
  const ffmpegArgs = currentFfmpegArgs(settings, tone ? tone.name : '', URL_LOCAL);
  child = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}
child.stdout.on('data', (d) => {
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
motion?.kill();
tone?.close();
sink.stdin.write('q');
await sleep(800);
sink.kill();

// -- what arrived --
const probe = (extra) => spawnSync('ffprobe', ['-v', 'error', '-of', 'json', ...extra, received], { encoding: 'utf8', maxBuffer: 1 << 28 });
const streams = existsSync(received)
  ? JSON.parse(probe(['-count_frames', '-show_entries', 'stream=codec_type,codec_name,profile,width,height,avg_frame_rate,r_frame_rate,nb_read_frames,sample_rate,channels,duration']).stdout || '{}').streams
  : null;
const packets = existsSync(received) ? JSON.parse(probe(['-select_streams', 'v', '-show_entries', 'packet=dts_time,pts_time,flags']).stdout || '{}').packets ?? [] : [];
const audioPackets = existsSync(received) ? JSON.parse(probe(['-select_streams', 'a', '-show_entries', 'packet=dts_time']).stdout || '{}').packets ?? [] : [];
const dts = packets.map((p) => Number(p.dts_time));
const keyTimes = packets.filter((p) => String(p.flags).includes('K')).map((p) => Number(p.dts_time));
const monotonic = (list) => list.every((v, i) => i === 0 || v >= list[i - 1]);
const gaps = keyTimes.slice(1).map((t, i) => Math.round((t - keyTimes[i]) * 100) / 100);

const gpuWindow = gpuRows.slice(gpuFrom, gpuTo);
const avg = (list, key) => (list.length ? Math.round((list.reduce((s, r) => s + r[key], 0) / list.length) * 10) / 10 : null);
const last = reports.at(-1) ?? null;
const midReports = reports.filter((r) => r.at > WARM);
const result = {
  engine,
  settings,
  motion: Boolean(args.motion),
  seconds,
  stopMs,
  exitCode: exited?.code ?? null,
  cpuPercentOfOneCore: cpu1 > cpu0 ? Math.round(((cpu1 - cpu0) / ((t1 - t0) / 1000)) * 1000) / 10 : null,
  gpu: { samples: gpuWindow.length, gpuPercent: avg(gpuWindow, 'gpu'), encoderPercent: avg(gpuWindow, 'enc'), memPercent: avg(gpuWindow, 'mem') },
  reported: { fps: midReports.length ? Math.round((midReports.reduce((s, r) => s + r.fps, 0) / midReports.length) * 10) / 10 : null, kbps: avg(midReports, 'kbps'), dropped: last?.dropped ?? null, frames: last?.frames ?? null, speed: last?.speed ?? null },
  received: {
    streams,
    videoPackets: packets.length,
    audioPackets: audioPackets.length,
    videoDtsMonotonic: monotonic(dts),
    audioDtsMonotonic: monotonic(audioPackets.map((p) => Number(p.dts_time))),
    keyframeGapsSeconds: gaps.length ? { min: Math.min(...gaps), max: Math.max(...gaps) } : null,
    firstVideoDts: dts[0] ?? null,
    firstAudioDts: Number(audioPackets[0]?.dts_time ?? NaN),
    lastVideoDts: dts.at(-1) ?? null,
    lastAudioDts: Number(audioPackets.at(-1)?.dts_time ?? NaN),
    // Pictures that arrived divided by the stream time they cover: the frame rate actually delivered.
    effectiveFps: dts.length > 1 ? Math.round(((dts.length - 1) / (dts.at(-1) - dts[0])) * 10) / 10 : null,
  },
  engineStderr: stderrLines.slice(-40),
  sinkStderr: sinkErr.split(/\r?\n/).filter(Boolean).slice(-4),
  file: received,
};
console.log(JSON.stringify(result, null, 2));
