namespace UncboxShell;

internal static class Program
{
    /// <summary>
    /// Uncbox.exe [url] [--screen=N] [--windowed]. The Uncbox server must already be running
    /// (npm start); the url defaults to http://localhost:5170, --screen picks a monitor (0 is the
    /// primary), and --windowed opens a 1280 × 720 window instead of covering the screen.
    /// </summary>
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        string? given = args.FirstOrDefault(a => !a.StartsWith("--"));
        var url = new UriBuilder(given ?? "http://localhost:5170/");
        // Tells the page it's in the shell, so the game panel offers "Play here".
        url.Query = string.IsNullOrEmpty(url.Query) ? "native=1" : url.Query.TrimStart('?') + "&native=1";

        int index = int.TryParse(args.FirstOrDefault(a => a.StartsWith("--screen="))?[9..], out int n) ? n : -1;
        var screens = Screen.AllScreens;
        var screen = index >= 0 && index < screens.Length ? screens[index] : Screen.PrimaryScreen ?? screens[0];

        Application.Run(new ShellForm(url.Uri, screen, args.Contains("--windowed")));
    }
}
