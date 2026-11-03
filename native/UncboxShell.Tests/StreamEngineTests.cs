using System.Net;
using System.Text.Json;
using UncboxShell;

namespace UncboxShell.Tests;

/// <summary>Which program streams, and how that reaches the server (StreamEngine.cs, ServerHost.cs).</summary>
public class StreamEngineTests
{
    [Theory]
    [InlineData("native", "native")]
    [InlineData("NATIVE", "native")]
    [InlineData(" Native ", "native")]
    [InlineData("ffmpeg", "ffmpeg")]
    [InlineData("FFmpeg", "ffmpeg")]
    [InlineData("turbo", null)]
    [InlineData("", null)]
    [InlineData(null, null)]
    public void Parse_takes_only_native_and_ffmpeg(string? value, string? expected) =>
        Assert.Equal(expected, StreamEngine.Parse(value));

    [Fact]
    public void Launch_is_FFmpeg_unless_the_engine_is_asked_for()
    {
        Assert.Equal("ffmpeg", StreamEngine.Choose([], null));
        Assert.Equal("ffmpeg", StreamEngine.Choose(["--windowed", "--screen=1", "http://localhost:5170/"], null));
    }

    [Fact]
    public void The_flag_asks_for_the_engine()
    {
        Assert.Equal("native", StreamEngine.Choose(["--engine=native"], null));
        Assert.Equal("native", StreamEngine.Choose(["--windowed", "--ENGINE=Native", "--screen=1"], null));
        Assert.Equal("ffmpeg", StreamEngine.Choose(["--engine=ffmpeg"], null));
    }

    [Fact]
    public void The_last_flag_wins()
    {
        Assert.Equal("ffmpeg", StreamEngine.Choose(["--engine=native", "--engine=ffmpeg"], null));
        Assert.Equal("native", StreamEngine.Choose(["--engine=ffmpeg", "--engine=native"], null));
    }

    [Fact]
    public void A_flag_beats_a_variable_set_by_hand_and_a_variable_works_without_one()
    {
        Assert.Equal("ffmpeg", StreamEngine.Choose(["--engine=ffmpeg"], "native"));
        Assert.Equal("native", StreamEngine.Choose(["--engine=native"], "ffmpeg"));
        Assert.Equal("native", StreamEngine.Choose([], "native"));
        Assert.Equal("native", StreamEngine.Choose(["--windowed"], "Native"));
    }

    [Fact]
    public void Nonsense_is_ignored_not_guessed_at()
    {
        Assert.Equal("ffmpeg", StreamEngine.Choose(["--engine=turbo"], null));
        Assert.Equal("ffmpeg", StreamEngine.Choose(["--engine="], "turbo"));
        // An unknown flag value falls through to the variable, and a valid earlier flag still counts.
        Assert.Equal("native", StreamEngine.Choose(["--engine=turbo"], "native"));
        Assert.Equal("native", StreamEngine.Choose(["--engine=native", "--engine=turbo"], null));
    }

    [Fact]
    public void The_request_body_is_the_json_the_route_reads()
    {
        foreach (string engine in new[] { StreamEngine.Native, StreamEngine.FFmpeg })
        {
            using var doc = JsonDocument.Parse(StreamEngine.RequestBody(engine));
            Assert.Equal(engine, doc.RootElement.GetProperty("engine").GetString());
            Assert.Single(doc.RootElement.EnumerateObject());
        }
    }

    [Fact]
    public void A_server_started_by_the_app_gets_the_choice_in_its_environment()
    {
        var native = ServerHost.StartInfo(@"C:\Uncbox", "node", "server/index.mjs --port=5170", StreamEngine.Native);
        Assert.Equal("native", native.Environment["UNCBOX_STREAM_ENGINE"]);
        Assert.Equal(@"C:\Uncbox", native.WorkingDirectory);
        Assert.Equal("server/index.mjs --port=5170", native.Arguments);
        Assert.False(native.UseShellExecute);
        Assert.True(native.CreateNoWindow);
        Assert.True(native.RedirectStandardInput);

        // The default launch says so too, so a variable left in the shell's own environment can't leak through.
        var ffmpeg = ServerHost.StartInfo(@"C:\Uncbox", "node", "server/index.mjs", StreamEngine.FFmpeg);
        Assert.Equal("ffmpeg", ffmpeg.Environment["UNCBOX_STREAM_ENGINE"]);
    }

    private static int FreePort()
    {
        using var probe = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        return ((IPEndPoint)probe.LocalEndpoint).Port;
    }

    /// <summary>A one-request web server on a free port; what it was asked is in Request.</summary>
    private sealed class Listener : IDisposable
    {
        private readonly HttpListener _http = new();
        public Uri Url { get; }
        public Task<(string Method, string Path, string ContentType, string Body)> Request { get; }

        public Listener(int status)
        {
            Url = new Uri($"http://localhost:{FreePort()}/");
            _http.Prefixes.Add(Url.ToString());
            _http.Start();
            Request = Task.Run(async () =>
            {
                var ctx = await _http.GetContextAsync();
                using var reader = new StreamReader(ctx.Request.InputStream, ctx.Request.ContentEncoding);
                string body = await reader.ReadToEndAsync();
                ctx.Response.StatusCode = status;
                ctx.Response.Close();
                return (ctx.Request.HttpMethod, ctx.Request.Url!.AbsolutePath, ctx.Request.ContentType ?? "", body);
            });
        }

        public void Dispose() => _http.Close();
    }

    [Fact]
    public async Task A_running_server_is_told_with_a_POST_to_the_engine_route()
    {
        using var server = new Listener(200);
        Assert.True(await ServerHost.TellEngine(server.Url, StreamEngine.Native));
        var (method, path, type, body) = await server.Request;
        Assert.Equal("POST", method);
        Assert.Equal("/api/stream/engine", path);
        Assert.StartsWith("application/json", type);
        Assert.Equal("""{"engine":"native"}""", body);
    }

    [Fact]
    public async Task The_address_may_carry_a_path_or_query_and_the_route_is_still_the_servers_own()
    {
        using var server = new Listener(200);
        Assert.True(await ServerHost.TellEngine(new Uri(server.Url, "/somewhere?native=1"), StreamEngine.FFmpeg));
        var (_, path, _, body) = await server.Request;
        Assert.Equal("/api/stream/engine", path);
        Assert.Equal("""{"engine":"ffmpeg"}""", body);
    }

    [Theory]
    [InlineData(404)] // an older server without the route
    [InlineData(409)] // a stream is running right now
    [InlineData(403)]
    public async Task A_server_that_declines_is_not_an_error_for_the_app(int status)
    {
        using var server = new Listener(status);
        Assert.False(await ServerHost.TellEngine(server.Url, StreamEngine.Native));
        await server.Request;
    }

    [Fact]
    public async Task Nothing_listening_is_not_an_error_either() =>
        Assert.False(await ServerHost.TellEngine(new Uri($"http://localhost:{FreePort()}/"), StreamEngine.Native));
}
