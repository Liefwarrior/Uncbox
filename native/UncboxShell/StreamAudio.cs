using System.Buffers.Binary;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;
using NAudio.Wave;
using static UncboxShell.AudioKit;

namespace UncboxShell;

/// <summary>
/// The sound of a stream: what Windows plays (WASAPI loopback of the default speakers) and a mic,
/// mixed into one raw audio stream that FFmpeg reads through a named pipe. FFmpeg can't capture
/// Windows' sound by itself, so the page asks for this (see src/native.ts for its side of the
/// messages, and ShellForm.cs).
///
/// On the pipe: interleaved 32-bit float, little-endian, 48 000 Hz, 2 channels, no header. Once FFmpeg
/// has connected, exactly real time is written, one 10 ms block (480 frames) per 10 ms of the clock,
/// mixed from whatever each source delivered and silence where one delivered nothing (loopback
/// delivers nothing while nothing plays). That steady clock is what keeps the sound in step with
/// the picture. The capture callbacks only fill a small buffer per source and never wait on the pipe.
///
/// One instance is one session: Start it once, Dispose it to stop. If FFmpeg closes the pipe, the
/// session stops itself and says "off".
/// </summary>
internal sealed class StreamAudio : IDisposable
{
    private const int LevelEveryBlocks = 10;
    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(20);

    [DllImport("winmm.dll")]
    private static extern uint timeBeginPeriod(uint ms);

    [DllImport("winmm.dll")]
    private static extern uint timeEndPeriod(uint ms);

    private readonly Action<object> _post;
    private readonly object _gate = new();
    private readonly CancellationTokenSource _cts = new();
    private Source? _desktop;
    private Source? _mic;
    private NamedPipeServerStream? _pipe;
    private Thread? _writer;
    private MMDeviceEnumerator? _devices;
    private LoopbackWatcher? _watcher;
    private volatile float _desktopGain = 1, _micGain = 1;
    private int _closed;

    /// <param name="post">Sends a message to the page. Called from any thread.</param>
    public StreamAudio(Action<object> post) => _post = post;

    /// <summary>
    /// Opens the sources and the pipe, and tells the page where the pipe is. mic is a device id,
    /// "default", or null for no mic. Failures are reported to the page as "error" and leave
    /// nothing running.
    /// </summary>
    public void Start(bool desktop, string? mic, double desktopVolume, double micVolume)
    {
        _desktopGain = ClampGain(desktopVolume, 1);
        _micGain = ClampGain(micVolume, 1);
        try
        {
            _devices = new MMDeviceEnumerator();
            if (desktop)
            {
                _desktop = new Source();
                try
                {
                    _desktop.Attach(OpenLoopback());
                }
                catch (Exception)
                {
                    throw new StreamAudioException("Couldn't record your desktop sound.");
                }
                _watcher = new LoopbackWatcher(() => Task.Run(ReopenLoopback));
                try
                {
                    _devices.RegisterEndpointNotificationCallback(_watcher);
                }
                catch (Exception)
                {
                    // Without it the sound just doesn't follow a change of speakers.
                    _watcher = null;
                }
            }
            if (mic is not null)
            {
                _mic = new Source();
                var capture = OpenMic(mic);
                try
                {
                    _mic.Attach(capture);
                }
                catch (StreamAudioException)
                {
                    throw;
                }
                catch (Exception)
                {
                    throw new StreamAudioException("That mic isn't connected.");
                }
            }

            string name = "uncbox-stream-audio-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(4)).ToLowerInvariant();
            _pipe = new NamedPipeServerStream(name, PipeDirection.Out, 1, PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly, 0, 64 * 1024);
            _writer = new Thread(WriterLoop) { IsBackground = true, Name = "Uncbox stream audio", Priority = ThreadPriority.AboveNormal };
            _writer.Start();
            _post(new { type = "streamaudio", state = "ready", pipe = @"\\.\pipe\" + name, rate = Rate, channels = Channels, format = "f32le" });
        }
        catch (Exception err)
        {
            Stop(err is StreamAudioException ? err.Message : "Couldn't set up the stream's sound.");
        }
    }

    /// <summary>Changes the gains (0 to 2) while the session runs.</summary>
    public void SetVolumes(double desktopVolume, double micVolume)
    {
        _desktopGain = ClampGain(desktopVolume, _desktopGain);
        _micGain = ClampGain(micVolume, _micGain);
    }

    private static WasapiCapture OpenLoopback()
    {
        using var enumerator = new MMDeviceEnumerator();
        return new WasapiLoopbackCapture(enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Console));
    }

    private WasapiCapture OpenMic(string id)
    {
        try
        {
            using var enumerator = new MMDeviceEnumerator();
            var device = id == "default"
                ? enumerator.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Console)
                : enumerator.GetDevice(id);
            if (device.State != DeviceState.Active) throw new StreamAudioException("That mic isn't connected.");
            return new WasapiCapture(device);
        }
        catch (StreamAudioException)
        {
            throw;
        }
        catch (UnauthorizedAccessException)
        {
            throw new StreamAudioException("Windows isn't letting Uncbox use the mic. Check Settings > Privacy & security > Microphone.");
        }
        catch (Exception)
        {
            throw new StreamAudioException("That mic isn't connected.");
        }
    }

