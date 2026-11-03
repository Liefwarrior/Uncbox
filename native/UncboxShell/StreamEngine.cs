namespace UncboxShell;

/// <summary>
/// Which program streams to Twitch: FFmpeg (the default) or Uncbox's own engine (the second way to
/// launch the app, `--engine=native`; see engine/README.md and server/stream.mjs). The server owns
/// the choice and falls back to FFmpeg by itself if the engine isn't built or can't run here, so
/// this only says what was asked for and how that is passed on:
///   - to a server this app starts: the UNCBOX_STREAM_ENGINE environment variable, and
///   - to a server that was already running: POST /api/stream/engine { engine }.
/// </summary>
internal static class StreamEngine
{
    public const string Native = "native";
    public const string FFmpeg = "ffmpeg";
    public const string EnvironmentVariable = "UNCBOX_STREAM_ENGINE";
    private const string Flag = "--engine=";

    /// <summary>"native" or "ffmpeg" (any case, spaces ignored) for what is asked for; null for anything else.</summary>
    public static string? Parse(string? value) => value?.Trim().ToLowerInvariant() switch
    {
        Native => Native,
        FFmpeg => FFmpeg,
        _ => null,
    };

    /// <summary>
    /// What this launch asks for: --engine=native|ffmpeg if given (the last one wins), else a
    /// UNCBOX_STREAM_ENGINE set by hand (<paramref name="environment"/>), else FFmpeg. A value that
    /// is neither is ignored rather than guessed at.
    /// </summary>
    public static string Choose(string[] args, string? environment)
    {
        string? given = args
            .Where(a => a.StartsWith(Flag, StringComparison.OrdinalIgnoreCase))
            .Select(a => Parse(a[Flag.Length..]))
            .LastOrDefault(v => v is not null);
        return given ?? Parse(environment) ?? FFmpeg;
    }

    /// <summary>The body of POST /api/stream/engine.</summary>
    public static string RequestBody(string engine) => $"{{\"engine\":\"{engine}\"}}";
}
