# Uncbox app

Uncbox as a Windows app: full screen, in the tray when minimized, and with the option to **play
the game inside the dashboard**. In Play here, the game panel holds the game's real window, so
mouse, keyboard and controller go straight to it, at its own resolution and frame rate.

Everything else is the same Uncbox as in the browser (presets, panels, chat, Discord, clips, the
WoW link, stream mode), because the app shows the same page.

## Start it

```bash
npm run app
```

That builds the app the first time (it needs the [.NET 10 SDK](https://dotnet.microsoft.com/download))
and starts it. The app starts the Uncbox server itself, building the page first if needed, and
stops it again when you quit. If a server is already running (`npm start` in a terminal), it uses
that one. Starting the app again while it runs brings the running one back.

- **Minimize** (Win+Down, or **Minimize to the tray** in the sidebar) and Uncbox goes to the tray.
  Click the tray icon or press **Ctrl+Shift+F12** to bring it back.
- The tray icon's menu has **Monitor**, to move Uncbox to another screen, and **Quit Uncbox**.
  Alt+F4 quits too.
- Options, after `npm run app --`: `--screen=1` for another monitor, `--windowed` for a
  1280 × 720 window to try things out, an address (`http://localhost:5172/`), `--data=<folder>`
  for the server it starts, and `--root=<folder>` if the app lives outside the Uncbox folder.

## Play here

1. Run your game in **windowed** or **borderless** mode. Exclusive full screen can't be moved into
   a panel.
2. In the game panel's toolbar, choose **Play here**, then pick the game's window.
3. Click into the panel and play.

In the toolbar:

- **Play** hands the keyboard and controller to the game, like clicking into it.
- **Full screen** gives the game the whole monitor at native resolution and hides Uncbox.
  **Ctrl+Shift+F12** brings the dashboard back.
- **Crop** works like it does for a capture: the trimmed edges are tucked under the dashboard.
- **Turn on clips** picks the game window once more for [clips](../README.md#clips) and the
  [WoW link](../integrations/wow/README.md). Those read a capture of the game, which runs in the
  background while you play.
- **Change game** picks another window.

Uncbox remembers the game. Next time, it goes back into the panel by itself as soon as the game
is running.

**Games that won't resize.** Some games keep themselves at full screen size (Unity games in full
screen mode do). After a couple of seconds of that, Uncbox stops fighting and shows the game in
the panel as a live picture from Windows' compositor instead, with no capture and no added delay.
Your controller and keyboard still go to the game; click the panel to hand them back if you clicked
elsewhere. The mouse can't reach a picture, so the toolbar shows how to make that game resizable:
for Unity and Unreal games it names the launch option to add in Steam (game, **Properties**,
**Launch Options**), such as `-window-mode borderless` or `-windowed`.

**Start games windowed.** In the Steam panel's **⋯** menu, this gives every installed Steam
game the launch option its engine needs to start in a window (Unity, Unreal, Source and Godot
games), so they size into the panel and the mouse works. Games you set launch options for
yourself are left alone, and turning it off removes exactly what Uncbox added. Steam reads launch
options when it starts, so Uncbox restarts it (back into Big Picture if you were there); it won't
while a game is running.

**Steam.** In the Steam Big Picture preset, **Big Picture** and **Steam library** put Steam itself
in the panel. A game you start from there takes the panel while it runs (Uncbox finds it by its
install folder), and Steam comes back when you quit it.

For OBS, use a **Display Capture** of the monitor Uncbox is on. A Window Capture of Uncbox leaves
the game out, because the game is its own window.

**WoW:** with Play here, the addon's strip sits under the dashboard, so neither you nor viewers
see it. Turn on clips so Uncbox can read it.

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

- **The dashboard** is the Uncbox page in WebView2 (the Edge engine), drawn with the GPU through
  DirectComposition.
- **The game** isn't captured for display. The app removes the game window's border and title bar
  and moves it onto the panel. It cuts a hole in its own window there (`SetWindowRgn`), so the game
  shows through. The game window is a little bigger than the hole when there's a crop or a WoW
  strip, and the extra sits under the dashboard.
- **Input:** clicking in the panel clicks the game itself, which then has focus. Keyboard, mouse,
  raw input and controllers work as they do outside Uncbox. Nothing is forwarded or emulated.
- **Frame rate and resolution:** the game presents its own frames, so it runs as fast as it can
  (100, 200+ fps), one game pixel per screen pixel. In the panel it renders at the panel's size.
  With Full screen and nothing on top of it, Windows lets the game present directly (independent
  flip), as it would for any borderless full-screen game.
- The app re-checks the game's position four times a second, since games move and resize
  themselves. Quitting, or choosing another source, gives the window its border, size and position
  back.
- The app's own dialogs (the window picker) and the clip player are drawn inside the page, so the
  game goes behind the dashboard while one is open.
- The server the app starts sits in a Windows job object, so it stops even if the app crashes.

The page and the app talk with small JSON messages over WebView2's `postMessage`:
`UncboxShell/ShellForm.cs` lists them, and `src/native.ts` is the page's side.

| File | What it does |
| --- | --- |
| `UncboxShell/Program.cs` | Options, one copy at a time. |
| `UncboxShell/ShellForm.cs` | The window, tray, WebView2, messages, the hole and Full screen. |
| `UncboxShell/ServerHost.cs` | Finds or starts the Uncbox server. |
| `UncboxShell/GameWindow.cs` | Restyles, places and restores the game's window. |
| `UncboxShell/Native.cs` | The Win32 calls. |
| `../scripts/app.mjs` | `npm run app`: builds when needed, then starts the app. |

## Tested

Driven over WebView2's DevTools port, with a stand-in game window:

- The app started its own server (with `--data`), and the server stopped when the app quit. A
  second start brought the running app back.
- Play here placed the window to the pixel on the panel. Moving it 5 px up for the WoW strip, and
  growing it to 840 × 396 for a 10% / 5% crop, both matched the expected numbers.
- The game was remembered: after quitting (window given back exactly) and starting again, it went
  straight back into the panel.
- Minimize and Minimize to the tray hid it; starting it again brought it back. Stream mode took a
  windowed app full screen and back. Full screen gave the game the 2560 × 1440 monitor, and
  Ctrl+Shift+F12 returned it.
- Turn on clips: the window picker shows above the game, and picking the game started the capture
  and the instant-replay buffer.

**Not yet tried:** a real game with a controller, and anti-cheat. Moving and restyling another
app's window is what tools like Borderless Gaming do, and it never touches the game's memory or
input. Still, check competitive games one at a time.

## Later

- **Mixed DPI / several monitors:** placement assumes Uncbox and the game are on the same monitor.
- **Packaging:** a single-file `dotnet publish` and an installer, so the app can live outside the
  Uncbox folder and start with Windows.
