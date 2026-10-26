// Streaming from Uncbox: the FFmpeg arguments, the progress parser, the key handling and the
// stream's life (starting, live, dropped, stopping). FFmpeg is never run and nothing touches the
// network: spawn is replaced by a fake, and the key file goes in a temp folder.

import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildFfmpegArgs,
  clampSettings,
  cpuScale,
  createProgressParser,
  createStream,
  gpuScale,
  ingestUrl,
  listsName,
  parseProgress,
  parseScreenSize,
  PIPE_SHAPE,
  redact,
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
    expect(valueAfter(args, '-preset')).toBe('p5');
    expect(valueAfter(args, '-tune')).toBe('hq');
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
    const at = args.indexOf('-thread_queue_size');
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
    expect(args[args.indexOf('-i') + 1]).toBe('ddagrab=output_idx=7:framerate=60:draw_mouse=1,' + cpuScale(1080));
    expect(valueAfter(args, '-b:v')).toBe('2500k');
  });

  it('does not scale at the screen’s own size, or when the height is "the screen’s"', () => {
    const own = buildFfmpegArgs({ ...base, settings: { ...base.settings, height: 1080 }, screenHeight: 1080 });
    expect(own[own.indexOf('-i') + 1]).not.toContain('scale');
    expect(buildFfmpegArgs(base)[buildFfmpegArgs(base).indexOf('-i') + 1]).not.toContain('scale');
  });

  it('scales on the processor by default and hands NVENC NV12', () => {
    const args = buildFfmpegArgs({ ...base, settings: { ...base.settings, height: 720 }, screenHeight: 1440 });
    const video = args[args.indexOf('-i') + 1];
    expect(video).toBe('ddagrab=output_idx=0:framerate=60:draw_mouse=1,hwdownload,format=bgra,scale=-2:720,format=nv12');
  });

  it('scales on the graphics card when that works', () => {
    const args = buildFfmpegArgs({ ...base, settings: { ...base.settings, height: 720 }, screenHeight: 2160, scaler: 'gpu' });
    expect(args[args.indexOf('-i') + 1]).toBe(`ddagrab=output_idx=0:framerate=60:draw_mouse=1,${gpuScale(720)}`);
    expect(gpuScale(720)).toBe('scale_d3d11=width=trunc(iw*720/ih/2)*2:height=720:format=nv12');
  });

  it('scales when the screen’s height is not known', () => {
    const args = buildFfmpegArgs({ ...base, settings: { ...base.settings, height: 1080 } });
    expect(args[args.indexOf('-i') + 1]).toContain('scale');
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

function fakeFfmpeg({ nvenc = true, ddagrab = true, d3d11 = false, gpuWorks = false, screenHeight = 1080 } = {}) {
  const runs = [];
  const streams = [];
  const spawn = vi.fn((file, args) => {
    const proc = new EventEmitter();
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
      if (kind === 'encoders') proc.stdout.emit('data', nvenc ? ' V....D h264_nvenc           NVIDIA NVENC H.264 encoder\n' : ' V....D libx264              x264\n');
      if (kind === 'filters') proc.stdout.emit('data', [ddagrab && ' ... ddagrab           |->V       Grab Windows Desktop images', d3d11 && ' ... scale_d3d11        V->V       Scale video using Direct3D11'].filter(Boolean).join('\n') + '\n');
      let code = 0;
      if (kind === 'probe') {
        if (args.includes('h264_nvenc') && args.join(' ').includes('color=black')) code = nvenc ? 0 : 1;
        else if (args.join(' ').includes('scale_d3d11')) code = gpuWorks ? 0 : 1;
        else proc.stderr.emit('data', `  Stream #0:0: Video: wrapped_avframe, bgra, ${Math.round((screenHeight * 16) / 9)}x${screenHeight} [SAR 1:1 DAR 16:9], 30 fps\n`);
      }
      proc.emit('close', code);
    });
    return proc;
  });
  return { spawn, runs, streams, last: () => streams.at(-1) };
}

const PROGRESS = (frame) => `frame=${frame}\nfps=59.9\nbitrate=5876.3kbits/s\ndrop_frames=1\nspeed=1.0x\nprogress=continue\n`;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** One request through the stream's handler (made by make() below, which wires up stream.call). */
const call = (stream, method, pathname, body, local = true) => stream.call(method, pathname, body, local);

