import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, Quality } from 'mediabunny';
import { DISCORD_AUDIO_BITRATE, DISCORD_FRAME_RATE, VERTICAL, discordBitrate, discordSize, mixOnly, verticalCrop } from './plan';
import type { Trim } from './plan';
import { clipUrl } from './replay';

// Re-encodes a saved clip in the page, with the browser's own video encoder (WebCodecs, on the
// graphics card when it has one) through mediabunny. Two outputs:
//   vertical  the 9:16 slice at 1080 x 1920, 60 fps, 12 Mbps: the short that gets saved
//   discord   a 720p-class, 30 fps copy sized by length to fit Discord's 10 MB limit
// A clip made with sound has four audio tracks (Mix, Game, Discord, Mic; see mux.ts). Both outputs keep
// only the first, the Mix, so they stay small and play everywhere. The vertical one carries it over
// as it is; the Discord copy re-encodes it small and leaves room for it in the size it aims for.
// Clips and downloads without sound stay without.

export interface Job {
  /** The saved clip to start from. */
  name: string;
  /** Seconds to keep, or null for the whole clip. */
  trim: Trim | null;
  /** Where the 9:16 slice sits, 0 (left) to 1 (right). null keeps the whole 16:9 picture. */
  frame: number | null;
  target: 'vertical' | 'discord';
  /** Below 1 asks a Discord copy for fewer bits than the length calls for, for a retry that came out too big. */
  squeeze?: number;
}

const cancelled = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });
export const wasCancelled = (err: unknown) => err instanceof Error && err.name === 'AbortError';

/** Makes the video and gives it back as a file. `onProgress` gets 0 to 1; abort `signal` to stop. */
export async function transcode(job: Job, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<Blob> {
  const res = await fetch(clipUrl(job.name), { signal });
  if (!res.ok) throw new Error('Couldn’t open that clip. It may have been moved or deleted.');
  const input = new Input({ source: new BlobSource(await res.blob()), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('That file has no video in it.');
    // A vertical short is always the slice; without a chosen spot it is the middle.
    const spot = job.frame ?? (job.target === 'vertical' ? 0.5 : null);
    const crop = spot === null ? undefined : verticalCrop(track.displayWidth, track.displayHeight, spot);
    const sound = (await input.getPrimaryAudioTrack()) !== null;
    const start = job.trim?.start ?? 0;
    const end = job.trim?.end ?? (await input.computeDuration());

    const video =
      job.target === 'vertical'
        ? {
            crop,
            width: VERTICAL.width,
            height: VERTICAL.height,
            // The slice is 608 x 1080, a hair off 9:16, so filling the frame stretches it by under 0.1%.
            fit: 'fill' as const,
            frameRate: VERTICAL.frameRate,
            quality: new Quality({ bitrate: VERTICAL.bitrate, bitrateMode: 'variable' }),
          }
        : {
            crop,
            ...discordSize(crop?.width ?? track.displayWidth, crop?.height ?? track.displayHeight),
            fit: 'fill' as const,
            frameRate: DISCORD_FRAME_RATE,
            // Constant, so the size stays close to what the length was worked out for.
            quality: new Quality({
              bitrate: Math.round(discordBitrate(end - start, sound ? DISCORD_AUDIO_BITRATE : 0) * (job.squeeze ?? 1)),
              bitrateMode: 'constant',
            }),
          };

    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    const conversion = await Conversion.init({
      input,
      output,
      trim: { start, end },
      ...mixOnly(job.target),
      video: { ...video, codec: 'avc', hardwareAcceleration: 'prefer-hardware', keyFrameInterval: 2, forceTranscode: true },
      showWarnings: false,
    });
    if (!conversion.isValid) throw new Error('This browser can’t encode H.264 video. Use Chrome or Edge.');
    conversion.onProgress = onProgress;
    const stop = () => void conversion.cancel();
    signal.addEventListener('abort', stop);
    try {
      await conversion.execute();
    } finally {
      signal.removeEventListener('abort', stop);
    }
    if (signal.aborted) throw cancelled();
    return new Blob([output.target.buffer!], { type: 'video/mp4' });
  } finally {
    input.dispose();
  }
}
