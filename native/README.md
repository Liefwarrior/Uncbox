# Uncbox app (spike)

A full-screen Windows app for Uncbox where you **play the game inside the dashboard**: the game
panel holds the game's real window, so mouse, keyboard and controller go straight to it, at its
own resolution and frame rate.

This is a spike: it works end to end, but it's rough at the edges (see [What's next](#whats-next)).

## How it works

```
┌────────────────────── Uncbox.exe (full screen, on top) ──────────────────────┐
│  WebView2: the same Uncbox page as in the browser, ?native=1                 │
│  ┌──────────── game panel ────────────┐  ┌ camera ┐                          │
│  │ ░░░░░░ hole cut in this window ░░░ │  │        │                          │
│  │ ░░  the game's own window sits ░░░ │  └────────┘                          │
│  │ ░░  here, borderless, and draws ░░ │  ┌ chat ──┐                          │
│  │ ░░  itself straight to screen  ░░░ │  │        │                          │
│  └────────────────────────────────────┘  └────────┘                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **The dashboard** is the normal Uncbox page in WebView2, the Edge engine. It draws with the GPU
  through DirectComposition, the same way Edge does. Nothing in Uncbox had to be rewritten.
- **The game** isn't captured. When the game panel is set to **Play here**, the shell takes the
  game's own window, removes its border and title bar, and moves it exactly onto the panel. It cuts
  a hole in its own window there with `SetWindowRgn`, so the game shows through.
- **Input:** clicking in the panel clicks the game itself, which then has focus. Keyboard, mouse,
  raw input and controllers (XInput, DirectInput, Steam Input) all work as they do outside Uncbox.
  Nothing is forwarded or emulated.
- **Frame rate and resolution:** the game renders and presents its own frames, so it runs at
  whatever it can do (100, 200+ fps), one game pixel per screen pixel. In the panel, it renders at
  the panel's size. **Full screen** gives it the whole monitor at native resolution and hides
  Uncbox. With nothing on top of it, Windows lets the game present directly (independent flip), the
  same as borderless full screen anywhere. **Ctrl+Shift+F12** brings the dashboard back.
- The shell keeps the game in place (it re-checks four times a second, since games move and resize
  themselves), and when it quits or the panel switches source, the window gets its border, size and
  position back.

The page and the shell talk with small JSON messages over WebView2's `postMessage`:
`native/UncboxShell/ShellForm.cs` lists them, and `src/native.ts` is the page's side.

## Try it

You need the [.NET 10 SDK](https://dotnet.microsoft.com/download) to build it. The WebView2 runtime
is already part of Windows 11.

```powershell
npm start                                  # the Uncbox server, as usual
dotnet run -c Release --project native/UncboxShell
```

Or build once with `dotnet build -c Release native/UncboxShell` and run
`native/UncboxShell/bin/Release/net10.0-windows/Uncbox.exe`. Options: a different address
(`Uncbox.exe http://localhost:5172/`), `--screen=1` for another monitor, and `--windowed` for a
1280 × 720 window to try it without covering the screen.

1. Run your game in **windowed** or **borderless** mode. Exclusive full screen can't be moved into
   a panel.
2. In the game panel's toolbar, choose **Play here**, then pick the game's window.
3. Click into the panel and play. **Full screen** (in the toolbar) gives it the whole screen;
   Ctrl+Shift+F12 comes back. Alt+F4 on Uncbox quits and gives the window back.

For OBS, use a **Display Capture** of that monitor. A Window Capture of Uncbox would leave the game
out, because the game is its own window.

## What was tested

With a stand-in game window (a plain WinForms window), driven through WebView2's DevTools port:

- Play here lists the windows, and picking one puts it exactly on the panel's rectangle (to the
  pixel, below the toolbar while editing), with its title bar removed and the hole cut.
- Full screen moved it to 0,0 2560 × 1440 (the monitor), hid Uncbox, and focused the game.
  Ctrl+Shift+F12 put it back in the panel.
- Closing Uncbox gave the window back its title bar, size and position.

**Not tried yet:** a real game, and a controller with one. Game-specific behavior (a game resizing
its swap chain, going exclusive full screen on focus, anti-cheat) is the main unknown.

## What's next

- **Clips and the WoW link in Play here.** They read a capture of the game. In the shell, the
  page can still capture the game window with `getDisplayMedia` (Windows Graphics Capture under
  the hood) just to feed them, without showing it. Or the shell can capture it natively with WGC
  and Direct3D 11 and hand frames over.
- **Remember the game:** match it by process name and title, so it goes back into the panel after
  a restart, like OBS's window matching.
- **Mixed DPI / several monitors:** placement assumes Uncbox and the game are on the same monitor.
- **A tray icon or menu** for quitting, choosing the monitor and the full-screen key.
- **Packaging:** a single-file `dotnet publish`, an installer, and starting the Node server from
  the app so it's one double-click.
- **Anti-cheat:** moving and restyling another app's window is what tools like Borderless Gaming
  do, and it doesn't touch the game's memory or input. Some anti-cheat systems may still not like a
  window sitting on top of the game, so check each competitive game.
