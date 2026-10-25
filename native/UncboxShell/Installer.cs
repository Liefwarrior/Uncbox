using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace UncboxShell;

/// <summary>What the install dialog's boxes were set to.</summary>
internal sealed record InstallOptions(bool StartWithWindows, bool DesktopShortcut);

/// <summary>
/// Installs Uncbox like a normal Windows app, for the current user only (no admin rights):
/// the app goes to %LOCALAPPDATA%\Programs\Uncbox, with a Start menu shortcut (and a desktop one if
/// asked), an entry in Settings > Apps, and optionally a start-with-Windows entry (see Autostart).
///
/// Uncbox.exe offers this when it is run from somewhere else (Downloads, an unzipped folder).
/// Either it is the Setup exe (npm run package embeds the node\ and app\ folders in it as a zip,
/// the "payload") or it sits beside node\ and app\ in an unzipped download. Uncbox.exe --uninstall
/// (what Settings > Apps runs) takes it away again. The user's data stays in
/// %LOCALAPPDATA%\Uncbox\data unless asked, and clips (Videos\Uncbox) are never deleted.
/// </summary>
internal static class Installer
{
    private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Uncbox";
    private const string PayloadName = "UncboxPayload.zip";
    /// <summary>Beside the exe of an unzipped download: "Just run it" was chosen, so don't ask again.</summary>
    private const string PortableMarker = "Uncbox.portable";
    private const string ExtractedMarker = ".complete";

