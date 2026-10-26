using System.Diagnostics;
using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace UncboxShell;

/// <summary>
/// The sound behind instant replay clips: the game, Discord and the mic, each kept apart for the
/// last 70 seconds (16-bit stereo, 48 kHz, in memory only) so the page can ask for the stretch a
/// clip covers and put each on its own track. Nothing is written to disk here.
///
/// The game is the program that owns the captured window (WASAPI process loopback of it and its
/// child programs); when that can't be found, it is all desktop sound except Discord. Discord is
/// its own program's sound (looked for again every 5 s, so it joins when Discord opens). The mic is
/// a capture device.
///
/// All three share one timeline: a writer thread on a Stopwatch appends exactly real time, in 10 ms
/// blocks (480 frames), to each source's ring, taking from that source's small queue and padding
/// with silence (loopback delivers nothing while nothing plays). Queues that run ahead (a device
/// clock a little fast) lose the excess. That keeps the three tracks in step with each other and
/// with the wall clock. One instance is one session: Start it once, Dispose it to stop.
/// </summary>
internal sealed class ClipAudio : IDisposable
{
    /// <summary>How much each source keeps.</summary>
    public const int Seconds = 70;
    /// <summary>The longest stretch the page can ask for at once.</summary>
    public const int MaxSpanMs = 65_000;
    private const int RingFrames = Seconds * AudioKit.Rate;
    /// <summary>Levels go to the page every 200 ms.</summary>
    private const int LevelEveryBlocks = 20;
    private static readonly TimeSpan Look = TimeSpan.FromSeconds(5);
    /// <summary>The Discord programs, in the order they are looked for (Vesktop is a Discord client too).</summary>
    private static readonly string[] DiscordNames = ["Discord", "DiscordPTB", "DiscordCanary", "Vesktop"];

    [DllImport("winmm.dll")]
    private static extern uint timeBeginPeriod(uint ms);

    [DllImport("winmm.dll")]
    private static extern uint timeEndPeriod(uint ms);

    private readonly Action<object> _post;
    private readonly Func<string, (int Pid, string Name)?> _findGame;
    private readonly object _gate = new();
    private readonly CancellationTokenSource _cts = new();
    private readonly Stopwatch _clock = new();
    private readonly Source _game = new(), _discord = new(), _mic = new();
    private Thread? _writer, _resolver;
    private string _title = "";
    private string? _micId;
    private string _gameMode = "desktop";
    private string _gameName = "";
    private string _micError = "";
    private string _lastStatus = "";
    private int _closed;

    /// <param name="post">Sends a message to the page. Called from any thread.</param>
    /// <param name="findGame">The program that owns the captured window (the page's label for the capture), and its name, or null when there is none.</param>
    public ClipAudio(Action<object> post, Func<string, (int Pid, string Name)?> findGame)
    {
        _post = post;
        _findGame = findGame;
    }

    public bool Running => Volatile.Read(ref _closed) == 0;

    /// <summary>Starts listening. mic is a device id, "default", or null for no mic.</summary>
    public void Start(string title, string? mic)
    {
        _title = title;
        _micId = mic;
        _clock.Start();
        _writer = new Thread(WriterLoop) { IsBackground = true, Name = "Uncbox clip sound", Priority = ThreadPriority.AboveNormal };
        _writer.Start();
        _resolver = new Thread(ResolverLoop) { IsBackground = true, Name = "Uncbox clip sources" };
        _resolver.Start();
    }

    /// <summary>How many frames a stretch of this length is.</summary>
    public static int Frames(int fromMs, int toMs) => (fromMs - toMs) * (AudioKit.Rate / 1000);

    /// <summary>
    /// Copies the stretch that started fromMs ago and ended toMs ago (as of now) into the three
    /// spans, each Frames(fromMs, toMs) × 2 samples of interleaved stereo. What isn't there (before
    /// the sound began, or past what is kept) is silence.
    /// </summary>
    public void Read(int fromMs, int toMs, Span<short> game, Span<short> discord, Span<short> mic)
    {
        long now = (long)Math.Round(_clock.Elapsed.TotalSeconds * AudioKit.Rate);
        long start = now - (long)fromMs * (AudioKit.Rate / 1000);
        int frames = Frames(fromMs, toMs);
        _game.Ring.Read(start, frames, game);
        _discord.Ring.Read(start, frames, discord);
        _mic.Ring.Read(start, frames, mic);
    }

