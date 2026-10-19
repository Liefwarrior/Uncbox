using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace UncboxShell;

/// <summary>
/// Uncbox as a full-screen app. The dashboard is the same page as in the browser, drawn by
/// WebView2. When the page's game panel is set to "Play here", the game's real window is moved
/// into the panel and this window gets a hole cut in it there, so the game shows through and
/// takes the mouse, keyboard and controller directly: no capture and no added delay.
///
/// The page and the shell talk with small JSON messages (src/native.ts is the page's side):
///   page → shell  { type: "windows" }                   list windows to pick from
///                 { type: "attach", id }                put that window in the panel
///                 { type: "detach" }                    give it back
///                 { type: "rect", x, y, w, h } | null   where the panel's hole is, in device pixels
///                 { type: "play" }                      hand the keyboard to the game
///                 { type: "fullscreen" }                give the game the whole screen until Ctrl+Shift+F12
///   shell → page  { type: "windows", windows: [{ id, title, process }] }
///                 { type: "attached", id, title } | { type: "detached" }
/// </summary>
internal sealed class ShellForm : Form
{
    private const int HOTKEY_ID = 1;
    private const int WM_HOTKEY = 0x0312;
    private const uint MOD_CONTROL = 0x2, MOD_SHIFT = 0x4, MOD_NOREPEAT = 0x4000;

    [DllImport("user32.dll")]
    private static extern bool RegisterHotKey(IntPtr hwnd, int id, uint modifiers, uint vk);

    [DllImport("user32.dll")]
    private static extern bool UnregisterHotKey(IntPtr hwnd, int id);

    private readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    private readonly System.Windows.Forms.Timer _keepPlaced = new() { Interval = 250 };
    private readonly Uri _url;
    private GameWindow? _game;
    private Native.RECT? _hole;
    /// <summary>The game fills the screen and Uncbox is out of the way, until Ctrl+Shift+F12.</summary>
    private bool _gameFullScreen;

    public ShellForm(Uri url, Screen screen, bool windowed)
    {
        _url = url;
        Text = "Uncbox";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        // Windowed is for trying it out: a 1280 × 720 window that other windows can cover.
        Bounds = windowed ? new Rectangle(screen.Bounds.X + 80, screen.Bounds.Y + 80, 1280, 720) : screen.Bounds;
        BackColor = Color.Black;
        TopMost = !windowed;
        Controls.Add(_web);
        _keepPlaced.Tick += (_, _) => KeepPlaced();
    }

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        // Ctrl+Shift+F12 brings Uncbox back from a full-screen game, or hides and shows it to get at
        // other apps behind it.
        RegisterHotKey(Handle, HOTKEY_ID, MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT, (uint)Keys.F12);

