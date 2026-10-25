namespace UncboxShell;

/// <summary>
/// The small window Uncbox.exe opens when it is run from somewhere it isn't installed (see
/// Installer). Result: OK when installed (and the installed copy started), Ignore for "Just run
/// it", Cancel when closed.
/// </summary>
internal sealed class InstallDialog : Form
{
    private readonly CheckBox _startup = new()
    {
        Text = "Start Uncbox when Windows starts",
        AutoSize = true,
        Checked = Autostart.HasEntry(),
        Margin = new Padding(0, 14, 0, 0),
    };
    private readonly CheckBox _desktop = new() { Text = "Add a desktop shortcut", AutoSize = true, Margin = new Padding(0, 6, 0, 0) };
    private readonly Button _install = new() { AutoSize = true, DialogResult = DialogResult.None, Padding = new Padding(10, 3, 10, 3) };
    private readonly Button _run = new() { Text = "Just run it", AutoSize = true, DialogResult = DialogResult.Ignore, Padding = new Padding(10, 3, 10, 3) };
    private readonly Label _status = new() { AutoSize = true, ForeColor = SystemColors.GrayText, Margin = new Padding(0, 10, 0, 0) };
    private bool _busy;

    public InstallDialog()
    {
        bool update = Installer.IsInstalled;
        string verb = update ? "Update" : "Install";
        Text = $"{verb} Uncbox";
        Font = new Font("Segoe UI", 9.5f);
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(20, 16, 20, 16);

        var title = new Label
        {
            Text = $"{verb} Uncbox",
            Font = new Font("Segoe UI Semibold", 14f),
            AutoSize = true,
        };
        string where = Installer.InstallDir;
        string note = update
            ? $"Uncbox {Installer.InstalledVersion ?? "(an older version)"} is already installed. This puts version {Installer.Version} in its place and keeps your settings."
            : $"Uncbox goes in {where}, for you only. No admin rights needed, and you’ll find it in the Start menu.";
        var body = new Label { Text = note, AutoSize = true, MaximumSize = new Size(420, 0), Margin = new Padding(0, 6, 0, 0) };

        _install.Text = verb;
        _install.Click += OnInstall;
        _run.Click += (_, _) => Close();
        AcceptButton = _install;

        var buttons = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.RightToLeft,
            AutoSize = true,
            Dock = DockStyle.Fill,
            Margin = new Padding(0, 16, 0, 0),
        };
        buttons.Controls.Add(_install);
        buttons.Controls.Add(_run);

        var layout = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, Dock = DockStyle.Fill };
        layout.Controls.AddRange([title, body, _startup, _desktop, _status, buttons]);
        buttons.MinimumSize = new Size(420, 0);
        Controls.Add(layout);
    }

    private void SetBusy(bool busy, string status = "")
    {
        _busy = busy;
        _install.Enabled = _run.Enabled = _startup.Enabled = _desktop.Enabled = !busy;
        _status.Text = status;
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // Half-copied is worse than either answer.
        if (_busy) e.Cancel = true;
        base.OnFormClosing(e);
    }

    private async void OnInstall(object? sender, EventArgs e)
    {
        if (!Installer.EnsureNotRunning(Installer.InstallDir, "update")) return;
        SetBusy(true, "Installing…");
        var options = new InstallOptions(_startup.Checked, _desktop.Checked);
        try
        {
            await Task.Run(() => Installer.Install(options));
            Installer.LaunchInstalled();
        }
        catch (Exception err)
        {
            SetBusy(false);
            MessageBox.Show($"Uncbox couldn’t be installed: {err.Message}", "Uncbox", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        _busy = false;
        DialogResult = DialogResult.OK;
    }
}

/// <summary>Asks before Uncbox.exe --uninstall removes anything. OK to go ahead; DeleteSettings if asked to.</summary>
internal sealed class UninstallDialog : Form
{
    private readonly CheckBox _settings = new()
    {
        Text = "Also delete my settings",
        AutoSize = true,
        Margin = new Padding(0, 14, 0, 0),
    };

    public bool DeleteSettings => _settings.Checked;

    public UninstallDialog()
    {
        Text = "Uninstall Uncbox";
        Font = new Font("Segoe UI", 9.5f);
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(20, 16, 20, 16);

        var title = new Label { Text = "Remove Uncbox?", Font = new Font("Segoe UI Semibold", 14f), AutoSize = true };
        var body = new Label
        {
            Text = "This removes the app, its shortcuts and its start-with-Windows entry. Your settings are kept unless you tick the box. Your clips in Videos\\Uncbox are always kept.",
            AutoSize = true,
            MaximumSize = new Size(420, 0),
            Margin = new Padding(0, 6, 0, 0),
        };
        var remove = new Button { Text = "Uninstall", AutoSize = true, DialogResult = DialogResult.OK, Padding = new Padding(10, 3, 10, 3) };
        var cancel = new Button { Text = "Cancel", AutoSize = true, DialogResult = DialogResult.Cancel, Padding = new Padding(10, 3, 10, 3) };
        AcceptButton = remove;
        CancelButton = cancel;

        var buttons = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.RightToLeft,
            AutoSize = true,
            Dock = DockStyle.Fill,
            MinimumSize = new Size(420, 0),
            Margin = new Padding(0, 16, 0, 0),
        };
        buttons.Controls.Add(remove);
        buttons.Controls.Add(cancel);

        var layout = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, Dock = DockStyle.Fill };
        layout.Controls.AddRange([title, body, _settings, buttons]);
        Controls.Add(layout);
    }
}
