using UncboxShell;

namespace UncboxShell.Tests;

/// <summary>
/// A mic folded to one voice in the middle (AudioKit.VoiceFold): an audio interface's mic on one
/// input of two must come out on both sides at its own level, not on one side, and not halved.
/// </summary>
public class VoiceFoldTests
{
    private const int Rate = 48000;
    /// <summary>10 ms, as WASAPI hands a mic over.</summary>
    private const int Frames = 480;

    /// <summary>One buffer of 32-bit float frames: each channel's value at frame i.</summary>
    private static byte[] Buffer(int channels, Func<int, int, float> sample, int start = 0)
    {
        var bytes = new byte[Frames * channels * 4];
        for (int i = 0; i < Frames; i++)
        {
            for (int c = 0; c < channels; c++)
            {
                BitConverter.TryWriteBytes(bytes.AsSpan((i * channels + c) * 4, 4), sample(start + i, c));
            }
        }
        return bytes;
    }

    /// <summary>A voice-like tone at -12 dBFS.</summary>
    private static float Voice(int i) => 0.25f * MathF.Sin(i * 2 * MathF.PI * 220 / Rate);

    /// <summary>An empty input's hiss, about -66 dBFS.</summary>
    private static float Hiss(int i) => 0.0005f * MathF.Sin(i * 1.7f + 0.3f);

    /// <summary>Feeds `buffers` buffers and returns the last one's stereo frames.</summary>
    private static float[] Feed(AudioKit.VoiceFold fold, int channels, Func<int, int, float> sample, int buffers, int start = 0)
    {
        var stereo = new float[Frames * 2];
        for (int b = 0; b < buffers; b++) fold.Decode(Buffer(channels, sample, start + b * Frames), true, 32, stereo);
        return stereo;
    }

    private static float Peak(float[] stereo, int side) => Enumerable.Range(0, Frames).Max(i => MathF.Abs(stereo[i * 2 + side]));

    [Fact]
    public void A_focusrite_mic_on_input_1_is_in_the_middle_at_its_full_level()
    {
        var fold = new AudioKit.VoiceFold(2, Rate);
        var stereo = Feed(fold, 2, (i, c) => c == 0 ? Voice(i) : Hiss(i), 20);
        Assert.Equal(0.25f, Peak(stereo, 0), 2);
        Assert.Equal(0.25f, Peak(stereo, 1), 2);
        Assert.Equal(1f, fold.Weights[0], 3);
        Assert.Equal(0f, fold.Weights[1], 3);
    }

    [Fact]
    public void A_mic_on_input_2_is_found_too()
    {
        var fold = new AudioKit.VoiceFold(2, Rate);
        var stereo = Feed(fold, 2, (i, c) => c == 1 ? Voice(i) : Hiss(i), 20);
        Assert.Equal(0.25f, Peak(stereo, 0), 2);
        Assert.Equal(1f, fold.Weights[1], 3);
    }

    [Fact]
    public void A_usb_mic_sending_the_same_on_both_channels_stays_as_it_was()
    {
        var fold = new AudioKit.VoiceFold(2, Rate);
        var stereo = Feed(fold, 2, (i, _) => Voice(i), 10);
        // Averaged, not added: not doubled.
        Assert.Equal(0.25f, Peak(stereo, 0), 2);
        Assert.Equal(0.5f, fold.Weights[0], 3);
        Assert.Equal(0.5f, fold.Weights[1], 3);
    }

    [Fact]
    public void Two_mics_on_one_interface_are_both_kept_while_both_are_talking()
    {
        var fold = new AudioKit.VoiceFold(2, Rate);
        Feed(fold, 2, (i, c) => c == 0 ? Voice(i) : 0.2f * MathF.Sin(i * 2 * MathF.PI * 330 / Rate), 20);
        Assert.True(fold.Weights[0] > 0.4f && fold.Weights[1] > 0.4f);
    }

    [Fact]
    public void It_finds_the_voice_within_a_few_buffers_and_fades_without_a_click()
    {
        var fold = new AudioKit.VoiceFold(2, Rate);
        // Silence first: both alike.
        Feed(fold, 2, (i, _) => 0f, 5);
        Assert.Equal(0.5f, fold.Weights[0], 3);
        // Then the voice on input 1: within 50 ms it has the whole level.
        var stereo = new float[Frames * 2];
        float jump = 0, last = 0;
        for (int b = 0; b < 5; b++)
        {
            fold.Decode(Buffer(2, (i, c) => c == 0 ? Voice(i) : Hiss(i), b * Frames), true, 32, stereo);
            for (int i = 0; i < Frames; i++)
            {
                jump = Math.Max(jump, MathF.Abs(stereo[i * 2] - last));
                last = stereo[i * 2];
            }
        }
        Assert.Equal(1f, fold.Weights[0], 3);
        // A 220 Hz tone at 0.25 moves at most about 0.0072 a sample: anything much bigger would be a click.
        Assert.True(jump < 0.01f, $"jump {jump}");
    }

    [Fact]
    public void A_mono_mic_is_copied_to_both_sides()
    {
        var fold = new AudioKit.VoiceFold(1, Rate);
        var stereo = Feed(fold, 1, (i, _) => Voice(i), 1);
        for (int i = 0; i < Frames; i++) Assert.Equal(stereo[i * 2], stereo[i * 2 + 1]);
        Assert.Equal(0.25f, Peak(stereo, 0), 2);
    }

    [Fact]
    public void It_reads_16_bit_whole_numbers_like_the_rest()
    {
        var fold = new AudioKit.VoiceFold(2, Rate);
        var bytes = new byte[Frames * 2 * 2];
        for (int i = 0; i < Frames; i++) BitConverter.TryWriteBytes(bytes.AsSpan(i * 4, 2), (short)(Voice(i) * 32767));
        var stereo = new float[Frames * 2];
        for (int b = 0; b < 10; b++) Assert.Equal(Frames, fold.Decode(bytes, false, 16, stereo));
        Assert.Equal(0.25f, Peak(stereo, 1), 2);
    }
}
