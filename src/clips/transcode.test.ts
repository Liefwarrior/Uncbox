import { ALL_FORMATS, BufferSource, BufferTarget, Conversion, EncodedPacket, Input, Mp4OutputFormat, Output } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import type { ClipPcm } from '../native';
import { muxClip } from './mux';
import { DISCORD_AUDIO_BITRATE, mixOnly } from './plan';

// Make vertical and the Discord copy keep only a clip's first audio track, the Mix. The video can't
// be re-encoded here (no WebCodecs in tests), so these convert the sound alone, with the same
// track and audio options transcode.ts uses.

const SPS = [0x67, 0x64, 0x00, 0x2a, 0xac, 0xd9, 0x40, 0x78, 0x02, 0x27, 0xe5, 0xc0, 0x44, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xf0, 0x3c, 0x60, 0xc6, 0x58];
const PPS = [0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0];
const decoderConfig: VideoDecoderConfig = {
  codec: 'avc1.64002A',
  codedWidth: 1920,
  codedHeight: 1080,
  description: new Uint8Array([1, SPS[1], SPS[2], SPS[3], 0xff, 0xe1, 0, SPS.length, ...SPS, 1, 0, PPS.length, ...PPS]),
};

const RATE = 48000;
const packets = Array.from({ length: 120 }, (_, i) => new EncodedPacket(new Uint8Array([0, 0, 0, 2, 0x65, 0x88]), i % 60 === 0 ? 'key' : 'delta', i / 60, 1 / 60));
const tone = (level: number) => Int16Array.from({ length: 2 * RATE * 2 }, (_, i) => Math.round(level * 32767 * Math.sin(i / 20)));

async function open(buffer: ArrayBuffer) {
  return new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
}

describe('the sound of a vertical short or a Discord copy', () => {
  it('keeps the Mix and drops Game, Discord and Mic', async () => {
    const sound: ClipPcm = { frames: 2 * RATE, rate: RATE, game: tone(0.5), discord: tone(0.2), mic: tone(0.1) };
    const clip = await open(await muxClip({ packets, decoderConfig }, sound, 'pcm-s16'));
    expect((await clip.getAudioTracks()).map((t) => t.name)).toEqual(['Mix', 'Game', 'Discord', 'Mic']);

    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    const conversion = await Conversion.init({ input: clip, output, trim: { start: 0.5, end: 1.5 }, video: { discard: true }, ...mixOnly('vertical'), showWarnings: false });
    await conversion.execute();

    const result = await open(output.target.buffer!);
    const audio = await result.getAudioTracks();
    expect(audio).toHaveLength(1);
    expect(audio[0].name).toBe('Mix');
    // Trimmed to a second (PCM packets are cut where the encoder made them, so a little over).
    expect(Math.abs((await audio[0].computeDuration()) - 1)).toBeLessThan(0.1);
  });

  it('leaves a clip with no sound without any', async () => {
    const clip = await open(await muxClip({ packets, decoderConfig }, null));
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    const conversion = await Conversion.init({ input: clip, output, video: { discard: true }, ...mixOnly('discord'), showWarnings: false });
    expect(conversion.utilizedTracks).toHaveLength(0);
  });

  it('asks for the Discord copy’s sound small, in AAC', () => {
    expect(mixOnly('discord')).toMatchObject({
      tracks: 'primary',
      audio: { codec: 'aac', numberOfChannels: 2, forceTranscode: true },
    });
    expect(DISCORD_AUDIO_BITRATE).toBe(64_000);
    expect(mixOnly('vertical')).toEqual({ tracks: 'primary', audio: {} });
  });
});
