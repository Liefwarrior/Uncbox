// Instant replay, off the page's main thread. Game frames come in from the capture, get scaled to
// 1080p, and are encoded as H.264 (High profile, 60 fps, 30 Mbps, on the graphics card when it
// can). The encoded video for the last 60 seconds stays in memory; "save" turns it into an MP4
// and uploads it to the server, which writes it to Videos\Uncbox.
//
// Sound comes from the Uncbox app (ClipAudio.cs), which keeps its own last 70 seconds. The two
// are lined up by wall-clock time: each frame is stamped with when it arrived here, so "prepare"
// can say when the clip began and ended, the page asks the app for exactly that stretch of sound,
// and "save" muxes it in as four tracks (see mux.ts).
//
// Encoded video is kept rather than frames: a minute of 1080p frames is ~30 GB, a minute of
// encoded video is ~225 MB. A clip has to start on a keyframe, so one is made every second and
// the buffer always reaches back to the last keyframe that's at least 60 seconds old.

import { EncodedPacket } from 'mediabunny';
import type { ClipPcm } from '../native';
import type { Crop } from '../state/model';
import { goesBack, keepFrom } from './buffer';
import { muxClip, pickAudioCodec } from './mux';
import type { ClipVideo } from './mux';
import { ArrivalClock, wallNow } from './pcm';

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
  /** Freezes what a clip would be, and says when it began and ended (wall-clock ms). */
  | { type: 'prepare'; id: number }
  /** Saves what `prepare` froze, with the app's sound for that stretch (null: video only). */
  | { type: 'save'; id: number; sound: ClipPcm | null };

export type FromWorker =
  | { type: 'status'; seconds: number; error: string }
  | { type: 'prepared'; id: number; startMs: number; endMs: number }
  /** soundError: why the clip has no sound, when sound was given but couldn't go in. */
  | { type: 'saved'; id: number; name: string; soundError?: string }
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
/** When each frame arrived, to turn the packets' times into wall-clock times. */
const arrival = new ArrivalClock();
/** The clip `prepare` froze, waiting for its sound. */
let prepared: { id: number; video: ClipVideo } | null = null;

/** Drops what no clip needs any more (see keepFrom). */
function prune() {
  const cut = keepFrom(packets, SECONDS);
  if (cut > 0) packets = packets.slice(cut);
}

const buffered = () => (packets.length ? packets[packets.length - 1].timestamp - packets[0].timestamp : 0);

async function run(frames: ReadableStream<VideoFrame>) {
  const config = await pickConfig();
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig) decoderConfig = meta.decoderConfig;
      const packet = EncodedPacket.fromEncodedChunk(chunk);
      // After the capture's clock restarted, start again from its first keyframe.
      if (packets.length && goesBack(packets[packets.length - 1].timestamp, packet.timestamp)) packets = [];
      // Until the first keyframe there's nothing a clip could start from.
      if (!packets.length && packet.type !== 'key') return;
      packets.push(packet);
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
    // The capture restarted its clock: start the timing over, with a keyframe first.
    if (goesBack(lastAt, frame.timestamp)) {
      lastAt = -Infinity;
      lastKeyAt = -Infinity;
      arrival.reset();
    }
    arrival.add(frame.timestamp / 1e6, wallNow());
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

/** Freezes the clip (the packets as they are now) and says when it began and ended. */
function prepare(id: number) {
  const clip = packets.slice();
  if (!clip.length || !decoderConfig || !arrival.ready) throw new Error('Nothing recorded yet.');
  prepared = { id, video: { packets: clip, decoderConfig } };
  const last = clip[clip.length - 1];
  post({
    type: 'prepared',
    id,
    startMs: arrival.wallMs(clip[0].timestamp),
    endMs: arrival.wallMs(last.timestamp + (last.duration || 1 / FPS)),
  });
}

async function save(id: number, sound: ClipPcm | null) {
  if (prepared?.id !== id) throw new Error('Nothing recorded yet.');
  const { video } = prepared;
  prepared = null;
  let file: ArrayBuffer | null = null;
  let soundError: string | undefined;
  if (sound) {
    // AAC plays everywhere; Opus is the fallback where the browser can't encode it.
    const codec = await pickAudioCodec();
    if (!codec) soundError = 'This browser can’t encode sound.';
    else {
      try {
        file = await muxClip(video, sound, codec);
      } catch (err) {
        soundError = err instanceof Error ? err.message : String(err);
      }
    }
  }
  file ??= await muxClip(video, null);
  const res = await fetch('/api/clips', {
    method: 'POST',
    headers: { 'Content-Type': 'video/mp4' },
    body: file,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Couldn’t save the clip (${res.status})`);
  post({ type: 'saved', id, name: json.name, soundError });
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
  } else if (msg.type === 'prepare') {
    try {
      prepare(msg.id);
    } catch (err) {
      post({ type: 'failed', id: msg.id, error: err instanceof Error ? err.message : String(err) });
    }
  } else if (msg.type === 'save') {
    save(msg.id, msg.sound).catch((err) => post({ type: 'failed', id: msg.id, error: err instanceof Error ? err.message : String(err) }));
  }
};

setInterval(() => post({ type: 'status', seconds: Math.floor(buffered()), error }), 1000);
