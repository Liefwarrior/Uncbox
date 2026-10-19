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
///               { type: "attach", id } | { type: "attach", match: { process, title, exact? } }
///               { type: "follow", folders: [...] }        take any window of a program in these folders
///                    the moment it appears (the Steam library folders, while Steam is in the panel);
///                    [] stops. A game taken this way goes back to Steam when it closes
///               { type: "detach" }                        give the game window back
///               { type: "rect", x, y, w, h, crop, stripPx } | { type: "rect" }
///                    where the panel's hole is, in device pixels; crop (percent per edge) and
///                    stripPx (the WoW strip) are tucked under the dashboard, out of sight
///               { type: "play" }                          hand the keyboard to the game
///               { type: "fullscreen" }                    the game gets the whole screen until Ctrl+Shift+F12
///               { type: "minimize" }                      to the tray
///   app → page  { type: "windows", windows: [{ id, title, process }] }
///               { type: "attached", id, title, process, followed } | { type: "detached" }
///                    followed: the app took it by itself (see follow), so it isn't the saved game
///               { type: "picture", on, launchOption }  the game won't be resized, so it's shown as a
///                    live picture; launchOption, if known, is what makes it resizable
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
    /// <summary>The game was taken by the follow folders, not picked or looked up by the page.</summary>
    private bool _gameFollowed;
    /// <summary>Folders (with a trailing separator) whose programs' windows take the panel as they appear.</summary>
    private string[] _follow = [];
    /// <summary>A followed game the page handed back (Steam's views): it isn't taken again while it lives.</summary>
    private IntPtr _released;
    /// <summary>The window event hooks, and their callback, kept in a field so it isn't collected.</summary>
    private readonly List<IntPtr> _hooks = [];
    private Native.WinEventProc? _onWinEvent;
    private Native.RECT? _hole;
    private Native.RECT? _gameRect;
    private Native.RECT? _applied;
    /// <summary>The game fills the screen and Uncbox is out of the way, until Ctrl+Shift+F12.</summary>
    private bool _gameFullScreen;

    /// <summary>
    /// Some games won't be resized (Unity games in full screen put themselves back at the monitor's
    /// size). After a couple of seconds of that, the game is left where it is, behind Uncbox, and
    /// shown in the panel as a live picture by the compositor: no capture and no added delay.
    /// Keyboard and controller still reach it, since it keeps focus; the mouse can't.
    /// </summary>
    private IntPtr _picture;
    private int _misfits;
    private const int MISFITS_BEFORE_PICTURE = 8;

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
        HookWindowEvents();

        if (!await StartServer()) return;

        // Each Uncbox server gets its own WebView2 profile, so two copies of the app (one per server)
        // never share one; the usual address keeps the plain folder it always had.
        string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Uncbox", "WebView2");
        if (_options.Url.Host != "localhost" || _options.Url.Port != 5170) data += $".{_options.Url.Host}.{_options.Url.Port}";
        try
        {
            var env = await CoreWebView2Environment.CreateAsync(userDataFolder: data);
            await _web.EnsureCoreWebView2Async(env);
        }
        catch (Exception err) when (err is COMException or WebView2RuntimeNotFoundException)
        {
            _splash.Text = err is WebView2RuntimeNotFoundException
                ? "Uncbox needs the Microsoft Edge WebView2 runtime: https://go.microsoft.com/fwlink/p/?LinkId=2124703"
                : $"Uncbox couldn’t start its page ({err.Message}). Close other copies of Uncbox and try again.";
            return;
        }
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
        foreach (var hook in _hooks) Native.UnhookWinEvent(hook);
        _hooks.Clear();
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
                var found = Find((string?)match["process"] ?? "", (string?)match["title"] ?? "", (bool?)match["exact"] ?? false);
                if (found != IntPtr.Zero) Attach(found);
                break;
            case "follow":
                Follow(msg["folders"] as JsonArray);
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
    /// only window (titles often change, "World of Warcraft" vs a loading screen). With exact, the
    /// title must match: Steam's library and Big Picture are both steamwebhelper windows.
    /// </summary>
    private IntPtr Find(string process, string title, bool exact)
    {
        if (process.Length == 0) return IntPtr.Zero;
        var same = Native.AppWindows(Handle).Where(w => w.Process.Equals(process, StringComparison.OrdinalIgnoreCase)).ToList();
        var hit = same.FirstOrDefault(w => w.Title == title);
        if (hit.Hwnd != IntPtr.Zero) return hit.Hwnd;
        return !exact && same.Count == 1 ? same[0].Hwnd : IntPtr.Zero;
    }

    /// <summary>
    /// The page's folders to follow (Steam's game folders), or none. Whatever of theirs is already
    /// open is taken right away; anything that opens later is taken by the window event hooks.
    /// </summary>
    private void Follow(JsonArray? folders)
    {
        _follow = (folders ?? [])
            .Select(f => (string?)f)
            .Where(f => !string.IsNullOrWhiteSpace(f))
            .Select(f => Path.GetFullPath(f!).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (_follow.Length == 0) _released = IntPtr.Zero;
        if (_game is { Alive: true } && _gameFollowed) return;
        var open = FindInFolders();
        if (open != IntPtr.Zero) Attach(open, followed: true);
    }

    /// <summary>
    /// A window of a program installed under one of the follow folders: the game Steam just started,
    /// which can be any exe in its folder, with any title. Its biggest window that isn't minimized wins.
    /// </summary>
    private IntPtr FindInFolders()
    {
        if (_follow.Length == 0) return IntPtr.Zero;
        return Native.TopLevelWindows(Handle)
            .Where(h => h != _game?.Handle && h != _released && InFollowFolders(h))
            .OrderBy(h => Native.IsIconic(h))
            .ThenByDescending(h => Native.GetWindowRect(h, out var r) ? (long)r.Width * r.Height : 0)
            .FirstOrDefault();
    }

    private bool InFollowFolders(IntPtr hwnd)
    {
        string path = Native.ProcessPathOf(hwnd);
        return path.Length > 0 && _follow.Any(f => path.StartsWith(f, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// Windows tells us when a window is shown, renamed or comes to the front, so a game that Steam
    /// starts takes the panel the moment its window opens, not on the page's next look. Three
    /// separate hooks rather than one range, which would include the very frequent location changes.
    /// Out of context, the events arrive through this thread's message loop, so the callback runs
    /// on the UI thread.
    /// </summary>
    private void HookWindowEvents()
    {
        _onWinEvent = OnWindowEvent;
        foreach (uint ev in new[] { Native.EVENT_OBJECT_SHOW, Native.EVENT_OBJECT_NAMECHANGE, Native.EVENT_SYSTEM_FOREGROUND })
        {
            var hook = Native.SetWinEventHook(ev, ev, IntPtr.Zero, _onWinEvent, 0, 0, Native.WINEVENT_OUTOFCONTEXT | Native.WINEVENT_SKIPOWNPROCESS);
            if (hook != IntPtr.Zero) _hooks.Add(hook);
        }
    }

    private void OnWindowEvent(IntPtr hook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
    {
        // Cheapest checks first: this runs for every window event on the PC. The program's path
        // is looked up last.
        if (_follow.Length == 0 || idObject != 0 || idChild != 0 || hwnd == IntPtr.Zero) return;
        if (hwnd == Handle || hwnd == _game?.Handle || hwnd == _released) return;
        // A followed game that's still up keeps the panel; if it goes, KeepPlaced picks the next window.
        if (_gameFollowed && _game is { Alive: true, Shown: true }) return;
        if (!Native.IsAppWindow(hwnd) || !InFollowFolders(hwnd)) return;
        Attach(hwnd, followed: true);
    }

    private void Attach(IntPtr hwnd, bool followed = false)
    {
        if (!Native.IsWindow(hwnd) || hwnd == Handle) return;
        if (_game?.Handle != hwnd)
        {
            StopPicture();
            _game?.Restore();
            _game = new GameWindow(hwnd);
            _game.MakeBorderless();
        }
        _gameFollowed = followed;
        KeepPlaced();
        Send(new { type = "attached", id = hwnd.ToString(), title = _game.Title, process = Native.ProcessNameOf(hwnd), followed });
    }

    private void Detach()
    {
        if (_gameFullScreen) LeaveGameFullScreen();
        StopPicture();
        _game?.Restore();
        // The page handing a followed game back (to Steam's library, say) means it stays out of
        // the panel, rather than being taken again the next time it comes to the front.
        if (_gameFollowed && _game is not null) _released = _game.Handle;
        _game = null;
        _gameFollowed = false;
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
        if (_released != IntPtr.Zero && !Native.IsWindow(_released)) _released = IntPtr.Zero;
        if (_game is { Alive: false })
        {
            bool followed = _gameFollowed;
            StopPicture();
            _game = null;
            _gameFollowed = false;
            // Games often swap a splash window for the main one: look for that before giving up.
            var next = followed ? FindInFolders() : IntPtr.Zero;
            if (next != IntPtr.Zero)
            {
                Attach(next, followed: true);
                return;
            }
            Send(new { type = "detached" });
            if (_gameFullScreen)
            {
                _gameFullScreen = false;
                Show();
            }
        }
        if (_game is not null && _gameFullScreen)
        {
            if (_game.HasFrame) _game.MakeBorderless();
            var s = Screen.FromHandle(_game.Handle).Bounds;
            _game.Place(new Native.RECT { Left = s.Left, Top = s.Top, Right = s.Right, Bottom = s.Bottom });
            return;
        }
        // In the tray, the game stays where it is. A window its app has hidden (Steam hides its
        // library for Big Picture) is left hidden rather than shown again.
        if (_game is not null && Visible && _game.Shown && _gameRect is { Width: > 0, Height: > 0 } rect)
        {
            if (_picture != IntPtr.Zero) ShowPicture();
            else
            {
                if (_game.HasFrame) _game.MakeBorderless();
                _game.Place(rect);
                _misfits = _game.Fits(rect) ? 0 : _misfits + 1;
                if (_misfits >= MISFITS_BEFORE_PICTURE) StartPicture();
            }
        }
        ApplyRegion();
    }

    private void StartPicture()
    {
        if (_game is null || Native.DwmRegisterThumbnail(Handle, _game.Handle, out _picture) != 0) return;
        ShowPicture();
        Send(new { type = "picture", on = true, launchOption = _game.WindowedLaunchOption() });
        Native.SetForegroundWindow(_game.Handle);
    }

    private void StopPicture()
    {
        _misfits = 0;
        if (_picture == IntPtr.Zero) return;
        Native.DwmUnregisterThumbnail(_picture);
        _picture = IntPtr.Zero;
        Send(new { type = "picture", on = false, launchOption = "" });
    }

    /// <summary>The picture fitted into the panel, keeping the game's shape.</summary>
    private void ShowPicture()
    {
        var props = new Native.THUMBNAIL_PROPERTIES
        {
            Flags = Native.TNP_RECTDESTINATION | Native.TNP_VISIBLE | Native.TNP_OPACITY | Native.TNP_SOURCECLIENTAREAONLY,
            Opacity = 255,
            SourceClientAreaOnly = 1,
        };
        if (_game is not null && _hole is { Width: > 0, Height: > 0 } hole && Native.GetClientRect(_game.Handle, out var src) && src.Width > 0 && src.Height > 0)
        {
            double scale = Math.Min((double)hole.Width / src.Width, (double)hole.Height / src.Height);
            int w = (int)Math.Round(src.Width * scale), h = (int)Math.Round(src.Height * scale);
            int x = hole.Left - Left + (hole.Width - w) / 2, y = hole.Top - Top + (hole.Height - h) / 2;
            props.Destination = new Native.RECT { Left = x, Top = y, Right = x + w, Bottom = y + h };
            props.Visible = 1;
        }
        Native.DwmUpdateThumbnailProperties(_picture, ref props);
    }

    /// <summary>Cuts the hole the game shows through, or fills it back in with no game.</summary>
    private void ApplyRegion()
    {
        // A game shown as a picture stays behind Uncbox: no hole.
        Native.RECT? want = _game is not null && _picture == IntPtr.Zero && _hole is { Width: > 0, Height: > 0 } ? _hole : null;
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
