# Roadmap

Where Uncbox is headed: one dashboard for **streaming, gaming, browsing and productivity**, so the
second monitor (or the whole screen) never needs another app. Tickets are numbered `UBX-n`; each
lists what done looks like. Status is one of **Building**, **Review**, **Shipped** (with the
commit), or **Queued**. Loose ideas that are not tickets yet live in [ideas.md](ideas.md).

## Wave 1: building now

### UBX-1 · Google Drive widget — Shipped (b1c95e1)
Browse and open your Drive from a widget: Recent, Starred, Shared with me, Search, thumbnails.
- Sign in with Google from Uncbox (installed-app OAuth with PKCE, your own Desktop OAuth client),
  tokens kept server-side in `data/google.json`, never sent to the page.
- A reusable `server/google.mjs` so Calendar and Gmail (UBX-9, UBX-11) reuse the sign-in.
- Works without signing in when Google Drive for desktop is installed (browses `G:\My Drive`).
- Done when: a signed-in widget lists recent files and opens one; signing out revokes the token.

### UBX-2 · Web widget — Shipped (0afc6c5)
A browser inside a panel: address bar, back/forward/reload, Open in browser, zoom, hide toolbar.
- In a plain browser: an iframe, with a friendly "this site can't be shown here" card for sites
  that refuse framing.
- In the Uncbox app: a real WebView2 laid over the panel, so any site works (Google Docs,
  YouTube, dashboards), with sign-ins that persist.
- Done when: several web widgets show different sites in the app and stay put while panels move.

### UBX-3 · OBS widget — Shipped (3b1e193)
Stream health and control over obs-websocket v5: LIVE/REC with timecodes, bitrate, dropped
frames, CPU/FPS, scene buttons, start/stop stream and record (stop asks first), mic mutes, save
replay buffer. Password kept server-side.
- Done when: the widget shows live status from OBS and switches scenes.

### UBX-4 · Focus timer and Launcher widgets — Shipped (dac0305)
- **Focus**: a Pomodoro timer that survives reloads, with a soft chime and break colours.
- **Launcher**: a dock of apps, folders, files, websites and Steam games. The server only ever
  launches tiles you saved (never an arbitrary path from the page); icons from the apps.
- Done when: a tile launches its app and a focus round chimes at the end.

### UBX-5 · Ping & FPS widget — Shipped (6327242)
Live ping (TCP connect timing, no admin), jitter, loss and a sparkline, plus game FPS, 1% lows and
in-game ping read from SMITE 2's performance timeline when a match is on. Sampling runs only while
a widget is showing.

### UBX-7 · Now playing gets controls — Shipped (6f508a0)
Album art, a live progress bar, and previous/play-pause/next/seek for Spotify, browsers and
anything in the Windows media flyout.

### UBX-8 · Installer, start with Windows, update notice — Shipped (e8dad8b)
`Uncbox.exe` installs itself per user (Start menu, uninstall entry, no admin), an optional "Start
Uncbox when Windows starts", and a quiet "a new version is out" notice from GitHub releases.

## Wave 2: queued (start as wave 1 lands)

### UBX-6 · Desk preset — Shipped (ae6bf93)
A built-in "Desk" preset for working between games: Drive, Web, Focus, Launcher, Calendar, Now
playing, Notifications, Clock/Weather, with its own calm theme.

### UBX-9 · Google Calendar widget — Shipped (b21b4ae)
Today and the next few days from your calendars, "starts in 10 min" highlight, join-meeting
button for Meet links; reuses the Google sign-in with incremental consent.

### UBX-10 · Save clips to Google Drive — Shipped (2c18d52)
A "Save to Drive" button in the clip player (and an option to upload every clip automatically)
into an "Uncbox Clips" folder, resumable uploads, a share link copied when done.

### UBX-11 · Gmail glance — Shipped (b21b4ae)
Unread count and the latest few subjects/senders, click to open in the Web widget or browser.

### UBX-12 · Command palette — Shipped (b19c36f)
Ctrl+K anywhere in Uncbox: switch presets, add widgets, launch Launcher tiles, search Drive, open
a URL in a Web widget, save a clip, toggle stream mode.

### UBX-13 · Twitch stream info — Shipped (a51aca9)
Viewer count, followers/subs as they happen, edit title and category from Uncbox (Twitch sign-in
kept server-side, like Google).

### UBX-14 · Community preset gallery — Shipped (4117336)
Browse and install shared `.uncbox` presets from inside Uncbox (a GitHub-hosted index to start).

