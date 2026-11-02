// Streaming from Uncbox: the FFmpeg arguments, the progress parser, the key handling and the
// stream's life (starting, live, dropped, stopping), with FFmpeg or with Uncbox's own engine
// (uncbox-stream.exe) behind it. Neither is ever run and nothing touches the network: spawn is
// replaced by fakes, and the key file goes in a temp folder.

import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toolsLine } from '../src/stream/format';
import {
  amfScale,
  buildEngineConfig,
  buildFfmpegArgs,
  clampSettings,
  cpuScale,
  createProgressParser,
  createStream,
  cudaScale,
  encoderArgs,
  ENCODERS,
  findEngine,
  gpuScale,
  ingestUrl,
  qsvScale,
  listsName,
  parseProbe,
  parseProgress,
  parseScreenSize,
  PIPE_SHAPE,
  redact,
  TWITCH_INGEST,
  wantedEngine,
} from './stream.mjs';

const KEY = 'live_123456789_AbCdEfGhIjKlMnOpQrSt';
const PIPE = '\\\\.\\pipe\\uncbox-stream-audio-1a2b3c4d';

const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];

describe('clampSettings', () => {
  it('keeps what Uncbox offers', () => {
    expect(clampSettings({ screen: 2, fps: 30, height: 720, kbps: 4500 })).toEqual({ screen: 2, fps: 30, height: 720, kbps: 4500 });
    expect(clampSettings({ screen: 1, fps: 60, height: 0, kbps: 6000 }).height).toBe(0);
  });

  it('pulls everything into range', () => {
    expect(clampSettings({ screen: 99, fps: 144, height: 900, kbps: 99_999 })).toEqual({ screen: 7, fps: 60, height: 1080, kbps: 8000 });
    expect(clampSettings({ screen: -3, kbps: 10 })).toMatchObject({ screen: 0, kbps: 2500 });
  });

  it('falls back to the defaults for nonsense', () => {
    for (const junk of [undefined, null, 'x', 5, [], { screen: 'a', fps: '60', height: '1080', kbps: NaN }]) {
      expect(clampSettings(junk), JSON.stringify(junk)).toEqual({ screen: 0, fps: 60, height: 1080, kbps: 6000 });
    }
  });
});

describe('ingestUrl', () => {
  it('goes to Twitch over TLS', () => {
    expect(ingestUrl(KEY, false)).toBe(`rtmps://live.twitch.tv:443/app/${KEY}`);
  });

  it('marks a test stream as a bandwidth test', () => {
    expect(ingestUrl(KEY, true)).toBe(`rtmps://live.twitch.tv:443/app/${KEY}?bandwidthtest=true`);
  });

  describe('UNCBOX_STREAM_INGEST (for testing only)', () => {
    it('replaces the Twitch address with another rtmp or rtmps one', () => {
      expect(ingestUrl(KEY, false, { UNCBOX_STREAM_INGEST: 'rtmp://127.0.0.1:19350/live' })).toBe(`rtmp://127.0.0.1:19350/live/${KEY}`);
      expect(ingestUrl(KEY, true, { UNCBOX_STREAM_INGEST: ' rtmps://localhost/app/ ' })).toBe(`rtmps://localhost/app/${KEY}?bandwidthtest=true`);
    });

    it('is ignored unless it is an rtmp(s) address', () => {
      for (const bad of ['', '   ', 'http://127.0.0.1/live', 'file:///c:/x', '127.0.0.1:1935', 'rtmp://', 'rtmp://host/app?x=1', '-f flv x', 'rtmp://a b/c']) {
        expect(ingestUrl(KEY, false, { UNCBOX_STREAM_INGEST: bad }), bad).toBe(`${TWITCH_INGEST}/${KEY}`);
      }
      expect(ingestUrl(KEY, false, {})).toBe(`${TWITCH_INGEST}/${KEY}`);
    });

    it('reaches both programs', () => {
      const env = { UNCBOX_STREAM_INGEST: 'rtmp://127.0.0.1:19350/live' };
      expect(buildFfmpegArgs({ settings: {}, key: KEY, env }).at(-1)).toBe(`rtmp://127.0.0.1:19350/live/${KEY}`);
      expect(buildEngineConfig({ settings: {}, key: KEY, env }).url).toBe(`rtmp://127.0.0.1:19350/live/${KEY}`);
    });
  });
});

describe('buildEngineConfig', () => {
  it('is the settings, the address with the key, the sound pipe and an automatic encoder', () => {
    expect(buildEngineConfig({ settings: { screen: 1, fps: 30, height: 720, kbps: 4500 }, key: KEY, test: false, audioPipe: PIPE, env: {} })).toEqual({
      url: `rtmps://live.twitch.tv:443/app/${KEY}`,
      screen: 1,
      fps: 30,
      height: 720,
      kbps: 4500,
      audioPipe: PIPE,
      encoder: 'auto',
    });
  });

  it('leaves out the pipe when there is none, and clamps what came from outside', () => {
    const config = buildEngineConfig({ settings: { screen: 40, fps: 240, height: 7, kbps: 1 }, key: KEY, test: true, env: {} });
    expect(config).toEqual({ url: `rtmps://live.twitch.tv:443/app/${KEY}?bandwidthtest=true`, screen: 7, fps: 60, height: 1080, kbps: 2500, encoder: 'auto' });
    expect('audioPipe' in config).toBe(false);
  });
});

describe('wantedEngine', () => {
  it('is native only when asked for by name', () => {
    for (const yes of ['native', 'NATIVE', ' Native ']) expect(wantedEngine(yes), yes).toBe('native');
    for (const no of ['ffmpeg', '', undefined, null, 'turbo', 'native2', 5]) expect(wantedEngine(no), String(no)).toBe('ffmpeg');
  });
});

describe('parseProbe', () => {
  const probe = (extra) => JSON.stringify({ version: '0.1.0', adapters: [{ name: 'GPU', vendor: 'nvidia', outputs: [{ index: 0, width: 2560, height: 1440, primary: true }] }], encoders: ['nvidia'], ...extra });

  it('reads the version, the cards and the encoders under the names the page knows', () => {
    const p = parseProbe(`${probe({ encoders: ['nvidia', 'amd', 'intel'] })}\n`);
    expect(p.version).toBe('0.1.0');
    expect(p.adapters).toHaveLength(1);
    expect(p.encoders).toEqual([
      { id: 'nvenc', tuning: 'quality' },
      { id: 'amf', tuning: 'quality' },
      { id: 'qsv', tuning: 'quality' },
    ]);
  });

  it('leaves out makers it does not know and repeats', () => {
    expect(parseProbe(probe({ encoders: ['other', 7, null, 'intel', 'intel'] })).encoders).toEqual([{ id: 'qsv', tuning: 'quality' }]);
    expect(parseProbe(probe({ encoders: [] })).encoders).toEqual([]);
  });

  it('takes a tuning when the probe gives one: on the encoder, per maker or for all', () => {
    expect(parseProbe(probe({ encoders: [{ id: 'nvidia', tuning: 'safe' }, { name: 'amd' }] })).encoders).toEqual([
      { id: 'nvenc', tuning: 'safe' },
      { id: 'amf', tuning: 'quality' },
    ]);
    expect(parseProbe(probe({ encoders: ['nvidia', 'amd'], tuning: { amd: 'safe' } })).encoders).toEqual([
      { id: 'nvenc', tuning: 'quality' },
      { id: 'amf', tuning: 'safe' },
    ]);
    expect(parseProbe(probe({ tuning: 'safe' })).encoders).toEqual([{ id: 'nvenc', tuning: 'safe' }]);
    expect(parseProbe(probe({ tuning: 'fast' })).encoders).toEqual([{ id: 'nvenc', tuning: 'quality' }]);
  });

  it('is null for anything that is not a probe', () => {
    for (const junk of ['', 'garbage', '{"version":"1"}', '{"encoders":"nvidia"}', 'null', '[]', '<html>', '{"encoders":["nvidia"]']) {
      expect(parseProbe(junk), junk).toBeNull();
    }
  });
});

describe('findEngine', () => {
  const SERVER = 'C:\\Apps\\Uncbox\\app\\server';
  const packaged = `${SERVER}\\uncbox-stream.exe`;
  const above = 'C:\\Apps\\Uncbox\\app\\uncbox-stream.exe';
  const built = 'C:\\Apps\\Uncbox\\app\\engine\\target\\release\\uncbox-stream.exe';
  /** A file system with only these files (and the folders named in `dirs`). */
  const fsWith = (files, dirs = []) => ({
    stat: vi.fn(async (p) => {
      if (files.includes(p)) return { isFile: () => true };
      if (dirs.includes(p)) return { isFile: () => false };
      throw new Error('ENOENT');
    }),
  });

  it('looks beside the server first (a packaged copy), then above it, then where npm run engine builds it', async () => {
    expect(await findEngine({ serverDir: SERVER, platform: 'win32', fs: fsWith([packaged, above, built]) })).toBe(packaged);
    expect(await findEngine({ serverDir: SERVER, platform: 'win32', fs: fsWith([above, built]) })).toBe(above);
    expect(await findEngine({ serverDir: SERVER, platform: 'win32', fs: fsWith([built]) })).toBe(built);
    const fs = fsWith([]);
    expect(await findEngine({ serverDir: SERVER, platform: 'win32', fs })).toBe('');
    expect(fs.stat.mock.calls.map(([p]) => p)).toEqual([packaged, above, built]);
  });

  it('does not count a folder with that name, and says nothing is there off Windows', async () => {
    expect(await findEngine({ serverDir: SERVER, platform: 'win32', fs: fsWith([built], [packaged]) })).toBe(built);
    expect(await findEngine({ serverDir: SERVER, platform: 'linux', fs: fsWith([packaged]) })).toBe('');
  });

  it('finds the engine of this checkout when it is built', async () => {
    // The real file system: a result is either nothing or a file called uncbox-stream.exe.
    const found = await findEngine();
    if (process.platform === 'win32' && found) expect(found.toLowerCase()).toMatch(/uncbox-stream\.exe$/);
    else expect(found).toBe('');
  });
});

describe('redact', () => {
  it('blanks the key wherever it appears', () => {
    const line = `[rtmps @ 0x1] Cannot open connection tcp://live.twitch.tv:443 for rtmps://live.twitch.tv:443/app/${KEY}`;
    expect(redact(line, KEY)).not.toContain(KEY);
    expect(redact(line, KEY)).toContain('live.twitch.tv:443/app/****');
    expect(redact(`${KEY} and ${KEY}`, KEY)).toBe('**** and ****');
  });

  it('blanks the encoded form and anything shaped like a key, even when the key is not known', () => {
    expect(redact('key live_55_abcdefghij12 end', '')).toBe('key live_**** end');
    expect(redact('a/b?k=a%2Fb', 'a/b')).toBe('****?k=****');
  });

  it('leaves other text alone', () => {
    expect(redact('Connection reset by peer', KEY)).toBe('Connection reset by peer');
  });
});

