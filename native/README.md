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
  for the server it starts, `--root=<folder>` if the app lives outside the Uncbox folder, and
  `--engine=native` to stream with Uncbox's own engine instead of FFmpeg (`npm run app:native`
  builds the engine first; the installed app has a "Uncbox (lighter streaming)" Start menu entry
  for it; see [Streaming with Uncbox](../docs/streaming-with-uncbox.md)). `npm run test:shell`
  runs the app's unit tests.

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
in the panel. A game you start from there takes the panel the moment its window appears (Windows
tells Uncbox about new windows, and Uncbox takes any from your Steam game folders), and Steam comes
back as soon as you quit it.

## Stealth mode

Play the game full screen, the way you would with OBS minimized, while viewers keep seeing the
dashboard with the game in its panel. **Stealth mode** in the sidebar, Ctrl+K or the tray menu turns
it on (see [Stealth mode](../docs/streaming-with-uncbox.md#stealth-mode-the-uncbox-app) for using it).

- The game window is placed full screen on its monitor, in front, and focused.
- The dashboard window stays up at its own size, behind everything (`HWND_BOTTOM`), as a tool window
  that never activates (`WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`), so it is out of the taskbar and Alt+Tab
  and a stray click can't bring it over the game. The style change keeps the same window handle, which
  the stream's capture of it relies on. Minimizing it is undone at once: a minimized window draws nothing.
  WebView2 runs with Chromium's window occlusion tracking off (`--disable-features=CalculateNativeWinOcclusion`),
  or the covered page would stop drawing. Outside stealth mode the dashboard is topmost (nothing covers it),
  and hidden (tray, Full screen) it stops drawing as before.
- No hole is cut: the game isn't behind the panel any more. The page keeps reporting the panel's box,
  crop, WoW strip and fit (`rect`), and the app turns that into the **scene** it sends the page
  (`StealthLayout.Scene`): this window, its size, the game's window and the panel. The page passes it to
  the server, which hands it to Uncbox's own streaming engine; the engine captures both windows with
  Windows.Graphics.Capture and draws the game over the panel on the graphics card (engine/src/scene.rs).
- The **manager** (`StealthForm.cs`) is a normal window with the same page in its manager view
  (`?native=1&view=manager`, same WebView2 environment and profile). Its preview is two DWM thumbnails
  (the dashboard, and the game placed over its panel the way the engine places it, `StealthLayout.PlaceGame`)
  in a small borderless window owned by the manager over the page's preview box, so its coordinates are
  the thumbnails' own and it moves and minimizes with the manager. Both windows are excluded from every
  capture (`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`, black on Windows before 10 2004).
- The manager's page has a short list of messages of its own (`OnManagerMessage`): leave stealth mode,
  where its preview goes, the game in front, minimize, the stream's volumes, the mic list, start with
  Windows, and **relays** to the dashboard's page: Go live / Test / End stream and Save clip, which the
  dashboard does (it owns the stream controller, the sound pipe and the replay buffer), while the
  dashboard's controller state comes back the same way. It can't move the game or open web views.
- **Ctrl+Shift+F12** swaps between the game and the manager. Closing the manager leaves stealth mode:
  the dashboard comes back topmost and full screen, and the game goes back into its panel.

| Message (page → app) | |
| --- | --- |
| `{ type: "stealth", on }` / `{ type: "stealth" }` | into or out of stealth mode / ask whether it's on |
| `{ type: "previewrect", x, y, w, h }` / `{ type: "previewrect" }` | the manager's preview box, in device pixels / hide it |
| `{ type: "relay", message }` | `streamcommand` or `clipsave` from the manager, `streamstate` from the dashboard |

| Message (app → page) | |
| --- | --- |
| `{ type: "stealth", on }` | to both pages |
| `{ type: "scene", scene }` | to the dashboard: what the stream shows (null outside stealth mode) |
| `{ type: "streamcommand", action }`, `{ type: "clipsave" }` | to the dashboard, from the manager |
| `{ type: "streamstate", state }` | to the manager, from the dashboard |

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
| `UncboxShell/ShellForm.cs` | The window, tray, WebView2, messages, the hole, Full screen and stealth mode. |
| `UncboxShell/StealthForm.cs` | Stealth mode's manager window: its page, the live preview, kept out of captures. |
| `UncboxShell/StealthLayout.cs` | Stealth mode's arithmetic: the scene, where the game goes in the preview, where the manager opens. |
| `UncboxShell/ServerHost.cs` | Finds or starts the Uncbox server (the repo's, or a package's own). |
| `UncboxShell/GameWindow.cs` | Restyles, places and restores the game's window. |
| `UncboxShell/Native.cs` | The Win32 calls. |
| `UncboxShell/ClipAudio.cs` | The sound of clips: the game's, Discord's and the mic's last 70 seconds, each apart, in memory; the page asks for a clip's stretch (`clipaudioget`, answered in a WebView2 shared buffer). |
| `UncboxShell/ProcessLoopback.cs` | WASAPI process loopback (one program's sound, or everything except one), which NAudio 2.2.1 doesn't offer. |
| `UncboxShell/AudioKit.cs` | The shared audio pieces: 10 ms timeline, conversion to 48 kHz stereo, the small queue, the mic list. |
| `../scripts/app.mjs` | `npm run app`: builds when needed, then starts the app. |
| `../scripts/package.mjs` | `npm run package`: the folder and zip anyone can run. |

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

**Stealth mode is new and not yet tried on a Windows PC.** It builds (`dotnet build` with the Windows
targeting pack), and its arithmetic (the scene, where the game goes in the preview, where the manager
opens) is covered by `StealthLayoutTests`, with the same cases as the engine's placement tests. The
windows themselves, the preview's thumbnails and the stream's scene haven't been seen working yet.

**Not yet tried:** a real game with a controller, and anti-cheat. Moving and restyling another
app's window is what tools like Borderless Gaming do, and it never touches the game's memory or
input. Still, check competitive games one at a time.

## Packaging

```bash
npm run package
```

builds the page, publishes the app as one self-contained file (no .NET install needed), and puts
everything into `release/Uncbox/`, plus `release/Uncbox-<version>-win-x64.zip` to hand out. It
needs the .NET 10 SDK and a connection the first time, to download Node.

```
Uncbox.exe              the app
node/node.exe           a portable Node (pinned in scripts/package.mjs), with its license
app/package.json        marks app/ as Uncbox's folder
app/server/             the server, without its tests
app/integrations/wow/   install.mjs and the addon the server copies into WoW
app/dist/               the built page
```

It also makes `release/Uncbox-Setup-<version>.exe`: the same app published a second time with
`node/` and `app/` zipped inside the exe. That one file is both installer and app (`Installer.cs`):
run from anywhere but `%LOCALAPPDATA%\Programs\Uncbox` it offers to install (copies itself and
unpacks the payload, adds shortcuts and the Settings > Apps entry), and `Uncbox.exe --uninstall`
removes it. The zip's `Uncbox.exe` offers the same from an unzipped folder. Start with Windows is a
`HKCU\...\Run` value running `Uncbox.exe --tray` (`Autostart.cs`; page messages `autostart` and
`autostartstate`).

The Node zip comes from nodejs.org and is checked against the `SHASUMS256.txt` published beside
it; packaging stops if they differ. It's cached in `release/.cache/`, which, like the rest of
`release/`, git ignores.

Next to its `node\` folder, the app runs the server with that Node from `app\`, never builds, and
keeps the user's data in `%LOCALAPPDATA%\Uncbox\data` (unless given `--data=`), so the folder can
be unzipped anywhere, even somewhere read-only. Run from the repo, nothing changes.

**Not done yet:** an installer (a Start menu entry, start with Windows, updates). Until then,
people unzip and run it.

## Later

- **Mixed DPI / several monitors:** placement assumes Uncbox and the game are on the same monitor.
- **An installer** on top of the package (see Packaging).
