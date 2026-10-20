using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace UncboxShell;

/// <summary>
/// Uncbox as a Windows app. The dashboard is the same page as in the browser, drawn by WebView2.
/// When the page's game panel is set to "Play here", the game's real window is moved into the
/// panel and this window gets a hole cut in it there, so the game shows through and takes the
/// mouse, keyboard and controller directly: no capture and no added delay. Minimized, Uncbox
/// lives in the tray.
///
/// The page and the app talk with small JSON messages (src/native.ts is the page's side):
///   page → app  { type: "windows" }                       list windows to pick from
///               { type: "attach", id } | { type: "attach", match: { process, title } }
///               { type: "detach" }                        give the game window back
///               { type: "rect", x, y, w, h, crop, stripPx } | { type: "rect" }
///                    where the panel's hole is, in device pixels; crop (percent per edge) and
///                    stripPx (the WoW strip) are tucked under the dashboard, out of sight
///               { type: "play" }                          hand the keyboard to the game
///               { type: "fullscreen" }                    the game gets the whole screen until Ctrl+Shift+F12
///               { type: "minimize" }                      to the tray
///   app → page  { type: "windows", windows: [{ id, title, process }] }
///               { type: "attached", id, title, process } | { type: "detached" }
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

    private readonly ShellOptions _options;
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill, Visible = false };
    private readonly Label _splash = new()
    {
        Dock = DockStyle.Fill,
        TextAlign = ContentAlignment.MiddleCenter,
        ForeColor = Color.FromArgb(0xC8, 0xCC, 0xD6),
        Font = new Font("Segoe UI", 16f),
        Text = "Starting Uncbox…",
    };
    private readonly NotifyIcon _tray = new() { Text = "Uncbox" };
    private readonly ToolStripMenuItem _fullMenu = new("Give the game the whole screen") { Enabled = false };
    private readonly ToolStripMenuItem _screenMenu = new("Monitor");
    private readonly System.Windows.Forms.Timer _keepPlaced = new() { Interval = 250 };
    private readonly ServerHost _server = new();
    private RegisteredWaitHandle? _wakeWait;
    private Screen _screen;
    private bool _windowedFull;
    private bool _trayHinted;

    private GameWindow? _game;
    private Native.RECT? _hole;
    private Native.RECT? _gameRect;
    private Native.RECT? _applied;
    /// <summary>The game fills the screen and Uncbox is out of the way, until Ctrl+Shift+F12.</summary>
    private bool _gameFullScreen;

    public ShellForm(ShellOptions options)
    {
        _options = options;
        var screens = Screen.AllScreens;
        _screen = options.Screen >= 0 && options.Screen < screens.Length ? screens[options.Screen] : Screen.PrimaryScreen ?? screens[0];
        Text = "Uncbox";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.FromArgb(0x10, 0x12, 0x19);
        TopMost = !options.Windowed;
        FitToScreen();
        Controls.Add(_web);
        Controls.Add(_splash);
        _keepPlaced.Tick += (_, _) => KeepPlaced();
        BuildTray();
    }

    /// <summary>The whole monitor, or (windowed, to try it out) a 1280 × 720 window on it.</summary>
    private void FitToScreen()
    {
        var b = _screen.Bounds;
        Bounds = _options.Windowed && !_windowedFull ? new Rectangle(b.X + 80, b.Y + 80, 1280, 720) : b;
        _applied = null;
    }

    private void BuildTray()
    {
        _tray.Icon = Icon;
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open Uncbox", null, (_, _) => RestoreFromTray());
        _fullMenu.Click += (_, _) => GameFullScreen();
        menu.Items.Add(_fullMenu);
        menu.Items.Add(_screenMenu);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit Uncbox", null, (_, _) => Close());
        menu.Opening += (_, _) =>
        {
            _fullMenu.Enabled = _game is { Alive: true };
            _screenMenu.DropDownItems.Clear();
            var screens = Screen.AllScreens;
            for (int i = 0; i < screens.Length; i++)
            {
                var s = screens[i];
                var item = new ToolStripMenuItem($"{i + 1}: {s.Bounds.Width} × {s.Bounds.Height}{(s.Primary ? " (main)" : "")}")
                {
                    Checked = s.DeviceName == _screen.DeviceName,
                };
                item.Click += (_, _) => MoveToScreen(s);
                _screenMenu.DropDownItems.Add(item);
            }
        };
        _tray.ContextMenuStrip = menu;
        _tray.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left) RestoreFromTray();
        };
        _tray.Visible = true;
    }

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        // Ctrl+Shift+F12 brings Uncbox back from a full-screen game, or sends it to the tray and back.
        RegisterHotKey(Handle, HOTKEY_ID, MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT, (uint)Keys.F12);
        // A second start of Uncbox.exe signals this one to come back instead.
        _wakeWait = ThreadPool.RegisterWaitForSingleObject(_options.Wake, (_, _) => BeginInvoke(RestoreFromTray), null, -1, false);

        if (!await StartServer()) return;

        string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Uncbox", "WebView2");
        var env = await CoreWebView2Environment.CreateAsync(userDataFolder: data);
        await _web.EnsureCoreWebView2Async(env);
        var core = _web.CoreWebView2;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.WebMessageReceived += (_, args) => OnMessage(args.WebMessageAsJson);
        core.PermissionRequested += OnPermission;
        core.NewWindowRequested += OnNewWindow;
        core.ContainsFullScreenElementChanged += (_, _) => OnPageFullScreen(core.ContainsFullScreenElement);
        core.NavigationCompleted += (_, args) =>
        {
            if (!args.IsSuccess) return;
            _web.Visible = true;
            _splash.Visible = false;
        };
        core.Navigate(_options.Url.ToString());
        _keepPlaced.Start();
    }

    private async Task<bool> StartServer()
    {
        var status = new Progress<string>(text => _splash.Text = text);
        if (_options.CanStartServer)
        {
            if (await _server.EnsureRunning(_options.Url, _options.Root, _options.DataDir, status)) return true;
            _splash.Text = _server.Error;
            return false;
        }
        // Someone else's server (unc.box, another PC): wait for it rather than start one.
        while (!await ServerHost.IsUp(_options.Url))
        {
            _splash.Text = $"Waiting for Uncbox at {_options.Url.GetLeftPart(UriPartial.Authority)}…";
            await Task.Delay(2000);
        }
        return true;
    }

    /// <summary>Camera and capture card permission for Uncbox's own pages, as a browser would remember it.</summary>
    private void OnPermission(object? sender, CoreWebView2PermissionRequestedEventArgs e)
    {
        var origin = new Uri(e.Uri);
        bool ours = origin.Host == _options.Url.Host && origin.Port == _options.Url.Port;
        if (ours && e.PermissionKind is CoreWebView2PermissionKind.Camera or CoreWebView2PermissionKind.Microphone)
        {
            e.State = CoreWebView2PermissionState.Allow;
        }
    }

    /// <summary>Links that would open a new window (Discord, help pages) open in the default browser.</summary>
    private void OnNewWindow(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri) && (uri.Scheme == "https" || uri.Scheme == "http"))
        {
            Process.Start(new ProcessStartInfo(uri.ToString()) { UseShellExecute = true });
        }
    }

    /// <summary>Stream mode asks for full screen; a windowed Uncbox goes full screen for it.</summary>
    private void OnPageFullScreen(bool full)
    {
        if (!_options.Windowed || full == _windowedFull) return;
        _windowedFull = full;
        TopMost = full;
        FitToScreen();
        KeepPlaced();
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_HOTKEY && m.WParam == HOTKEY_ID)
        {
            if (_gameFullScreen) LeaveGameFullScreen();
            else if (Visible && WindowState != FormWindowState.Minimized) ToTray();
            else RestoreFromTray();
        }
        base.WndProc(ref m);
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        // Minimizing (Win+Down, the taskbar, the page's button) sends Uncbox to the tray.
        if (WindowState == FormWindowState.Minimized) ToTray();
    }

    private void ToTray()
    {
        Hide();
        if (_trayHinted) return;
        _trayHinted = true;
        _tray.ShowBalloonTip(3000, "Uncbox is still running", "Click the Uncbox icon here, or press Ctrl+Shift+F12, to bring it back.", ToolTipIcon.None);
    }

    private void RestoreFromTray()
    {
        if (_gameFullScreen)
        {
            LeaveGameFullScreen();
            return;
        }
        Show();
        WindowState = FormWindowState.Normal;
        FitToScreen();
        Activate();
        KeepPlaced();
    }

    private void MoveToScreen(Screen screen)
    {
        _screen = screen;
        FitToScreen();
        if (!Visible) RestoreFromTray();
        KeepPlaced();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        _keepPlaced.Stop();
        UnregisterHotKey(Handle, HOTKEY_ID);
        _wakeWait?.Unregister(null);
        _game?.Restore();
        _tray.Visible = false;
        _tray.Dispose();
        _server.Dispose();
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
            case "attach" when msg["match"] is JsonObject match:
                var found = Find((string?)match["process"] ?? "", (string?)match["title"] ?? "");
                if (found != IntPtr.Zero) Attach(found);
                break;
            case "detach":
                Detach();
                break;
            case "rect":
                SetHole(msg);
                break;
            case "play":
                if (_game is { Alive: true }) Native.SetForegroundWindow(_game.Handle);
                break;
            case "fullscreen":
                GameFullScreen();
                break;
            case "minimize":
                ToTray();
                break;
        }
    }

    /// <summary>
    /// The window a game saved from last time is in now: same program and title, or the program's
    /// only window (titles often change, "World of Warcraft" vs a loading screen).
    /// </summary>
    private IntPtr Find(string process, string title)
    {
        if (process.Length == 0) return IntPtr.Zero;
        var same = Native.AppWindows(Handle).Where(w => w.Process.Equals(process, StringComparison.OrdinalIgnoreCase)).ToList();
        var exact = same.FirstOrDefault(w => w.Title == title);
        if (exact.Hwnd != IntPtr.Zero) return exact.Hwnd;
        return same.Count == 1 ? same[0].Hwnd : IntPtr.Zero;
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
        Send(new { type = "attached", id = hwnd.ToString(), title = _game.Title, process = Native.ProcessNameOf(hwnd) });
    }

    private void Detach()
    {
        if (_gameFullScreen) LeaveGameFullScreen();
        _game?.Restore();
        _game = null;
        ApplyRegion();
        Send(new { type = "detached" });
    }

    private void GameFullScreen()
    {
        if (_game is not { Alive: true }) return;
        // With nothing on top of it, Windows lets the game present straight to the screen
        // (independent flip): its full frame rate, native resolution, no added delay.
        _gameFullScreen = true;
        Hide();
        KeepPlaced();
        Native.SetForegroundWindow(_game.Handle);
    }

    private void LeaveGameFullScreen()
    {
        _gameFullScreen = false;
        Show();
        WindowState = FormWindowState.Normal;
        FitToScreen();
        KeepPlaced();
        if (_game is { Alive: true }) Native.SetForegroundWindow(_game.Handle);
    }

    /// <summary>
    /// The panel's hole from the page, and where the game window goes: the hole, grown by the
    /// crop on each side so the cropped edges (and the WoW strip) sit under the dashboard.
    /// </summary>
    private void SetHole(JsonNode msg)
    {
        if (msg["w"] is null)
        {
            _hole = _gameRect = null;
            KeepPlaced();
            return;
        }
        var origin = _web.PointToScreen(Point.Empty);
        double x = origin.X + (double)msg["x"]!, y = origin.Y + (double)msg["y"]!;
        double w = (double)msg["w"]!, h = (double)msg["h"]!;
        _hole = Rect(x, y, w, h);

        double Pct(string edge) => Math.Clamp((double?)msg["crop"]?[edge] ?? 0, 0, 45) / 100;
        double l = Pct("left"), r = Pct("right"), t = Pct("top"), b = Pct("bottom");
        double strip = (double?)msg["stripPx"] ?? 0;
        double gw = w / (1 - l - r), gh = h / (1 - t - b);
        _gameRect = Rect(x - l * gw, y - t * gh - strip, gw, gh + strip);
        KeepPlaced();
    }

    private static Native.RECT Rect(double x, double y, double w, double h)
    {
        int left = (int)Math.Round(x), top = (int)Math.Round(y);
        return new Native.RECT { Left = left, Top = top, Right = left + (int)Math.Round(w), Bottom = top + (int)Math.Round(h) };
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
            var s = Screen.FromHandle(_game.Handle).Bounds;
            _game.Place(new Native.RECT { Left = s.Left, Top = s.Top, Right = s.Right, Bottom = s.Bottom });
            return;
        }
        // In the tray, the game stays where it is.
        if (_game is not null && Visible && _gameRect is { Width: > 0, Height: > 0 } rect) _game.Place(rect);
        ApplyRegion();
    }

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
        // Regions are in window coordinates.
        var full = Native.CreateRectRgn(0, 0, Width, Height);
        var cut = Native.CreateRectRgn(hole.Left - Left, hole.Top - Top, hole.Right - Left, hole.Bottom - Top);
        Native.CombineRgn(full, full, cut, Native.RGN_DIFF);
        Native.DeleteObject(cut);
        // The window owns the region from here on, so it isn't deleted.
        Native.SetWindowRgn(Handle, full, true);
    }
}