describe('buildFfmpegArgs', () => {
  const base = { settings: { screen: 0, fps: 60, height: 0, kbps: 6000 }, key: KEY, test: false, audioPipe: PIPE };

  it('captures with ddagrab, encodes with NVENC and sends FLV to Twitch', () => {
    const args = buildFfmpegArgs(base);
    expect(args.slice(0, 6)).toEqual(['-hide_banner', '-loglevel', 'warning', '-nostats', '-progress', 'pipe:1']);
    expect(args).toContain('-nostats');
    expect(args[args.indexOf('-i') + 1]).toBe('ddagrab=output_idx=0:framerate=60:draw_mouse=1');
    expect(valueAfter(args, '-c:v')).toBe('h264_nvenc');
    expect(valueAfter(args, '-preset')).toBe('p6');
    expect(valueAfter(args, '-tune')).toBe('hq');
    expect(valueAfter(args, '-multipass')).toBe('qres');
    expect(valueAfter(args, '-temporal-aq')).toBe('1');
    // Spatial AQ made the worst frames worse in VMAF tests; look-ahead 20 scored best.
    expect(args).not.toContain('-spatial-aq');
    expect(valueAfter(args, '-rc-lookahead')).toBe('20');
    expect(valueAfter(args, '-b_ref_mode')).toBe('middle');
    expect(valueAfter(args, '-rc')).toBe('cbr');
    expect(valueAfter(args, '-b:v')).toBe('6000k');
    expect(valueAfter(args, '-maxrate')).toBe('6000k');
    expect(valueAfter(args, '-bufsize')).toBe('12000k');
    expect(valueAfter(args, '-g')).toBe('120');
    expect(valueAfter(args, '-bf')).toBe('2');
    expect(valueAfter(args, '-profile:v')).toBe('high');
    expect(valueAfter(args, '-c:a')).toBe('aac');
    expect(valueAfter(args, '-b:a')).toBe('160k');
    expect(valueAfter(args, '-af')).toBe('aresample=async=1000');
    expect(valueAfter(args, '-flvflags')).toBe('no_duration_filesize');
    expect(args.slice(-3)).toEqual(['-f', 'flv', `rtmps://live.twitch.tv:443/app/${KEY}`]);
  });

  it('maps the screen and the sound, in that order', () => {
    const args = buildFfmpegArgs(base);
    const maps = args.flatMap((a, i) => (a === '-map' ? [args[i + 1]] : []));
    expect(maps).toEqual(['0:v', '1:a']);
  });

  it('reads the sound from the pipe as the contract says', () => {
    const args = buildFfmpegArgs(base);
    const at = args.lastIndexOf('-thread_queue_size');
    expect(args.slice(at, at + 10)).toEqual(['-thread_queue_size', '1024', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', PIPE]);
    expect(args.join(' ')).not.toContain('anullsrc');
  });

  it('uses silent sound without a pipe', () => {
    const args = buildFfmpegArgs({ ...base, audioPipe: '' });
    expect(args).toContain('anullsrc=channel_layout=stereo:sample_rate=48000');
    expect(args).not.toContain('f32le');
  });

  it('follows the settings: screen, frame rate, bitrate', () => {
    const args = buildFfmpegArgs({ ...base, settings: { screen: 2, fps: 30, height: 0, kbps: 3000 } });
    expect(args[args.indexOf('-i') + 1]).toBe('ddagrab=output_idx=2:framerate=30:draw_mouse=1');
    expect(valueAfter(args, '-b:v')).toBe('3000k');
    expect(valueAfter(args, '-bufsize')).toBe('6000k');
    expect(valueAfter(args, '-g')).toBe('60');
  });

  it('clamps settings that came from outside', () => {
    const args = buildFfmpegArgs({ ...base, settings: { screen: 40, fps: 240, height: 7, kbps: 1 } });
    expect(args[args.indexOf('-i') + 1]).toBe('ddagrab=output_idx=7:framerate=60:draw_mouse=1');
    expect(valueAfter(args, '-vf')).toBe(cpuScale(1080));
    expect(valueAfter(args, '-b:v')).toBe('2500k');
  });

  it('sends a steady frame rate, so viewers get exactly 60 and keyframes land exactly two seconds apart', () => {
    const args = buildFfmpegArgs(base);
    expect(valueAfter(args, '-fps_mode')).toBe('cfr');
    expect(valueAfter(args, '-r')).toBe('60');
    expect(args.indexOf('-fps_mode')).toBeLessThan(args.indexOf('-c:v'));
    expect(valueAfter(buildFfmpegArgs({ ...base, settings: { ...base.settings, fps: 30 } }), '-r')).toBe('30');
  });

  it('uses the safe encoder settings when the check found the card needs them', () => {
    const args = buildFfmpegArgs({ ...base, tuning: 'safe' });
    expect(valueAfter(args, '-preset')).toBe('p5');
    expect(args).not.toContain('-b_ref_mode');
    expect(valueAfter(args, '-b:v')).toBe('6000k');
  });

  it('keeps the capture alone in its input, with a short queue, so scaling can’t hold it up', () => {
    const args = buildFfmpegArgs({ ...base, settings: { ...base.settings, height: 1080 }, screenHeight: 1440, scaler: 'cuda' });
    const at = args.indexOf('-thread_queue_size');
    expect(args.slice(at, at + 6)).toEqual(['-thread_queue_size', '8', '-f', 'lavfi', '-i', 'ddagrab=output_idx=0:framerate=60:draw_mouse=1']);
    expect(args.indexOf('-vf')).toBeGreaterThan(args.lastIndexOf('-i'));
  });

  it('does not scale at the screen’s own size, or when the height is "the screen’s"', () => {
    expect(buildFfmpegArgs({ ...base, settings: { ...base.settings, height: 1080 }, screenHeight: 1080 })).not.toContain('-vf');
    expect(buildFfmpegArgs(base)).not.toContain('-vf');
  });

  it('scales on the processor when nothing quicker works, and hands the encoder NV12', () => {
    const args = buildFfmpegArgs({ ...base, settings: { ...base.settings, height: 720 }, screenHeight: 1440 });
    expect(valueAfter(args, '-vf')).toBe('hwdownload,format=bgra,scale=-2:720,format=nv12');
  });

  it('scales with CUDA on an NVIDIA card when the check saw that work', () => {
    const args = buildFfmpegArgs({ ...base, settings: { ...base.settings, height: 1080 }, screenHeight: 1440, scaler: 'cuda' });
    expect(valueAfter(args, '-vf')).toBe(cudaScale(1080));
    // No conversion on the processor in between: NVENC takes the scaled BGRA as it is.
    expect(cudaScale(1080)).toBe('hwdownload,format=bgra,hwupload_cuda,scale_cuda=w=trunc(iw*1080/ih/2)*2:h=1080:interp_algo=lanczos');
  });

  it('scales with Direct3D when that works, frames never leaving the card', () => {
    const args = buildFfmpegArgs({ ...base, settings: { ...base.settings, height: 720 }, screenHeight: 2160, scaler: 'd3d11' });
    expect(valueAfter(args, '-vf')).toBe(gpuScale(720));
    expect(gpuScale(720)).toBe('scale_d3d11=width=trunc(iw*720/ih/2)*2:height=720:format=nv12');
  });

  it('scales when the screen’s height is not known', () => {
    const args = buildFfmpegArgs({ ...base, settings: { ...base.settings, height: 1080 } });
    expect(valueAfter(args, '-vf')).toContain('scale');
  });

  it('streams with AMD’s encoder and scaler on an AMD card', () => {
    const args = buildFfmpegArgs({ ...base, settings: { ...base.settings, height: 1080 }, screenHeight: 1440, encoder: 'amf', scaler: 'amf' });
    expect(valueAfter(args, '-vf')).toBe(amfScale(1080));
    expect(valueAfter(args, '-c:v')).toBe('h264_amf');
    expect(valueAfter(args, '-rc')).toBe('cbr');
    expect(valueAfter(args, '-quality')).toBe('quality');
    expect(args).not.toContain('-tune');
  });

  it('hands frames to Intel Quick Sync even at the screen’s own size', () => {
    const own = buildFfmpegArgs({ ...base, encoder: 'qsv', scaler: 'qsv' });
    expect(valueAfter(own, '-vf')).toBe('hwmap=derive_device=qsv,format=qsv');
    expect(valueAfter(own, '-c:v')).toBe('h264_qsv');
    // When mapping didn't work (the screen is on another card), the frames are copied off instead.
    expect(valueAfter(buildFfmpegArgs({ ...base, encoder: 'qsv', scaler: 'cpu' }), '-vf')).toBe('hwdownload,format=bgra,format=nv12');
    const scaled = buildFfmpegArgs({ ...base, settings: { ...base.settings, height: 720 }, screenHeight: 1440, encoder: 'qsv', scaler: 'qsv' });
    expect(valueAfter(scaled, '-vf')).toBe(qsvScale(720));
  });

  it('gives every encoder the same rate control: CBR, a two-second buffer and a keyframe every two seconds', () => {
    for (const [id, tuning] of ENCODERS.flatMap((e) => [[e.id, 'quality'], [e.id, 'safe']])) {
      const args = encoderArgs(id, 4500, 30, tuning);
      expect(valueAfter(args, '-b:v'), id).toBe('4500k');
      expect(valueAfter(args, '-maxrate'), id).toBe('4500k');
      expect(valueAfter(args, '-bufsize'), id).toBe('9000k');
      expect(valueAfter(args, '-g'), id).toBe('60');
      expect(valueAfter(args, '-profile:v'), id).toBe('high');
    }
  });

  it('adds the bandwidth test only for a test stream', () => {
    expect(buildFfmpegArgs({ ...base, test: true }).at(-1)).toBe(`rtmps://live.twitch.tv:443/app/${KEY}?bandwidthtest=true`);
    expect(buildFfmpegArgs(base).at(-1)).not.toContain('bandwidthtest');
  });
});

describe('parseProgress', () => {
  // What `-progress pipe:1` prints: a block every half second.
  const block = (frame, extra = {}) =>
    Object.entries({
      frame,
      fps: '59.94',
      'stream_0_0_q': '24.0',
      bitrate: '5876.3kbits/s',
      total_size: 3145728,
      out_time_us: 4433333,
      out_time_ms: 4433333,
      out_time: '00:00:04.433333',
      dup_frames: 0,
      drop_frames: 2,
      speed: '0.998x',
      progress: 'continue',
      ...extra,
    })
      .map(([k, v]) => `${k}=${v}\n`)
      .join('');

  it('turns a block into the numbers the page shows', () => {
    expect(parseProgress(block(295))).toEqual({ fps: 59.9, kbps: 5876, dropped: 2, frames: 295, speed: 1 });
  });

  it('treats N/A as zero, as FFmpeg prints at the very start', () => {
    expect(parseProgress(block(0, { bitrate: 'N/A', speed: 'N/A', fps: '0.00' }))).toEqual({ fps: 0, kbps: 0, dropped: 2, frames: 0, speed: 0 });
  });

  it('takes the last of several blocks in one chunk', () => {
    expect(parseProgress(block(100) + block(160))?.frames).toBe(160);
  });

  it('says nothing until a block is complete, and copes with chunks cut anywhere', () => {
    const parser = createProgressParser();
    const text = block(10) + block(20);
    const seen = [];
    for (let i = 0; i < text.length; i += 7) {
      const stats = parser.push(text.slice(i, i + 7));
      if (stats) seen.push(stats.frames);
    }
    expect(seen).toEqual([10, 20]);
    expect(parseProgress('frame=3\nfps=1\n')).toBeNull();
  });

  it('reads Windows line endings', () => {
    expect(parseProgress(block(7).replace(/\n/g, '\r\n'))?.frames).toBe(7);
  });

  it('ignores lines that are not key=value', () => {
    expect(parseProgress(`hello\n${block(5)}`)?.frames).toBe(5);
  });
});

describe('reading FFmpeg’s other output', () => {
  it('finds the screen’s size', () => {
    const text = '  Stream #0:0: Video: wrapped_avframe, bgra, 2560x1440 [SAR 1:1 DAR 16:9], 30 fps, 30 tbr, 1000k tbn';
    expect(parseScreenSize(text)).toEqual({ width: 2560, height: 1440 });
    expect(parseScreenSize('nothing here')).toBeNull();
  });

  it('finds an encoder or a filter in the list', () => {
    const encoders = ' V....D av1_nvenc            NVIDIA NVENC av1 encoder\n V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)\n';
    expect(listsName(encoders, 'h264_nvenc')).toBe(true);
    expect(listsName(encoders, 'hevc_nvenc')).toBe(false);
    const filters = ' .. hwdownload        V->V       Download a hardware frame\n ... ddagrab           |->V       Grab Windows Desktop images\n';
    expect(listsName(filters, 'ddagrab')).toBe(true);
    expect(listsName(filters, 'scale_d3d11')).toBe(false);
  });
});

describe('the audio pipe name', () => {
  it('takes only the names the shell makes', () => {
    expect(PIPE_SHAPE.test(PIPE)).toBe(true);
    expect(PIPE_SHAPE.test('\\\\.\\pipe\\uncbox-stream-audio-1a2b3c4d5e6f7a8b1a2b3c4d5e6f7a8b')).toBe(true);
    for (const bad of ['\\\\.\\pipe\\other', '\\\\.\\pipe\\uncbox-stream-audio-xyz', 'C:\\x.raw', '\\\\.\\pipe\\uncbox-stream-audio-1a2b3c4d -f flv x', '\\\\.\\pipe\\uncbox-stream-audio-1a2b3c', '']) {
      expect(PIPE_SHAPE.test(bad), bad).toBe(false);
    }
  });
});

// ---- the feature, with a fake FFmpeg ----

/** What a program run through the fake spawn is. */
const kindOf = (args) => (args.includes('-progress') ? 'stream' : args.includes('-version') ? 'version' : args.includes('-encoders') ? 'encoders' : args.includes('-filters') ? 'filters' : 'probe');

/**
 * `built` are the encoders compiled into this FFmpeg and `cards` the ones the PC can run (`safeOnly`
 * of them refuse the quality settings, like an old card); `filters`
 * are the scaling filters it lists and `scales` the ones that work on captured frames.
 */
function fakeFfmpeg({ built = ['nvenc', 'amf', 'qsv'], cards = ['nvenc'], safeOnly = [], ddagrab = true, filters = [], scales = [], screenHeight = 1080 } = {}) {
  const runs = [];
  const streams = [];
  const codec = (id) => ENCODERS.find((e) => e.id === id).codec;
  const spawn = vi.fn((file, args) => {
    const proc = new EventEmitter();
    proc.pid = 4321;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = Object.assign(new EventEmitter(), { written: [], write: (text) => void proc.stdin.written.push(text) });
    proc.kill = vi.fn(() => queueMicrotask(() => proc.emit('close', null)));
    const kind = kindOf(args);
    runs.push({ file, args, kind });
    if (kind === 'stream') {
      streams.push(proc);
      return proc;
    }
    queueMicrotask(() => {
      if (kind === 'version') proc.stdout.emit('data', 'ffmpeg version 8.1.2-full_build Copyright (c) 2000-2026\n');
      if (kind === 'encoders') proc.stdout.emit('data', [' V....D libx264              x264', ...built.map((id) => ` V....D ${codec(id)}           a graphics card's H.264 encoder`)].join('\n') + '\n');
      if (kind === 'filters') {
        const listed = [ddagrab && 'ddagrab', 'scale', 'hwdownload', ...filters].filter(Boolean);
        proc.stdout.emit('data', listed.map((name) => ` ... ${name}           V->V       a filter`).join('\n') + '\n');
      }
      let code = 0;
      const line = args.join(' ');
      if (kind === 'probe') {
        const card = cards.find((id) => args.includes(codec(id)));
        // The plain one-frame probe works on any card; the stream's quality settings not on an old one.
        if (line.includes('color=black')) code = card && !(line.includes('-frames:v 5') && safeOnly.includes(card)) ? 0 : 1;
        else if (line.includes('-frames:v 2')) code = scales.some((name) => line.includes(name)) ? 0 : 1;
        else proc.stderr.emit('data', `  Stream #0:0: Video: wrapped_avframe, bgra, ${Math.round((screenHeight * 16) / 9)}x${screenHeight} [SAR 1:1 DAR 16:9], 30 fps\n`);
      }
      proc.emit('close', code);
    });
    return proc;
  });
  return { spawn, runs, streams, last: () => streams.at(-1) };
}

const NATIVE_EXE = 'C:\\Uncbox\\engine\\target\\release\\uncbox-stream.exe';
const PROBE = {
  version: '0.1.0',
  adapters: [{ name: 'NVIDIA GeForce RTX', vendor: 'nvidia', outputs: [{ index: 0, width: 2560, height: 1440, primary: true }] }],
  encoders: ['nvidia'],
};

/**
 * Uncbox's own engine, as the contract in engine/README.md has it: `probe` prints one line of JSON
 * (`probe`, or `probeText` for something that isn't, ending with `probeCode`) and `run` reads its
 * settings from stdin. `hold` keeps the probe from answering until release().
 */
function fakeNative({ probe = PROBE, probeText, probeCode = 0, hold = false } = {}) {
  const runs = [];
  const streams = [];
  const held = [];
  const spawn = vi.fn((file, args) => {
    const proc = new EventEmitter();
    proc.pid = 8765;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = Object.assign(new EventEmitter(), { written: [], write: (text) => void proc.stdin.written.push(text) });
    proc.kill = vi.fn(() => queueMicrotask(() => proc.emit('close', null)));
    runs.push({ file, args, kind: args[0] });
    if (args[0] === 'run') {
      streams.push(proc);
      return proc;
    }
    const answer = () => {
      const text = probeText ?? (probe ? `${JSON.stringify(probe)}\n` : '');
      if (text) proc.stdout.emit('data', text);
      proc.emit('close', probeCode);
    };
    if (hold) held.push(answer);
    else queueMicrotask(answer);
    return proc;
  });
  return { spawn, runs, streams, last: () => streams.at(-1), release: () => held.splice(0).forEach((answer) => answer()) };
}

const PROGRESS = (frame) => `frame=${frame}\nfps=59.9\nbitrate=5876.3kbits/s\ndrop_frames=1\nspeed=1.0x\nprogress=continue\n`;
const tick = () => new Promise((resolve) => setImmediate(resolve));
/** Waits (two seconds at most) for something that happens without being awaited, like a file being written. */
async function until(ok) {
  for (let i = 0; i < 200 && !(await ok()); i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

/** One request through the stream's handler (made by make() below, which wires up stream.call). */
const call = (stream, method, pathname, body, local = true) => stream.call(method, pathname, body, local);

describe('the stream', () => {
  let dir;
  let events;
  let clock;
  let timers;
  let ffmpeg;
  let native;
  let twitch;
  let priority;
  let consoleLines;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'uncbox-stream-'));
    events = [];
    clock = 1_000_000;
    timers = [];
    ffmpeg = fakeFfmpeg();
    native = fakeNative();
    consoleLines = [];
    // Not signed in to Twitch unless a test says so.
    twitch = { streamKey: vi.fn(async () => Promise.reject(Object.assign(new Error('Sign in to Twitch first.'), { status: 401, code: 'not-signed-in' }))) };
    priority = [];
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  function make(over = {}) {
    let reply = () => {};
    let from = { body: {}, local: true };
    const stream = createStream({
      broadcastEvent: (name, data) => events.push([name, data]),
      sendJson: (_res, status, body) => reply({ status, body }),
      isLocal: () => from.local,
      readJson: async () => from.body ?? {},
      dataDir: dir,
      twitch,
      // One spawn for both programs, as the real one is: which one it is is told by the file.
      spawn: (file, args, options) => (file === NATIVE_EXE ? native.spawn(file, args, options) : ffmpeg.spawn(file, args, options)),
      findFfmpeg: async () => 'C:\\Tools\\ffmpeg.exe',
      findNative: async () => NATIVE_EXE,
      // FFmpeg unless a test asks for the engine.
      env: {},
      log: (line) => consoleLines.push(line),
      raisePriority: (pid) => priority.push(pid),
      now: () => clock,
      setTimer: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        if (t) t.cleared = true;
      },
      ...over,
    });
    stream.call = (method, pathname, body, local) =>
      new Promise((resolve) => {
        reply = resolve;
        from = { body, local };
        void stream({ method, socket: {} }, {}, new URL(pathname, 'http://localhost'));
      });
    return stream;
  }

  const pendingTimer = (ms) => timers.find((t) => t.ms === ms && !t.cleared);
  const last = () => events.at(-1)[1];

  it('starts off, with no key and nothing checked', async () => {
    const stream = make();
    expect(await stream.snapshot()).toEqual({
      state: 'off',
      test: false,
      startedAt: null,
      stats: null,
      error: '',
      key: { set: false, hint: '', source: null },
      tools: { ffmpeg: false, version: '', encoder: null, tuning: null, scaler: null, ddagrab: null, engine: 'ffmpeg' },
    });
  });

  describe('the key', () => {
    it('keeps a pasted key in the data folder and tells the page only its last four characters', async () => {
      const stream = make();
      const res = await call(stream, 'POST', '/api/stream/key', { key: `  ${KEY}  ` });
      expect(res.status).toBe(200);
      expect(res.body.key).toEqual({ set: true, hint: 'QrSt', source: 'pasted' });
      expect(JSON.stringify(res.body)).not.toContain(KEY);
      expect(JSON.parse(await readFile(path.join(dir, 'stream.json'), 'utf8'))).toEqual({ key: KEY, source: 'pasted' });
      // Pushed to the page too, without the key.
      expect(JSON.stringify(events)).not.toContain(KEY);
      expect(last().key.set).toBe(true);
    });

    it('is remembered by the next run of the server', async () => {
      await call(make(), 'POST', '/api/stream/key', { key: KEY });
      const again = await call(make(), 'GET', '/api/stream');
      expect(again.body.key).toEqual({ set: true, hint: 'QrSt', source: 'pasted' });
    });

    it('forgets the key when given an empty one', async () => {
      const stream = make();
      await call(stream, 'POST', '/api/stream/key', { key: KEY });
      const res = await call(stream, 'POST', '/api/stream/key', { key: '' });
      expect(res.body.key).toEqual({ set: false, hint: '', source: null });
      expect(JSON.parse(await readFile(path.join(dir, 'stream.json'), 'utf8'))).toEqual({ forgotten: true });
    });

    it('turns away anything that is not shaped like a Twitch key', async () => {
      const stream = make();
      for (const bad of ['hello', 'live_abc_defghijklmnop', 'live_123_short', `${KEY} extra`, 'rtmps://live.twitch.tv/app/' + KEY, 42]) {
        const res = await call(stream, 'POST', '/api/stream/key', { key: bad });
        expect(res.status, String(bad)).toBe(400);
        expect(res.body.error).toMatch(/stream key/);
      }
      expect((await stream.snapshot()).key.set).toBe(false);
    });

    it('can be read from the Twitch sign-in, and says where it came from', async () => {
      twitch.streamKey.mockResolvedValue(KEY);
      const stream = make();
      const res = await call(stream, 'POST', '/api/stream/key/twitch');
      expect(res.status).toBe(200);
      expect(res.body.key).toEqual({ set: true, hint: 'QrSt', source: 'twitch' });
      expect(JSON.parse(await readFile(path.join(dir, 'stream.json'), 'utf8'))).toEqual({ key: KEY, source: 'twitch' });
    });

    it('passes on that the Twitch sign-in needs doing again', async () => {
      twitch.streamKey.mockRejectedValue(Object.assign(new Error('Sign in to Twitch again so Uncbox can read your stream key.'), { status: 409, code: 'needs-signin' }));
      const res = await call(make(), 'POST', '/api/stream/key/twitch');
      expect(res).toMatchObject({ status: 409, body: { code: 'needs-signin' } });
    });

    it('does not take a key from Twitch that is the wrong shape', async () => {
      twitch.streamKey.mockResolvedValue('nonsense');
      expect((await call(make(), 'POST', '/api/stream/key/twitch')).status).toBe(502);
    });

    it('cannot be changed while streaming', async () => {
      const stream = await liveStream();
      expect((await call(stream, 'POST', '/api/stream/key', { key: '' })).status).toBe(409);
      expect((await call(stream, 'POST', '/api/stream/key/twitch')).status).toBe(409);
    });

    it('comes from the Twitch sign-in by itself when there is none yet, so signing in is all the setup', async () => {
      twitch.streamKey.mockResolvedValue(KEY);
      const stream = make();
      await call(stream, 'POST', '/api/stream/check');
      // The check doesn't wait for it; the page hears when it is saved.
      await until(() => last()?.key.set);
      expect(last().key).toEqual({ set: true, hint: 'QrSt', source: 'twitch' });
      expect((await stream.snapshot()).key).toEqual({ set: true, hint: 'QrSt', source: 'twitch' });
      // And going live takes it too, without the Streaming section having been opened.
      await rm(path.join(dir, 'stream.json'));
      const fresh = make();
      const res = await call(fresh, 'POST', '/api/stream/start', {});
      expect(res.status).toBe(200);
      expect(ffmpeg.last()).toBeDefined();
    });

    it('stays forgotten: the sign-in doesn’t hand it back, now or after a restart, until one is asked for', async () => {
      twitch.streamKey.mockResolvedValue(KEY);
      const stream = make();
      await call(stream, 'POST', '/api/stream/key/twitch');
      await call(stream, 'POST', '/api/stream/key', { key: '' });
      await call(stream, 'POST', '/api/stream/check', { force: true });
      await tick();
      expect((await stream.snapshot()).key.set).toBe(false);
      const restarted = make();
      expect((await call(restarted, 'POST', '/api/stream/start', {})).body.error).toMatch(/stream key/);
      expect((await restarted.snapshot()).key.set).toBe(false);
      expect(ffmpeg.streams).toHaveLength(0);
      // Asking for it again is fine.
      expect((await call(restarted, 'POST', '/api/stream/key/twitch')).body.key).toEqual({ set: true, hint: 'QrSt', source: 'twitch' });
    });

    it('is read from the file once, so a slow first read can’t undo a key saved meanwhile', async () => {
      const stream = make();
      const first = stream.snapshot();
      await call(stream, 'POST', '/api/stream/key', { key: KEY });
      await first;
      expect((await stream.snapshot()).key).toEqual({ set: true, hint: 'QrSt', source: 'pasted' });
    });

    it('is not swapped for the sign-in’s when one is already set', async () => {
      twitch.streamKey.mockResolvedValue('live_987654321_ZyXwVuTsRqPoNmLkJiHg');
      const stream = make();
      await call(stream, 'POST', '/api/stream/key', { key: KEY });
      await call(stream, 'POST', '/api/stream/check');
      expect((await stream.snapshot()).key).toEqual({ set: true, hint: 'QrSt', source: 'pasted' });
      expect(twitch.streamKey).not.toHaveBeenCalled();
    });

    it('is written so only this user can read it', async () => {
      await call(make(), 'POST', '/api/stream/key', { key: KEY });
      if (process.platform !== 'win32') expect((await stat(path.join(dir, 'stream.json'))).mode & 0o077).toBe(0);
    });
  });

  describe('checking', () => {
    it('finds FFmpeg, NVENC and ddagrab, and scales on the processor when nothing quicker works', async () => {
      const stream = make();
      const res = await call(stream, 'POST', '/api/stream/check');
      expect(res.body.tools).toEqual({ ffmpeg: true, version: '8.1.2-full_build', encoder: 'nvenc', tuning: 'quality', scaler: 'cpu', ddagrab: true, engine: 'ffmpeg' });
      // The one-frame NVENC probe from the ticket, then a few frames with the stream's own settings.
      const probes = ffmpeg.runs.filter((r) => r.args.join(' ').includes('color=black')).map((r) => r.args.join(' '));
      expect(probes[0]).toBe('-hide_banner -f lavfi -i color=black:s=256x256:r=30 -frames:v 1 -c:v h264_nvenc -f null -');
      expect(probes[1]).toContain(encoderArgs('nvenc', 2500, 30, 'quality').join(' '));
    });

    it('takes the first encoder the card can run: NVIDIA, then AMD, then Intel', async () => {
      ffmpeg = fakeFfmpeg({ cards: ['amf', 'qsv'] });
      expect((await call(make(), 'POST', '/api/stream/check')).body.tools.encoder).toBe('amf');
      ffmpeg = fakeFfmpeg({ cards: ['qsv'] });
      expect((await call(make(), 'POST', '/api/stream/check')).body.tools.encoder).toBe('qsv');
      // An encoder this FFmpeg wasn't built with isn't tried at all.
      ffmpeg = fakeFfmpeg({ built: ['qsv'], cards: ['nvenc', 'qsv'] });
      expect((await call(make(), 'POST', '/api/stream/check')).body.tools.encoder).toBe('qsv');
      expect(ffmpeg.runs.some((r) => r.args.includes('h264_nvenc'))).toBe(false);
    });

    it('picks the quickest scaling that works on captured frames with the stream’s own encoder settings', async () => {
      // scale_d3d11 is listed but fails (as with FFmpeg 8.1), so CUDA it is.
      ffmpeg = fakeFfmpeg({ filters: ['scale_d3d11', 'scale_cuda'], scales: ['scale_cuda'] });
      expect((await call(make(), 'POST', '/api/stream/check')).body.tools.scaler).toBe('cuda');
      const tried = ffmpeg.runs.filter((r) => r.args.join(' ').includes('-frames:v 2')).map((r) => r.args);
      expect(tried).toHaveLength(2);
      expect(tried[0][tried[0].indexOf('-i') + 1]).toBe(`ddagrab=output_idx=0:framerate=30,${gpuScale(720)}`);
      expect(tried[1].join(' ')).toContain(encoderArgs('nvenc', 2500, 30).join(' '));
      ffmpeg = fakeFfmpeg({ filters: ['scale_d3d11', 'scale_cuda'], scales: ['scale_d3d11', 'scale_cuda'] });
      expect((await call(make(), 'POST', '/api/stream/check')).body.tools.scaler).toBe('d3d11');
      // AMD's own scaler on an AMD card.
      ffmpeg = fakeFfmpeg({ cards: ['amf'], filters: ['vpp_amf', 'scale_cuda'], scales: ['vpp_amf', 'scale_cuda'] });
      expect((await call(make(), 'POST', '/api/stream/check')).body.tools).toMatchObject({ encoder: 'amf', scaler: 'amf' });
    });

    it('keeps the answer instead of asking FFmpeg again', async () => {
      const stream = make();
      await call(stream, 'POST', '/api/stream/check');
      const before = ffmpeg.spawn.mock.calls.length;
      await call(stream, 'POST', '/api/stream/check');
      expect(ffmpeg.spawn.mock.calls.length).toBe(before);
      await call(stream, 'POST', '/api/stream/check', { force: true });
      expect(ffmpeg.spawn.mock.calls.length).toBeGreaterThan(before);
    });

    it('says when FFmpeg is missing, and looks again next time', async () => {
      let path = '';
      const stream = make({ findFfmpeg: async () => path });
      expect((await call(stream, 'POST', '/api/stream/check')).body.tools).toEqual({ ffmpeg: false, version: '', encoder: null, tuning: null, scaler: null, ddagrab: null, engine: 'ffmpeg' });
      path = 'C:\\Tools\\ffmpeg.exe';
      expect((await call(stream, 'POST', '/api/stream/check')).body.tools.ffmpeg).toBe(true);
    });

    it('falls back to the safe settings on a card that refuses the quality ones, and scales with those', async () => {
      ffmpeg = fakeFfmpeg({ safeOnly: ['nvenc'], filters: ['scale_cuda'], scales: ['scale_cuda'] });
      expect((await call(make(), 'POST', '/api/stream/check')).body.tools).toMatchObject({ encoder: 'nvenc', tuning: 'safe', scaler: 'cuda' });
      const scaleProbe = ffmpeg.runs.find((r) => r.args.join(' ').includes('-frames:v 2'));
      expect(scaleProbe.args.join(' ')).toContain(encoderArgs('nvenc', 2500, 30, 'safe').join(' '));
    });

    it('does not wait on Twitch, so a slow sign-in can’t hold up the check', async () => {
      twitch.streamKey.mockImplementation(() => new Promise(() => {}));
      const res = await call(make(), 'POST', '/api/stream/check');
      expect(res.status).toBe(200);
      expect(res.body.tools.encoder).toBe('nvenc');
    });

    it('says when there is no encoder this PC can run', async () => {
      ffmpeg = fakeFfmpeg({ cards: [] });
      expect((await call(make(), 'POST', '/api/stream/check')).body.tools).toMatchObject({ ffmpeg: true, encoder: '', scaler: null });
    });

    it('says when this FFmpeg cannot capture the screen', async () => {
      ffmpeg = fakeFfmpeg({ ddagrab: false });
      expect((await call(make(), 'POST', '/api/stream/check')).body.tools).toMatchObject({ ddagrab: false });
    });

    it('is told to the page', async () => {
      await call(make(), 'POST', '/api/stream/check');
      expect(last().tools.encoder).toBe('nvenc');
    });
  });

  /** A stream that has been started and has frames going out. */
  async function liveStream(body = {}, make_ = make) {
    const stream = make_();
    await call(stream, 'POST', '/api/stream/key', { key: KEY });
    const res = await call(stream, 'POST', '/api/stream/start', { settings: { screen: 0, fps: 60, height: 1080, kbps: 6000 }, ...body });
    expect(res.status).toBe(200);
    // The first frames, from whichever program is streaming.
    ((await stream.snapshot()).tools.engine === 'native' ? native : ffmpeg).last().stdout.emit('data', PROGRESS(30));
    await tick();
    return stream;
  }

  describe('starting', () => {
    it('needs a key', async () => {
      const res = await call(make(), 'POST', '/api/stream/start', {});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/stream key/);
      expect(ffmpeg.streams).toHaveLength(0);
    });

    it('needs FFmpeg, and points at the Downloads widget', async () => {
      const stream = make({ findFfmpeg: async () => '' });
      await call(stream, 'POST', '/api/stream/key', { key: KEY });
      const res = await call(stream, 'POST', '/api/stream/start', {});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/FFmpeg isn’t installed.*Downloads widget/);
    });

    it('refuses with plain words when there is no encoder or no ddagrab', async () => {
      ffmpeg = fakeFfmpeg({ cards: [] });
      let stream = make();
      await call(stream, 'POST', '/api/stream/key', { key: KEY });
      expect((await call(stream, 'POST', '/api/stream/start', {})).body.error).toMatch(/graphics card \(NVIDIA, AMD or Intel\)/);
      ffmpeg = fakeFfmpeg({ ddagrab: false });
      stream = make();
      expect((await call(stream, 'POST', '/api/stream/start', {})).body.error).toMatch(/capture the screen/);
    });

    it('refuses an audio pipe that is not one of Uncbox’s', async () => {
      const stream = make();
      await call(stream, 'POST', '/api/stream/key', { key: KEY });
      const res = await call(stream, 'POST', '/api/stream/start', { audioPipe: '\\\\.\\pipe\\something-else' });
      expect(res.status).toBe(400);
      expect(ffmpeg.streams).toHaveLength(0);
    });

    it('runs FFmpeg with the arguments for the settings, the pipe and the key, and is "starting" until frames arrive', async () => {
      const stream = make();
      await call(stream, 'POST', '/api/stream/key', { key: KEY });
      const res = await call(stream, 'POST', '/api/stream/start', { audioPipe: PIPE, settings: { screen: 1, fps: 30, height: 720, kbps: 4500 } });
      expect(res.body.state).toBe('starting');
      const run = ffmpeg.runs.findLast((r) => r.kind === 'stream');
      expect(run.file).toBe('C:\\Tools\\ffmpeg.exe');
      expect(run.args).toEqual(buildFfmpegArgs({ settings: { screen: 1, fps: 30, height: 720, kbps: 4500 }, key: KEY, audioPipe: PIPE, encoder: 'nvenc', scaler: 'cpu', screenHeight: 1080 }));
      expect(run.args).toContain(PIPE);
      expect(run.args.at(-1)).toBe(ingestUrl(KEY, false));
    });

    it('runs FFmpeg above normal priority, so a busy game can’t starve the stream', async () => {
      await liveStream();
      expect(priority).toEqual([4321]);
    });

    it('still streams when the priority can’t be raised', async () => {
      const stream = await liveStream({}, () =>
        make({
          raisePriority: () => {
            throw new Error('EACCES');
          },
        }),
      );
      expect((await stream.snapshot()).state).toBe('live');
    });

    it('streams with the encoder and scaling the check found', async () => {
      ffmpeg = fakeFfmpeg({ cards: ['amf'], filters: ['vpp_amf'], scales: ['vpp_amf'], screenHeight: 1440 });
      await liveStream({ settings: { height: 1080 } });
      const args = ffmpeg.runs.findLast((r) => r.kind === 'stream').args;
      expect(valueAfter(args, '-c:v')).toBe('h264_amf');
      expect(valueAfter(args, '-vf')).toBe(amfScale(1080));
    });

    it('goes live on the first frames, with the stats', async () => {
      const stream = await liveStream();
      const snap = await stream.snapshot();
      expect(snap).toMatchObject({ state: 'live', test: false, startedAt: clock, stats: { fps: 59.9, kbps: 5876, dropped: 1, frames: 30, speed: 1 }, error: '' });
    });

    it('stays "starting" while FFmpeg reports no frames yet', async () => {
      const stream = make();
      await call(stream, 'POST', '/api/stream/key', { key: KEY });
      await call(stream, 'POST', '/api/stream/start', {});
      ffmpeg.last().stdout.emit('data', 'frame=0\nfps=0.00\nbitrate=N/A\ndrop_frames=0\nspeed=N/A\nprogress=continue\n');
      await tick();
      expect((await stream.snapshot()).state).toBe('starting');
    });

    it('makes a test stream a bandwidth test', async () => {
      const stream = await liveStream({ test: true });
      expect((await stream.snapshot()).test).toBe(true);
      expect(ffmpeg.runs.findLast((r) => r.kind === 'stream').args.at(-1)).toBe(ingestUrl(KEY, true));
    });

    it('uses silent sound without a pipe', async () => {
      await liveStream();
      expect(ffmpeg.runs.findLast((r) => r.kind === 'stream').args).toContain('anullsrc=channel_layout=stereo:sample_rate=48000');
    });

    it('does not scale a screen that is already the chosen height, and scales one that is not', async () => {
      await liveStream({ settings: { height: 1080 } });
      expect(ffmpeg.runs.findLast((r) => r.kind === 'stream').args).not.toContain('-vf');
      ffmpeg = fakeFfmpeg({ screenHeight: 1440 });
      await liveStream({ settings: { height: 1080 } });
      const args = ffmpeg.runs.findLast((r) => r.kind === 'stream').args;
      expect(valueAfter(args, '-vf')).toContain('scale=-2:1080');
    });

    it('scales on the graphics card only when the check saw that work', async () => {
      ffmpeg = fakeFfmpeg({ screenHeight: 1440, filters: ['scale_d3d11'], scales: ['scale_d3d11'] });
      await liveStream({ settings: { height: 720 } });
      let args = ffmpeg.runs.findLast((r) => r.kind === 'stream').args;
      expect(valueAfter(args, '-vf')).toContain('scale_d3d11');
      ffmpeg = fakeFfmpeg({ screenHeight: 1440, filters: ['scale_d3d11'], scales: [] });
      await liveStream({ settings: { height: 720 } });
      args = ffmpeg.runs.findLast((r) => r.kind === 'stream').args;
      expect(valueAfter(args, '-vf')).toContain('hwdownload');
    });

    it('does not start twice, even when the second Go live comes while the first waits for the key from Twitch', async () => {
      let answer;
      twitch.streamKey.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
      const stream = make();
      const first = call(stream, 'POST', '/api/stream/start', {});
      await until(() => answer);
      // A second Go live (another window, or the palette) while the first waits on Twitch.
      await expect(stream.start({})).rejects.toMatchObject({ status: 409 });
      answer(KEY);
      expect((await first).status).toBe(200);
      expect(ffmpeg.streams).toHaveLength(1);
    });

    it('does not start twice', async () => {
      const stream = await liveStream();
      const again = await call(stream, 'POST', '/api/stream/start', {});
      expect(again.status).toBe(409);
      expect(ffmpeg.streams).toHaveLength(1);
    });

    it('reports it when FFmpeg cannot be run at all', async () => {
      const stream = make();
      await call(stream, 'POST', '/api/stream/key', { key: KEY });
      await call(stream, 'POST', '/api/stream/start', {});
      ffmpeg.last().emit('error', new Error('spawn ENOENT'));
      await tick();
      expect(await stream.snapshot()).toMatchObject({ state: 'error', error: 'Couldn’t start the stream.' });
    });
  });

  describe('keeping the key out of everything', () => {
    it('blanks the key in what FFmpeg prints, whatever the chunking', async () => {
      const stream = await liveStream();
      const proc = ffmpeg.last();
      proc.stderr.emit('data', `[tls @ 0x1] Connection to rtmps://live.twitch.tv:443/app/${KEY.slice(0, 20)}`);
      proc.stderr.emit('data', `${KEY.slice(20)} failed\nConnection to ${KEY} reset by peer\n`);
      await tick();
      const snap = await stream.snapshot();
      expect(snap.error).toBe('Connection to **** reset by peer');
      expect(JSON.stringify(snap)).not.toContain(KEY);
      expect(JSON.stringify(events)).not.toContain(KEY);
    });

    it('never puts the key in a status, even when the stream drops with it in the last line', async () => {
      const stream = await liveStream();
      ffmpeg.last().stderr.emit('data', `Error opening output rtmps://live.twitch.tv:443/app/${KEY}\n`);
      ffmpeg.last().emit('close', 1);
      await tick();
      const snap = await stream.snapshot();
      expect(snap.state).toBe('dropped');
      expect(snap.error).toBe('Error opening output rtmps://live.twitch.tv:443/app/****');
      expect(JSON.stringify(events)).not.toContain(KEY);
    });
  });

  describe('dropping', () => {
    it('is "dropped" with the last line FFmpeg printed when it exits by itself', async () => {
      const stream = await liveStream();
      ffmpeg.last().stderr.emit('data', 'Warning: something\nConnection reset by peer\n');
      ffmpeg.last().emit('close', 1);
      await tick();
      expect(await stream.snapshot()).toMatchObject({ state: 'dropped', error: 'Connection reset by peer' });
      expect(last().state).toBe('dropped');
    });

    it('gives a plain line when FFmpeg said nothing', async () => {
      const stream = make();
      await call(stream, 'POST', '/api/stream/key', { key: KEY });
      await call(stream, 'POST', '/api/stream/start', {});
      ffmpeg.last().emit('close', 3);
      await tick();
      expect((await stream.snapshot()).error).toBe('The stream stopped (code 3).');
    });

    it('drops while still starting, too', async () => {
      const stream = make();
      await call(stream, 'POST', '/api/stream/key', { key: KEY });
      await call(stream, 'POST', '/api/stream/start', {});
      ffmpeg.last().emit('close', 1);
      await tick();
      expect((await stream.snapshot()).state).toBe('dropped');
    });

    it('can be started again after a drop (the page does that)', async () => {
      const stream = await liveStream();
      ffmpeg.last().emit('close', 1);
      await tick();
      const res = await call(stream, 'POST', '/api/stream/start', { audioPipe: PIPE });
      expect(res.status).toBe(200);
      expect(ffmpeg.streams).toHaveLength(2);
      expect(res.body).toMatchObject({ state: 'starting', error: '' });
    });

    it('is cleared by a stop', async () => {
      const stream = await liveStream();
      ffmpeg.last().emit('close', 1);
      await tick();
      const res = await call(stream, 'POST', '/api/stream/stop');
      expect(res.body).toMatchObject({ state: 'off', error: '' });
    });
  });

  describe('stopping', () => {
    it('asks FFmpeg to finish with q, and is off once it has', async () => {
      const stream = await liveStream();
      const proc = ffmpeg.last();
      const res = await call(stream, 'POST', '/api/stream/stop');
      expect(res.body.state).toBe('stopping');
      expect(proc.stdin.written).toEqual(['q\n']);
      expect(proc.kill).not.toHaveBeenCalled();
      proc.emit('close', 0);
      await tick();
      expect(await stream.snapshot()).toMatchObject({ state: 'off', startedAt: null, stats: null, error: '' });
      expect(pendingTimer(5000)).toBeUndefined();
    });

    it('kills FFmpeg after five seconds if it will not finish', async () => {
      const stream = await liveStream();
      const proc = ffmpeg.last();
      await call(stream, 'POST', '/api/stream/stop');
      pendingTimer(5000).fn();
      expect(proc.kill).toHaveBeenCalled();
      await tick();
      expect((await stream.snapshot()).state).toBe('off');
    });

    it('is fine to stop when nothing is running', async () => {
      const res = await call(make(), 'POST', '/api/stream/stop');
      expect(res).toMatchObject({ status: 200, body: { state: 'off' } });
    });

    it('can start again right after', async () => {
      const stream = await liveStream();
      await call(stream, 'POST', '/api/stream/stop');
      ffmpeg.last().emit('close', 0);
      await tick();
      expect((await call(stream, 'POST', '/api/stream/start', {})).status).toBe(200);
    });

    it('kills FFmpeg when the server shuts down, without announcing it', async () => {
      const stream = await liveStream();
      const proc = ffmpeg.last();
      const sent = events.length;
      stream.close();
      expect(proc.kill).toHaveBeenCalled();
      await tick();
      expect(events.length).toBe(sent);
    });
  });

  describe('telling the page', () => {
    it('pushes every change of state, but progress at most once a second', async () => {
      const stream = make();
      await call(stream, 'POST', '/api/stream/key', { key: KEY });
      await call(stream, 'POST', '/api/stream/start', {});
      const proc = ffmpeg.last();
      proc.stdout.emit('data', PROGRESS(30)); // live: a change of state
      await tick();
      const afterLive = events.length;
      expect(last().state).toBe('live');
      clock += 300;
      proc.stdout.emit('data', PROGRESS(60));
      clock += 300;
      proc.stdout.emit('data', PROGRESS(90));
      await tick();
      expect(events.length).toBe(afterLive);
      clock += 500;
      proc.stdout.emit('data', PROGRESS(120));
      await tick();
      expect(events.length).toBe(afterLive + 1);
      expect(last().stats.frames).toBe(120);
      expect(events.every(([name]) => name === 'stream')).toBe(true);
    });
  });

  // ---- the same feature with either program behind it ----

  /** Who is asked for, as the server's own environment says (the shell's launch and `npm run app:native` set this). */
  const asking = (engine, over = {}) => make({ env: { UNCBOX_STREAM_ENGINE: engine }, ...over });
  const fakes = () => ({ ffmpeg, native });
  const toolKeys = ['ddagrab', 'encoder', 'engine', 'ffmpeg', 'scaler', 'tuning', 'version'];

  describe('choosing who streams', () => {
    it('is FFmpeg unless the engine is asked for, and then never even looks for the engine', async () => {
      const findNative = vi.fn(async () => NATIVE_EXE);
      const res = await call(make({ findNative }), 'POST', '/api/stream/check');
      expect(res.body.tools).toMatchObject({ engine: 'ffmpeg', ffmpeg: true, version: '8.1.2-full_build' });
      expect(findNative).not.toHaveBeenCalled();
      expect(native.spawn).not.toHaveBeenCalled();
      // Nonsense in the environment is no request for the engine.
      expect((await call(asking('turbo'), 'POST', '/api/stream/check')).body.tools.engine).toBe('ffmpeg');
      expect((await call(asking('ffmpeg'), 'POST', '/api/stream/check')).body.tools.engine).toBe('ffmpeg');
      expect(native.spawn).not.toHaveBeenCalled();
    });

    it('uses the engine when UNCBOX_STREAM_ENGINE=native and it is built and has an encoder, without looking for FFmpeg at all', async () => {
      const findFfmpeg = vi.fn(async () => 'C:\\Tools\\ffmpeg.exe');
      const res = await call(asking('native', { findFfmpeg }), 'POST', '/api/stream/check');
      expect(res.body.tools).toEqual({ ffmpeg: true, version: '0.1.0', encoder: 'nvenc', tuning: 'quality', scaler: 'd3d11', ddagrab: true, engine: 'native' });
      expect(findFfmpeg).not.toHaveBeenCalled();
      expect(ffmpeg.spawn).not.toHaveBeenCalled();
      expect(native.runs).toEqual([{ file: NATIVE_EXE, args: ['probe'], kind: 'probe' }]);
      expect(consoleLines).toEqual([]);
    });

    it('maps the engine’s encoders to the page’s names, and takes the tuning from the probe when it says', async () => {
      native = fakeNative({ probe: { ...PROBE, encoders: ['amd', 'nvidia'] } });
      expect((await call(asking('native'), 'POST', '/api/stream/check')).body.tools).toMatchObject({ encoder: 'amf', tuning: 'quality' });
      native = fakeNative({ probe: { ...PROBE, encoders: [{ id: 'intel', tuning: 'safe' }] } });
      expect((await call(asking('native'), 'POST', '/api/stream/check')).body.tools).toMatchObject({ encoder: 'qsv', tuning: 'safe' });
    });

    it('works with a probe that has none of the newer fields', async () => {
      native = fakeNative({ probe: { version: '0.0.9', adapters: [], encoders: ['nvidia'] } });
      expect((await call(asking('native'), 'POST', '/api/stream/check')).body.tools).toMatchObject({ engine: 'native', encoder: 'nvenc', tuning: 'quality', version: '0.0.9' });
    });

    it('can be told by the shell which to use, and checks again', async () => {
      const stream = make();
      await call(stream, 'POST', '/api/stream/check');
      expect(last().tools.engine).toBe('ffmpeg');
      const res = await call(stream, 'POST', '/api/stream/engine', { engine: 'native' });
      expect(res.status).toBe(200);
      // The answer is the whole status, like every other route's.
      expect(res.body).toMatchObject({ state: 'off', tools: { engine: 'native', encoder: 'nvenc', ffmpeg: true } });
      expect(last().tools.engine).toBe('native');
      expect((await call(stream, 'POST', '/api/stream/engine', { engine: 'ffmpeg' })).body.tools).toMatchObject({ engine: 'ffmpeg', version: '8.1.2-full_build' });
      expect(last().tools.engine).toBe('ffmpeg');
    });

    it('does nothing at all when it is told what is already asked for', async () => {
      const stream = asking('native');
      await call(stream, 'POST', '/api/stream/check');
      const before = native.spawn.mock.calls.length;
      expect((await call(stream, 'POST', '/api/stream/engine', { engine: 'native' })).status).toBe(200);
      expect(native.spawn.mock.calls.length).toBe(before);
    });

    it('turns away anything but native and ffmpeg', async () => {
      const stream = make();
      for (const body of [{}, { engine: 'turbo' }, { engine: '' }, { engine: 5 }, { engine: 'NATIVE' }, undefined]) {
        const res = await call(stream, 'POST', '/api/stream/engine', body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error).toMatch(/native.*ffmpeg/);
      }
      expect(native.spawn).not.toHaveBeenCalled();
    });

    it('is refused while a stream runs, and the stream and the choice are left alone', async () => {
      const stream = await liveStream();
      const proc = ffmpeg.last();
      const res = await call(stream, 'POST', '/api/stream/engine', { engine: 'native' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/End the stream/);
      expect(native.spawn).not.toHaveBeenCalled();
      expect(proc.kill).not.toHaveBeenCalled();
      expect(await stream.snapshot()).toMatchObject({ state: 'live', tools: { engine: 'ffmpeg' } });
      // After the stream ends, it is accepted.
      await call(stream, 'POST', '/api/stream/stop');
      proc.emit('close', 0);
      await tick();
      expect((await call(stream, 'POST', '/api/stream/engine', { engine: 'native' })).body.tools.engine).toBe('native');
    });

    it('is refused while a stream is starting, too (waiting for the key from Twitch)', async () => {
      let answer;
      twitch.streamKey.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
      const stream = make();
      const start = call(stream, 'POST', '/api/stream/start', {});
      await until(() => answer);
      await expect(stream.setEngine('native')).rejects.toMatchObject({ status: 409 });
      answer(KEY);
      await start;
    });

    it('is accepted for a stream that dropped, as no program is running', async () => {
      const stream = await liveStream();
      ffmpeg.last().emit('close', 1);
      await tick();
      // Nothing is running any more (the page starts it again by itself), so this is no hindrance.
      expect((await call(stream, 'POST', '/api/stream/engine', { engine: 'native' })).status).toBe(200);
    });

    it('streams with the engine that was asked for after the change', async () => {
      const stream = make();
      await call(stream, 'POST', '/api/stream/key', { key: KEY });
      await call(stream, 'POST', '/api/stream/engine', { engine: 'native' });
      await call(stream, 'POST', '/api/stream/start', {});
      expect(ffmpeg.streams).toHaveLength(0);
      expect(native.streams).toHaveLength(1);
    });

    it('lets the newest answer win when the engine is changed during a check', async () => {
      native = fakeNative({ hold: true });
      const stream = asking('native');
      const first = stream.check();
      await until(() => native.runs.length > 0);
      await call(stream, 'POST', '/api/stream/engine', { engine: 'ffmpeg' });
      native.release();
      await first;
      expect((await stream.snapshot()).tools).toMatchObject({ engine: 'ffmpeg', version: '8.1.2-full_build' });
    });

    describe('falling back to FFmpeg, silently for the page and with one line in the console', () => {
      const falls = async (stream) => {
        const res = await call(stream, 'POST', '/api/stream/check');
        expect(res.body.tools).toMatchObject({ engine: 'ffmpeg', ffmpeg: true, version: '8.1.2-full_build', encoder: 'nvenc', ddagrab: true });
        expect(consoleLines).toHaveLength(1);
        expect(consoleLines[0]).toMatch(/FFmpeg/);
        // Nothing for the page: no error, no state.
        expect(res.body).toMatchObject({ state: 'off', error: '' });
        return res;
      };

      it('when the engine is not built', async () => {
        await falls(asking('native', { findNative: async () => '' }));
        expect(consoleLines[0]).toMatch(/isn’t built/);
        expect(native.spawn).not.toHaveBeenCalled();
      });

      it('when looking for it goes wrong', async () => {
        await falls(
          asking('native', {
            findNative: async () => {
              throw new Error('EPERM');
            },
          }),
        );
      });

      it('when it will not run', async () => {
        native = fakeNative({ probeCode: 1, probe: null });
        await falls(asking('native'));
        native = fakeNative({ probeCode: 3 });
        consoleLines.length = 0;
        await falls(asking('native'));
      });

      it('when its answer is garbage', async () => {
        for (const text of ['garbage', '<html>nope</html>', '{"version":"0.1.0"}', '']) {
          consoleLines.length = 0;
          native = fakeNative({ probeText: text });
          await falls(asking('native'));
        }
      });

      it('when it finds no encoder that works', async () => {
        native = fakeNative({ probe: { ...PROBE, encoders: [] } });
        await falls(asking('native'));
        consoleLines.length = 0;
        native = fakeNative({ probe: { ...PROBE, encoders: ['someone-else'] } });
        await falls(asking('native'));
      });

      it('when it takes too long to answer', async () => {
        native = fakeNative({ hold: true });
        const stream = asking('native');
        const checking = stream.check();
        await until(() => pendingTimer(15_000));
        pendingTimer(15_000).fn();
        await checking;
        expect(native.runs[0].args).toEqual(['probe']);
        expect(consoleLines).toHaveLength(1);
        expect((await stream.snapshot()).tools.engine).toBe('ffmpeg');
      });

      it('and then FFmpeg is what a start needs, with FFmpeg’s own words when it is missing too', async () => {
        const stream = asking('native', { findNative: async () => '', findFfmpeg: async () => '' });
        await call(stream, 'POST', '/api/stream/key', { key: KEY });
        const res = await call(stream, 'POST', '/api/stream/start', {});
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/FFmpeg isn’t installed.*Downloads widget/);
      });

      it('and a stream still works, through FFmpeg', async () => {
        const stream = await liveStream({}, () => asking('native', { findNative: async () => '' }));
        expect(ffmpeg.streams).toHaveLength(1);
        expect(native.streams).toHaveLength(0);
        expect((await stream.snapshot()).state).toBe('live');
      });
    });

    it('never says FFmpeg is missing when the engine will stream, even with no FFmpeg on the PC', async () => {
      const stream = asking('native', { findFfmpeg: async () => '' });
      const { tools } = (await call(stream, 'POST', '/api/stream/check')).body;
      expect(tools).toMatchObject({ ffmpeg: true, ddagrab: true, engine: 'native' });
      expect(toolsLine(tools, true).state).toBe('ready');
      await call(stream, 'POST', '/api/stream/key', { key: KEY });
      expect((await call(stream, 'POST', '/api/stream/start', {})).status).toBe(200);
      expect(native.streams).toHaveLength(1);
    });
  });

  describe('looking the same to the page', () => {
    it('gives the same tools, with the same fields and meanings, whoever streams', async () => {
      const viaFfmpeg = (await call(make(), 'POST', '/api/stream/check')).body;
      const viaNative = (await call(asking('native'), 'POST', '/api/stream/check')).body;
      expect(Object.keys(viaFfmpeg.tools).sort()).toEqual(toolKeys);
      expect(Object.keys(viaNative.tools).sort()).toEqual(toolKeys);
      expect(Object.keys(viaNative).sort()).toEqual(Object.keys(viaFfmpeg).sort());
      for (const field of toolKeys.filter((f) => f !== 'engine' && f !== 'version' && f !== 'scaler')) {
        expect(typeof viaNative.tools[field], field).toBe(typeof viaFfmpeg.tools[field]);
      }
      expect(viaNative.tools).toMatchObject({ ffmpeg: true, ddagrab: true, encoder: 'nvenc', tuning: 'quality', scaler: 'd3d11' });
      expect(typeof viaNative.tools.version).toBe('string');
    });

    it('has the same snapshot before anything is checked', async () => {
      const a = await make().snapshot();
      const b = await asking('native').snapshot();
      expect(b).toEqual(a);
    });

    it('says the same thing in the readiness line, and never asks for an FFmpeg install', async () => {
      const viaFfmpeg = (await call(make(), 'POST', '/api/stream/check')).body.tools;
      const viaNative = (await call(asking('native'), 'POST', '/api/stream/check')).body.tools;
      expect(toolsLine(viaNative, true)).toEqual(toolsLine(viaFfmpeg, true));
      expect(toolsLine(viaNative, true)).toEqual({ state: 'ready', text: 'Ready: NVIDIA NVENC on your graphics card' });
      native = fakeNative({ probe: { ...PROBE, encoders: ['amd'] } });
      ffmpeg = fakeFfmpeg({ cards: ['amf'] });
      const amdNative = (await call(asking('native'), 'POST', '/api/stream/check')).body.tools;
      const amdFfmpeg = (await call(make(), 'POST', '/api/stream/check')).body.tools;
      expect(toolsLine(amdNative, true)).toEqual(toolsLine(amdFfmpeg, true));
      expect(toolsLine(amdNative, true).text).toBe('Ready: AMD AMF on your graphics card');
    });

    it('pushes the same events', async () => {
      await call(asking('native'), 'POST', '/api/stream/check');
      expect(events.every(([name]) => name === 'stream')).toBe(true);
      expect(Object.keys(last()).sort()).toEqual(['error', 'key', 'startedAt', 'state', 'stats', 'test', 'tools']);
      expect(last().tools.engine).toBe('native');
    });
  });

  describe('streaming with the engine', () => {
    const live = (body, over) => liveStream(body, () => asking('native', over));
    const lastRun = () => native.runs.findLast((r) => r.kind === 'run');

    it('runs the engine with just "run", and tells it the settings, the sound and the address on stdin', async () => {
      const stream = asking('native');
      await call(stream, 'POST', '/api/stream/key', { key: KEY });
      const res = await call(stream, 'POST', '/api/stream/start', { audioPipe: PIPE, settings: { screen: 1, fps: 30, height: 720, kbps: 4500 } });
      expect(res.body.state).toBe('starting');
      const run = lastRun();
      expect(run.file).toBe(NATIVE_EXE);
      expect(run.args).toEqual(['run']);
      const proc = native.last();
      // One line of JSON, ending in a newline, with exactly what the contract has.
      expect(proc.stdin.written).toHaveLength(1);
      expect(proc.stdin.written[0].endsWith('\n')).toBe(true);
      expect(JSON.parse(proc.stdin.written[0])).toEqual({
        url: `rtmps://live.twitch.tv:443/app/${KEY}`,
        screen: 1,
        fps: 30,
        height: 720,
        kbps: 4500,
        audioPipe: PIPE,
        encoder: 'auto',
      });
      expect(proc.stdin.written[0].trim().split('\n')).toHaveLength(1);
      // FFmpeg was only ever asked about the screen's size when it was the one streaming.
      expect(ffmpeg.runs).toEqual([]);
    });

    it('never puts the key in the arguments or the environment, only on stdin', async () => {
      await live({ audioPipe: PIPE });
      const [call_] = native.spawn.mock.calls.filter(([, args]) => args[0] === 'run');
      expect(JSON.stringify(call_)).not.toContain(KEY);
      expect(JSON.stringify(call_)).not.toContain('live_');
      expect(native.last().stdin.written[0]).toContain(KEY);
    });

    it('sends the defaults, clamped, with no sound pipe when there is none', async () => {
      await live({ settings: { screen: 99, fps: 144, height: 900, kbps: 99_999 } });
      expect(JSON.parse(native.last().stdin.written[0])).toEqual({ url: ingestUrl(KEY), screen: 7, fps: 60, height: 1080, kbps: 8000, encoder: 'auto' });
    });

    it('makes a test stream the bandwidth test address, and a normal one not', async () => {
      const stream = await live({ test: true });
      expect((await stream.snapshot()).test).toBe(true);
      expect(JSON.parse(native.last().stdin.written[0]).url).toBe(`rtmps://live.twitch.tv:443/app/${KEY}?bandwidthtest=true`);
      await live({ test: false });
      expect(JSON.parse(native.last().stdin.written[0]).url).toBe(`rtmps://live.twitch.tv:443/app/${KEY}`);
    });

    it('streams to UNCBOX_STREAM_INGEST when that is set (for testing against a listener on this PC)', async () => {
      await live({}, { env: { UNCBOX_STREAM_ENGINE: 'native', UNCBOX_STREAM_INGEST: 'rtmp://127.0.0.1:19350/test' } });
      expect(JSON.parse(native.last().stdin.written[0]).url).toBe(`rtmp://127.0.0.1:19350/test/${KEY}`);
      await liveStream({}, () => make({ env: { UNCBOX_STREAM_INGEST: 'rtmp://127.0.0.1:19350/test' } }));
      expect(ffmpeg.runs.findLast((r) => r.kind === 'stream').args.at(-1)).toBe(`rtmp://127.0.0.1:19350/test/${KEY}`);
    });

    it('goes live on the first frames, with the stats, as FFmpeg does', async () => {
      const stream = await live();
      expect(await stream.snapshot()).toMatchObject({ state: 'live', test: false, startedAt: clock, stats: { fps: 59.9, kbps: 5876, dropped: 1, frames: 30, speed: 1 }, error: '' });
    });

    it('reads the engine’s progress when it comes in pieces, and stays "starting" at 0 frames', async () => {
      const stream = asking('native');
      await call(stream, 'POST', '/api/stream/key', { key: KEY });
      await call(stream, 'POST', '/api/stream/start', {});
      native.last().stdout.emit('data', 'frame=0\nfps=0.00\nbitrate=N/A\ndrop_frames=0\nspeed=N/A\nprogress=continue\n');
      await tick();
      expect((await stream.snapshot()).state).toBe('starting');
      const text = PROGRESS(60);
      native.last().stdout.emit('data', text.slice(0, 11));
      native.last().stdout.emit('data', text.slice(11));
      await tick();
      expect(await stream.snapshot()).toMatchObject({ state: 'live', stats: { frames: 60 } });
    });

    it('counts the engine’s dropped pictures as FFmpeg’s', async () => {
      const stream = await live();
      native.last().stdout.emit('data', 'frame=900\nfps=60.0\nbitrate=5000.0kbits/s\ndrop_frames=7\nspeed=1.00x\nprogress=continue\n');
      clock += 2000;
      await tick();
      expect((await stream.snapshot()).stats).toMatchObject({ dropped: 7, frames: 900 });
    });

    it('does not start without a key, and says so in the same words', async () => {
      const res = await call(asking('native'), 'POST', '/api/stream/start', {});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/stream key/);
      expect(native.streams).toHaveLength(0);
    });

    it('refuses an audio pipe that is not one of Uncbox’s, before anything is run', async () => {
      const stream = asking('native');
      await call(stream, 'POST', '/api/stream/key', { key: KEY });
      expect((await call(stream, 'POST', '/api/stream/start', { audioPipe: '\\\\.\\pipe\\something-else' })).status).toBe(400);
      expect(native.streams).toHaveLength(0);
    });
  });

  // What has to be true whichever program is behind the stream.
  describe.each([['ffmpeg'], ['native']])('with %s: the life of a stream', (engine) => {
    const fake = () => fakes()[engine];
    const start = async (body = {}) => {
      const stream = asking(engine);
      await call(stream, 'POST', '/api/stream/key', { key: KEY });
      const res = await call(stream, 'POST', '/api/stream/start', body);
      return { stream, res };
    };
    const live = (body, over) => liveStream(body, () => asking(engine, over));
    /** What was sent to the program on stdin, the config line (native only) excluded. */
    const sent = () => fake().last().stdin.written.filter((text) => !text.startsWith('{'));

    it('starts, and is "starting" until frames arrive', async () => {
      const { res } = await start();
      expect(res.body).toMatchObject({ state: 'starting', error: '', tools: { engine } });
      expect(fake().streams).toHaveLength(1);
    });

    it('runs above normal priority, and still streams when that is not allowed', async () => {
      await live();
      expect(priority).toEqual([engine === 'native' ? 8765 : 4321]);
      const stream = await live({}, {
        raisePriority: () => {
          throw new Error('EACCES');
        },
      });
      expect((await stream.snapshot()).state).toBe('live');
    });

    it('does not start twice', async () => {
      const stream = await live();
      const again = await call(stream, 'POST', '/api/stream/start', {});
      expect(again.status).toBe(409);
      expect(fake().streams).toHaveLength(1);
    });

    it('does not start twice while the first Go live waits for the key from Twitch', async () => {
      let answer;
      twitch.streamKey.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
      const stream = asking(engine);
      const first = call(stream, 'POST', '/api/stream/start', {});
      await until(() => answer);
      await expect(stream.start({})).rejects.toMatchObject({ status: 409 });
      answer(KEY);
      expect((await first).status).toBe(200);
      expect(fake().streams).toHaveLength(1);
    });

    it('takes the key from the Twitch sign-in by itself, and stays forgotten after Forget', async () => {
      twitch.streamKey.mockResolvedValue(KEY);
      const stream = asking(engine);
      const res = await call(stream, 'POST', '/api/stream/start', {});
      expect(res.status).toBe(200);
      expect(res.body.key).toEqual({ set: true, hint: KEY.slice(-4), source: 'twitch' });
      expect(engine === 'native' ? JSON.parse(native.last().stdin.written[0]).url : ffmpeg.runs.findLast((r) => r.kind === 'stream').args.at(-1)).toBe(ingestUrl(KEY, false, {}));
      // End it, forget the key: the sign-in doesn't hand it straight back.
      await call(stream, 'POST', '/api/stream/stop');
      fake().last().emit('close', 0);
      await tick();
      expect((await call(stream, 'POST', '/api/stream/key', { key: '' })).body.key).toEqual({ set: false, hint: '', source: null });
      twitch.streamKey.mockClear();
      const again = await call(stream, 'POST', '/api/stream/start', {});
      expect(again.status).toBe(400);
      expect(again.body.error).toMatch(/stream key/);
      expect(fake().streams).toHaveLength(1);
    });

    it('asks for the end with q, and is off once the program has ended', async () => {
      const stream = await live();
      const proc = fake().last();
      const res = await call(stream, 'POST', '/api/stream/stop');
      expect(res.body.state).toBe('stopping');
      expect(sent()).toEqual(['q\n']);
      expect(proc.kill).not.toHaveBeenCalled();
      proc.emit('close', 0);
      await tick();
      expect(await stream.snapshot()).toMatchObject({ state: 'off', startedAt: null, stats: null, error: '' });
      expect(pendingTimer(5000)).toBeUndefined();
    });

    it('kills it after the grace period if it will not end', async () => {
      const stream = await live();
      const proc = fake().last();
      await call(stream, 'POST', '/api/stream/stop');
      expect(pendingTimer(5000)).toBeDefined();
      pendingTimer(5000).fn();
      expect(proc.kill).toHaveBeenCalled();
      await tick();
      expect((await stream.snapshot()).state).toBe('off');
    });

    it('can start again right after a stop', async () => {
      const stream = await live();
      await call(stream, 'POST', '/api/stream/stop');
      fake().last().emit('close', 0);
      await tick();
      expect((await call(stream, 'POST', '/api/stream/start', {})).status).toBe(200);
      expect(fake().streams).toHaveLength(2);
    });

    it('kills it when the server shuts down, without announcing it', async () => {
      const stream = await live();
      const proc = fake().last();
      const before = events.length;
      stream.close();
      expect(proc.kill).toHaveBeenCalled();
      await tick();
      expect(events.length).toBe(before);
    });

    it('is "dropped" with the last line it printed when it ends by itself', async () => {
      const stream = await live();
      fake().last().stderr.emit('data', 'Warning: something\nConnection reset by peer\n');
      fake().last().emit('close', 1);
      await tick();
      expect(await stream.snapshot()).toMatchObject({ state: 'dropped', error: 'Connection reset by peer' });
      expect(last().state).toBe('dropped');
    });

    it('can be started again after a drop, as the page does', async () => {
      const stream = await live();
      fake().last().emit('close', 1);
      await tick();
      const res = await call(stream, 'POST', '/api/stream/start', { audioPipe: PIPE });
      expect(res.status).toBe(200);
      expect(fake().streams).toHaveLength(2);
      expect(res.body).toMatchObject({ state: 'starting', error: '' });
    });

    it('says what happened in words that name neither program', async () => {
      const { stream } = await start();
      fake().last().emit('close', 3);
      await tick();
      expect(await stream.snapshot()).toMatchObject({ state: 'dropped', error: 'The stream stopped (code 3).' });
      // And when it cannot be run at all.
      const second = await live();
      await call(second, 'POST', '/api/stream/stop');
      fake().last().emit('close', 0);
      await tick();
      await call(second, 'POST', '/api/stream/start', {});
      fake().last().emit('error', new Error('spawn ENOENT'));
      await tick();
      expect(await second.snapshot()).toMatchObject({ state: 'error', error: 'Couldn’t start the stream.' });
      expect(events.map(([, status]) => status.error).join(' ')).not.toMatch(/ffmpeg/i);
    });

    it('is cleared by a stop after an error or a drop', async () => {
      const stream = await live();
      fake().last().emit('close', 1);
      await tick();
      expect((await call(stream, 'POST', '/api/stream/stop')).body).toMatchObject({ state: 'off', error: '' });
    });

    it('blanks the key in whatever it prints, whatever the chunking, and in everything pushed', async () => {
      const stream = await live();
      const proc = fake().last();
      proc.stderr.emit('data', `[tls @ 0x1] Connection to rtmps://live.twitch.tv:443/app/${KEY.slice(0, 20)}`);
      proc.stderr.emit('data', `${KEY.slice(20)} failed\nConnection to ${KEY} reset by peer\n`);
      await tick();
      expect((await stream.snapshot()).error).toBe('Connection to **** reset by peer');
      proc.stderr.emit('data', `Error opening output rtmps://live.twitch.tv:443/app/${KEY}\n`);
      proc.emit('close', 1);
      await tick();
      const snap = await stream.snapshot();
      expect(snap).toMatchObject({ state: 'dropped', error: 'Error opening output rtmps://live.twitch.tv:443/app/****' });
      expect(JSON.stringify(snap)).not.toContain(KEY);
      expect(JSON.stringify(events)).not.toContain(KEY);
    });

    it('blanks a key in any other shape the program might print', async () => {
      await live();
      fake().last().stderr.emit('data', 'The server refused live_987654321_zzzzzzzzzzzz\n');
      fake().last().emit('close', 1);
      await tick();
      expect(last().error).toBe('The server refused live_****');
    });

    it('pushes every change of state, but progress at most once a second', async () => {
      const stream = asking(engine);
      await call(stream, 'POST', '/api/stream/key', { key: KEY });
      await call(stream, 'POST', '/api/stream/start', {});
      const proc = fake().last();
      proc.stdout.emit('data', PROGRESS(30));
      await tick();
      const afterLive = events.length;
      expect(last().state).toBe('live');
      clock += 300;
      proc.stdout.emit('data', PROGRESS(60));
      clock += 300;
      proc.stdout.emit('data', PROGRESS(90));
      await tick();
      expect(events.length).toBe(afterLive);
      clock += 500;
      proc.stdout.emit('data', PROGRESS(120));
      await tick();
      expect(events.length).toBe(afterLive + 1);
      expect(last().stats.frames).toBe(120);
    });

    it('never has the word FFmpeg in anything the page is told while streaming', async () => {
      const stream = await live();
      fake().last().emit('close', 2);
      await tick();
      await call(stream, 'POST', '/api/stream/stop');
      expect(events.map(([, status]) => status.error).join(' ')).not.toMatch(/ffmpeg|engine/i);
    });
  });

  describe('the routes', () => {
    it('answers the status to anyone, and everything else only to this PC', async () => {
      const stream = make();
      expect((await call(stream, 'GET', '/api/stream', undefined, false)).status).toBe(200);
      for (const [method, route] of [
        ['POST', '/api/stream/key'],
        ['POST', '/api/stream/key/twitch'],
        ['POST', '/api/stream/check'],
        ['POST', '/api/stream/engine'],
        ['POST', '/api/stream/start'],
        ['POST', '/api/stream/stop'],
      ]) {
        expect((await call(stream, method, route, { key: KEY }, false)).status, route).toBe(403);
      }
      expect(ffmpeg.spawn).not.toHaveBeenCalled();
      expect(native.spawn).not.toHaveBeenCalled();
      expect((await stream.snapshot()).key.set).toBe(false);
    });

    it('knows its own routes', async () => {
      const stream = make();
      expect((await call(stream, 'POST', '/api/stream/nothing')).status).toBe(404);
      expect((await call(stream, 'GET', '/api/stream/key')).status).toBe(404);
      expect((await call(stream, 'DELETE', '/api/stream')).status).toBe(405);
    });
  });
});