### UBX-15 · Screen reading for more games — Shipped (b8e5903)
Screen triggers: "when this phrase shows in this box, add 1 to a counter, mark a party member
down, or tick a milestone", with recipes (Souls, GTA, Game Over, Nuzlocke "{name} fainted!",
Defeat), fuzzy matching for OCR noise, one firing per sighting, and Undo on every firing. Not yet
built: reading the Pokémon HP bar by its colour (a follow-up).

## HIP sprint 1: harden and innovate

### HIP-1 · Local routes only answer Uncbox itself — Shipped (01539d6)
Every "this PC only" route trusts any request from this PC, so a web page open in your browser
could post to `localhost` (launch a tile, stop the stream, replace the Google client) and a
DNS-rebinding page could read Drive, Calendar or Gmail answers. Done when: one guard in front of
every API route checks the Host header against Uncbox's own names, rejects cross-site Origins and
`Sec-Fetch-Site: cross-site`, requires `application/json` for state-changing bodies, and the
native app and the unc.box address still work; tests cover each attack.

### HIP-2 · The server never loses data or leaks helpers — Shipped (1807eb2)
Atomic writes (temp file + rename) for every `data/*.json`, a last-good backup of `state.json`
that loads when the main one is corrupt, PowerShell and polling helpers that stop when no page
needs them (the media helper runs forever today), and a clean shutdown. Done when: killing the
server mid-write never corrupts state, and an idle Uncbox with no widgets showing runs no helpers.

### HIP-3 · Smoke tests for every widget and route — Shipped (a4521de)
A test that renders every widget type and panel in every preset theme with mocked data (no
crashes, no React warnings, compact sizes too), and a server test that boots on a random port with
a temp data folder and calls every GET route. Done when: both run in `npm run check`.

### HIP-4 · Automations — Shipped (02da118)
Simple "when this, do that" rules in a sidebar section: when a game starts or stops (the existing
game detection), when OBS goes live or stops, at a time of day, when a focus round starts; then
switch preset, toggle stream mode, switch an OBS scene, start a focus round, or show a note. Done
when: "when SMITE 2 starts, switch to the SMITE preset" and "when OBS goes live, turn on stream
mode" work, with each firing shown in a toast with Undo.

### HIP-5 · Accessibility and keyboard pass — Shipped (d63bb6b)
Every control reachable and visible by keyboard (focus rings in every theme), labels on icon
buttons, menus and dialogs with the right roles and focus trapping, reduced-motion support, and
contrast checked for each theme's text tokens. Done when: an automated axe-style check of each
widget and panel finds nothing serious, and the palette, menus and clip player are fully usable
without a mouse.

## Wave 3: video downloads, the widget library, and WoW for guild leaders

### UBX-16 · yt-dlp plugin — Shipped (2995fa3)
Download any video yt-dlp supports, at the source's own resolution and frame rate (no downscaling,
60 fps stays 60 fps), into the Uncbox clips folder, so it plays in the clip player and can be made
vertical, sent to Discord or saved to Drive. Uses the installed yt-dlp and ffmpeg, with one-click
install through winget when they're missing. Also: "Download this video" from a Web widget and
from Ctrl+K.

### UBX-17 · Widget library ("Get More Widgets") — Shipped (43aced6)
Every panel and widget becomes one kind of thing, a widget, defined in one place with its own
folder. The sidebar gets a "Get More Widgets" library to browse, search and add them; "More panels"
and "Add a widget" go away. Presets stay, with better defaults. Done when: adding a widget is one
folder plus one registry line, documented, and the old panel/widget split is gone from the code.

### UBX-18 · WoW addon sets itself up, and links your guild — Shipped (7d7b7b9)
The WoW preset installs and updates the addon by itself, writes its settings, and picks WoW as the
game window. The addon reports your guild roster, raid group, ready checks, loot and boss kills,
live over the strip and in full through its saved variables. Uncbox keeps guild history (who
raids, attendance, loot) in a local database.

### UBX-19 · WoW guild widgets — Shipped (18d94bc)
Widgets for running a 50+ person guild: roster and who's online, raid composition and roles,
attendance, loot history, guild events feed, and recruitment notes.

### UBX-20 · Uncbox AH engine — Shipped (bec31a5)
Our own auction house addon and price database, modelled on TradeSkillMaster and Auctionator:
full and targeted scans, market value from scan history, sale rates from your mail, posting rules,
undercut detection, deals, flips and crafting profit, with prices written back into the game for
tooltips and one-click posting.

