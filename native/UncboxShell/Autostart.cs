using System.Text.Json.Nodes;
using Microsoft.Win32;

namespace UncboxShell;

/// <summary>
/// "Start with Windows": a value in the current user's Run key that starts Uncbox.exe with --tray
/// when they sign in, so it waits in the tray instead of covering the screen. Per user, so no
/// admin rights. The page asks with { type: "autostart" } and changes it with
/// { type: "autostart", enabled }; either way the app answers { type: "autostartstate", enabled }.
/// </summary>
internal static class Autostart
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "Uncbox";

    private static string Exe => Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "Uncbox.exe");

    /// <summary>What the Run key holds for an Uncbox.exe at this path.</summary>
    public static string Command(string exe) => $"\"{exe}\" --tray";

    /// <summary>Whether Uncbox (this exe) is set to start when Windows does.</summary>
    public static bool IsEnabled(string? exe = null)
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey);
        return key?.GetValue(ValueName) is string value && value.Equals(Command(exe ?? Exe), StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Whether any Uncbox entry is there, whichever copy of the app it points to.</summary>
    public static bool HasEntry()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey);
        return key?.GetValue(ValueName) is not null;
    }

    public static void Set(bool enabled, string? exe = null)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey);
        if (enabled) key.SetValue(ValueName, Command(exe ?? Exe), RegistryValueKind.String);
        else key.DeleteValue(ValueName, throwOnMissingValue: false);
    }

    /// <summary>Applies the page's message, if it carries a change, and returns how things stand.</summary>
    public static bool Handle(JsonNode? msg)
    {
        try
        {
            if (msg?["enabled"] is JsonValue v && v.TryGetValue(out bool on)) Set(on);
            return IsEnabled();
        }
        catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            return false;
        }
    }
}
