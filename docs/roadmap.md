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

### UBX-19 · WoW guild widgets — Building
Widgets for running a 50+ person guild: roster and who's online, raid composition and roles,
attendance, loot history, guild events feed, and recruitment notes.

### UBX-20 · Uncbox AH engine — Shipped (bec31a5)
Our own auction house addon and price database, modelled on TradeSkillMaster and Auctionator:
full and targeted scans, market value from scan history, sale rates from your mail, posting rules,
undercut detection, deals, flips and crafting profit, with prices written back into the game for
tooltips and one-click posting.

### UBX-21 · Auction House widget — Building
The Uncbox side of the AH tools: item search with price history charts, deals and flips,
crafting profit, your auctions and sales, posting rules and shopping lists.
