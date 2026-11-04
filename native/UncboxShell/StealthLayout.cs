using System.Text.Json.Nodes;

namespace UncboxShell;

/// <summary>A rectangle in fractional pixels.</summary>
internal readonly record struct Box(double X, double Y, double W, double H)
{
    public double Right => X + W;
    public double Bottom => Y + H;

    /// <summary>The largest box of the shape <paramref name="aspect"/> (width over height) centred in this one.</summary>
    public Box Fitted(double aspect)
    {
        if (W <= 0 || H <= 0 || aspect <= 0) return this;
        (double w, double h) = W / H > aspect ? (H * aspect, H) : (W, W / aspect);
        return new Box(X + (W - w) / 2, Y + (H - h) / 2, w, h);
    }

    public Native.RECT ToRect()
    {
        int left = (int)Math.Round(X), top = (int)Math.Round(Y);
        return new Native.RECT { Left = left, Top = top, Right = (int)Math.Round(Right), Bottom = (int)Math.Round(Bottom) };
    }
}

/// <summary>Where the game's panel is on the dashboard, and how the game's picture fills it.</summary>
/// <param name="Panel">The panel in the dashboard's device pixels.</param>
/// <param name="Left">Shares of the game's picture cut off at each edge (the panel's Crop), 0 to 0.45.</param>
/// <param name="StripPx">The WoW addon's strip at the top of the game's picture, which viewers never see.</param>
/// <param name="Fit">"contain", "cover" or "stretch", as the game panel's Fit setting says.</param>
internal readonly record struct GamePanel(Box Panel, double Left, double Top, double Right, double Bottom, double StripPx, string Fit);

/// <summary>
/// Stealth mode's arithmetic, kept apart from the windows so it can be tested: where the game goes
/// in the manager's live preview (the same placement the streaming engine uses for viewers, see
/// engine/src/scene.rs), and the scene the page passes on to the server for the engine.
/// </summary>
internal static class StealthLayout
{
    /// <summary>
    /// The game's thumbnail in the preview: which part of the game's picture (its client area,
    /// <paramref name="gameW"/> x <paramref name="gameH"/>) is shown, and where. <paramref name="dashboard"/>
    /// is where the dashboard's own thumbnail landed, for a dashboard of <paramref name="dashW"/> x
    /// <paramref name="dashH"/>. Null when nothing of the game would show.
    /// </summary>
    public static (Box Source, Box Dest)? PlaceGame(Box dashboard, double dashW, double dashH, GamePanel game, double gameW, double gameH)
    {
        if (dashW < 2 || dashH < 2 || gameW < 2 || gameH < 2 || dashboard.W < 2 || dashboard.H < 2) return null;
        double strip = Math.Min(Math.Max(game.StripPx, 0), gameH - 2);
        double inner = gameH - strip;
        var src = new Box(gameW * game.Left, strip + inner * game.Top, gameW * (1 - game.Left - game.Right), inner * (1 - game.Top - game.Bottom));
        if (src.W < 2 || src.H < 2) return null;

        double kx = dashboard.W / dashW, ky = dashboard.H / dashH;
        var dest = new Box(dashboard.X + game.Panel.X * kx, dashboard.Y + game.Panel.Y * ky, game.Panel.W * kx, game.Panel.H * ky);
        if (dest.W < 1 || dest.H < 1) return null;
        switch (game.Fit)
        {
            case "stretch":
                break;
            case "cover":
                src = src.Fitted(dest.W / dest.H);
                break;
            default:
                dest = dest.Fitted(src.W / src.H);
                break;
        }

        // Only what is on the dashboard shows, and the game's picture is trimmed to match.
        double x0 = Math.Max(dest.X, dashboard.X), y0 = Math.Max(dest.Y, dashboard.Y);
        double x1 = Math.Min(dest.Right, dashboard.Right), y1 = Math.Min(dest.Bottom, dashboard.Bottom);
        if (x1 - x0 < 1 || y1 - y0 < 1) return null;
        double sx = src.W / dest.W, sy = src.H / dest.H;
        var source = new Box(src.X + (x0 - dest.X) * sx, src.Y + (y0 - dest.Y) * sy, (x1 - x0) * sx, (y1 - y0) * sy);
        return (source, new Box(x0, y0, x1 - x0, y1 - y0));
    }

    /// <summary>
    /// The scene the streaming engine shows in stealth mode (see engine/src/scene.rs and clampScene in
    /// server/stream.mjs): the dashboard's window and size, and the game's window over its panel when
    /// there is one. The pointer is drawn over the dashboard only outside stealth mode: in stealth mode
    /// it is over the game, whose own capture draws it.
    /// </summary>
    public static JsonObject Scene(IntPtr dashboard, int dashW, int dashH, bool stealth, IntPtr game, GamePanel? panel)
    {
        var scene = new JsonObject
        {
            ["window"] = dashboard.ToInt64().ToString(),
            ["cursor"] = !stealth,
            ["size"] = new JsonObject { ["w"] = dashW, ["h"] = dashH },
        };
        if (game != IntPtr.Zero && panel is { } p && p.Panel.W >= 2 && p.Panel.H >= 2)
        {
            scene["game"] = new JsonObject
            {
                ["window"] = game.ToInt64().ToString(),
                ["rect"] = new JsonObject
                {
                    ["x"] = Math.Round(p.Panel.X),
                    ["y"] = Math.Round(p.Panel.Y),
                    ["w"] = Math.Round(p.Panel.W),
                    ["h"] = Math.Round(p.Panel.H),
                },
                ["crop"] = new JsonObject
                {
                    ["top"] = Math.Round(p.Top * 100, 3),
                    ["right"] = Math.Round(p.Right * 100, 3),
                    ["bottom"] = Math.Round(p.Bottom * 100, 3),
                    ["left"] = Math.Round(p.Left * 100, 3),
                },
                ["stripPx"] = Math.Round(p.StripPx),
                ["fit"] = p.Fit is "cover" or "stretch" ? p.Fit : "contain",
            };
        }
        return scene;
    }

    /// <summary>
    /// Where the manager window opens: on another screen than the dashboard's when there is one (as
    /// OBS usually sits), else in the middle of the same one. A little smaller than the screen's work area.
    /// </summary>
    public static Rectangle ManagerBounds(Rectangle dashboardScreen, IReadOnlyList<Rectangle> workAreas)
    {
        var area = workAreas.FirstOrDefault(a => !a.IntersectsWith(dashboardScreen));
        if (area.IsEmpty) area = workAreas.FirstOrDefault(a => a.IntersectsWith(dashboardScreen));
        if (area.IsEmpty) area = dashboardScreen;
        int w = Math.Clamp((int)(area.Width * 0.72), Math.Min(760, area.Width), Math.Min(1500, area.Width));
        int h = Math.Clamp((int)(area.Height * 0.78), Math.Min(520, area.Height), Math.Min(980, area.Height));
        return new Rectangle(area.X + (area.Width - w) / 2, area.Y + (area.Height - h) / 2, w, h);
    }
}
