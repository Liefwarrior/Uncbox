// Compares the picture quality of the streaming engine with FFmpeg's on the same clip, with no screen,
// network or timing involved: the clip is turned into a Y4M file, each encoder encodes that file with
// the settings a Twitch stream uses (constant bitrate, a buffer of two seconds, a keyframe every two
// seconds), and the results are scored against the original with VMAF, PSNR and SSIM.
//
//   node engine/scripts/quality.mjs <clip> --start 20 --dur 20 --tag smite
//   node engine/scripts/quality.mjs <clip> --start 25 --dur 20 --tag smite2 --variants engine-nvenc,ffmpeg-nvenc
//
// Options: --start <seconds>   where in the clip to begin (default 0)
//          --dur <seconds>     how much of it (default 20; a 1080p60 second is 187 MB of Y4M)
//          --tag <name>        names the files (default "clip")
//          --kbps <n>          video bitrate (default 6000)
//          --work <folder>     where the Y4M and the encoded files go (default a folder in the temp directory)
//          --variants a,b,c    engine-nvenc (the engine's direct NVIDIA encoder), engine-nvenc-safe (its safe settings),
//                              engine-mf (Media Foundation), ffmpeg-nvenc, ffmpeg-nvenc-safe
//                              (default: engine-nvenc,engine-mf,ffmpeg-nvenc)
//
// Needs ffmpeg and ffprobe on PATH, FFmpeg's with libvmaf, and a built engine (npm run engine). The engine
// reads the Y4M through its test source ("source": { "y4m": ... }, "pace": false) and writes an FLV file
// ("url": "file:...flv"); FFmpeg gets exactly the arguments server/stream.mjs gives its NVENC encoder. Every
// result is decoded to raw pictures in order before it is compared, so the scores cannot be thrown off
// by the time stamps of the two containers.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encoderArgs } from '../../server/stream.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const exe = path.join(root, 'engine', 'target', 'release', 'uncbox-stream.exe');
const [clip, ...rest] = process.argv.slice(2);
const args = Object.fromEntries(rest.flatMap((a, i, all) => (a.startsWith('--') ? [[a.slice(2), all[i + 1]]] : [])));
if (!clip) {
  console.error('usage: node engine/scripts/quality.mjs <clip> [--start s] [--dur s] [--tag name] [--kbps n] [--work folder] [--variants a,b]');
  process.exit(2);
}
const start = String(args.start ?? 0);
const dur = String(args.dur ?? 20);
const tag = String(args.tag ?? 'clip');
const kbps = Number(args.kbps ?? 6000);
const variants = String(args.variants ?? 'engine-nvenc,engine-mf,ffmpeg-nvenc').split(',');
const work = args.work ? path.resolve(args.work) : mkdtempSync(path.join(os.tmpdir(), 'uncbox-quality-'));
mkdirSync(path.join(work, 'out'), { recursive: true });
const run = (cmd, a, opts = {}) => spawnSync(cmd, a, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });

const y4m = path.join(work, `${tag}.y4m`);
if (!existsSync(y4m)) {
  console.error(`making ${y4m}`);
  const made = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', start, '-t', dur, '-i', clip, '-an', '-pix_fmt', 'yuv420p', '-f', 'yuv4mpegpipe', y4m]);
  if (made.status !== 0) throw new Error(made.stderr);
}
const probed = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,height', '-of', 'csv=p=0', y4m]).stdout.trim().split(',');
const [rateNumber, rateDivisor = '1'] = probed[0].split('/'); // "60/1"
const fps = Math.round(Number(rateNumber) / Number(rateDivisor));
const height = Number(probed[1]);

/** The engine encoding the Y4M to an FLV file. */
function engine(out, extra) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(exe, ['run'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stdin.write(JSON.stringify({ url: `file:${out}`, source: { y4m }, pace: false, kbps, height, ...extra }) + '\n');
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.stdout.on('data', () => {});
    child.on('close', (code) => resolve({ code, seconds: (Date.now() - started) / 1000, note: err.trim().split(/\r?\n/).slice(-2).join(' | ') }));
  });
}

/** VMAF (mean, worst 5% and 1% of frames), PSNR and SSIM of `file` against the Y4M. */
function score(file) {
  const raw = path.join(work, 'out', '_decoded.y4m');
  const decoded = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-fps_mode', 'passthrough', '-an', '-pix_fmt', 'yuv420p', '-f', 'yuv4mpegpipe', raw]);
  if (decoded.status !== 0) throw new Error(decoded.stderr);
  const logName = `out/${path.basename(file)}.json`;
  const graph = `[0:v]setpts=N/(${fps}*TB)[d];[1:v]setpts=N/(${fps}*TB)[r];[d][r]libvmaf=n_threads=16:feature=name=psnr|name=float_ssim:log_fmt=json:log_path=${logName}`;
  // The log path is relative (a drive letter's colon is a filter-graph separator), so run in the work folder.
  const scored = run('ffmpeg', ['-hide_banner', '-i', 'out/_decoded.y4m', '-i', `${tag}.y4m`, '-lavfi', graph, '-f', 'null', '-'], { cwd: work });
  if (!existsSync(path.join(work, logName))) throw new Error(`no VMAF log for ${file}: ${scored.stderr.slice(-400)}`);
  const j = JSON.parse(readFileSync(path.join(work, logName), 'utf8'));
  const frames = j.frames.map((x) => x.metrics.vmaf).sort((a, b) => a - b);
  const pooled = j.pooled_metrics;
  const at = (p) => frames[Math.floor(p * (frames.length - 1))];
  const bitrate = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=bit_rate', '-of', 'csv=p=0', file]).stdout) / 1000;
  rmSync(raw, { force: true });
  return {
    vmaf_mean: +pooled.vmaf.mean.toFixed(2),
    vmaf_5pct_low: +at(0.05).toFixed(2),
    vmaf_1pct_low: +at(0.01).toFixed(2),
    psnr_y: +pooled.psnr_y.mean.toFixed(2),
    ssim: +pooled.float_ssim.mean.toFixed(4),
    frames: frames.length,
    kbps: Math.round(bitrate),
  };
}

const results = {};
for (const variant of variants) {
  const out = path.join(work, 'out', variant.startsWith('ffmpeg') ? `${tag}_${variant}.mp4` : `${tag}_${variant}.flv`);
  let timing;
  if (variant === 'engine-nvenc') timing = await engine(out, {});
  else if (variant === 'engine-nvenc-safe') timing = await engine(out, { tuning: 'safe' });
  else if (variant === 'engine-mf') timing = await engine(out, { backend: 'mf' });
  else if (variant === 'ffmpeg-nvenc' || variant === 'ffmpeg-nvenc-safe') {
    const encoder = encoderArgs('nvenc', kbps, fps, variant.endsWith('safe') ? 'safe' : 'quality');
    const started = Date.now();
    const r = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', y4m, '-an', ...encoder, out]);
    timing = { code: r.status, seconds: (Date.now() - started) / 1000, note: r.stderr.slice(-200) };
  } else throw new Error(`unknown variant ${variant}`);
  results[variant] = timing.code === 0 ? { ...score(out), encode_seconds: timing.seconds, note: timing.note } : { failed: timing };
  console.error(`${tag} ${variant}: ${JSON.stringify(results[variant])}`);
}
console.log(JSON.stringify({ tag, clip, start, dur, kbps, fps, results }, null, 2));
