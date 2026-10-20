using System.Diagnostics;
using System.Runtime.InteropServices;

namespace UncboxShell;

/// <summary>
/// Makes sure the Uncbox server is running, so the app is one double-click. If something already
/// answers at the address (npm start in a terminal, say) it's used as is. Otherwise the server is
/// started from the Uncbox folder, after a build if dist/ is missing, and stopped with the app.
/// The server sits in a job object, so it goes away even if the app crashes.
///
/// A packaged copy (npm run package) carries its own Node in node\ and the server and page in
/// app\, next to Uncbox.exe. It never builds, and keeps the user's data in %LOCALAPPDATA% rather
/// than in the folder it was unzipped to.
/// </summary>
internal sealed class ServerHost : IDisposable
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(2) };
    private readonly IntPtr _job = CreateJob();
    private Process? _server;

    public string? Error { get; private set; }

    /// <summary>The Node that ships beside the app in a packaged copy, or null when running from the repo.</summary>
    private static string? BundledNode
    {
        get
        {
            string node = Path.Combine(AppContext.BaseDirectory, "node", "node.exe");
            return File.Exists(node) ? node : null;
        }
    }

    /// <summary>Where a packaged copy keeps its settings, away from the folder it was unzipped to.</summary>
    private static string PackagedDataDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Uncbox", "data");

    /// <summary>
    /// The folder with Uncbox's package.json: the given one, the app\ folder of a packaged copy, or
    /// the nearest folder above the app (the repo, when run with npm run app).
    /// </summary>
    public static string? FindRoot(string? given)
    {
        if (given is not null) return File.Exists(Path.Combine(given, "package.json")) ? Path.GetFullPath(given) : null;
        // Looked at first, so a copy unzipped inside some other Node project still uses its own app\.
        string packaged = Path.Combine(AppContext.BaseDirectory, "app");
        if (File.Exists(Path.Combine(packaged, "package.json"))) return Path.GetFullPath(packaged);
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            string pkg = Path.Combine(dir.FullName, "package.json");
            if (File.Exists(pkg) && File.ReadAllText(pkg).Contains("\"name\": \"uncbox\"")) return dir.FullName;
        }
        return null;
    }

    public static async Task<bool> IsUp(Uri url)
    {
        try
        {
            using var res = await Http.GetAsync(new Uri(url, "/api/clips"));
            return res.IsSuccessStatusCode;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            return false;
        }
    }

    /// <summary>Starts the server if nothing answers at url. False, with Error set, if it can't.</summary>
    public async Task<bool> EnsureRunning(Uri url, string? root, string? dataDir, IProgress<string> status)
    {
        if (await IsUp(url)) return true;
        if (root is null)
        {
            Error = $"Nothing is answering at {url.GetLeftPart(UriPartial.Authority)}, and the Uncbox folder wasn't found to start it. Run npm start, or pass --root=<Uncbox folder>.";
            return false;
        }
        string? bundledNode = BundledNode;
        if (!File.Exists(Path.Combine(root, "dist", "index.html")))
        {
            // A packaged copy has no npm or source to build from, so a missing page means a damaged download.
            if (bundledNode is not null)
            {
                Error = "Uncbox's page files are missing (the app\\dist folder). Unzip the download again.";
                return false;
            }
            status.Report("Building Uncbox (first run only)…");
            var build = Start(root, "cmd.exe", "/d /c npm run build");
            if (build is null) return false;
            await build.WaitForExitAsync();
            if (build.ExitCode != 0)
            {
                Error = "Building Uncbox failed. Run npm install, then npm run build, in the Uncbox folder.";
                return false;
            }
        }
        status.Report("Starting Uncbox…");
        string args = $"server/index.mjs --port={url.Port}";
        dataDir ??= bundledNode is not null ? PackagedDataDir : null;
        if (dataDir is not null) args += $" \"--data={Path.GetFullPath(dataDir)}\"";
        _server = Start(root, bundledNode ?? "node", args);
        if (_server is null) return false;
        for (int i = 0; i < 60; i++)
        {
            if (await IsUp(url)) return true;
            if (_server.HasExited) break;
            await Task.Delay(250);
        }
        Error = "The Uncbox server didn't start. Try npm start in the Uncbox folder to see why.";
        return false;
    }

    private Process? Start(string root, string file, string args)
    {
        try
        {
            var p = Process.Start(new ProcessStartInfo(file, args)
            {
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
            })!;
            AssignProcessToJobObject(_job, p.Handle);
            return p;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            Error = "Node.js wasn't found. Install it from nodejs.org (version 20 or newer).";
            return null;
        }
    }

    public void Dispose()
    {
        // Closing the job ends the server and anything it started.
        if (_job != IntPtr.Zero) CloseHandle(_job);
        _server?.Dispose();
    }

    // ---- job object: children die with the app ----

    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong A, B, C, D, E, F;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string? name);

    [DllImport("kernel32.dll")]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int length);

    [DllImport("kernel32.dll")]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private static IntPtr CreateJob()
    {
        var job = CreateJobObject(IntPtr.Zero, null);
        var info = new ExtendedLimits { Basic = { LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE } };
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf<ExtendedLimits>());
        return job;
    }
}