    /// <summary>The default speakers changed while streaming: listen to the new ones instead.</summary>
    private void ReopenLoopback()
    {
        lock (_gate)
        {
            if (_closed != 0 || _desktop is null) return;
            _desktop.Detach();
            try
            {
                _desktop.Attach(OpenLoopback());
            }
            catch (Exception)
            {
                // No speakers to listen to for now: the stream carries silence for the desktop.
            }
        }
    }

    private void WriterLoop()
    {
        var pipe = _pipe!;
        var ct = _cts.Token;
        try
        {
            // Wait for FFmpeg to open the pipe.
            var connect = pipe.WaitForConnectionAsync(ct);
            if (!connect.Wait(ConnectTimeout, ct))
            {
                Stop("FFmpeg didn't start.");
                return;
            }
        }
        catch (Exception)
        {
            if (!ct.IsCancellationRequested) Stop("FFmpeg didn't start.");
            return;
        }

        timeBeginPeriod(1);
        try
        {
            // Whatever was captured while waiting is old news: start from now.
            _desktop?.Clear();
            _mic?.Clear();
            var desktop = new float[BlockFrames * Channels];
            var mic = new float[BlockFrames * Channels];
            var mixed = new float[BlockFrames * Channels];
            var bytes = new byte[mixed.Length * sizeof(float)];
            float desktopGain = _desktopGain, micGain = _micGain;
            float desktopPeak = 0, micPeak = 0;
            long written = 0;
            var clock = Stopwatch.StartNew();
            while (!ct.IsCancellationRequested)
            {
                if (BlocksDue(clock.Elapsed.TotalSeconds, written) <= 0)
                {
                    Thread.Sleep(1);
                    continue;
                }
                if (_desktop is { } d) d.TakeBlock(desktop); else Array.Clear(desktop);
                if (_mic is { } m) m.TakeBlock(mic); else Array.Clear(mic);
                float nextDesktop = _desktopGain, nextMic = _micGain;
                MixBlock(desktop, mic, desktopGain, nextDesktop, micGain, nextMic, mixed, out float dp, out float mp);
                desktopGain = nextDesktop;
                micGain = nextMic;
                desktopPeak = Math.Max(desktopPeak, dp);
                micPeak = Math.Max(micPeak, mp);

                MemoryMarshal.AsBytes(mixed.AsSpan()).CopyTo(bytes);
                // Cancelled by Dispose; throws IOException when FFmpeg has closed its end.
                pipe.WriteAsync(bytes, 0, bytes.Length, ct).GetAwaiter().GetResult();
                written++;

                if (written % LevelEveryBlocks == 0)
                {
                    _post(new { type = "audiolevels", desktop = Math.Round(desktopPeak, 3), mic = Math.Round(micPeak, 3) });
                    desktopPeak = micPeak = 0;
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Dispose.
        }
        catch (Exception)
        {
            // FFmpeg closed the pipe (or went away).
            Stop(null);
        }
        finally
        {
            timeEndPeriod(1);
        }
    }

    /// <summary>Ends the session by itself: "off" (or an error) goes to the page, then everything is released.</summary>
    private void Stop(string? error)
    {
        if (!Release()) return;
        object message = error is null
            ? new { type = "streamaudio", state = "off" }
            : new { type = "streamaudio", state = "error", error };
        _post(message);
    }

    /// <summary>Stops the sources and closes the pipe, once. False when that was already done.</summary>
    private bool Release()
    {
        if (Interlocked.Exchange(ref _closed, 1) != 0) return false;
        _cts.Cancel();
        if (_watcher is not null)
        {
            try
            {
                _devices?.UnregisterEndpointNotificationCallback(_watcher);
            }
            catch (Exception)
            {
                // Already gone.
            }
        }
        lock (_gate)
        {
            _desktop?.Dispose();
            _mic?.Dispose();
        }
        try
        {
            _pipe?.Dispose();
        }
        catch (Exception)
        {
            // Nothing left to close.
        }
        _devices?.Dispose();
        return true;
    }

    /// <summary>Stops without telling the page: the caller says what the page should hear.</summary>
    public void Dispose()
    {
        Release();
        // The writer ends on the cancel; don't wait long if it's stuck in a write.
        if (_writer is { } w && w != Thread.CurrentThread) w.Join(1000);
    }

    // ---- The parts that can go wrong: small, pure and static (the shared ones are in AudioKit.cs) ----

    /// <summary>A volume from the page as a gain: 0 to 2, and the fallback for anything that isn't a number.</summary>
    internal static float ClampGain(double value, double fallback)
    {
        if (double.IsNaN(value) || double.IsInfinity(value)) value = fallback;
        return (float)Math.Clamp(value, 0, 2);
    }

    /// <summary>
    /// Mixes one block of each source (interleaved stereo): each source times its gain, summed,
    /// clamped to [-1, 1]. The gain moves in a straight line from its old to its new value across
    /// the block, so a volume change doesn't crackle. The peaks are each source after its gain
    /// (0 to 1), for the level meters.
    /// </summary>
    internal static void MixBlock(ReadOnlySpan<float> desktop, ReadOnlySpan<float> mic,
        float desktopFrom, float desktopTo, float micFrom, float micTo,
        Span<float> output, out float desktopPeak, out float micPeak)
    {
        int frames = output.Length / Channels;
        float dPeak = 0, mPeak = 0;
        for (int i = 0; i < frames; i++)
        {
            float t = (i + 1) / (float)frames;
            float dg = desktopFrom + (desktopTo - desktopFrom) * t;
            float mg = micFrom + (micTo - micFrom) * t;
            for (int c = 0; c < Channels; c++)
            {
                int k = i * Channels + c;
                float d = desktop[k] * dg, m = mic[k] * mg;
                dPeak = Math.Max(dPeak, Math.Abs(d));
                mPeak = Math.Max(mPeak, Math.Abs(m));
                float sum = d + m;
                output[k] = float.IsNaN(sum) ? 0 : Math.Clamp(sum, -1f, 1f);
            }
        }
        desktopPeak = Math.Min(dPeak, 1f);
        micPeak = Math.Min(mPeak, 1f);
    }

    // ---- Pieces ----

    private sealed class StreamAudioException(string message) : Exception(message);

    /// <summary>
    /// One thing being recorded: a capture device, its conversion to 48 kHz stereo, and the buffer
    /// the writer thread takes blocks from.
    /// </summary>
    private sealed class Source : IDisposable
    {
        private readonly FrameRing _ring = new(RingFrames);
        private WasapiCapture? _capture;
        private bool _primed;
        private int _blocksOver;

        public void Attach(WasapiCapture capture)
        {
            var format = capture.WaveFormat;
            var std = format is WaveFormatExtensible ext ? ext.ToStandardWaveFormat() : format;
            bool isFloat = std.Encoding == WaveFormatEncoding.IeeeFloat;
            if (!CanDecode(isFloat, format.BitsPerSample, format.Channels) || format.SampleRate < 8000)
            {
                capture.Dispose();
                throw new StreamAudioException("Couldn't record that sound.");
            }
            int rate = format.SampleRate, bits = format.BitsPerSample, channels = format.Channels;
            bool same = rate == Rate;
            var resampler = same ? null : new StereoResampler(rate, Rate);
            float[] decoded = [], resampled = [];
            capture.DataAvailable += (_, e) =>
            {
                int frameBytes = bits / 8 * channels;
                int frames = e.BytesRecorded / frameBytes;
                if (frames == 0) return;
                if (decoded.Length < frames * 2) decoded = new float[frames * 2];
                DecodeToStereo(e.Buffer.AsSpan(0, frames * frameBytes), isFloat, bits, channels, decoded);
                if (resampler is null)
                {
                    _ring.Write(decoded, frames);
                    return;
                }
                int room = (int)Math.Ceiling(frames * (double)Rate / rate) + 2;
                if (resampled.Length < room * 2) resampled = new float[room * 2];
                int n = resampler.Process(decoded, frames, resampled);
                _ring.Write(resampled, n);
            };
            capture.StartRecording();
            _capture = capture;
        }

        /// <summary>Stops listening to the current device (the buffer keeps what it has).</summary>
        public void Detach()
        {
            var capture = _capture;
            _capture = null;
            if (capture is null) return;
            try
            {
                capture.StopRecording();
            }
            catch (Exception)
            {
                // The device may be gone already.
            }
            capture.Dispose();
        }

        public void Clear()
        {
            _ring.Clear();
            _primed = false;
            _blocksOver = 0;
        }

        /// <summary>
        /// Fills one block (480 stereo frames) from the buffer; what isn't there is silence. Reading
        /// only starts once 20 ms are waiting, and stops again when the buffer runs dry, so a late
        /// callback costs one short silence instead of a stutter. A buffer that keeps holding more
        /// than it should has its excess dropped (FramesToDrop).
        /// </summary>
        public void TakeBlock(Span<float> block)
        {
            int have = _ring.Count;
            if (!_primed && have >= PrimeFrames) _primed = true;
            int got = 0;
            if (_primed)
            {
                got = _ring.Read(block, BlockFrames);
                if (got < BlockFrames) _primed = false;
            }
            block[(got * Channels)..].Clear();

            int left = _ring.Count;
            _blocksOver = left > StandingFrames ? _blocksOver + 1 : 0;
            int drop = FramesToDrop(left, _blocksOver);
            if (drop > 0)
            {
                _ring.Drop(drop);
                _blocksOver = 0;
            }
        }

        public void Dispose() => Detach();
    }

    /// <summary>Calls back when the default speakers change.</summary>
    private sealed class LoopbackWatcher(Action changed) : IMMNotificationClient
    {
        public void OnDefaultDeviceChanged(DataFlow flow, Role role, string defaultDeviceId)
        {
            // Windows says it once per role; the speakers (not the headset for calls) are the one that matters.
            if (flow == DataFlow.Render && role == Role.Console) changed();
        }

        public void OnDeviceStateChanged(string deviceId, DeviceState newState)
        {
        }

        public void OnDeviceAdded(string pwstrDeviceId)
        {
        }

        public void OnDeviceRemoved(string deviceId)
        {
        }

        public void OnPropertyValueChanged(string pwstrDeviceId, PropertyKey key)
        {
        }
    }
}
