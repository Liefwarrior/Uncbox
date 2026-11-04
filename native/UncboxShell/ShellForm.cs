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
///               { type: "web" | "webrect" | "webnav" | "webzoom" | "webclose", id, ... }
///                    the web widgets' pages, each a WebView2 over its panel (see WebViews.cs)
///               { type: "autostart" } | { type: "autostart", enabled }   ask / change start-with-Windows
///               { type: "audiodevices" }                  list the mics
///               { type: "streamaudio", on, desktop, mic, desktopVolume, micVolume } | { type: "streamaudio", on: false }
///                    capture desktop sound and a mic into a named pipe for FFmpeg (see StreamAudio.cs)
///               { type: "streamaudiovolume", desktopVolume, micVolume }   gains from 0 to 2, while on
///               { type: "clipaudio", on: true, title, mic } | { type: "clipaudio", on: false }
///                    keep the last minute of the game's, Discord's and the mic's sound for clips (see
///                    ClipAudio.cs); title is the captured window's label, mic a device id, "default" or null
///               { type: "clipaudioget", id, fromMs, toMs }   the sound of a clip's stretch of time
///               { type: "stealth", on } | { type: "stealth" }   go into or out of stealth mode / ask whether it's on
///               { type: "relay", message }                the stream controller's state, for the manager's page
///   app → page  { type: "windows", windows: [{ id, title, process }] }
///               { type: "attached", id, title, process, followed } | { type: "detached" }
///                    followed: the app took it by itself (see follow), so it isn't the saved game
///               { type: "autostartstate", enabled }       whether Uncbox starts with Windows (see Autostart.cs)
///               { type: "picture", on, launchOption }  the game won't be resized, so it's shown as a
///                    live picture; launchOption, if known, is what makes it resizable
///               { type: "webstate", id, url, title, canGoBack, canGoForward, loading }
///                    where a web widget's page is (see WebViews.cs)
///               { type: "audiodevices", mics: [{ id, name, isDefault }] }
///               { type: "streamaudio", state: "ready", pipe, rate, channels, format } | { state: "off" } | { state: "error", error }
///               { type: "audiolevels", desktop, mic }     peak 0..1 of each source, about 10 times a second
///               { type: "clipaudio", state: "on", game, gameName, discord, mic, micError } | { state: "off" } | { state: "error", error }
///               { type: "cliplevels", game, discord, mic }   peak levels 0..1, about five times a second
///               { type: "stealth", on }                   stealth mode came on or went off
///               { type: "scene", scene }                  what the stream shows in stealth mode (see StealthLayout.Scene), or null
///               { type: "streamcommand", action }        from the manager: "start", "test", "end" or "state"
///               { type: "clipsave" }                      from the manager: save a clip
///               and, for clipaudioget, a WebView2 shared buffer (game, then Discord, then mic: each
///               frames x 2 interleaved s16le samples) with { type: "clipaudio", id, frames, rate } or, as
///               JSON, { type: "clipaudio", id, error }
///
/// Stealth mode is the OBS way of playing: the game goes full screen in front and is played as it
/// is, the dashboard keeps running at its own size behind it (out of the taskbar and Alt+Tab, never
/// taking focus), and a small manager window (StealthForm.cs) runs Uncbox. The stream shows the
/// dashboard with the game drawn over its panel, made by Uncbox's own streaming engine from two
/// window captures (engine/src/scene.rs); the page passes the scene this window describes on to the
/// server. The manager's page talks to this window too, through a short list of its own messages.
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
    private readonly ToolStripMenuItem _stealthMenu = new("Stealth mode");
    private readonly ToolStripMenuItem _screenMenu = new("Monitor");
    private readonly System.Windows.Forms.Timer _keepPlaced = new() { Interval = 250 };
    private readonly ServerHost _server = new();
    private CoreWebView2Environment? _env;
    /// <summary>The sound for clips, while the page's replay buffer runs.</summary>
    private ClipAudio? _clipAudio;
    /// <summary>The web widgets' pages; made once the dashboard's own WebView2 is up.</summary>
    private WebViews? _webViews;
    /// <summary>The stream's sound (desktop and mic into a pipe for FFmpeg), while the page has it on.</summary>
    private StreamAudio? _streamAudio;
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
    /// <summary>The game panel as the page measured it (device pixels from the dashboard's top left), with its crop and fit.</summary>
    private GamePanel? _panel;

    /// <summary>
    /// Stealth mode: the game full screen in front, the dashboard running behind it for the stream,
    /// and the manager window to run Uncbox from.
    /// </summary>
    private bool _stealth;
    private StealthForm? _manager;
    /// <summary>The scene last told to the page, so only changes are sent.</summary>
    private string _sceneSent = "";
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
        _stealthMenu.Click += (_, _) =>
        {
            if (_stealth) LeaveStealth();
            else EnterStealth();
        };
        menu.Items.Add(_stealthMenu);
        menu.Items.Add(_screenMenu);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit Uncbox", null, (_, _) => Close());
        menu.Opening += (_, _) =>
        {
            _fullMenu.Enabled = _game is { Alive: true } && !_stealth;
            _stealthMenu.Checked = _stealth;
            _stealthMenu.Enabled = _env is not null;
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
        // Started with Windows (--tray): invisible until the tray hides it, and no "still running" tip.
        if (_options.StartInTray)
        {
            Opacity = 0;
            _trayHinted = true;
            BeginInvoke(ToTray);
        }

        if (!await StartServer()) return;

        // Each Uncbox server gets its own WebView2 profile, so two copies of the app (one per server)
        // never share one; the usual address keeps the plain folder it always had.
        string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Uncbox", "WebView2");
        if (_options.Url.Host != "localhost" || _options.Url.Port != 5170) data += $".{_options.Url.Host}.{_options.Url.Port}";
        CoreWebView2Environment env;
        try
        {
            // Stealth mode streams the dashboard while the game covers it, so the page has to keep drawing
            // when covered (Chromium would otherwise stop, as it does for a hidden tab). Outside stealth
            // mode the dashboard is topmost and nothing covers it, and hidden (the tray, full screen) it
            // still stops drawing as before.
            var options = new CoreWebView2EnvironmentOptions { AdditionalBrowserArguments = "--disable-features=CalculateNativeWinOcclusion" };
            env = await CoreWebView2Environment.CreateAsync(null, data, options);
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
        _env = env;
        _webViews = new WebViews(this, _web, env, Send);
        // The dashboard reloaded: its web widgets start over and ask for their pages again, and the
        // clip sound (the mic included) stops until the new page asks for it.
        core.ContentLoading += (_, _) =>
        {
            _webViews.CloseAll();
            StopClipAudio();
            // The new page asks for stealth mode's state and is told the scene again.
            _sceneSent = "";
        };
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
            if (!await _server.EnsureRunning(_options.Url, _options.Root, _options.DataDir, status, _options.Engine))
            {
                _splash.Text = _server.Error;
                return false;
            }
            // A server that was already running has its own idea of who streams: say what this launch wants.
            await ServerHost.TellEngine(_options.Url, _options.Engine);
            return true;
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
            // In stealth mode it swaps between the game and the manager, the way you'd click OBS and back.
            if (_stealth) ToggleManager();
            else if (_gameFullScreen) LeaveGameFullScreen();
            else if (Visible && WindowState != FormWindowState.Minimized) ToTray();
            else RestoreFromTray();
        }
        base.WndProc(ref m);
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        if (WindowState != FormWindowState.Minimized) return;
        // In stealth mode the dashboard is what viewers see, and a minimized window draws nothing: it stays up, behind.
        if (_stealth)
        {
            BeginInvoke(() =>
            {
                WindowState = FormWindowState.Normal;
                FitToScreen();
                SendBehind();
            });
            return;
        }
        // Minimizing (Win+Down, the taskbar, the page's button) sends Uncbox to the tray.
        ToTray();
    }

    private void ToTray()
    {
        // In stealth mode "to the tray" is the manager getting out of the way; the dashboard keeps running.
        if (_stealth)
        {
            _manager?.Minimize();
            FocusGame();
            return;
        }
        Hide();
        if (_trayHinted) return;
        _trayHinted = true;
        _tray.ShowBalloonTip(3000, "Uncbox is still running", "Click the Uncbox icon here, or press Ctrl+Shift+F12, to bring it back.", ToolTipIcon.None);
    }

    private void RestoreFromTray()
    {
        if (_stealth)
        {
            _manager?.Bring();
            return;
        }
        if (_gameFullScreen)
        {
            LeaveGameFullScreen();
            return;
        }
        Opacity = 1;
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
        _manager?.CloseFromApp();
        _manager = null;
        _game?.Restore();
        _webViews?.Dispose();
        _streamAudio?.Dispose();
        StopClipAudio();
        _tray.Visible = false;
        _tray.Dispose();
        _server.Dispose();
        base.OnFormClosing(e);
    }

    private void Send(object message) => _web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(message));

    /// <summary>Whether stealth mode is on, to the dashboard's page and the manager's.</summary>
    private void SendStealthState()
    {
        var state = new { type = "stealth", on = _stealth };
        Send(state);
        _manager?.Send(state);
    }

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
            case "web" or "webrect" or "webnav" or "webzoom" or "webclose":
                if (msg is not null) _webViews?.OnMessage((string)msg["type"]!, msg);
                break;
            case "autostart":
                Send(new { type = "autostartstate", enabled = Autostart.Handle(msg) });
                break;
            case "audiodevices":
                Task.Run(() => PostFromAnyThread(AudioKit.ListMics()));
                break;
            case "streamaudio" when msg is not null:
                StreamAudioMessage(msg);
                break;
            case "streamaudiovolume" when msg is not null:
                _streamAudio?.SetVolumes((double?)msg["desktopVolume"] ?? 1, (double?)msg["micVolume"] ?? 1);
                break;
            case "clipaudio" when msg is not null:
                if ((bool?)msg["on"] == true) StartClipAudio((string?)msg["title"] ?? "", (string?)msg["mic"]);
                else StopClipAudio();
                break;
            case "clipaudioget" when msg is not null:
                SendClipAudio((int?)msg["id"] ?? 0, (int?)msg["fromMs"] ?? 0, (int?)msg["toMs"] ?? 0);
                break;
            case "stealth" when msg is not null:
                StealthMessage(msg);
                break;
            // The dashboard's stream controller, for the manager's page to show (it runs no controller of its own).
            case "relay" when msg is not null && msg["message"] is JsonObject relayed && KindOf(relayed) == "streamstate":
                _manager?.SendJson(relayed.ToJsonString());
                break;
        }
    }

    /// <summary>A message's type, or null when it has none.</summary>
    private static string? KindOf(JsonNode message) => message["type"] is JsonValue v && v.TryGetValue(out string? kind) ? kind : null;

    /// <summary>{ type: "stealth", on } from either page; without on, a page asking (it just loaded).</summary>
    private void StealthMessage(JsonNode msg)
    {
        bool? on = (bool?)msg["on"];
        if (on == true) EnterStealth();
        else if (on == false) LeaveStealth();
        else
        {
            SendStealthState();
            _sceneSent = "";
            SendScene();
        }
    }

    /// <summary>
    /// What the manager's page may ask for. It is the same Uncbox page, but it isn't the dashboard: it
    /// can't move the game or open web views, only run stealth mode and hand things to the dashboard.
    /// </summary>
    private void OnManagerMessage(string json)
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
        if (msg is null || _manager is not { } manager) return;
        switch ((string?)msg["type"])
        {
            case "stealth":
                if ((bool?)msg["on"] == false) LeaveStealth();
                else manager.Send(new { type = "stealth", on = _stealth });
                break;
            case "previewrect":
                manager.SetPreviewBox(msg);
                UpdatePreview();
                break;
            // Going live, ending, a clip: the dashboard's page does those (it has the controller and the replay buffer).
            case "relay" when msg["message"] is JsonObject relayed && KindOf(relayed) is "streamcommand" or "clipsave":
                _web.CoreWebView2?.PostWebMessageAsJson(relayed.ToJsonString());
                break;
            case "play":
                FocusGame();
                break;
            case "minimize":
                manager.Minimize();
                FocusGame();
                break;
            case "streamaudiovolume":
                _streamAudio?.SetVolumes((double?)msg["desktopVolume"] ?? 1, (double?)msg["micVolume"] ?? 1);
                break;
            case "audiodevices":
                Task.Run(() =>
                {
                    var mics = AudioKit.ListMics();
                    try
                    {
                        if (!IsDisposed) BeginInvoke(() => _manager?.Send(mics));
                    }
                    catch (InvalidOperationException)
                    {
                        // Closed in between.
                    }
                });
                break;
            case "autostart":
                manager.Send(new { type = "autostartstate", enabled = Autostart.Handle(msg) });
                break;
        }
    }

    // ---- stealth mode ----

    /// <summary>
    /// The game goes full screen in front, as you'd play it with OBS; the dashboard stays up behind it
    /// at its own size (the stream shows it), out of the taskbar and Alt+Tab; the manager opens.
    /// </summary>
    private void EnterStealth()
    {
        if (_env is null) return;
        if (_stealth)
        {
            _manager?.Bring();
            return;
        }
        _stealth = true;
        _gameFullScreen = false;
        // The stream draws the game from its own capture, so the dashboard needs no picture of it.
        StopPicture();
        Opacity = 1;
        if (!Visible) Show();
        WindowState = FormWindowState.Normal;
        TopMost = false;
        FitToScreen();
        SetStealthStyles(true);
        // No hole in stealth mode: the game isn't behind the panel any more. (FitToScreen forgets which
        // region is applied, so ApplyRegion alone wouldn't take the old one away.)
        Native.SetWindowRgn(Handle, IntPtr.Zero, true);
        _applied = null;
        SendBehind();

        var bounds = StealthLayout.ManagerBounds(_screen.Bounds, Screen.AllScreens.Select(s => s.WorkingArea).ToList());
        var url = new UriBuilder(_options.Url);
        url.Query = url.Query.TrimStart('?') + "&view=manager";
        var manager = new StealthForm(_env, url.Uri, Icon, bounds, OnManagerMessage, LeaveStealth);
        manager.FormClosed += (_, _) =>
        {
            if (_manager == manager) _manager = null;
        };
        _manager = manager;
        manager.Show();

        KeepPlaced();
        SendStealthState();
        SendScene();
        // Into the game: that's what stealth mode is for. The manager is a click (or Ctrl+Shift+F12) away.
        if (_game is { Alive: true }) FocusGame();
    }

    /// <summary>Back to the full dashboard, the game back in its panel.</summary>
    private void LeaveStealth()
    {
        if (!_stealth) return;
        _stealth = false;
        var manager = _manager;
        _manager = null;
        manager?.CloseFromApp();
        SetStealthStyles(false);
        TopMost = !_options.Windowed || _windowedFull;
        Show();
        WindowState = FormWindowState.Normal;
        FitToScreen();
        Activate();
        KeepPlaced();
        SendStealthState();
        SendScene();
        if (_game is { Alive: true }) FocusGame();
    }

    /// <summary>Ctrl+Shift+F12 in stealth mode: the manager up, or out of the way and back into the game.</summary>
    private void ToggleManager()
    {
        if (_manager is not { } manager) return;
        if (manager.IsActive)
        {
            manager.Minimize();
            FocusGame();
        }
        else manager.Bring();
    }

    private void FocusGame()
    {
        if (_game is { Alive: true }) Native.SetForegroundWindow(_game.Handle);
    }

    /// <summary>
    /// In stealth mode the dashboard is a tool window that never takes focus: not in the taskbar or
    /// Alt+Tab (the manager is), and a stray click on it doesn't bring it over the game. The taskbar only
    /// reads the style when a window is shown, so the window is hidden and shown again around the change
    /// (without handing it focus). Its handle stays the same, which the stream's capture of it relies on.
    /// </summary>
    private void SetStealthStyles(bool on)
    {
        long ex = Native.GetWindowLongPtr(Handle, Native.GWL_EXSTYLE);
        long want = on ? (ex | Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE) & ~Native.WS_EX_APPWINDOW : ex & ~(Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE);
        if (want == ex) return;
        Native.ShowWindow(Handle, Native.SW_HIDE);
        Native.SetWindowLongPtr(Handle, Native.GWL_EXSTYLE, want);
        Native.ShowWindow(Handle, on ? Native.SW_SHOWNOACTIVATE : Native.SW_RESTORE);
    }

    /// <summary>The dashboard under every other window, where the game (or anything else) covers it.</summary>
    private void SendBehind() =>
        Native.SetWindowPos(Handle, Native.HWND_BOTTOM, 0, 0, 0, 0, Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);

    /// <summary>
    /// Tells the page what the stream shows in stealth mode: this window, with the game's window over
    /// its panel (when there is a game in it), or null outside stealth mode. Only changes are sent.
    /// </summary>
    private void SendScene()
    {
        if (_web.CoreWebView2 is null) return;
        var scene = _stealth ? StealthLayout.Scene(Handle, ClientSize.Width, ClientSize.Height, true, _game is { Alive: true } g ? g.Handle : IntPtr.Zero, _panel) : null;
        string json = scene?.ToJsonString() ?? "null";
        if (json == _sceneSent) return;
        _sceneSent = json;
        _web.CoreWebView2.PostWebMessageAsJson(new JsonObject { ["type"] = "scene", ["scene"] = scene }.ToJsonString());
    }

    /// <summary>The manager's preview: this window, with the game over its panel, as viewers see it.</summary>
    private void UpdatePreview()
    {
        if (_manager is not { } manager) return;
        var game = _game is { Alive: true } g ? g.Handle : IntPtr.Zero;
        manager.UpdatePreview(Handle, ClientSize, game, game != IntPtr.Zero ? _panel : null);
    }

    /// <summary>
    /// Starts or stops the stream's sound (see StreamAudio.cs). Only one session at a time: starting
    /// again replaces the old one, which says nothing; stopping always answers "off".
    /// </summary>
    private void StreamAudioMessage(JsonNode msg)
    {
        _streamAudio?.Dispose();
        _streamAudio = null;
        if ((bool?)msg["on"] != true)
        {
            Send(new { type = "streamaudio", state = "off" });
            return;
        }
        _streamAudio = new StreamAudio(PostFromAnyThread);
        _streamAudio.Start((bool?)msg["desktop"] ?? false, (string?)msg["mic"], (double?)msg["desktopVolume"] ?? 1, (double?)msg["micVolume"] ?? 1);
    }

    /// <summary>The stream's and clips' sound report from their own threads; the page is only spoken to from this one.</summary>
    private void PostFromAnyThread(object message)
    {
        try
        {
            if (!IsDisposed && IsHandleCreated) BeginInvoke(() => Send(message));
        }
        catch (InvalidOperationException)
        {
            // The window closed in between.
        }
    }

    /// <summary>(Re)starts the sound kept for clips. title is the label of the page's capture of the game.</summary>
    private void StartClipAudio(string title, string? mic)
    {
        _clipAudio?.Dispose();
        var self = Handle;
        _clipAudio = new ClipAudio(PostFromAnyThread, label => WindowOfCapture(self, label));
        _clipAudio.Start(title, mic);
    }

    /// <summary>Stops the clip sound (and the mic) and tells the page, if it was running.</summary>
    private void StopClipAudio()
    {
        var audio = _clipAudio;
        _clipAudio = null;
        if (audio is null) return;
        audio.Dispose();
        PostFromAnyThread(new { type = "clipaudio", state = "off" });
    }

    /// <summary>
    /// The program that owns a window the page is capturing. Chrome and Edge label a window capture
    /// "window:HANDLE:0", so the handle is used when the label has one; any other label is taken to
    /// be the window's title.
    /// </summary>
    private static (int Pid, string Name)? WindowOfCapture(IntPtr self, string label)
    {
        var handle = System.Text.RegularExpressions.Regex.Match(label, @"^window:(\d+):");
        if (handle.Success && long.TryParse(handle.Groups[1].Value, out long h))
        {
            var hwnd = new IntPtr(h);
            if (!Native.IsWindow(hwnd)) return null;
            Native.GetWindowThreadProcessId(hwnd, out uint owner);
            return ((int)owner, Native.TitleOf(hwnd));
        }
        var windows = Native.AppWindows(self);
        var hit = windows.FirstOrDefault(w => w.Title == label);
        if (hit.Hwnd == IntPtr.Zero) hit = windows.FirstOrDefault(w => w.Title.Equals(label, StringComparison.OrdinalIgnoreCase));
        if (hit.Hwnd == IntPtr.Zero) return null;
        Native.GetWindowThreadProcessId(hit.Hwnd, out uint pid);
        return ((int)pid, hit.Title);
    }

    /// <summary>
    /// Answers clipaudioget: the three sources' sound for the stretch that started fromMs ago and
    /// ended toMs ago, in a WebView2 shared buffer (60 s of three tracks is 35 MB, too much for JSON).
    /// </summary>
    private unsafe void SendClipAudio(int id, int fromMs, int toMs)
    {
        void Fail(string error) => Send(new { type = "clipaudio", id, error });
        var audio = _clipAudio;
        if (audio is not { Running: true } || _env is null || _web.CoreWebView2 is null)
        {
            Fail("Sound isn't being recorded.");
            return;
        }
        if (toMs < 0 || fromMs <= toMs || fromMs - toMs > ClipAudio.MaxSpanMs)
        {
            Fail("That stretch of sound is too long to keep.");
            return;
        }
        int frames = ClipAudio.Frames(fromMs, toMs);
        int samples = frames * AudioKit.Channels;
        CoreWebView2SharedBuffer? buffer = null;
        try
        {
            buffer = _env.CreateSharedBuffer((ulong)samples * 3 * sizeof(short));
            var all = new Span<short>((void*)buffer.Buffer, samples * 3);
            audio.Read(fromMs, toMs, all[..samples], all[samples..(2 * samples)], all[(2 * samples)..]);
            _web.CoreWebView2.PostSharedBufferToScript(
                buffer, CoreWebView2SharedBufferAccess.ReadOnly,
                JsonSerializer.Serialize(new { type = "clipaudio", id, frames, rate = AudioKit.Rate }));
        }
        catch (Exception)
        {
            Fail("Couldn't get the sound for that clip.");
        }
        finally
        {
            // The page has its own mapping of it by now.
            buffer?.Dispose();
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
        SendScene();
        if (_stealth) FocusGame();
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
        SendScene();
    }

    private void GameFullScreen()
    {
        // Stealth mode already has the game full screen, with the dashboard still drawing behind it.
        if (_game is not { Alive: true } || _stealth) return;
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
            _panel = null;
            KeepPlaced();
            SendScene();
            return;
        }
        var origin = _web.PointToScreen(Point.Empty);
        double px = (double)msg["x"]!, py = (double)msg["y"]!;
        double x = origin.X + px, y = origin.Y + py;
        double w = (double)msg["w"]!, h = (double)msg["h"]!;
        _hole = Rect(x, y, w, h);

        double Pct(string edge) => Math.Clamp((double?)msg["crop"]?[edge] ?? 0, 0, 45) / 100;
        double l = Pct("left"), r = Pct("right"), t = Pct("top"), b = Pct("bottom");
        double strip = Math.Max((double?)msg["stripPx"] ?? 0, 0);
        double gw = w / (1 - l - r), gh = h / (1 - t - b);
        _gameRect = Rect(x - l * gw, y - t * gh - strip, gw, gh + strip);
        // The web view fills this window, so the page's box is the panel in the window's own pixels.
        _panel = new GamePanel(new Box(px, py, w, h), l, t, r, b, strip, (string?)msg["fit"] ?? "contain");
        KeepPlaced();
        SendScene();
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
            SendScene();
            if (_gameFullScreen)
            {
                _gameFullScreen = false;
                Show();
            }
        }
        if (_stealth)
        {
            KeepStealth();
            return;
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

    /// <summary>
    /// Stealth mode, a few times a second: the game full screen on its monitor, the dashboard kept
    /// behind (should something have brought it forward), the manager's preview and the scene current.
    /// </summary>
    private void KeepStealth()
    {
        if (_game is { Alive: true, Shown: true } game)
        {
            if (game.HasFrame) game.MakeBorderless();
            var s = Screen.FromHandle(game.Handle).Bounds;
            game.Place(new Native.RECT { Left = s.Left, Top = s.Top, Right = s.Right, Bottom = s.Bottom });
        }
        if (Native.GetForegroundWindow() == Handle) SendBehind();
        ApplyRegion();
        UpdatePreview();
        SendScene();
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
        // A game shown as a picture stays behind Uncbox: no hole. Nor in stealth mode, where the game is
        // in front, full screen, and the stream draws it over the panel from its own capture.
        Native.RECT? want = _game is not null && !_stealth && _picture == IntPtr.Zero && _hole is { Width: > 0, Height: > 0 } ? _hole : null;
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
