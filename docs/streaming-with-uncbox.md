# Streaming with Uncbox

Uncbox can go live on Twitch by itself, without OBS. It captures one screen, encodes it on your
graphics card and sends it to Twitch. There is nothing to tune: Uncbox finds your card's encoder
and the quickest way to scale the picture on its own. It streams with Uncbox unless you pick OBS
(anyone who already picked OBS keeps it).

## What you need

- A Windows PC with an **NVIDIA, AMD or Intel graphics card** and a current driver. Uncbox uses
  the card's own video encoder (NVIDIA NVENC, AMD AMF or Intel Quick Sync), so the game keeps the
  processor.
- **FFmpeg**. If it isn't installed, the Streaming section says so and has an **Install FFmpeg**
  button (the same install the Downloads widget does).
- To stream your sound, run the **Uncbox app** (`npm run app` or the installed one). Windows
  plays your desktop sound where a web page can't reach it; the app records it and your mic and
  gives them to the stream. In a plain browser the stream is picture only, and says so.
- A Twitch account.

## Set it up

Sign in to Twitch in a Twitch widget. That is the whole setup: Uncbox reads your stream key from
the sign-in the first time you open **Streaming** or press **Go live**. Everything below is optional.

1. **Stream key.** Picked up from the Twitch sign-in on its own. You can also **Paste stream key**
   (Twitch: Creator Dashboard, Settings, Stream, Primary Stream key) or press **Get it from Twitch**.
   If it says to sign in again, do that once: Twitch needs one more permission to read the key. The key stays on this PC in `data/stream.json`. Uncbox shows only its last four
   characters (and not even those while you are on air), and never puts it in your settings,
   exported presets or anything it sends to the page.
2. **Screen.** Which monitor to capture: Screen 1 is your main one.
3. **Quality.** `1080p60 · 6000` suits most connections. Lower ones (`720p60 · 4500`,
   `720p30 · 3000`) need less upload. **Screen size** sends the screen as it is.
4. **Sound** (in the app). **Desktop sound** is what Windows plays. **Mic** picks a microphone,
   or **No mic**. The sliders go from silent to double volume, and while you are live a small
   bar under each shows how loud it is.

