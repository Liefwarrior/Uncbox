namespace UncboxShell;

/// <summary>
/// A game's own window, moved into the dashboard's game panel. Its border and title bar come off
/// so the picture fills the panel exactly, and everything goes back the way it was on release.
/// </summary>
internal sealed class GameWindow(IntPtr hwnd)
{
    private readonly long _style = Native.GetWindowLongPtr(hwnd, Native.GWL_STYLE);
    private readonly long _exStyle = Native.GetWindowLongPtr(hwnd, Native.GWL_EXSTYLE);
    private readonly Native.RECT _rect = Native.GetWindowRect(hwnd, out var r) ? r : default;
    private Native.RECT _placed;

    public IntPtr Handle { get; } = hwnd;
    public string Title => Native.TitleOf(Handle);
    public bool Alive => Native.IsWindow(Handle);
    public bool Shown => Native.IsWindowVisible(Handle);

    /// <summary>
    /// The title bar or sizing border is back. Games (Unreal ones especially) restyle their own
    /// window on load or a settings change, so the app checks this every time it re-places it.
    /// </summary>
    public bool HasFrame => (Native.GetWindowLongPtr(Handle, Native.GWL_STYLE) & (Native.WS_CAPTION | Native.WS_THICKFRAME)) != 0;

    /// <summary>Whether the window is where it was put (a pixel or two either way is fine).</summary>
    public bool Fits(Native.RECT at) =>
        Native.GetWindowRect(Handle, out var now) &&
        Math.Abs(now.Left - at.Left) <= 2 && Math.Abs(now.Top - at.Top) <= 2 &&
        Math.Abs(now.Width - at.Width) <= 2 && Math.Abs(now.Height - at.Height) <= 2;

    /// <summary>
    /// The launch option that makes this game resizable, from its engine (found next to its exe),
    /// or "" if it isn't one Uncbox knows.
    /// </summary>
    public string WindowedLaunchOption()
    {
        string exe = Native.ProcessPathOf(Handle);
        string? dir = exe.Length > 0 ? Path.GetDirectoryName(exe) : null;
        if (dir is null) return "";
        if (File.Exists(Path.Combine(dir, "UnityPlayer.dll"))) return "-window-mode borderless";
        // Unreal games keep their exe in <game>/Binaries/Win64 with the Engine folder at the top.
        for (var d = new DirectoryInfo(dir); d is not null && d.Parent is not null; d = d.Parent)
        {
            if (Directory.Exists(Path.Combine(d.FullName, "Engine", "Binaries"))) return "-windowed";
        }
        return "";
    }

    public void MakeBorderless()
    {
        if (Native.IsIconic(Handle)) Native.ShowWindow(Handle, Native.SW_RESTORE);
        long frame = Native.WS_CAPTION | Native.WS_THICKFRAME | Native.WS_SYSMENU | Native.WS_MINIMIZEBOX | Native.WS_MAXIMIZEBOX;
        Native.SetWindowLongPtr(Handle, Native.GWL_STYLE, (_style & ~frame) | Native.WS_POPUP);
        long edges = Native.WS_EX_DLGMODALFRAME | Native.WS_EX_CLIENTEDGE | Native.WS_EX_STATICEDGE | Native.WS_EX_WINDOWEDGE;
        Native.SetWindowLongPtr(Handle, Native.GWL_EXSTYLE, _exStyle & ~edges);
        _placed = default;
    }

    /// <summary>Puts the window at this screen rectangle, unless it's already there.</summary>
    public void Place(Native.RECT at)
    {
        bool moved = !Native.GetWindowRect(Handle, out var now) || !Same(now, at);
        if (!moved && Same(_placed, at) && !Native.IsIconic(Handle)) return;
        if (Native.IsIconic(Handle)) Native.ShowWindow(Handle, Native.SW_RESTORE);
        Native.SetWindowPos(Handle, Native.HWND_TOP, at.Left, at.Top, at.Width, at.Height,
            Native.SWP_NOACTIVATE | Native.SWP_FRAMECHANGED | Native.SWP_SHOWWINDOW);
        _placed = at;
    }

    public void Restore()
    {
        if (!Alive) return;
        Native.SetWindowLongPtr(Handle, Native.GWL_STYLE, _style);
        Native.SetWindowLongPtr(Handle, Native.GWL_EXSTYLE, _exStyle);
        Native.SetWindowPos(Handle, Native.HWND_TOP, _rect.Left, _rect.Top, _rect.Width, _rect.Height,
            Native.SWP_NOACTIVATE | Native.SWP_FRAMECHANGED | Native.SWP_SHOWWINDOW);
    }

    private static bool Same(Native.RECT a, Native.RECT b) =>
        a.Left == b.Left && a.Top == b.Top && a.Right == b.Right && a.Bottom == b.Bottom;
}
