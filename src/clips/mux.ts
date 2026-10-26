import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  Quality,
  canEncodeAudio,
} from 'mediabunny';
import type { AudioCodec, EncodedPacket } from 'mediabunny';
import type { ClipPcm } from '../native';
import { chunks, framesFor, mixTracks, s16ToF32, sliceFrames } from './pcm';

// Writes a clip's MP4: the video as it was encoded, and when the app gave us the sound, four audio
// tracks in this order, so an editor (DaVinci Resolve) can mix them:
//   1 Mix      game + Discord + mic summed (clamped); the default one, which is all that players,
//              phones, Discord's embeds and the in-app player look at
//   2 Game, 3 Discord, 4 Mic    each on its own
// A source that delivered nothing is still a track (silence), so the layout never changes.

/** The track names, in order. */
export const AUDIO_TRACKS = ['Mix', 'Game', 'Discord', 'Mic'] as const;

export const AUDIO_BITRATE = 160_000;
/** Audio goes to the encoder in pieces this long, so a minute never sits in memory as floats. */
const CHUNK_SECONDS = 1;

/** The codec the browser can encode: AAC (plays everywhere), else Opus; null when neither. */
export async function pickAudioCodec(): Promise<'aac' | 'opus' | null> {
  for (const codec of ['aac', 'opus'] as const) {
    const ok = await canEncodeAudio(codec, { numberOfChannels: 2, sampleRate: 48000, bitrate: AUDIO_BITRATE }).catch(() => false);
    if (ok) return codec;
  }
  return null;
}

export interface ClipVideo {
  /** Starting on a keyframe, times in seconds. */
  packets: readonly EncodedPacket[];
  decoderConfig: VideoDecoderConfig;
}

/** The MP4 for these packets, with the sound's four tracks when `sound` is given. */
export async function muxClip(video: ClipVideo, sound: ClipPcm | null, codec: AudioCodec = 'aac'): Promise<ArrayBuffer> {
  const clip = video.packets;
  if (!clip.length) throw new Error('Nothing recorded yet.');
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const videoSource = new EncodedVideoPacketSource('avc');
  // No frameRate here: it would round timestamps to 1/60 s, and captures deliver frames a little unevenly.
  output.addVideoTrack(videoSource);

  const start = clip[0].timestamp;
  const lastPacket = clip[clip.length - 1];
  const span = lastPacket.timestamp - start + (lastPacket.duration || 1 / 60);
  // Audio starts at the clip's first video frame and is exactly as long as the video.
  const frames = sound ? framesFor(span, sound.rate) : 0;
  const audio = sound && frames > 0 ? sound : null;
  const sources = audio
    ? AUDIO_TRACKS.map((name, i) => {
        const source = new AudioSampleSource({ codec, quality: new Quality({ bitrate: AUDIO_BITRATE }) });
        output.addAudioTrack(source, { name, disposition: { default: i === 0 } });
        return source;
      })
    : [];

  await output.start();

  // Fed side by side: the output interleaves its tracks, so one waiting on the others would stall.
  const feedVideo = async () => {
    for (let i = 0; i < clip.length; i++) {
      await videoSource.add(clip[i].clone({ timestamp: clip[i].timestamp - start }), i === 0 ? { decoderConfig: video.decoderConfig } : undefined);
    }
  };
  const feedAudio = async (source: AudioSampleSource, floats: (at: number, n: number) => Float32Array) => {
    const rate = audio!.rate;
    for (const [at, n] of chunks(frames, rate * CHUNK_SECONDS)) {
      const sample = new AudioSample({ data: floats(at, n), format: 'f32', numberOfChannels: 2, sampleRate: rate, timestamp: at / rate });
      try {
        await source.add(sample);
      } finally {
        sample.close();
      }
    }
  };

  const jobs: Promise<void>[] = [feedVideo()];
  if (audio) {
    const own = [audio.game, audio.discord, audio.mic].map((pcm) => sliceFrames(pcm, 0, frames));
    const piece = (pcm: Int16Array, at: number, n: number) => s16ToF32(pcm.subarray(at * 2, (at + n) * 2));
    jobs.push(
      feedAudio(sources[0], (at, n) => mixTracks(own.map((pcm) => piece(pcm, at, n)))),
      feedAudio(sources[1], (at, n) => piece(own[0], at, n)),
      feedAudio(sources[2], (at, n) => piece(own[1], at, n)),
      feedAudio(sources[3], (at, n) => piece(own[2], at, n)),
    );
  }
  await Promise.all(jobs);
  await output.finalize();
  return output.target.buffer!;
}