The last line of the section says whether this PC is ready, naming the encoder it found ("Ready:
NVIDIA NVENC on your graphics card"), or what is missing.

## Try it first

**Test stream (not public)** sends the stream to Twitch as a bandwidth test. Twitch takes it but
shows it to no one, so you can check the picture, sound and numbers without going live.

## Go live

Press **Go live** (it asks once more: **Go live?**). The line under the button counts your time:

    ● Live 1:02:33 · 5.9 Mbps · 0 dropped

**End stream** (also two clicks) stops it. Ctrl+K has **Go live**, **Test stream** and **End
stream** too.

While you stream from Uncbox, **On air** is forced on, like with OBS, so mail, calendar, file
names and paths stay off the screen you are sending.

If the connection drops, Uncbox tries again after 2, 4, 8, 16 and 30 seconds with fresh sound,
and gives up after five tries in a row, telling you why. If the sound stops, the stream ends rather
than carry on silent.

## How light it is

Uncbox does the heavy work on the graphics card's video encoder, which games barely use, and runs
FFmpeg above normal priority so a game that takes every core can't make the stream stutter.
Measured on an RTX 5090 laptop, streaming a 2560×1440 screen at `1080p60 · 6000` into a local test
receiver for 25 seconds at a time (ranges are several runs, quiet and busy desktop):

| | Before | Now |
|---|---|---|
| Frames sent | 55–57 a second | exactly 60 a second |
| Keyframes | 2.0–2.4 s apart | exactly 2 s apart |
| Processor time | 48–106% of one core | 27–43% of one core |
| Scaling | on the processor (bicubic) | on the graphics card (CUDA, Lanczos) |
| Video encoder busy | 7–11% | 4–12% |
| Picture (VMAF, SMITE footage) | 90.9–91.9 | 92.6–93.3, and better on the worst frames |

The picture is scaled with CUDA on NVIDIA cards, AMF on AMD and Quick Sync on Intel, falling back
to the processor only where none of those work. NVENC runs at its quality end (a quarter-size
first pass, adaptive quantisation over time, B-frames as references and 20 frames of look-ahead,
which adds about a quarter of a second to the few seconds viewers are behind anyway). If a card refuses
any of that, the check finds out and Uncbox streams with plainer settings instead. AMD and Intel
cards use the same approach but haven't been measured yet.

## Lighter streaming (optional)

Uncbox has a second way to launch that streams with Uncbox's own small streaming program instead
of FFmpeg. Nothing looks different and everything above works the same: the same Streaming section,
buttons, settings and messages. What changes is the load on your PC. On the RTX 5090 laptop
(2560×1440 screen, `1080p60 · 6000`, a local test receiver) the processor time went from about
38% of one core to about 4%, and it needs no FFmpeg install. See `engine/README.md` for the measurements.

Start it one of these ways:

- **From a checkout:** `npm run app:native` instead of `npm run app`. The first run builds the
  program (it needs Rust and the LLVM-MinGW compiler, which install per user without admin rights:
  see `engine/README.md`, "Building"), and rebuilds it when its source changes.
- **Installed:** the Start menu has a second entry, **Uncbox (lighter streaming)**, beside **Uncbox**
  (copies that include the program only).
- **In a browser:** start the server with `UNCBOX_STREAM_ENGINE=native npm start`.

If Uncbox is already running, launching it again just brings the running one back, so quit it first
(tray icon, **Quit Uncbox**) to switch. You can't switch while a stream is going.

It falls back to FFmpeg by itself. If the program isn't built, or can't start an encoder on this PC,
Uncbox streams with FFmpeg exactly as before, and the only sign is one line in the server's console.
(`npm run app:native` without Rust installed says how to get it and starts normally.)

Viewers can't tell them apart. On NVIDIA the program drives NVENC directly with the same settings
FFmpeg uses (B-frames, 20 frames of look-ahead, a quarter-size first pass), and scored the same VMAF
as FFmpeg on two SMITE clips (92.6-93.3). What you get is the processor time back: measured on an
RTX 5090 laptop at 1080p60, 4-10% of one core against FFmpeg's 35-83%, and it stops in a fifth of
a second. It also streams HDR screens and turned (portrait) screens upright, and keeps going when a
screen changes size mid-stream. On AMD and Intel cards the lighter launch streams with FFmpeg: the
program could only use Windows' own encoders there, whose picture is visibly plainer, so FFmpeg's
AMF and Quick Sync encoders do it instead and the stream looks the same either way.

## Stealth mode (the Uncbox app)

Stealth mode is the OBS way of playing: your game goes full screen and you play it exactly as you
normally would, while viewers keep seeing your Uncbox dashboard with the game in its panel. Uncbox
shrinks to a small manager window, like OBS's, that you can minimize while you play.

Turn it on with **Stealth mode** in the sidebar (under Stream mode), Ctrl+K "Stealth mode", or the
tray icon's menu. Then:

- **The game** (in Play here) goes full screen on its monitor, in front, at its own resolution and
  frame rate. Mouse, keyboard and controller are simply the game's.
- **The dashboard** keeps running behind it at its own size, in stream mode. It leaves the taskbar
  and Alt+Tab and never takes focus, so it can't come up over your game.
- **The manager** opens, on your second screen if you have one: a live preview of exactly what
  viewers see, Go live / Test stream / End stream with the stream's numbers, Save clip, your presets
  as one-click scenes, and the whole sidebar (widgets, clips, streaming, automations, the WoW addon).
  Everything you change there changes the dashboard too.
- **Ctrl+Shift+F12** swaps between the game and the manager. Minimizing the manager is like minimizing
  OBS: the stream goes on. Closing it (or **Full dashboard**) leaves stealth mode, and the game goes
  back into its panel. The stream goes on through that too.

The manager never shows on stream, in clips or in a screen share, even on the screen being captured:
Windows leaves it out of every capture.

### What the stream shows

In stealth mode the stream doesn't capture a screen. Uncbox's own engine captures two windows with
Windows' compositor (the dashboard, and the game) and puts the game over its panel on the graphics
card, with the panel's crop, its Fit setting and the WoW addon's strip left out, exactly where the
dashboard has it. That is an OBS scene (a window capture with a browser overlay), made without a
scene renderer: the graphics card's video processor draws the game into the panel in the same pass
that turns the picture into what the encoder takes, so the picture never touches the processor and
there is no extra full-size copy. Move a panel, change presets or swap the game and the stream follows
in about a tenth of a second.

Stealth mode always streams with Uncbox's own engine, whichever way Uncbox was launched: FFmpeg can't
put two windows together. A stream that FFmpeg is already running when stealth mode comes on is
started again on the engine (a few seconds); one the engine runs just switches. On an installed Uncbox
the engine is included; from a checkout, build it once with `npm run engine` (see `engine/README.md`).
On AMD and Intel cards it streams through Windows' own encoder, whose picture is plainer than FFmpeg's
there; on NVIDIA it drives NVENC with the same settings as always.

### Why it's lighter than OBS

Where OBS spends its time with a setup like this, and what stealth mode does instead:

| | OBS (window capture + browser source overlay) | Uncbox stealth mode |
|---|---|---|
| Overlay | A browser source rendered off screen every frame, then copied into OBS | The dashboard draws only what changes; static frames (the WoW gilding included) are painted once |
| Scene | OBS's own renderer composites every source every frame | Two window captures go straight into the video processor's pass, which the stream needs anyway |
| Preview | OBS renders a preview of the scene in its window | Windows' compositor draws the preview (thumbnails); minimized, it costs nothing |
| Capture rate | Every frame the game presents | No more often than the stream sends (Windows 11 24H2 and later), even at 240 fps |
| Encoder | NVENC through OBS | NVENC driven directly, with the settings above |

The engine's own numbers above (4-10% of one core against FFmpeg's 35-83%) were measured streaming a
screen; the scene adds one small pass on the graphics card and a second window capture, and hasn't been
measured on its own yet. Nor has OBS been measured with this setup on the test PC, so there's no OBS
figure here: compare on your own PC with Task Manager's Details tab (CPU and GPU of `obs64.exe` and its
browser helpers against `uncbox-stream.exe`, `Uncbox.exe` and `msedgewebview2.exe`) while both stream
the same game.