        string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Uncbox", "WebView2");
        var env = await CoreWebView2Environment.CreateAsync(userDataFolder: data);
        await _web.EnsureCoreWebView2Async(env);
        var core = _web.CoreWebView2;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.WebMessageReceived += (_, args) => OnMessage(args.WebMessageAsJson);
        // The page asks for full screen in stream mode; this window already is.
        core.ContainsFullScreenElementChanged += (_, _) => { };
        core.Navigate(_url.ToString());
        _keepPlaced.Start();
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_HOTKEY && m.WParam == HOTKEY_ID)
        {
            if (_gameFullScreen)
            {
                _gameFullScreen = false;
                Show();
                KeepPlaced();
                if (_game is { Alive: true }) Native.SetForegroundWindow(_game.Handle);
            }
            else if (Visible) Hide();
            else
            {
                Show();
                Activate();
            }
        }
        base.WndProc(ref m);
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        _keepPlaced.Stop();
        UnregisterHotKey(Handle, HOTKEY_ID);
        _game?.Restore();
        base.OnFormClosing(e);
    }

    private void Send(object message) => _web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(message));

    private void OnMessage(string json)
    {
        JsonNode? msg;
        try
        {
            msg = JsonNode.Parse(json);
        }
        catch (JsonException)
        {
            return;
        }
        switch ((string?)msg?["type"])
        {
            case "windows":
                Send(new
                {
                    type = "windows",
                    windows = Native.AppWindows(Handle).Select(w => new { id = w.Hwnd.ToString(), title = w.Title, process = w.Process }),
                });
                break;
            case "attach" when long.TryParse((string?)msg["id"], out long id):
                Attach(new IntPtr(id));
                break;
            case "detach":
                Detach();
                break;
            case "rect":
                SetHole(msg["w"] is null ? null : RectFrom(msg));
                break;
            case "play":
                if (_game is { Alive: true }) Native.SetForegroundWindow(_game.Handle);
                break;
            case "fullscreen" when _game is { Alive: true }:
                // With nothing on top of it, Windows lets the game present straight to the screen
                // (independent flip): its full frame rate, native resolution, no added delay.
                _gameFullScreen = true;
                Hide();
                KeepPlaced();
                Native.SetForegroundWindow(_game.Handle);
                break;
        }
    }

    private void Attach(IntPtr hwnd)
    {
        if (!Native.IsWindow(hwnd) || hwnd == Handle) return;
        if (_game?.Handle != hwnd)
        {
            _game?.Restore();
            _game = new GameWindow(hwnd);
            _game.MakeBorderless();
        }
        KeepPlaced();
        Send(new { type = "attached", id = hwnd.ToString(), title = _game.Title });
    }

    private void Detach()
    {
        _game?.Restore();
        _game = null;
        ApplyRegion();
        Send(new { type = "detached" });
    }

    /// <summary>The page's rectangle, in device pixels of the page, as a rectangle on screen.</summary>
    private Native.RECT RectFrom(JsonNode msg)
    {
        var origin = _web.PointToScreen(Point.Empty);
        int x = (int)Math.Round((double)msg["x"]!), y = (int)Math.Round((double)msg["y"]!);
        int w = (int)Math.Round((double)msg["w"]!), h = (int)Math.Round((double)msg["h"]!);
        return new Native.RECT { Left = origin.X + x, Top = origin.Y + y, Right = origin.X + x + w, Bottom = origin.Y + y + h };
    }

    private void SetHole(Native.RECT? hole)
    {
        _hole = hole;
        KeepPlaced();
    }

    /// <summary>
    /// Keeps the game where the panel is. Games move or resize themselves (on load, on a resolution
    /// change), so this re-checks a few times a second rather than trusting one move.
    /// </summary>
    private void KeepPlaced()
    {
        if (_game is { Alive: false })
        {
            _game = null;
            Send(new { type = "detached" });
            if (_gameFullScreen)
            {
                _gameFullScreen = false;
                Show();
            }
        }
        if (_game is not null && _gameFullScreen)
        {
            var screen = Screen.FromHandle(Handle).Bounds;
            _game.Place(new Native.RECT { Left = screen.Left, Top = screen.Top, Right = screen.Right, Bottom = screen.Bottom });
            return;
        }
        if (_game is not null && _hole is { } hole && hole.Width > 0 && hole.Height > 0) _game.Place(hole);
        ApplyRegion();
    }

    private Native.RECT? _applied;

    /// <summary>Cuts the hole the game shows through, or fills it back in with no game.</summary>
    private void ApplyRegion()
    {
        Native.RECT? want = _game is not null && _hole is { Width: > 0, Height: > 0 } ? _hole : null;
        if (Nullable.Equals(want, _applied)) return;
        _applied = want;
        if (want is not { } hole)
        {
            Native.SetWindowRgn(Handle, IntPtr.Zero, true);
            return;
        }
        // Regions are in window coordinates; the window sits at its screen's top-left.
        var full = Native.CreateRectRgn(0, 0, Width, Height);
        var cut = Native.CreateRectRgn(hole.Left - Left, hole.Top - Top, hole.Right - Left, hole.Bottom - Top);
        Native.CombineRgn(full, full, cut, Native.RGN_DIFF);
        Native.DeleteObject(cut);
        // The window owns the region from here on, so it isn't deleted.
        Native.SetWindowRgn(Handle, full, true);
    }
}