### UBX-21 · Auction House widget — Shipped (14b0601)
The Uncbox side of the AH tools: item search with price history charts, deals and flips,
crafting profit, your auctions and sales, posting rules and shopping lists.

### UBX-24 � Replay buffer stays a minute long � Review
The replay buffer kept the last keyframe from before a pause in the game capture (a minimized game
sends no frames), so a clip saved just after coming back spanned the whole pause, hours if left
overnight. If the capture's clock ever went backwards, nothing was trimmed again and recording
stopped. Now a clip never reaches back past the pause, and a clock restart starts the buffer over.

### UBX-25 · Clips with sound: game, Discord and mic on separate tracks — Review
Instant replay clips were video only. In the Uncbox app, clips now carry four AAC tracks: Mix (game,
Discord and mic summed, the one players, phones and Discord's embeds use), then Game, Discord and Mic
each on its own so an editor like DaVinci Resolve can mix them. The app listens to the game's own
program (WASAPI process loopback), to Discord's, and to a mic you pick, keeps the last 70 seconds of
each in memory, and the page asks for exactly the clip's stretch when you press the clip key. Make
vertical and the Discord copy keep just the Mix. A Sound row under Clips sets it up, with level meters.

## Demo prep: first live demo (2026-10-25)

### DEMO-1 · A calmer sidebar — Shipped (a87a12e)
Presets in one dropdown, Get More Widgets in its own window with a category list (and the board's
own panel names), settings sections that fold away, Background as a list, a one-line setup list.

### DEMO-2 · Dropdowns instead of button rows — Shipped (34b11fb)
The Game panel's source, the SMITE 2 role, the Auction House tabs when narrow, and the guild news
filters are dropdowns; live-show buttons (OBS scenes, start/stop, launcher tiles) stay buttons.

### DEMO-3 · Nothing private on stream — Shipped (00e2b43)
One "private" signal (stream mode, OBS live, or the On air switch) hides mail, calendar, file names,
paths and addresses in every widget, toast, clip and the palette, so leaving stream mode mid-show
is safe. Audit in [stream-privacy.md](stream-privacy.md); checklist in [going-live.md](going-live.md).

## Stream with Uncbox (2026-10-26)

Go live on Twitch from Uncbox itself, without OBS: FFmpeg captures the screen with `ddagrab`
(Desktop Duplication) and encodes on the graphics card with `h264_nvenc`, frames never leaving the
GPU, and sends it to Twitch over `rtmps://`. The app records desktop sound and the mic (FFmpeg can't
capture what Windows plays) and hands FFmpeg one mixed stream through a named pipe. A sidebar
setting picks "Stream with: OBS / Uncbox"; OBS stays the default and nothing about it changes.

### UBX-22 · Go live from Uncbox: server, sidebar, Twitch key — Review (e4dd5c3)
`server/stream.mjs` runs FFmpeg and reports bitrate, dropped frames and uptime; the stream key lives
in `data/stream.json` (pasted, or fetched from the Twitch sign-in) and never reaches the page. A
"Test (not public)" mode uses Twitch's bandwidth test, so it can be tried without going live. Going
live through Uncbox turns the private signal on, like OBS going live.

### UBX-23 · Desktop sound and mic for the stream: native shell — Review (1ea70b4)
The shell records the default speakers (WASAPI loopback) and a chosen mic, mixes them to 48 kHz
stereo, fills silence so the timing holds, and writes it to a named pipe FFmpeg reads. It lists
mics and reports sound levels for the sidebar meters.

Measured on the RTX 5090 laptop (2560×1440 screen, idle desktop): the screen's own size streams
at a full 60 fps with every frame on the graphics card. Scaling to 1080p costs a copy to the CPU,
because FFmpeg 8.1's `scale_d3d11` can't take ddagrab's frames ("Could not create the texture"),
and lands at about 55 fps. Worth revisiting when FFmpeg fixes it.

### UBX-26 · Performance pass: a steady 60 fps, any graphics card, no setup — Review
1080p60 is now exactly 60: the capture runs alone in its input and the scaling as the output's
filter (scaling inside the capture lost 3 to 5 frames a second), and -fps_mode cfr fills the odd
frame ddagrab misses, so keyframes land exactly 2 s apart. Scaling moved to the card with CUDA
(Lanczos): 27-43% of a core instead of 48-106%. The check picks the encoder (NVIDIA NVENC, AMD
AMF, Intel Quick Sync), tries the stream's own settings and falls back to safe ones on an older
card, and keeps the quickest scaling it has seen work. NVENC: p6, quarter-size first pass,
temporal AQ, 20 frames of look-ahead, B-frames as references (VMAF 92.6-93.3 against 90.9-91.9 on
SMITE footage, better worst frames, about 0.27 s more delay). FFmpeg runs above normal priority. No setup: Uncbox is the default way to
stream, and a Twitch sign-in hands over the stream key (a forgotten key stays forgotten). Fixed on
the way: a key file race, a double Go live starting two FFmpegs, status events arriving out of
order, and the app serving a page older than its source. Animated backgrounds draw at 30 fps
(Network: 29-37% of a core at 120, 11-21% at 30). Reviewed independently; AMD and Intel scaling
untested on real hardware.

### UBX-27 · Uncbox's own streaming engine, in Rust — Review
uncbox-stream.exe (engine/) captures a screen with Desktop Duplication, turns and scales it in the
graphics card's video processor and encodes it there, so pictures never touch the processor. It sends
FLV over its own RTMP client (rtmps through Windows' SChannel), takes the app's sound pipe, and speaks
FFmpeg's progress format so the server reads it the same way. The stream key arrives on stdin, never on
the command line.

### UBX-28 · The engine matches FFmpeg's picture — Review
Direct NVENC (nvEncodeAPI64.dll, zero-copy D3D11 input) with exactly FFmpeg's quality settings: P6/HQ,
CBR, quarter-size first pass, temporal AQ, look-ahead 20, two B-frames as references, with the same
safe fallback for older cards. VMAF on two SMITE clips equals FFmpeg's (93.27 and 92.64; on one clip the
bytes match). HDR screens stream like ddagrab's (Windows hands over SDR), turned screens go out upright,
and a size change mid-stream keeps the stream going. Media Foundation stays for AMD and Intel (untested
on those cards). Measured live: 4-10% of a core against FFmpeg's 35-83%. Test-only: a Y4M file source
and FLV file output, for comparing pictures.

### UBX-29 · A second way to launch: lighter streaming with Uncbox's own engine — Review
The app takes `--engine=native` (also `npm run app:native`, a second Start-menu shortcut "Uncbox (lighter
streaming)", or `UNCBOX_STREAM_ENGINE=native` by hand) and the server then streams with uncbox-stream.exe
(UBX-27) instead of FFmpeg. One streaming feature, two engines behind it: the page sees the same tools,
status, wording and behaviour either way, and the server falls back to FFmpeg silently (one console line)
when the engine isn't built or its probe lists no encoder. A running server is told with
`POST /api/stream/engine` (409 while a stream runs). Messages no longer name FFmpeg as the thing streaming.
`npm run app:native` builds the engine when it is missing or older than its source, and starts with FFmpeg
if cargo isn't there. Measured here, 1080p60 into a local receiver: about 4% of a core against 38%.

## WoW Forever launch (2026-11-04)

### UBX-30 · Stealth mode: play full screen, stream the dashboard — Review
The OBS way of playing, in the Uncbox app: the game goes full screen in front and is played as it is,
while the stream keeps showing the dashboard with the game in its panel. The dashboard runs behind the
game at its own size (a tool window that never takes focus), and Uncbox shrinks to an OBS-style manager
window: a live preview drawn by Windows' compositor, Go live / Test / End with the stream's numbers, Save
clip, presets as one-click scenes and the whole sidebar, all reaching the dashboard through the shared
state, and kept out of every capture. Ctrl+Shift+F12 swaps between the game and the manager. The stream
is a scene made by Uncbox's own engine: both windows captured with Windows.Graphics.Capture (no more often
than the stream sends), the game drawn into the panel by a second pass of the video processor into the
NV12 picture, so there is no scene renderer and no extra full-size copy. The scene follows the panel live
over the engine's stdin and switches screen ⇄ scene mid-stream; a stream FFmpeg runs is started again on
the engine. Built and unit tested (engine, server, app arithmetic, both pages); not yet run on Windows
hardware, and not yet measured against OBS.

### UBX-31 · WoW Forever: gilded frames and a lighter addon link — Review
The WoW Forever preset gets its own gilded look: filigree corners and rivets on every panel, gold titles
over a diamond rule, a heavier double frame around the game, beveled level and XP bars and a warmer glow.
All static, painted once, so it costs nothing while streaming. The addon strip reader moved off the page's
main thread into a worker that copies only the strip's few rows of each frame (VideoFrame.copyTo with a
rectangle): measured in Chromium at 2560 × 1440 over 8 s, 2.6 to 3.9 ms of main-thread time instead of
about 3 s, with the same messages decoded.
