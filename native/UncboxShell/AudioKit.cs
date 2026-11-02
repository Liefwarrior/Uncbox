using System.Buffers.Binary;
using NAudio.CoreAudioApi;

namespace UncboxShell;

/// <summary>
/// The pieces every Uncbox audio capture shares: the 48 kHz stereo timeline (10 ms blocks), turning
/// a device's bytes into that format, the small per-source queue, the clock and the drift rule, and
/// finding the microphones. The stream's sound (StreamAudio.cs) and the clips' (ClipAudio.cs) both
/// build on it.
/// </summary>
internal static class AudioKit
{
    public const int Rate = 48000;
    public const int Channels = 2;
    /// <summary>Frames in one written block: 10 ms.</summary>
    public const int BlockFrames = 480;
    /// <summary>What a source's small queue holds at most: 200 ms.</summary>
    public const int RingFrames = Rate / 5;
    /// <summary>A source's queue should stay under this (100 ms); over it for a while means its clock runs fast.</summary>
    public const int StandingFrames = Rate / 10;
    /// <summary>Blocks (10 ms each) over StandingFrames before the excess is dropped: 300 ms.</summary>
    public const int OverBlocksBeforeDrop = 30;
    /// <summary>What is kept when the excess is dropped: 40 ms.</summary>
    public const int KeepFrames = Rate / 25;
    /// <summary>A source waits for this much (20 ms) before it starts being read, so late callbacks don't leave gaps.</summary>
    public const int PrimeFrames = BlockFrames * 2;

