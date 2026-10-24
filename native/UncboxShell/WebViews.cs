using System.Diagnostics;
using System.Net;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;

namespace UncboxShell;

/// <summary>
/// The page's web widgets (src/widgets/web/WebWidget.tsx). Each one gets its own WebView2 on the main
/// window, placed over its panel and kept there as the page reports the panel's box, so it can show
/// any site, which an iframe can't. They all share one profile, separate from the dashboard's own,
/// so sign-ins (Google and so on) last between widgets and restarts.
///
/// Messages (src/native.ts is the page's side; ids are the widgets'):
///   page → app  { type: "web", id, url }                      make the view, or take it to this page
///               { type: "webrect", id, x, y, w, h, visible }  its box in device pixels, like "rect"
///               { type: "webnav", id, action }                "back", "forward" or "reload"
///               { type: "webzoom", id, factor }               1 is 100%
///               { type: "webclose", id }
///   app → page  { type: "webstate", id, url, title, canGoBack, canGoForward, loading }
///
/// Only http and https pages are opened. A link that opens a new window stays in the view when it's
/// the same site, and opens in the default browser when it's another one.
/// </summary>
internal sealed class WebViews : IDisposable
{
    /// <summary>The shared profile's name; its data sits beside the dashboard's, in the same folder.</summary>
    private const string PROFILE = "UncboxWeb";

    private sealed class View
    {
        public required string Id { get; init; }
        /// <summary>The controller's parent: a plain child window we can move, show and hide.</summary>
        public Panel Host { get; } = new() { Visible = false, BackColor = Color.FromArgb(0x10, 0x12, 0x19) };
        public CoreWebView2Controller? Controller;
        public Rectangle Box;
        public bool Visible;
        public double Zoom = 1;
        public string? Url;
        public bool Creating;
        public bool Closed;
        public bool Loading;
    }

    private readonly Form _owner;
    private readonly Control _page;
    private readonly CoreWebView2Environment _env;
    private readonly Action<object> _send;
    private readonly Dictionary<string, View> _views = [];

    /// <param name="owner">The main window the views sit on.</param>
    /// <param name="page">The dashboard's own WebView2: the page's box is relative to it.</param>
    public WebViews(Form owner, Control page, CoreWebView2Environment env, Action<object> send)
    {
        _owner = owner;
        _page = page;
        _env = env;
        _send = send;
        // Hidden in the tray (or behind a full-screen game), the views stop drawing too.
        _owner.VisibleChanged += (_, _) =>
        {
            foreach (var v in _views.Values) Place(v);
        };
    }

    public void OnMessage(string type, JsonNode msg)
    {
        string? id = (string?)msg["id"];
        if (string.IsNullOrEmpty(id)) return;
        switch (type)
        {
            case "web" when (string?)msg["url"] is { } url:
                Open(Get(id), url);
                break;
            case "webrect":
                SetBox(Get(id), msg);
                break;
            case "webzoom" when (double?)msg["factor"] is { } factor:
                var zoomed = Get(id);
                zoomed.Zoom = Math.Clamp(factor, 0.25, 5);
                if (zoomed.Controller is not null) zoomed.Controller.ZoomFactor = zoomed.Zoom;
                break;
            case "webnav" when _views.TryGetValue(id, out var v) && v.Controller?.CoreWebView2 is { } core:
                switch ((string?)msg["action"])
                {
                    case "back" when core.CanGoBack:
                        core.GoBack();
                        break;
                    case "forward" when core.CanGoForward:
                        core.GoForward();
                        break;
                    case "reload":
                        core.Reload();
                        break;
                }
                break;
            case "webclose":
                Close(id);
                break;
        }
    }

    /// <summary>The page reloaded: its widgets are asking for their views again.</summary>
    public void CloseAll()
    {
        foreach (var id in _views.Keys.ToList()) Close(id);
    }

    public void Dispose() => CloseAll();

    /// <summary>The widget's view, made when first mentioned: the box can arrive before the page does.</summary>
    private View Get(string id)
    {
        if (_views.TryGetValue(id, out var v)) return v;
        v = new View { Id = id };
        _owner.Controls.Add(v.Host);
        _views[id] = v;
        return v;
    }

    private static bool IsWeb(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);

    private void Open(View v, string url)
    {
        if (!IsWeb(url)) return;
        v.Url = url;
        if (v.Controller?.CoreWebView2 is { } core)
        {
            if (core.Source != url) core.Navigate(url);
        }
        else if (!v.Creating)
        {
            _ = CreateAsync(v);
        }
    }