    private static string Exe => Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "Uncbox.exe");
    private static string ExeDir => Path.GetDirectoryName(Exe)!;

    private static string LocalData => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Uncbox");

    public static string InstallDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Uncbox");

    private static string InstalledExe => Path.Combine(InstallDir, "Uncbox.exe");
    private static string StartMenuLink => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Uncbox.lnk");
    private static string DesktopLink => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Uncbox.lnk");

    /// <summary>This build's version (package.json's, stamped in by npm run package).</summary>
    public static string Version => Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";

    public static bool IsInstalled => File.Exists(InstalledExe);

    /// <summary>The installed version, or null when not installed (or the entry was removed by hand).</summary>
    public static string? InstalledVersion
    {
        get
        {
            using var key = Registry.CurrentUser.OpenSubKey(UninstallKey);
            return key?.GetValue("DisplayVersion") as string;
        }
    }

    private static bool HasPayload => Assembly.GetExecutingAssembly().GetManifestResourceInfo(PayloadName) is not null;

    private static bool SamePath(string a, string b) =>
        string.Equals(Path.GetFullPath(a).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Handles --uninstall and the first-run install offer. True when that was the whole job and the
    /// app should exit; false to carry on starting Uncbox as usual.
    /// </summary>
    public static bool TryHandle(string[] args)
    {
        if (args.Contains("--uninstall"))
        {
            Uninstall();
            return true;
        }
        if (!ShouldOffer(args)) return false;
        using var dialog = new InstallDialog();
        return dialog.ShowDialog() switch
        {
            DialogResult.Ignore => JustRun(args),
            // Installed (and started), or the dialog was closed: nothing more for this copy to do.
            _ => true,
        };
    }

    /// <summary>
    /// Only a packaged copy that isn't where it would be installed. Not when started for a given
    /// address or folder (a developer's setup), at sign-in (--tray), or with --no-install.
    /// </summary>
    private static bool ShouldOffer(string[] args)
    {
        if (args.Any(a => !a.StartsWith("--") || a is "--no-install" or "--tray" || a.StartsWith("--root="))) return false;
        if (SamePath(ExeDir, InstallDir)) return false;
        if (HasPayload) return true;
        bool unzipped = File.Exists(Path.Combine(ExeDir, "node", "node.exe")) && File.Exists(Path.Combine(ExeDir, "app", "package.json"));
        return unzipped && !File.Exists(Path.Combine(ExeDir, PortableMarker));
    }

    // ---- install ----

    /// <summary>Puts Uncbox in the install folder, with its shortcuts and Settings > Apps entry. Throws if it can't.</summary>
    public static void Install(InstallOptions options)
    {
        string dest = InstallDir, staging = dest + ".new", old = dest + ".old";
        DeleteTree(staging);
        DeleteTree(old);
        try
        {
            Populate(staging);
            // The new copy is complete before the old one is touched, so a failure leaves the old one working.
            if (Directory.Exists(dest)) Directory.Move(dest, old);
            Directory.Move(staging, dest);
        }
        catch
        {
            DeleteTree(staging);
            if (!Directory.Exists(dest) && Directory.Exists(old)) Directory.Move(old, dest);
            throw;
        }
        DeleteTree(old);

        CreateShortcut(StartMenuLink, InstalledExe);
        if (options.DesktopShortcut) CreateShortcut(DesktopLink, InstalledExe);
        Register(dest);
        Autostart.Set(options.StartWithWindows, InstalledExe);
    }

    /// <summary>Starts the installed copy.</summary>
    public static void LaunchInstalled() =>
        Process.Start(new ProcessStartInfo(InstalledExe) { WorkingDirectory = InstallDir, UseShellExecute = false });

    /// <summary>
    /// Fills an empty folder with a runnable Uncbox: the embedded node\ and app\ plus this exe, or a
    /// copy of the unzipped download this exe sits in.
    /// </summary>
    private static void Populate(string dest)
    {
        Directory.CreateDirectory(dest);
        if (HasPayload)
        {
            using var payload = Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadName)!;
            ZipFile.ExtractToDirectory(payload, dest, overwriteFiles: true);
            File.Copy(Exe, Path.Combine(dest, "Uncbox.exe"), overwrite: true);
        }
        else
        {
            CopyTree(new DirectoryInfo(ExeDir), dest);
        }
    }

    private static void CopyTree(DirectoryInfo from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var file in from.GetFiles())
        {
            if (file.Name != PortableMarker) file.CopyTo(Path.Combine(to, file.Name), overwrite: true);
        }
        foreach (var dir in from.GetDirectories()) CopyTree(dir, Path.Combine(to, dir.Name));
    }

    /// <summary>"Just run it": an unzipped download simply carries on; the Setup exe unpacks beside the app's data and starts that.</summary>
    private static bool JustRun(string[] args)
    {
        if (!HasPayload)
        {
            try
            {
                File.WriteAllText(Path.Combine(ExeDir, PortableMarker), "Uncbox was chosen to run from here, so it doesn't offer to install. Delete this file to be asked again.\r\n");
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // Read-only folder: it will just ask again next time.
            }
            return false;
        }
        try
        {
            string root = Path.Combine(LocalData, "Portable"), dir = Path.Combine(root, Version);
            if (!File.Exists(Path.Combine(dir, ExtractedMarker)))
            {
                DeleteTree(root);
                Populate(dir);
                File.WriteAllText(Path.Combine(dir, ExtractedMarker), "");
            }
            var start = new ProcessStartInfo(Path.Combine(dir, "Uncbox.exe")) { WorkingDirectory = dir, UseShellExecute = false };
            foreach (string a in args.Append("--no-install")) start.ArgumentList.Add(a);
            Process.Start(start);
        }
        catch (Exception e)
        {
            MessageBox.Show($"Uncbox couldn’t start: {e.Message}", "Uncbox", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        return true;
    }

    private static void Register(string dest)
    {
        using var key = Registry.CurrentUser.CreateSubKey(UninstallKey);
        key.SetValue("DisplayName", "Uncbox");
        key.SetValue("DisplayIcon", InstalledExe);
        key.SetValue("DisplayVersion", Version);
        key.SetValue("Publisher", "Uncbox");
        key.SetValue("InstallLocation", dest);
        key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
        key.SetValue("UninstallString", $"\"{InstalledExe}\" --uninstall");
        key.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, FolderSize(new DirectoryInfo(dest)) / 1024), RegistryValueKind.DWord);
        key.SetValue("NoModify", 1, RegistryValueKind.DWord);
        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
    }

    private static long FolderSize(DirectoryInfo dir) =>
        dir.EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length);

    // ---- uninstall ----

    private static void Uninstall()
    {
        if (!IsInstalled && InstalledVersion is null)
        {
            MessageBox.Show("Uncbox isn’t installed for this user.", "Uninstall Uncbox", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        using var dialog = new UninstallDialog();
        if (dialog.ShowDialog() != DialogResult.OK || !EnsureNotRunning(InstallDir, "remove")) return;

        // Only the entries that are Uncbox's own: a shortcut someone repointed is theirs.
        foreach (string link in new[] { StartMenuLink, DesktopLink })
        {
            if (File.Exists(link) && ShortcutTarget(link) is { } target && SamePath(target, InstalledExe)) TryDelete(link);
        }
        Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, throwOnMissingSubKey: false);
        // A start-with-Windows entry that points at some other copy (an unzipped one) is left alone.
        if (Autostart.IsEnabled(InstalledExe)) Autostart.Set(false, InstalledExe);
        if (dialog.DeleteSettings) DeleteUserData();

        MessageBox.Show(
            dialog.DeleteSettings ? "Uncbox and your settings were removed. Your clips are still in Videos\\Uncbox." : "Uncbox was removed. Your settings and clips were kept.",
            "Uninstall Uncbox", MessageBoxButtons.OK, MessageBoxIcon.Information);
        DeleteFolderAfterExit(InstallDir);
    }

    /// <summary>
    /// The settings and the page's browser profile. The clips folder (Videos\Uncbox) is never touched:
    /// it isn't ours alone to judge, and a clip can't be undeleted.
    /// </summary>
    private static void DeleteUserData()
    {
        DeleteTree(Path.Combine(LocalData, "data"));
        if (Directory.Exists(LocalData))
        {
            foreach (string dir in Directory.GetDirectories(LocalData, "WebView2*")) DeleteTree(dir);
            if (!Directory.EnumerateFileSystemEntries(LocalData).Any()) DeleteTree(LocalData);
        }
    }

    /// <summary>
    /// This exe is running from the folder being removed, so it can't delete it. A short-lived cmd
    /// waits for the exit and then removes it (twice, in case something lingered).
    /// </summary>
    private static void DeleteFolderAfterExit(string folder)
    {
        string command = $"ping -n 4 127.0.0.1 >nul & rmdir /s /q \"{folder}\" & ping -n 6 127.0.0.1 >nul & rmdir /s /q \"{folder}\"";
        Process.Start(new ProcessStartInfo("cmd.exe", $"/d /s /c \"{command}\"") { CreateNoWindow = true, UseShellExecute = false });
    }

    // ---- the running app ----

    /// <summary>
    /// Uncbox in the given folder has to be closed before its files can be replaced or removed. It's
    /// asked to quit from the tray rather than killed, so a game it holds is handed back properly.
    /// False if the person gave up.
    /// </summary>
    public static bool EnsureNotRunning(string folder, string verb)
    {
        while (true)
        {
            var running = RunningFrom(folder);
            if (!running.Any(p => p.ProcessName.Equals("Uncbox", StringComparison.OrdinalIgnoreCase)))
            {
                // Its server goes with it; a straggler would keep files locked.
                foreach (var p in running)
                {
                    try
                    {
                        p.Kill(entireProcessTree: true);
                        p.WaitForExit(3000);
                    }
                    catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception) { }
                }
                return true;
            }
            var answer = MessageBox.Show(
                $"Uncbox is running. To {verb} it, quit it first: right-click its icon in the tray (by the clock) and choose Quit Uncbox. Then press Retry.",
                "Uncbox", MessageBoxButtons.RetryCancel, MessageBoxIcon.Information);
            if (answer != DialogResult.Retry) return false;
        }
    }

    /// <summary>Uncbox and Node processes whose program file is inside the folder (not this process).</summary>
    private static List<Process> RunningFrom(string folder)
    {
        string prefix = Path.GetFullPath(folder).TrimEnd('\\') + "\\";
        var found = new List<Process>();
        foreach (var p in Process.GetProcessesByName("Uncbox").Concat(Process.GetProcessesByName("node")))
        {
            try
            {
                if (p.Id != Environment.ProcessId && p.MainModule?.FileName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) == true) found.Add(p);
            }
            catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception) { }
        }
        return found;
    }

    // ---- files and shortcuts ----

    private static void DeleteTree(string path)
    {
        try
        {
            if (Directory.Exists(path)) Directory.Delete(path, recursive: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }

    private static void TryDelete(string file)
    {
        try
        {
            File.Delete(file);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }

    /// <summary>A .lnk, made with Windows' own scripting object (late-bound, so no extra references).</summary>
    private static void CreateShortcut(string link, string target)
    {
        dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell")!)!;
        try
        {
            dynamic shortcut = shell.CreateShortcut(link);
            shortcut.TargetPath = target;
            shortcut.WorkingDirectory = Path.GetDirectoryName(target);
            shortcut.IconLocation = target + ",0";
            shortcut.Description = "Uncbox";
            shortcut.Save();
            Marshal.FinalReleaseComObject(shortcut);
        }
        finally
        {
            Marshal.FinalReleaseComObject(shell);
        }
    }

    private static string? ShortcutTarget(string link)
    {
        try
        {
            dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell")!)!;
            try
            {
                dynamic shortcut = shell.CreateShortcut(link);
                string target = shortcut.TargetPath;
                Marshal.FinalReleaseComObject(shortcut);
                return target;
            }
            finally
            {
                Marshal.FinalReleaseComObject(shell);
            }
        }
        catch (COMException)
        {
            return null;
        }
    }
}
