// Instant replay, off the page's main thread. Game frames come in from the capture, get scaled to
// 1080p, and are encoded as H.264 (High profile, 60 fps, 30 Mbps, on the graphics card when it
// can). The encoded video for the last 60 seconds stays in memory; "save" turns it into an MP4
// and uploads it to the server, which writes it to Videos\Uncbox.
//
// Encoded video is kept rather than frames: a minute of 1080p frames is ~30 GB, a minute of
// encoded video is ~225 MB. A clip has to start on a keyframe, so one is made every second and
// the buffer always reaches back to the last keyframe that's at least 60 seconds old.

import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } from 'mediabunny';
import type { Crop } from '../state/model';

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 60;
const SECONDS = 60;
const BITRATE = 30_000_000;
const KEYFRAME_EVERY_US = 1_000_000;
/** Frames waiting in the encoder before new ones are dropped, so a busy GPU can't pile up memory. */
const MAX_QUEUE = 6;

export type ToWorker =
  | { type: 'start'; frames: ReadableStream<VideoFrame>; crop: Crop }
  | { type: 'crop'; crop: Crop }
  | { type: 'save'; id: number };

export type FromWorker =
  | { type: 'status'; seconds: number; error: string }
  | { type: 'saved'; id: number; name: string }
  | { type: 'failed'; id: number; error: string };

const post = (msg: FromWorker) => postMessage(msg);

// High profile at level 4.2 covers 1080p60; Main and Baseline are fallbacks for GPUs without it.
const CODECS = ['avc1.64002A', 'avc1.4D402A', 'avc1.42E02A'];

async function pickConfig(): Promise<VideoEncoderConfig> {
  for (const hardwareAcceleration of ['prefer-hardware', 'no-preference'] as const) {
    for (const codec of CODECS) {
      const config: VideoEncoderConfig = {
        codec,
        width: WIDTH,
        height: HEIGHT,
        framerate: FPS,
        bitrate: BITRATE,
        bitrateMode: 'variable',
        latencyMode: 'quality',
        hardwareAcceleration,
        avc: { format: 'avc' },
      };
      const { supported } = await VideoEncoder.isConfigSupported(config).catch(() => ({ supported: false }));
      if (supported) return config;
    }
  }
  throw new Error('This browser can’t encode H.264 video. Use Chrome or Edge.');
}

let crop: Crop = { top: 0, right: 0, bottom: 0, left: 0 };
let packets: EncodedPacket[] = [];
let decoderConfig: VideoDecoderConfig | null = null;
let error = '';

/** Drops everything before the newest keyframe that is still at least SECONDS old. */
function prune() {
  const newest = packets[packets.length - 1].timestamp;
  let cut = 0;
  for (let i = 0; i < packets.length; i++) {
    if (newest - packets[i].timestamp < SECONDS) break;
    if (packets[i].type === 'key') cut = i;
  }
  if (cut > 0) packets = packets.slice(cut);
}

const buffered = () => (packets.length ? packets[packets.length - 1].timestamp - packets[0].timestamp : 0);

async function run(frames: ReadableStream<VideoFrame>) {
  const config = await pickConfig();
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig) decoderConfig = meta.decoderConfig;
      // Until the first keyframe there's nothing a clip could start from.
      if (!packets.length && chunk.type !== 'key') return;
      packets.push(EncodedPacket.fromEncodedChunk(chunk));
      prune();
    },
    error: (e) => {
      error = `Recording stopped: ${e.message}`;
    },
  });
  encoder.configure(config);

  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  ctx.imageSmoothingQuality = 'high';
  const reader = frames.getReader();
  let lastAt = -Infinity;
  let lastKeyAt = -Infinity;

  for (;;) {
    const { value: frame, done } = await reader.read();
    if (done) break;
    // Captures can run faster than 60 fps or stall the encoder; skip frames rather than fall behind.
    const due = frame.timestamp - lastAt >= 1e6 / FPS - 2000;
    if (!due || encoder.state !== 'configured' || encoder.encodeQueueSize > MAX_QUEUE) {
      frame.close();
      continue;
    }
    lastAt = frame.timestamp;

    // The same crop viewers see (menu bars, the WoW addon's strip), then fit into 1920 × 1080.
    const fw = frame.displayWidth;
    const fh = frame.displayHeight;
    const pct = (n: number) => Math.min(Math.max(n, 0), 45) / 100;
    const sx = fw * pct(crop.left);
    const sy = fh * pct(crop.top);
    const sw = fw * (1 - pct(crop.left) - pct(crop.right));
    const sh = fh * (1 - pct(crop.top) - pct(crop.bottom));
    const scale = Math.min(WIDTH / sw, HEIGHT / sh);
    const dw = Math.round(sw * scale);
    const dh = Math.round(sh * scale);
    if (dw < WIDTH || dh < HEIGHT) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
    }
    ctx.drawImage(frame, sx, sy, sw, sh, (WIDTH - dw) / 2, (HEIGHT - dh) / 2, dw, dh);
    const out = new VideoFrame(canvas, { timestamp: frame.timestamp, duration: 1e6 / FPS });
    frame.close();
    const keyFrame = frame.timestamp - lastKeyAt >= KEYFRAME_EVERY_US;
    if (keyFrame) lastKeyAt = frame.timestamp;
    encoder.encode(out, { keyFrame });
    out.close();
  }
  if (encoder.state === 'configured') await encoder.flush().catch(() => {});
  encoder.close();
}

async function save(id: number) {
  const clip = packets.slice();
  if (!clip.length || !decoderConfig) throw new Error('Nothing recorded yet.');
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new EncodedVideoPacketSource('avc');
  // No frameRate here: it would round timestamps to 1/60 s, and captures deliver frames a little unevenly.
  output.addVideoTrack(source);
  await output.start();
  const start = clip[0].timestamp;
  for (let i = 0; i < clip.length; i++) {
    await source.add(clip[i].clone({ timestamp: clip[i].timestamp - start }), i === 0 ? { decoderConfig } : undefined);
  }
  await output.finalize();
  const res = await fetch('/api/clips', {
    method: 'POST',
    headers: { 'Content-Type': 'video/mp4' },
    body: output.target.buffer!,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Couldn’t save the clip (${res.status})`);
  post({ type: 'saved', id, name: json.name });
}

onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === 'start') {
    crop = msg.crop;
    run(msg.frames).catch((err) => {
      error = err instanceof Error ? err.message : String(err);
    });
  } else if (msg.type === 'crop') {
    crop = msg.crop;
  } else if (msg.type === 'save') {
    save(msg.id).catch((err) => post({ type: 'failed', id: msg.id, error: err instanceof Error ? err.message : String(err) }));
  }
};

setInterval(() => post({ type: 'status', seconds: Math.floor(buffered()), error }), 1000);