    private async Task CreateAsync(View v)
    {
        v.Creating = true;
        try
        {
            var options = _env.CreateCoreWebView2ControllerOptions();
            options.ProfileName = PROFILE;
            options.IsInPrivateModeEnabled = false;
            var controller = await _env.CreateCoreWebView2ControllerAsync(v.Host.Handle, options);
            if (v.Closed)
            {
                controller.Close();
                return;
            }
            v.Controller = controller;
            var core = controller.CoreWebView2;
            // Pages out on the web get no way to talk to Uncbox.
            core.Settings.IsWebMessageEnabled = false;
            core.Settings.AreHostObjectsAllowed = false;
            controller.ZoomFactor = v.Zoom;
            core.NavigationStarting += (_, e) =>
            {
                // Web pages only: no files, no app links, nothing a page shouldn't be able to open.
                if (!IsWeb(e.Uri) && e.Uri != "about:blank") e.Cancel = true;
                else
                {
                    v.Loading = true;
                    PostState(v);
                }
            };
            core.NavigationCompleted += (_, _) =>
            {
                v.Loading = false;
                PostState(v);
            };
            core.SourceChanged += (_, _) => PostState(v);
            core.HistoryChanged += (_, _) => PostState(v);
            core.DocumentTitleChanged += (_, _) => PostState(v);
            core.NewWindowRequested += (_, e) => OnNewWindow(core, e);
            Place(v);
            if (v.Url is not null) core.Navigate(v.Url);
        }
        catch (Exception err) when (err is COMException or InvalidOperationException or ArgumentException)
        {
            // No WebView2 for this widget; the page keeps showing its panel with nothing in it.
            Debug.WriteLine($"Web view failed: {err.Message}");
        }
        finally
        {
            v.Creating = false;
        }
    }

    private void SetBox(View v, JsonNode msg)
    {
        // The page's box is in the dashboard's own pixels; the views are children of the window.
        int x = _page.Left + (int)Math.Round((double?)msg["x"] ?? 0), y = _page.Top + (int)Math.Round((double?)msg["y"] ?? 0);
        int w = (int)Math.Round((double?)msg["w"] ?? 0), h = (int)Math.Round((double?)msg["h"] ?? 0);
        v.Box = new Rectangle(x, y, w, h);
        v.Visible = (bool?)msg["visible"] ?? false;
        Place(v);
    }

    /// <summary>Puts the view where its panel is, or hides it (under an overlay, or with the window).</summary>
    private void Place(View v)
    {
        bool show = v.Visible && v.Box.Width > 0 && v.Box.Height > 0 && _owner.Visible;
        if (show)
        {
            bool wasHidden = !v.Host.Visible;
            if (v.Host.Bounds != v.Box) v.Host.Bounds = v.Box;
            if (wasHidden)
            {
                v.Host.Visible = true;
                // Above the dashboard's own view, which fills the window.
                v.Host.BringToFront();
            }
        }
        else if (v.Host.Visible)
        {
            v.Host.Visible = false;
        }
        if (v.Controller is { } controller)
        {
            controller.IsVisible = show;
            if (show) controller.Bounds = v.Host.ClientRectangle;
        }
    }

    private void PostState(View v)
    {
        if (v.Closed || v.Controller?.CoreWebView2 is not { } core) return;
        _send(new
        {
            type = "webstate",
            id = v.Id,
            url = core.Source,
            title = core.DocumentTitle,
            canGoBack = core.CanGoBack,
            canGoForward = core.CanGoForward,
            loading = v.Loading,
        });
    }

    /// <summary>Same site: it opens right here. Another site: in the default browser.</summary>
    private static void OnNewWindow(CoreWebView2 core, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri) || !IsWeb(e.Uri)) return;
        if (Uri.TryCreate(core.Source, UriKind.Absolute, out var here) && Site(here.Host) == Site(uri.Host))
        {
            core.Navigate(uri.ToString());
        }
        else
        {
            Process.Start(new ProcessStartInfo(uri.ToString()) { UseShellExecute = true });
        }
    }

    /// <summary>
    /// The part of a host name that names the site: "www.youtube.com" and "m.youtube.com" are both
    /// "youtube.com". Names like "bbc.co.uk" keep three parts.
    /// </summary>
    internal static string Site(string host)
    {
        host = host.ToLowerInvariant();
        if (IPAddress.TryParse(host.Trim('[', ']'), out _)) return host;
        var parts = host.Split('.');
        if (parts.Length <= 2) return host;
        int keep = parts[^1].Length == 2 && parts[^2].Length <= 3 ? 3 : 2;
        return string.Join('.', parts[^keep..]);
    }

    private void Close(string id)
    {
        if (!_views.Remove(id, out var v)) return;
        v.Closed = true;
        v.Controller?.Close();
        _owner.Controls.Remove(v.Host);
        v.Host.Dispose();
    }
}
