import { ALL_FORMATS, BufferSource, EncodedPacket, Input } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import type { ClipPcm } from '../native';
import { AUDIO_TRACKS, muxClip } from './mux';

// The clip file's layout, written with the lossless PCM codec (the browser's AAC encoder doesn't
// exist in tests; the track order, names and defaults don't depend on the codec).

// A real 1080p High-profile SPS and PPS in an avcC record, so the muxer has a valid decoder config.
const SPS = [0x67, 0x64, 0x00, 0x2a, 0xac, 0xd9, 0x40, 0x78, 0x02, 0x27, 0xe5, 0xc0, 0x44, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xf0, 0x3c, 0x60, 0xc6, 0x58];
const PPS = [0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0];
const AVCC = new Uint8Array([1, SPS[1], SPS[2], SPS[3], 0xff, 0xe1, 0, SPS.length, ...SPS, 1, 0, PPS.length, ...PPS]);
const decoderConfig: VideoDecoderConfig = { codec: 'avc1.64002A', codedWidth: 1920, codedHeight: 1080, description: AVCC };

/** `seconds` of 60 fps video starting at `from`, a keyframe each second; the picture bytes are nothing real. */
function packets(seconds: number, from = 5) {
  const out: EncodedPacket[] = [];
  for (let i = 0; i < seconds * 60; i++) {
    out.push(new EncodedPacket(new Uint8Array([0, 0, 0, 2, 0x65, 0x88]), i % 60 === 0 ? 'key' : 'delta', from + i / 60, 1 / 60));
  }
  return out;
}

const RATE = 48000;
const tone = (frames: number, level: number) => {
  const pcm = new Int16Array(frames * 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(level * 32767 * Math.sin(i / 20));
  return pcm;
};

async function read(buffer: ArrayBuffer) {
  const input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
  return { input, video: await input.getVideoTracks(), audio: await input.getAudioTracks() };
}

describe('muxClip', () => {
  it('writes the video alone when there is no sound', async () => {
    const { video, audio } = await read(await muxClip({ packets: packets(2), decoderConfig }, null, 'pcm-s16'));
    expect(video).toHaveLength(1);
    expect(audio).toHaveLength(0);
  });

  it('writes Mix, Game, Discord and Mic in that order, with only the Mix as the default', async () => {
    const sound: ClipPcm = { frames: 2 * RATE, rate: RATE, game: tone(2 * RATE, 0.5), discord: tone(2 * RATE, 0.25), mic: new Int16Array(2 * RATE * 2) };
    const { input, video, audio } = await read(await muxClip({ packets: packets(2), decoderConfig }, sound, 'pcm-s16'));
    expect(video).toHaveLength(1);
    expect(audio.map((t) => t.name)).toEqual([...AUDIO_TRACKS]);
    expect(audio.map((t) => t.disposition.default)).toEqual([true, false, false, false]);
    expect(audio.every((t) => t.numberOfChannels === 2 && t.sampleRate === RATE)).toBe(true);
    // The Mix is what the primary track is, and so what a player plays.
    expect((await input.getPrimaryAudioTrack())?.name).toBe('Mix');
    // Audio starts with the first video frame and runs as long as the video.
    for (const t of audio) {
      expect(await t.getFirstTimestamp()).toBeCloseTo(0, 3);
      expect(await t.computeDuration()).toBeCloseTo(2, 2);
    }
  });

  it('still writes four tracks when a source delivered nothing, and cuts sound that runs long', async () => {
    const sound: ClipPcm = { frames: 5 * RATE, rate: RATE, game: tone(5 * RATE, 0.5), discord: new Int16Array(0), mic: new Int16Array(10) };
    const { audio } = await read(await muxClip({ packets: packets(1.5), decoderConfig }, sound, 'pcm-s16'));
    expect(audio.map((t) => t.name)).toEqual([...AUDIO_TRACKS]);
    for (const t of audio) expect(await t.computeDuration()).toBeCloseTo(1.5, 2);
  });
});