    // ---- Finding the sources ----

    private void ResolverLoop()
    {
        var ct = _cts.Token;
        bool first = true;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                string? fatal = Resolve(first);
                if (fatal is not null)
                {
                    Stop(fatal);
                    return;
                }
            }
            catch (Exception)
            {
                // Try again at the next look.
            }
            first = false;
            if (ct.WaitHandle.WaitOne(Look)) break;
        }
    }

    /// <summary>
    /// Makes the sources match what is running now, and tells the page when that changed. Returns
    /// words for the page when nothing at all could be recorded (the very first time only).
    /// </summary>
    private string? Resolve(bool first)
    {
        lock (_gate)
        {
            if (!Running) return null;
            var procs = ProcessList.Take();
            int discordPid = FindDiscord(procs);

            // Discord: its own program's sound, or silence.
            if (discordPid == 0) _discord.Detach();
            else
            {
                string key = $"app:{discordPid}";
                if (_discord.Key != key || _discord.Failed)
                {
                    _discord.Detach();
                    TryOpen(() => ProcessLoopbackCapture.Open(discordPid, true), _discord, key);
                }
            }

            // The game: the captured window's program, else all desktop sound except Discord.
            var game = _title.Length > 0 ? _findGame(_title) : null;
            bool gameOk = false;
            if (game is { } g && procs.Any(p => p.Pid == g.Pid))
            {
                string key = $"app:{g.Pid}";
                if (_game.Key == key && !_game.Failed) gameOk = true;
                else
                {
                    _game.Detach();
                    gameOk = TryOpen(() => ProcessLoopbackCapture.Open(g.Pid, true), _game, key);
                }
                if (gameOk)
                {
                    _gameMode = "app";
                    _gameName = g.Name;
                }
            }
            if (!gameOk)
            {
                _gameMode = "desktop";
                _gameName = "";
                string key = discordPid != 0 ? $"except:{discordPid}" : $"all:{DefaultSpeakers()}";
                if (_game.Key != key || _game.Failed)
                {
                    _game.Detach();
                    bool opened = TryOpen(
                        discordPid != 0 ? () => ProcessLoopbackCapture.Open(discordPid, false) : OpenDefaultLoopback, _game, key);
                    // Process loopback can be missing (older Windows): all sound, Discord included, is better than none.
                    if (!opened && discordPid != 0) opened = TryOpen(OpenDefaultLoopback, _game, $"all:{DefaultSpeakers()}");
                    if (!opened && first) return "Couldn't record the game's sound.";
                }
            }

            // The mic.
            ResolveMic();

            Report();
            return null;
        }
    }

    private void ResolveMic()
    {
        if (_micId is null)
        {
            _mic.Detach();
            _micError = "";
            return;
        }
        try
        {
            using var enumerator = new MMDeviceEnumerator();
            var device = _micId == "default"
                ? enumerator.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Console)
                : enumerator.GetDevice(_micId);
            string key = "mic:" + device.ID;
            if (_mic.Key == key && !_mic.Failed) return;
            _mic.Detach();
            if (device.State != DeviceState.Active) throw new InvalidOperationException("That mic isn't connected.");
            IWaveIn capture;
            try
            {
                // Event-driven with a short buffer, so the mic arrives in regular 10 ms pieces.
                capture = new WasapiCapture(device, true, 20);
                _mic.Attach(capture, key);
            }
            catch (UnauthorizedAccessException)
            {
                throw;
            }
            catch (Exception)
            {
                _mic.Detach();
                _mic.Attach(new WasapiCapture(device), key);
            }
            _micError = "";
        }
        catch (UnauthorizedAccessException)
        {
            _mic.Detach();
            _micError = "Windows isn't letting Uncbox use the mic. Check Settings > Privacy & security > Microphone.";
        }
        catch (Exception)
        {
            _mic.Detach();
            _micError = "That mic isn't connected.";
        }
    }

    private static bool TryOpen(Func<IWaveIn> open, Source source, string key)
    {
        IWaveIn? capture = null;
        try
        {
            capture = open();
            source.Attach(capture, key);
            return true;
        }
        catch (Exception)
        {
            capture?.Dispose();
            return false;
        }
    }

    private static IWaveIn OpenDefaultLoopback()
    {
        using var enumerator = new MMDeviceEnumerator();
        return new WasapiLoopbackCapture(enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Console));
    }

    private static string DefaultSpeakers()
    {
        try
        {
            using var enumerator = new MMDeviceEnumerator();
            using var device = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Console);
            return device.ID;
        }
        catch (Exception)
        {
            return "";
        }
    }

    /// <summary>
    /// The Discord program that started the others (its helpers have the same name and Discord as
    /// parent), the first of Discord, PTB, Canary and Vesktop that is running; 0 when none is.
    /// </summary>
    internal static int FindDiscord(IReadOnlyList<ProcessList.Entry> procs)
    {
        foreach (string name in DiscordNames)
        {
            var same = procs.Where(p => p.Name.Equals(name, StringComparison.OrdinalIgnoreCase)).ToList();
            foreach (var p in same)
            {
                if (!procs.Any(o => o.Pid == p.Parent && o.Name.Equals(name, StringComparison.OrdinalIgnoreCase))) return p.Pid;
            }
        }
        return 0;
    }

    /// <summary>Tells the page what is being recorded, when that changed.</summary>
    private void Report()
    {
        var message = new
        {
            type = "clipaudio",
            state = "on",
            game = _gameMode,
            gameName = _gameName,
            discord = _discord.Attached,
            mic = _mic.Attached,
            micError = _micError,
        };
        string text = $"{message.game}|{message.gameName}|{message.discord}|{message.mic}|{message.micError}";
        if (text == _lastStatus) return;
        _lastStatus = text;
        _post(message);
    }

    // ---- The clock ----

    private void WriterLoop()
    {
        var ct = _cts.Token;
        timeBeginPeriod(1);
        try
        {
            var sources = new[] { _game, _discord, _mic };
            var block = new float[AudioKit.BlockFrames * AudioKit.Channels];
            var peaks = new float[sources.Length];
            long written = 0;
            while (!ct.IsCancellationRequested)
            {
                if (AudioKit.BlocksDue(_clock.Elapsed.TotalSeconds, written) <= 0)
                {
                    Thread.Sleep(1);
                    continue;
                }
                for (int i = 0; i < sources.Length; i++)
                {
                    sources[i].TakeBlock(block);
                    peaks[i] = Math.Max(peaks[i], sources[i].Ring.Append(block, AudioKit.BlockFrames));
                }
                written++;
                if (written % LevelEveryBlocks == 0)
                {
                    _post(new { type = "cliplevels", game = Math.Round(peaks[0], 3), discord = Math.Round(peaks[1], 3), mic = Math.Round(peaks[2], 3) });
                    Array.Clear(peaks);
                }
            }
        }
        finally
        {
            timeEndPeriod(1);
        }
    }

    /// <summary>Ends the session by itself, with words for the page.</summary>
    private void Stop(string error)
    {
        if (!Release()) return;
        DisposeSources();
        _post(new { type = "clipaudio", state = "error", error });
    }

    private void DisposeSources()
    {
        lock (_gate)
        {
            _game.Dispose();
            _discord.Dispose();
            _mic.Dispose();
        }
    }

    private bool Release()
    {
        if (Interlocked.Exchange(ref _closed, 1) != 0) return false;
        _cts.Cancel();
        return true;
    }

    /// <summary>Stops without telling the page: the caller says what the page should hear.</summary>
    public void Dispose()
    {
        Release();
        if (_writer is { } w && w != Thread.CurrentThread) w.Join(1000);
        if (_resolver is { } r && r != Thread.CurrentThread) r.Join(3000);
        DisposeSources();
    }

    // ---- Pieces ----

    /// <summary>
    /// The last 70 seconds of one source as 16-bit interleaved stereo, indexed by frames since the
    /// session's clock started. One writer, one reader at a time.
    /// </summary>
    internal sealed class ClipRing(int capacityFrames)
    {
        private readonly short[] _data = new short[capacityFrames * AudioKit.Channels];
        private readonly object _lock = new();
        private long _written;

        /// <summary>Adds one block (floats, -1 to 1) and returns its peak, 0 to 1.</summary>
        public float Append(ReadOnlySpan<float> stereo, int frames)
        {
            float peak = 0;
            lock (_lock)
            {
                int at = (int)(_written % capacityFrames) * AudioKit.Channels;
                for (int i = 0; i < frames * AudioKit.Channels; i++)
                {
                    float x = stereo[i];
                    if (float.IsNaN(x)) x = 0;
                    float a = Math.Abs(x);
                    if (a > peak) peak = a;
                    _data[at] = (short)Math.Round(Math.Clamp(x, -1f, 1f) * 32767f);
                    if (++at == _data.Length) at = 0;
                }
                _written += frames;
            }
            return Math.Min(peak, 1f);
        }

        /// <summary>
        /// Fills destination (frames × 2 samples) with the frames from startFrame on. Frames before
        /// the ring's oldest or past what was written are silence.
        /// </summary>
        public void Read(long startFrame, int frames, Span<short> destination)
        {
            destination[..(frames * AudioKit.Channels)].Clear();
            lock (_lock)
            {
                long from = Math.Max(startFrame, Math.Max(0, _written - capacityFrames));
                long to = Math.Min(startFrame + frames, _written);
                while (from < to)
                {
                    int at = (int)(from % capacityFrames);
                    int run = (int)Math.Min(to - from, capacityFrames - at);
                    _data.AsSpan(at * AudioKit.Channels, run * AudioKit.Channels)
                        .CopyTo(destination[(int)((from - startFrame) * AudioKit.Channels)..]);
                    from += run;
                }
            }
        }
    }

    /// <summary>
    /// One thing being recorded: a capture, its conversion to 48 kHz stereo, the small queue the
    /// writer takes 10 ms blocks from, and the ring the clips are cut from.
    /// </summary>
    private sealed class Source : IDisposable
    {
        public readonly ClipRing Ring = new(RingFrames);
        private readonly AudioKit.FrameRing _queue = new(AudioKit.RingFrames);
        private IWaveIn? _capture;
        private bool _primed;
        private int _blocksOver;

        /// <summary>What it is listening to ("" for nothing); the resolver compares it with what it wants.</summary>
        public string Key { get; private set; } = "";
        /// <summary>The device stopped by itself (unplugged, program closed).</summary>
        public volatile bool Failed;
        public bool Attached => _capture is not null && !Failed;

        public void Attach(IWaveIn capture, string key)
        {
            var format = capture.WaveFormat;
            var std = format is WaveFormatExtensible ext ? ext.ToStandardWaveFormat() : format;
            bool isFloat = std.Encoding == WaveFormatEncoding.IeeeFloat;
            if (!AudioKit.CanDecode(isFloat, format.BitsPerSample, format.Channels) || format.SampleRate < 8000)
            {
                capture.Dispose();
                throw new InvalidOperationException("Couldn't record that sound.");
            }
            int rate = format.SampleRate, bits = format.BitsPerSample, channels = format.Channels;
            var resampler = rate == AudioKit.Rate ? null : new AudioKit.StereoResampler(rate, AudioKit.Rate);
            float[] decoded = [], resampled = [];
            capture.DataAvailable += (_, e) =>
            {
                try
                {
                    int frameBytes = bits / 8 * channels;
                    int frames = e.BytesRecorded / frameBytes;
                    if (frames == 0) return;
                    if (decoded.Length < frames * 2) decoded = new float[frames * 2];
                    AudioKit.DecodeToStereo(e.Buffer.AsSpan(0, frames * frameBytes), isFloat, bits, channels, decoded);
                    if (resampler is null)
                    {
                        _queue.Write(decoded, frames);
                        return;
                    }
                    int room = (int)Math.Ceiling(frames * (double)AudioKit.Rate / rate) + 2;
                    if (resampled.Length < room * 2) resampled = new float[room * 2];
                    int n = resampler.Process(decoded, frames, resampled);
                    _queue.Write(resampled, n);
                }
                catch (Exception)
                {
                    // A callback that throws would take the app down; the resolver opens this source again.
                    Failed = true;
                }
            };
            capture.RecordingStopped += (_, e) =>
            {
                // A stop we asked for has no error; anything else means the device went away.
                if (e.Exception is not null) Failed = true;
            };
            _queue.Clear();
            _primed = false;
            _blocksOver = 0;
            Failed = false;
            try
            {
                capture.StartRecording();
            }
            catch (Exception)
            {
                capture.Dispose();
                throw;
            }
            _capture = capture;
            Key = key;
        }

        /// <summary>Stops listening (the ring keeps what it has; the rest of the time is silence).</summary>
        public void Detach()
        {
            var capture = _capture;
            _capture = null;
            Key = "";
            Failed = false;
            if (capture is null) return;
            try
            {
                capture.StopRecording();
            }
            catch (Exception)
            {
                // The device may be gone already.
            }
            try
            {
                capture.Dispose();
            }
            catch (Exception)
            {
                // Same.
            }
        }

        /// <summary>
        /// Fills one block (480 stereo frames) from the queue; what isn't there is silence. Reading
        /// only starts once 20 ms are waiting, and stops again when the queue runs dry, so a late
        /// callback costs one short silence instead of a stutter. A queue that keeps holding more
        /// than it should has its excess dropped (AudioKit.FramesToDrop).
        /// </summary>
        public void TakeBlock(Span<float> block)
        {
            int have = _queue.Count;
            if (!_primed && have >= AudioKit.PrimeFrames) _primed = true;
            int got = 0;
            if (_primed)
            {
                got = _queue.Read(block, AudioKit.BlockFrames);
                if (got < AudioKit.BlockFrames) _primed = false;
            }
            block[(got * AudioKit.Channels)..].Clear();

            int left = _queue.Count;
            _blocksOver = left > AudioKit.StandingFrames ? _blocksOver + 1 : 0;
            int drop = AudioKit.FramesToDrop(left, _blocksOver);
            if (drop > 0)
            {
                _queue.Drop(drop);
                _blocksOver = 0;
            }
        }

        public void Dispose() => Detach();
    }

    /// <summary>The programs running, with who started them (a Toolhelp snapshot).</summary>
    internal static class ProcessList
    {
        internal readonly record struct Entry(int Pid, int Parent, string Name);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct ProcessEntry32
        {
            public uint Size;
            public uint Usage;
            public uint ProcessId;
            public UIntPtr DefaultHeapId;
            public uint ModuleId;
            public uint Threads;
            public uint ParentProcessId;
            public int PriorityClassBase;
            public uint Flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            public string ExeFile;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry32 entry);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry32 entry);

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);

        public static List<Entry> Take()
        {
            var list = new List<Entry>();
            IntPtr snapshot = CreateToolhelp32Snapshot(0x2 /* TH32CS_SNAPPROCESS */, 0);
            if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1)) return list;
            try
            {
                var entry = new ProcessEntry32 { Size = (uint)Marshal.SizeOf<ProcessEntry32>() };
                for (bool ok = Process32FirstW(snapshot, ref entry); ok; ok = Process32NextW(snapshot, ref entry))
                {
                    string name = entry.ExeFile;
                    if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) name = name[..^4];
                    list.Add(new Entry((int)entry.ProcessId, (int)entry.ParentProcessId, name));
                }
            }
            finally
            {
                CloseHandle(snapshot);
            }
            return list;
        }
    }
}