    /// <summary>The active microphones, for the page's picker.</summary>
    public static object ListMics()
    {
        var mics = new List<object>();
        try
        {
            using var enumerator = new MMDeviceEnumerator();
            string? defaultId = null;
            try
            {
                using var def = enumerator.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Console);
                defaultId = def.ID;
            }
            catch (Exception)
            {
                // No mic at all.
            }
            foreach (var device in enumerator.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active))
            {
                using (device)
                {
                    string name;
                    try
                    {
                        name = device.FriendlyName;
                    }
                    catch (Exception)
                    {
                        continue;
                    }
                    mics.Add(new { id = device.ID, name, isDefault = device.ID == defaultId });
                }
            }
        }
        catch (Exception)
        {
            // Windows' audio service isn't answering: an empty list says there's no mic to pick.
        }
        return new { type = "audiodevices", mics };
    }

    /// <summary>
    /// How many 10 ms blocks should have been written by now, less those that were: how far behind
    /// the wall clock the stream is. Writing exactly this many keeps the audio as long as the picture.
    /// </summary>
    internal static long BlocksDue(double elapsedSeconds, long blocksWritten) =>
        (long)Math.Floor(elapsedSeconds * Rate / BlockFrames) - blocksWritten;

    /// <summary>
    /// How many frames to throw away from a source's buffer. A device's clock that runs a little fast
    /// slowly fills its buffer; once it has held more than 100 ms for 300 ms straight, everything
    /// above 40 ms goes (a small click, rather than sound that lags further and further).
    /// </summary>
    internal static int FramesToDrop(int bufferedFrames, int blocksOver) =>
        bufferedFrames > StandingFrames && blocksOver >= OverBlocksBeforeDrop ? bufferedFrames - KeepFrames : 0;

    /// <summary>Whether DecodeToStereo understands a device's sample format.</summary>
    internal static bool CanDecode(bool isFloat, int bitsPerSample, int channels) =>
        channels >= 1 && (isFloat ? bitsPerSample == 32 : bitsPerSample is 8 or 16 or 24 or 32);

    /// <summary>
    /// Turns a device's bytes (little-endian: 8, 16, 24 or 32-bit whole numbers, or 32-bit float; any
    /// number of channels) into interleaved stereo floats at the device's own rate, and returns the
    /// frames. Mono is copied to both sides; more than two channels are folded down (see Downmix).
    /// </summary>
    internal static int DecodeToStereo(ReadOnlySpan<byte> source, bool isFloat, int bitsPerSample, int channels, Span<float> stereo)
    {
        int bytes = bitsPerSample / 8;
        int frames = source.Length / (bytes * channels);
        Span<float> frame = stackalloc float[8];
        for (int i = 0; i < frames; i++)
        {
            int at = i * bytes * channels;
            int n = Math.Min(channels, 8);
            for (int c = 0; c < n; c++) frame[c] = ReadSample(source.Slice(at + c * bytes, bytes), isFloat, bytes);
            Downmix(frame, channels, out stereo[i * 2], out stereo[i * 2 + 1]);
        }
        return frames;
    }

    private static float ReadSample(ReadOnlySpan<byte> s, bool isFloat, int bytes) => bytes switch
    {
        4 when isFloat => BinaryPrimitives.ReadSingleLittleEndian(s),
        4 => BinaryPrimitives.ReadInt32LittleEndian(s) / 2147483648f,
        3 => ((s[0] << 8 | s[1] << 16 | s[2] << 24) >> 8) / 8388608f,
        2 => BinaryPrimitives.ReadInt16LittleEndian(s) / 32768f,
        _ => (s[0] - 128) / 128f,
    };

    /// <summary>
    /// One frame of any channel count as left and right, with the usual Windows channel order
    /// (front left, front right, centre, bass, then the sides and back). The centre and the
    /// surround channels are mixed in at 0.71 each, the bass is left out, and with more than two
    /// channels everything is scaled by 0.59 so a loud film mix doesn't clip.
    /// </summary>
    internal static void Downmix(ReadOnlySpan<float> f, int channels, out float left, out float right)
    {
        const float Side = 0.7071f, Scale = 0.5858f;
        switch (channels)
        {
            case 1:
                left = right = f[0];
                return;
            case 2:
                left = f[0];
                right = f[1];
                return;
        }
        float l = f[0], r = f[1], center = 0, sl = 0, sr = 0;
        switch (channels)
        {
            case 3: center = f[2]; break;
            case 4: sl = f[2]; sr = f[3]; break;
            case 5: center = f[2]; sl = f[3]; sr = f[4]; break;
            case 6: center = f[2]; sl = f[4]; sr = f[5]; break;
            case 7: center = f[2] + f[6]; sl = f[4]; sr = f[5]; break;
            default: center = f[2]; sl = f[4] + f[6]; sr = f[5] + f[7]; break;
        }
        left = (l + Side * (center + sl)) * Scale;
        right = (r + Side * (center + sr)) * Scale;
    }

    // ---- Pieces ----

    /// <summary>
    /// A fixed-size queue of stereo frames. The capture thread writes, the writer thread reads; when
    /// it's full the oldest frames go, so it never grows and never blocks.
    /// </summary>
    internal sealed class FrameRing(int capacityFrames)
    {
        private readonly float[] _data = new float[capacityFrames * Channels];
        private readonly object _lock = new();
        private int _start, _count;

        public int Count
        {
            get
            {
                lock (_lock) return _count;
            }
        }

        public void Write(ReadOnlySpan<float> stereo, int frames)
        {
            lock (_lock)
            {
                if (frames > capacityFrames)
                {
                    stereo = stereo[((frames - capacityFrames) * Channels)..];
                    frames = capacityFrames;
                }
                int overflow = _count + frames - capacityFrames;
                if (overflow > 0)
                {
                    _start = (_start + overflow) % capacityFrames;
                    _count -= overflow;
                }
                for (int i = 0; i < frames; i++)
                {
                    int at = (_start + _count + i) % capacityFrames * Channels;
                    _data[at] = stereo[i * 2];
                    _data[at + 1] = stereo[i * 2 + 1];
                }
                _count += frames;
            }
        }

        /// <summary>Moves up to the asked frames into the front of destination, oldest first, and returns how many.</summary>
        public int Read(Span<float> destination, int frames)
        {
            lock (_lock)
            {
                int n = Math.Min(frames, _count);
                for (int i = 0; i < n; i++)
                {
                    int at = (_start + i) % capacityFrames * Channels;
                    destination[i * 2] = _data[at];
                    destination[i * 2 + 1] = _data[at + 1];
                }
                Skip(n);
                return n;
            }
        }

        public void Drop(int frames)
        {
            lock (_lock) Skip(Math.Min(frames, _count));
        }

        public void Clear()
        {
            lock (_lock) _start = _count = 0;
        }

        private void Skip(int frames)
        {
            _start = (_start + frames) % capacityFrames;
            _count -= frames;
        }
    }

    /// <summary>
    /// Stereo sample-rate conversion by straight-line interpolation, one chunk after another: the
    /// position and the last frame carry over, so chunk edges don't click. Plenty for speech and
    /// game sound, and light enough to run in a capture callback.
    /// </summary>
    internal sealed class StereoResampler(int inputRate, int outputRate)
    {
        private readonly double _step = (double)inputRate / outputRate;
        // Where the next output frame sits in the next chunk, in input frames; -1 is the last frame of the one before.
        private double _position;
        private float _lastL, _lastR;

        /// <summary>Resamples stereo input into output (big enough for ceil(frames * out / in) + 2 frames) and returns the frames written.</summary>
        public int Process(ReadOnlySpan<float> input, int frames, Span<float> output)
        {
            if (frames == 0) return 0;
            int written = 0;
            while (_position < frames - 1)
            {
                int i0 = (int)Math.Floor(_position);
                float frac = (float)(_position - i0);
                float l0, r0;
                if (i0 < 0)
                {
                    l0 = _lastL;
                    r0 = _lastR;
                }
                else
                {
                    l0 = input[i0 * 2];
                    r0 = input[i0 * 2 + 1];
                }
                float l1 = input[(i0 + 1) * 2], r1 = input[(i0 + 1) * 2 + 1];
                output[written * 2] = l0 + (l1 - l0) * frac;
                output[written * 2 + 1] = r0 + (r1 - r0) * frac;
                written++;
                _position += _step;
            }
            _position -= frames;
            _lastL = input[(frames - 1) * 2];
            _lastR = input[(frames - 1) * 2 + 1];
            return written;
        }
    }
}
