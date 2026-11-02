using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;
using NAudio.Wasapi.CoreAudioApi.Interfaces;
using NAudio.Wave;

namespace UncboxShell;

/// <summary>
/// The sound of one program (and the programs it started), or of everything except one: WASAPI
/// "process loopback", which Windows 10 (2004 and later, best on 11) offers. NAudio 2.2.1 has no
/// public way to ask for it, so this makes the request itself (ActivateAudioInterfaceAsync on the
/// virtual device "VAD\Process_Loopback") and reads the audio client it gets back with NAudio's
/// AudioClient, the way WasapiCapture does. It looks like any NAudio capture (IWaveIn) to the rest
/// of the shell. Format: 48 kHz, stereo, 16-bit; Windows converts to it.
/// </summary>
internal sealed class ProcessLoopbackCapture : IWaveIn
{
    private const string VirtualDevice = "VAD\\Process_Loopback";
    private static readonly TimeSpan ActivateTimeout = TimeSpan.FromSeconds(5);
    private static readonly Guid AudioClientId = new("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");

    private readonly AudioClient _client;
    private readonly int _blockAlign;
    private readonly EventWaitHandle _ready = new(false, EventResetMode.AutoReset);
    private readonly CancellationTokenSource _stop = new();
    private Thread? _thread;
    private int _stopped;

    public WaveFormat WaveFormat { get; set; } = new(AudioKit.Rate, 16, AudioKit.Channels);
    public event EventHandler<WaveInEventArgs>? DataAvailable;
    public event EventHandler<StoppedEventArgs>? RecordingStopped;

    private ProcessLoopbackCapture(AudioClient client)
    {
        _client = client;
        _blockAlign = WaveFormat.BlockAlign;
    }

    /// <summary>
    /// The sound of <paramref name="pid"/> and its child programs (include), or of everything else
    /// on the PC (not include). Throws when Windows can't do it (an older Windows, a program that
    /// is gone).
    /// </summary>
    public static ProcessLoopbackCapture Open(int pid, bool include)
    {
        var handler = new Handler();
        var args = new ActivationParams
        {
            ActivationType = 1, // process loopback
            TargetProcessId = (uint)pid,
            Mode = include ? 0 : 1, // include / exclude the target's process tree
        };
        IntPtr blob = Marshal.AllocHGlobal(Marshal.SizeOf<ActivationParams>());
        IntPtr variant = Marshal.AllocHGlobal(Marshal.SizeOf<PropVariantBlob>());
        try
        {
            Marshal.StructureToPtr(args, blob, false);
            Marshal.StructureToPtr(new PropVariantBlob { Type = 0x41 /* VT_BLOB */, Size = (uint)Marshal.SizeOf<ActivationParams>(), Data = blob }, variant, false);
            ActivateAudioInterfaceAsync(VirtualDevice, AudioClientId, variant, handler, out _);
            if (!handler.Done.Task.Wait(ActivateTimeout)) throw new TimeoutException("Windows didn't answer.");
        }
        finally
        {
            Marshal.FreeHGlobal(variant);
            Marshal.FreeHGlobal(blob);
        }
        var client = new AudioClient(handler.Done.Task.Result);
        var capture = new ProcessLoopbackCapture(client);
        try
        {
            // Process loopback has no mix format to ask for: the format below is converted to by Windows.
            client.Initialize(AudioClientShareMode.Shared,
                AudioClientStreamFlags.Loopback | AudioClientStreamFlags.EventCallback,
                0, 0, capture.WaveFormat, Guid.Empty);
            client.SetEventHandle(capture._ready.SafeWaitHandle.DangerousGetHandle());
        }
        catch (Exception)
        {
            capture.Dispose();
            throw;
        }
        return capture;
    }

    public void StartRecording()
    {
        if (_thread is not null) return;
        var reader = _client.AudioCaptureClient;
        _client.Start();
        _thread = new Thread(() => Run(reader)) { IsBackground = true, Name = "Uncbox process sound", Priority = ThreadPriority.AboveNormal };
        _thread.Start();
    }

    public void StopRecording()
    {
        _stop.Cancel();
        _ready.Set();
        if (_thread is { } t && t != Thread.CurrentThread) t.Join(1000);
    }

    private void Run(AudioCaptureClient reader)
    {
        Exception? failure = null;
        var buffer = new byte[AudioKit.Rate / 10 * _blockAlign];
        try
        {
            while (!_stop.IsCancellationRequested)
            {
                _ready.WaitOne(100);
                int size = reader.GetNextPacketSize();
                while (size > 0 && !_stop.IsCancellationRequested)
                {
                    IntPtr data = reader.GetBuffer(out int frames, out var flags);
                    int bytes = frames * _blockAlign;
                    if (buffer.Length < bytes) buffer = new byte[bytes];
                    if ((flags & AudioClientBufferFlags.Silent) != 0) Array.Clear(buffer, 0, bytes);
                    else Marshal.Copy(data, buffer, 0, bytes);
                    reader.ReleaseBuffer(frames);
                    DataAvailable?.Invoke(this, new WaveInEventArgs(buffer, bytes));
                    size = reader.GetNextPacketSize();
                }
            }
        }
        catch (Exception err)
        {
            failure = err;
        }
        try
        {
            _client.Stop();
        }
        catch (Exception)
        {
            // Already gone.
        }
        if (Interlocked.Exchange(ref _stopped, 1) == 0) RecordingStopped?.Invoke(this, new StoppedEventArgs(failure));
    }

    public void Dispose()
    {
        StopRecording();
        _client.Dispose();
        _ready.Dispose();
    }

    // ---- Talking to Windows ----

    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
    private static extern void ActivateAudioInterfaceAsync(
        [In, MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        [In, MarshalAs(UnmanagedType.LPStruct)] Guid riid,
        [In] IntPtr activationParams,
        [In] IActivateAudioInterfaceCompletionHandler completionHandler,
        out IActivateAudioInterfaceAsyncOperation activationOperation);

    /// <summary>AUDIOCLIENT_ACTIVATION_PARAMS with its process loopback member.</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct ActivationParams
    {
        public int ActivationType;
        public uint TargetProcessId;
        public int Mode;
    }

    /// <summary>A PROPVARIANT holding a blob (x64 layout: 8 bytes of header, then the size, then the pointer).</summary>
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    private struct PropVariantBlob
    {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(8)] public uint Size;
        [FieldOffset(16)] public IntPtr Data;
    }

    /// <summary>Windows calls this from one of its own threads, so it has to say it can ("agile").</summary>
    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAgileObject;

    private sealed class Handler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly TaskCompletionSource<IAudioClient> Done = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
        {
            try
            {
                operation.GetActivateResult(out int hr, out object client);
                if (hr < 0) Done.TrySetException(Marshal.GetExceptionForHR(hr) ?? new InvalidOperationException("Windows refused."));
                else Done.TrySetResult((IAudioClient)client);
            }
            catch (Exception err)
            {
                Done.TrySetException(err);
            }
        }
    }
}