describe('the stream', () => {
  let dir;
  let events;
  let clock;
  let timers;
  let ffmpeg;
  let twitch;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'uncbox-stream-'));
    events = [];
    clock = 1_000_000;
    timers = [];
    ffmpeg = fakeFfmpeg();
    twitch = { streamKey: vi.fn(async () => KEY) };
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
      spawn: ffmpeg.spawn,
      findFfmpeg: async () => 'C:\\Tools\\ffmpeg.exe',
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
      tools: { ffmpeg: false, version: '', nvenc: null, ddagrab: null },
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
      expect(JSON.parse(await readFile(path.join(dir, 'stream.json'), 'utf8'))).toEqual({});
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

    it('is written so only this user can read it', async () => {
      await call(make(), 'POST', '/api/stream/key', { key: KEY });
      if (process.platform !== 'win32') expect((await stat(path.join(dir, 'stream.json'))).mode & 0o077).toBe(0);
    });
  });

  describe('checking', () => {
    it('finds FFmpeg, NVENC and ddagrab', async () => {
      const stream = make();
      const res = await call(stream, 'POST', '/api/stream/check');
      expect(res.body.tools).toEqual({ ffmpeg: true, version: '8.1.2-full_build', nvenc: true, ddagrab: true });
      // The one-frame NVENC probe from the ticket.
      const probe = ffmpeg.runs.find((r) => r.args.join(' ').includes('color=black'));
      expect(probe.args.join(' ')).toBe('-hide_banner -f lavfi -i color=black:s=256x256 -frames:v 1 -c:v h264_nvenc -f null -');
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
      expect((await call(stream, 'POST', '/api/stream/check')).body.tools).toEqual({ ffmpeg: false, version: '', nvenc: null, ddagrab: null });
      path = 'C:\\Tools\\ffmpeg.exe';
      expect((await call(stream, 'POST', '/api/stream/check')).body.tools.ffmpeg).toBe(true);
    });

    it('says when this FFmpeg has no NVENC, or no card to run it', async () => {
      ffmpeg = fakeFfmpeg({ nvenc: false });
      expect((await call(make(), 'POST', '/api/stream/check')).body.tools).toMatchObject({ ffmpeg: true, nvenc: false });
    });

    it('says when this FFmpeg cannot capture the screen', async () => {
      ffmpeg = fakeFfmpeg({ ddagrab: false });
      expect((await call(make(), 'POST', '/api/stream/check')).body.tools).toMatchObject({ ddagrab: false });
    });

    it('is told to the page', async () => {
      await call(make(), 'POST', '/api/stream/check');
      expect(last().tools.nvenc).toBe(true);
    });
  });

  /** A stream that has been started and has frames going out. */
  async function liveStream(body = {}, make_ = make) {
    const stream = make_();
    await call(stream, 'POST', '/api/stream/key', { key: KEY });
    const res = await call(stream, 'POST', '/api/stream/start', { settings: { screen: 0, fps: 60, height: 1080, kbps: 6000 }, ...body });
    expect(res.status).toBe(200);
    ffmpeg.last().stdout.emit('data', PROGRESS(30));
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

    it('refuses with plain words when there is no NVENC or no ddagrab', async () => {
      ffmpeg = fakeFfmpeg({ nvenc: false });
      let stream = make();
      await call(stream, 'POST', '/api/stream/key', { key: KEY });
      expect((await call(stream, 'POST', '/api/stream/start', {})).body.error).toMatch(/NVENC/);
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
      expect(run.args).toEqual(buildFfmpegArgs({ settings: { screen: 1, fps: 30, height: 720, kbps: 4500 }, key: KEY, audioPipe: PIPE, screenHeight: 1080 }));
      expect(run.args).toContain(PIPE);
      expect(run.args.at(-1)).toBe(ingestUrl(KEY, false));
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
      expect(ffmpeg.runs.findLast((r) => r.kind === 'stream').args[ffmpeg.runs.findLast((r) => r.kind === 'stream').args.indexOf('-i') + 1]).not.toContain('scale');
      ffmpeg = fakeFfmpeg({ screenHeight: 1440 });
      await liveStream({ settings: { height: 1080 } });
      const args = ffmpeg.runs.findLast((r) => r.kind === 'stream').args;
      expect(args[args.indexOf('-i') + 1]).toContain('scale=-2:1080');
    });

    it('scales on the graphics card only when the check saw that work', async () => {
      ffmpeg = fakeFfmpeg({ screenHeight: 1440, d3d11: true, gpuWorks: true });
      await liveStream({ settings: { height: 720 } });
      let args = ffmpeg.runs.findLast((r) => r.kind === 'stream').args;
      expect(args[args.indexOf('-i') + 1]).toContain('scale_d3d11');
      ffmpeg = fakeFfmpeg({ screenHeight: 1440, d3d11: true, gpuWorks: false });
      await liveStream({ settings: { height: 720 } });
      args = ffmpeg.runs.findLast((r) => r.kind === 'stream').args;
      expect(args[args.indexOf('-i') + 1]).toContain('hwdownload');
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
      expect(await stream.snapshot()).toMatchObject({ state: 'error', error: 'Couldn’t start FFmpeg.' });
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
      expect((await stream.snapshot()).error).toBe('FFmpeg stopped (code 3).');
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

  describe('the routes', () => {
    it('answers the status to anyone, and everything else only to this PC', async () => {
      const stream = make();
      expect((await call(stream, 'GET', '/api/stream', undefined, false)).status).toBe(200);
      for (const [method, route] of [
        ['POST', '/api/stream/key'],
        ['POST', '/api/stream/key/twitch'],
        ['POST', '/api/stream/check'],
        ['POST', '/api/stream/start'],
        ['POST', '/api/stream/stop'],
      ]) {
        expect((await call(stream, method, route, { key: KEY }, false)).status, route).toBe(403);
      }
      expect(ffmpeg.spawn).not.toHaveBeenCalled();
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
