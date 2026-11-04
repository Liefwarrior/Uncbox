using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace UncboxShell;

/// <summary>
/// Stealth mode's manager: a plain window, like OBS's, that runs Uncbox while you play. It shows the
/// Uncbox page in its manager view (?view=manager): a live preview of exactly what viewers see, the
/// Go live controls, and the whole sidebar (presets, widgets, clips, streaming, automations...).
/// Everything changed here changes the dashboard too, since every Uncbox page shares the same state.
///
/// The preview is drawn by Windows' compositor (DWM thumbnails of the dashboard and of the game, the
/// game placed over its panel the way the streaming engine places it), so it costs next to nothing:
/// OBS renders its preview itself, every frame. The thumbnails sit in a small borderless window of
/// their own over the page's preview box, owned by the manager so it moves, hides and minimizes with it.
///
/// The manager is kept out of every screen capture (SetWindowDisplayAffinity), so it never reaches a
/// stream, a clip or a screen share even when it sits on the screen being captured. Closing it leaves
/// stealth mode (the dashboard comes back); minimizing it is like minimizing OBS: the stream goes on.
/// </summary>
internal sealed class StealthForm : Form
{
    private readonly CoreWebView2Environment _env;
    private readonly Uri _url;
    private readonly Action<string> _onMessage;
    private readonly Action _onClose;
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill, Visible = false };
    private readonly Label _splash = new()
    {
        Dock = DockStyle.Fill,
        TextAlign = ContentAlignment.MiddleCenter,
        ForeColor = Color.FromArgb(0xC8, 0xCC, 0xD6),
        Font = new Font("Segoe UI", 13f),
        Text = "Opening stealth mode…",
    };
    private readonly PreviewWindow _preview = new();
    private IntPtr _dashThumb, _gameThumb;
    private IntPtr _dashSource, _gameSource;
    /// <summary>The page's preview box, in device pixels from the page's top left; null while hidden.</summary>
    private Rectangle? _box;
    /// <summary>Closed by the app (stealth mode ended), not by the person.</summary>
    private bool _closing;

    public StealthForm(CoreWebView2Environment env, Uri url, Icon? icon, Rectangle bounds, Action<string> onMessage, Action onClose)
    {
        _env = env;
        _url = url;
        _onMessage = onMessage;
        _onClose = onClose;
        Text = "Uncbox · Stealth mode";
        Icon = icon;
        StartPosition = FormStartPosition.Manual;
        Bounds = bounds;
        MinimumSize = new Size(720, 480);
        BackColor = Color.FromArgb(0x10, 0x12, 0x19);
        Controls.Add(_web);
        Controls.Add(_splash);
        Move += (_, _) => PlacePreview();
        Resize += (_, _) => PlacePreview();
    }

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        // Viewers never see the manager: screen captures leave it out (or, before Windows 10 2004, show black).
        if (!Native.SetWindowDisplayAffinity(Handle, Native.WDA_EXCLUDEFROMCAPTURE)) Native.SetWindowDisplayAffinity(Handle, Native.WDA_MONITOR);
        try
        {
            await _web.EnsureCoreWebView2Async(_env);
        }
        catch (Exception err) when (err is COMException or WebView2RuntimeNotFoundException or InvalidOperationException)
        {
            _splash.Text = $"Stealth mode couldn’t open its page ({err.Message}).";
            return;
        }
        var core = _web.CoreWebView2;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.WebMessageReceived += (_, args) => _onMessage(args.WebMessageAsJson);
        core.NewWindowRequested += (_, args) =>
        {
            args.Handled = true;
            if (Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri) && (uri.Scheme == "https" || uri.Scheme == "http"))
            {
                Process.Start(new ProcessStartInfo(uri.ToString()) { UseShellExecute = true });
            }
        };
        // A reload of the page takes the preview away until it says where the box is again.
        core.ContentLoading += (_, _) => SetBox(null);
        core.NavigationCompleted += (_, args) =>
        {
            if (!args.IsSuccess) return;
            _web.Visible = true;
            _splash.Visible = false;
            // The page may have said where its preview goes before it finished loading.
            PlacePreview();
        };
        core.Navigate(_url.ToString());
        // The preview's own window, kept over the page's box (owned, so it stays above this one and minimizes with it).
        _preview.Owner = this;
        PlacePreview();
    }

    /// <summary>To the manager's page.</summary>
    public void Send(object message) => SendJson(JsonSerializer.Serialize(message));

    public void SendJson(string json)
    {
        if (!IsDisposed) _web.CoreWebView2?.PostWebMessageAsJson(json);
    }

    /// <summary>Up and in front, like clicking OBS in the taskbar.</summary>
    public void Bring()
    {
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Show();
        Activate();
    }

    public void Minimize() => WindowState = FormWindowState.Minimized;

    /// <summary>Whether the person is using the manager right now.</summary>
    public bool IsActive => Native.GetForegroundWindow() == Handle;

    /// <summary>{ type: "previewrect", x, y, w, h } from the page (device pixels), or without w to hide the preview.</summary>
    public void SetPreviewBox(JsonNode msg)
    {
        if (msg["w"] is null || msg["h"] is null)
        {
            SetBox(null);
            return;
        }
        double x = (double?)msg["x"] ?? 0, y = (double?)msg["y"] ?? 0, w = (double?)msg["w"] ?? 0, h = (double?)msg["h"] ?? 0;
        if (w < 2 || h < 2)
        {
            SetBox(null);
            return;
        }
        var r = new Box(x, y, w, h).ToRect();
        SetBox(new Rectangle(r.Left, r.Top, r.Width, r.Height));
    }

    private void SetBox(Rectangle? box)
    {
        if (Nullable.Equals(box, _box)) return;
        _box = box;
        PlacePreview();
    }

    /// <summary>The preview's window over the page's box, on screen; hidden without one.</summary>
    private void PlacePreview()
    {
        if (_preview.IsDisposed || _preview.Owner is null) return;
        if (_box is not { } box || WindowState == FormWindowState.Minimized || !_web.Visible)
        {
            if (_preview.Visible) _preview.Hide();
            return;
        }
        var origin = _web.PointToScreen(new Point(box.X, box.Y));
        var bounds = new Rectangle(origin, box.Size);
        if (_preview.Bounds != bounds) _preview.Bounds = bounds;
        if (!_preview.Visible) _preview.Show();
    }

    /// <summary>
    /// Shows the dashboard and the game in the preview, the game over its panel as viewers see it.
    /// Cheap to call often: thumbnails are registered once per window and only moved after that.
    /// </summary>
    public void UpdatePreview(IntPtr dashboard, Size dashSize, IntPtr game, GamePanel? panel)
    {
        if (_preview.IsDisposed) return;
        // The thumbnails need the preview's window to exist, shown or not.
        _ = _preview.Handle;
        var area = new Box(0, 0, _preview.ClientSize.Width, _preview.ClientSize.Height);
        Box? dashOn = null;
        if (Retarget(ref _dashThumb, ref _dashSource, dashboard) && dashSize.Width > 0 && dashSize.Height > 0)
        {
            dashOn = area.Fitted((double)dashSize.Width / dashSize.Height);
            Show(_dashThumb, dashOn.Value.ToRect(), null);
        }
        else Hide(_dashThumb);

        bool gameShown = false;
        if (dashOn is { } on && panel is { } p && Retarget(ref _gameThumb, ref _gameSource, game) && Native.GetClientRect(game, out var client))
        {
            var placed = StealthLayout.PlaceGame(on, dashSize.Width, dashSize.Height, p, client.Width, client.Height);
            if (placed is { } where)
            {
                Show(_gameThumb, where.Dest.ToRect(), where.Source.ToRect());
                gameShown = true;
            }
        }
        if (!gameShown) Hide(_gameThumb);
    }

    /// <summary>Keeps a thumbnail of <paramref name="source"/> (registered again when it changes); false with none.</summary>
    private bool Retarget(ref IntPtr thumb, ref IntPtr current, IntPtr source)
    {
        if (source == current && thumb != IntPtr.Zero) return true;
        if (thumb != IntPtr.Zero) Native.DwmUnregisterThumbnail(thumb);
        thumb = IntPtr.Zero;
        current = source;
        if (source == IntPtr.Zero || !Native.IsWindow(source)) return false;
        return Native.DwmRegisterThumbnail(_preview.Handle, source, out thumb) == 0;
    }

    private static void Show(IntPtr thumb, Native.RECT dest, Native.RECT? source)
    {
        var props = new Native.THUMBNAIL_PROPERTIES
        {
            Flags = Native.TNP_RECTDESTINATION | Native.TNP_VISIBLE | Native.TNP_OPACITY | Native.TNP_SOURCECLIENTAREAONLY | (source is null ? 0 : Native.TNP_RECTSOURCE),
            Destination = dest,
            Source = source ?? default,
            Opacity = 255,
            Visible = 1,
            SourceClientAreaOnly = 1,
        };
        Native.DwmUpdateThumbnailProperties(thumb, ref props);
    }

    private static void Hide(IntPtr thumb)
    {
        if (thumb == IntPtr.Zero) return;
        var props = new Native.THUMBNAIL_PROPERTIES { Flags = Native.TNP_VISIBLE, Visible = 0 };
        Native.DwmUpdateThumbnailProperties(thumb, ref props);
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        PlacePreview();
    }

    /// <summary>Stealth mode ended: closes for good.</summary>
    public void CloseFromApp()
    {
        _closing = true;
        Close();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // The person closed the manager: that means "back to the dashboard", which the app does (and then closes this).
        if (!_closing && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            _onClose();
            return;
        }
        if (_dashThumb != IntPtr.Zero) Native.DwmUnregisterThumbnail(_dashThumb);
        if (_gameThumb != IntPtr.Zero) Native.DwmUnregisterThumbnail(_gameThumb);
        _dashThumb = _gameThumb = IntPtr.Zero;
        _preview.Close();
        base.OnFormClosing(e);
    }

    /// <summary>
    /// The window the preview's thumbnails are drawn in: borderless, so its own coordinates are the
    /// thumbnails' coordinates, never in the taskbar, never taking focus, and out of captures too.
    /// </summary>
    private sealed class PreviewWindow : Form
    {
        public PreviewWindow()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.Black;
            Size = new Size(2, 2);
        }

        protected override bool ShowWithoutActivation => true;

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= (int)(Native.WS_EX_NOACTIVATE | Native.WS_EX_TOOLWINDOW);
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            if (!Native.SetWindowDisplayAffinity(Handle, Native.WDA_EXCLUDEFROMCAPTURE)) Native.SetWindowDisplayAffinity(Handle, Native.WDA_MONITOR);
        }
    }
}
