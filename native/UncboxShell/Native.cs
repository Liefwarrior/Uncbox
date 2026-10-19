using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace UncboxShell;

/// <summary>The few Win32 calls the shell needs to find a game's window and move it into the dashboard.</summary>
internal static partial class Native
{
    public const int GWL_STYLE = -16;
    public const int GWL_EXSTYLE = -20;
    public const long WS_CAPTION = 0x00C00000;
    public const long WS_THICKFRAME = 0x00040000;
    public const long WS_SYSMENU = 0x00080000;
    public const long WS_MINIMIZEBOX = 0x00020000;
    public const long WS_MAXIMIZEBOX = 0x00010000;
    public const long WS_POPUP = 0x80000000;
    public const long WS_EX_DLGMODALFRAME = 0x00000001;
    public const long WS_EX_CLIENTEDGE = 0x00000200;
    public const long WS_EX_STATICEDGE = 0x00020000;
    public const long WS_EX_TOOLWINDOW = 0x00000080;
    public const long WS_EX_WINDOWEDGE = 0x00000100;

    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_FRAMECHANGED = 0x0020;
    public const uint SWP_NOZORDER = 0x0004;
    public const uint SWP_SHOWWINDOW = 0x0040;
    public static readonly IntPtr HWND_TOP = IntPtr.Zero;

    public const int SW_RESTORE = 9;
    public const int RGN_DIFF = 4;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left, Top, Right, Bottom;
        public readonly int Width => Right - Left;
        public readonly int Height => Bottom - Top;
    }

    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool IsWindowVisible(IntPtr hwnd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool IsWindow(IntPtr hwnd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool IsIconic(IntPtr hwnd);

    [LibraryImport("user32.dll", EntryPoint = "GetWindowTextLengthW")]
    public static partial int GetWindowTextLength(IntPtr hwnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);

    [LibraryImport("user32.dll")]
    public static partial uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

    [LibraryImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    public static partial long GetWindowLongPtr(IntPtr hwnd, int index);

    [LibraryImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    public static partial long SetWindowLongPtr(IntPtr hwnd, int index, long value);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool GetWindowRect(IntPtr hwnd, out RECT rect);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool ShowWindow(IntPtr hwnd, int cmd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool SetForegroundWindow(IntPtr hwnd);

    [LibraryImport("user32.dll")]
    public static partial int SetWindowRgn(IntPtr hwnd, IntPtr rgn, [MarshalAs(UnmanagedType.Bool)] bool redraw);

    [LibraryImport("gdi32.dll")]
    public static partial IntPtr CreateRectRgn(int left, int top, int right, int bottom);

    [LibraryImport("gdi32.dll")]
    public static partial int CombineRgn(IntPtr dest, IntPtr a, IntPtr b, int mode);

    [LibraryImport("gdi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool DeleteObject(IntPtr obj);

    public static string TitleOf(IntPtr hwnd)
    {
        int length = GetWindowTextLength(hwnd);
        if (length == 0) return "";
        var text = new StringBuilder(length + 1);
        GetWindowText(hwnd, text, text.Capacity);
        return text.ToString();
    }

    public static string ProcessNameOf(IntPtr hwnd)
    {
        GetWindowThreadProcessId(hwnd, out uint pid);
        try
        {
            using var p = Process.GetProcessById((int)pid);
            return p.ProcessName;
        }
        catch (ArgumentException)
        {
            return "";
        }
    }

    [LibraryImport("kernel32.dll")]
    public static partial IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);

    [LibraryImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);

    // ---- DWM thumbnails: a live, scaled picture of another window, drawn by the compositor ----

    [StructLayout(LayoutKind.Sequential)]
    public struct THUMBNAIL_PROPERTIES
    {
        public int Flags;
        public RECT Destination;
        public RECT Source;
        public byte Opacity;
        public int Visible;
        public int SourceClientAreaOnly;
    }

    public const int TNP_RECTDESTINATION = 0x1, TNP_OPACITY = 0x4, TNP_VISIBLE = 0x8, TNP_SOURCECLIENTAREAONLY = 0x10;

    [LibraryImport("dwmapi.dll")]
    public static partial int DwmRegisterThumbnail(IntPtr destination, IntPtr source, out IntPtr thumbnail);

    [LibraryImport("dwmapi.dll")]
    public static partial int DwmUnregisterThumbnail(IntPtr thumbnail);

    [DllImport("dwmapi.dll")]
    public static extern int DwmUpdateThumbnailProperties(IntPtr thumbnail, ref THUMBNAIL_PROPERTIES properties);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool GetClientRect(IntPtr hwnd, out RECT rect);

    /// <summary>The full path of the program that owns a window, or "" if Windows won't say.</summary>
    public static string ProcessPathOf(IntPtr hwnd)
    {
        GetWindowThreadProcessId(hwnd, out uint pid);
        // PROCESS_QUERY_LIMITED_INFORMATION: enough for the path, and allowed for most processes.
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) return "";
        try
        {
            var name = new StringBuilder(1024);
            int size = name.Capacity;
            return QueryFullProcessImageName(process, 0, name, ref size) ? name.ToString() : "";
        }
        finally
        {
            CloseHandle(process);
        }
    }

    /// <summary>Visible, titled, top-level app windows other than the shell's own, like Alt+Tab shows.</summary>
    public static List<(IntPtr Hwnd, string Title, string Process)> AppWindows(IntPtr exclude)
    {
        var found = new List<(IntPtr, string, string)>();
        uint self = (uint)Environment.ProcessId;
        EnumWindows((hwnd, _) =>
        {
            if (hwnd == exclude || !IsWindowVisible(hwnd)) return true;
            if ((GetWindowLongPtr(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return true;
            GetWindowThreadProcessId(hwnd, out uint pid);
            if (pid == self) return true;
            string title = TitleOf(hwnd);
            if (title.Length == 0 || title == "Program Manager") return true;
            found.Add((hwnd, title, ProcessNameOf(hwnd)));
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