### Good to know

- Run the game **windowed or borderless**, as for Play here. Exclusive full screen can't be captured as
  a window.
- **Windows 10** draws a yellow border around a window being captured (Windows 11 lets Uncbox turn it
  off), so you'll see one around the game while you stream in stealth mode there.
- With the manager on the game's own screen and its preview showing, Windows composes the game with it
  (a few milliseconds more delay). Put the manager on another screen or minimize it for the game's
  lowest delay.
- **WoW:** the addon's strip shows at the top-left of your own screen while you play full screen
  (viewers never see it). Clips and the WoW link keep working from their own capture of the game.

## What viewers see

Outside stealth mode: the screen you picked, as it is, one picture. Anything on that screen is on
stream, including Uncbox itself, so use stream mode (F8) or capture a screen with only the game. In
stealth mode: the dashboard with the game in it, as above. Need other scenes and overlays? Use OBS, as
before.

## If it won't start

- **No stream key yet.** Add one under Streaming.
- **FFmpeg isn't installed.** Use **Install FFmpeg**, then **Check again**.
- **No encoder.** Uncbox needs the video encoder on an NVIDIA, AMD or Intel graphics card. Update
  the graphics driver.
- **Dropped right away.** The line under the button shows the last thing the stream program said,
  with the key blanked out. Twitch refusing the key is the usual cause: copy it again.
- **In stealth mode: "needs Uncbox's own streaming engine".** Run `npm run engine` once from a
  checkout (an installed Uncbox has it), then Go live again. "Windows 10 version 1903 or later" means
  Windows can't capture windows here, or the engine was built before stealth mode: rebuild it.
