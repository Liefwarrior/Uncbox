namespace UncboxShell;

internal static class Program
{
    /// <summary>
    /// Uncbox.exe [url] [--screen=N] [--windowed] [--root=folder] [--data=folder]
    ///
    /// Opens http://localhost:5170 unless given another address, starting the Uncbox server first
    /// if nothing answers there (from --root, or the Uncbox folder the app sits in). --screen picks
    /// a monitor (0 is the primary), --windowed opens a 1280 × 720 window instead of covering the
    /// screen. --data is passed on to a server it starts. Starting it again while it runs just
    /// brings the running one back.
    /// </summary>
    [STAThread]
    private static void Main(string[] args)
    {
        using var single = new Mutex(true, @"Local\Uncbox.App", out bool first);
        using var wake = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\Uncbox.Show");
        if (!first)
        {
            wake.Set();
            return;
        }

        ApplicationConfiguration.Initialize();
        string? given = args.FirstOrDefault(a => !a.StartsWith("--"));
        var url = new UriBuilder(given ?? "http://localhost:5170/");
        // Tells the page it's in the app, so the game panel offers "Play here".
        url.Query = string.IsNullOrEmpty(url.Query) ? "native=1" : url.Query.TrimStart('?') + "&native=1";

        var options = new ShellOptions
        {
            Url = url.Uri,
            Screen = int.TryParse(Arg(args, "--screen="), out int n) ? n : -1,
            Windowed = args.Contains("--windowed"),
            // Only a local address can be started from here; anything else must already be up.
            Root = url.Host is "localhost" or "127.0.0.1" ? ServerHost.FindRoot(Arg(args, "--root=")) : null,
            CanStartServer = url.Host is "localhost" or "127.0.0.1",
            DataDir = Arg(args, "--data="),
            Wake = wake,
        };
        Application.Run(new ShellForm(options));
    }

    private static string? Arg(string[] args, string prefix) =>
        args.FirstOrDefault(a => a.StartsWith(prefix))?[prefix.Length..];
}

internal sealed class ShellOptions
{
    public required Uri Url { get; init; }
    public int Screen { get; init; }
    public bool Windowed { get; init; }
    public string? Root { get; init; }
    public bool CanStartServer { get; init; }
    public string? DataDir { get; init; }
    public required EventWaitHandle Wake { get; init; }
}
